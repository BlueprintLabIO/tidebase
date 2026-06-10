import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Tidebase, type RunContext } from '@tidebase/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'

let tidebaseServer: ServerType
let tide: Tidebase
let webhookServer: Server
let webhookUrl: string

beforeAll(async () => {
  const app = createApp()
  tidebaseServer = serve({ fetch: app.fetch, port: 0 })
  const port = (tidebaseServer.address() as AddressInfo).port
  tide = new Tidebase({
    url: `http://127.0.0.1:${port}`,
    webhookSecret: 'test-webhook-secret'
  })

  // Recovery receiver: bridges node:http to the SDK's fetch-style webhook handler,
  // exactly how a user would mount it in their own app.
  const handler = tide.webhook()
  webhookServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const request = new Request('http://localhost/tidebase/recover', {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, String(v)])
        ),
        body: Buffer.concat(chunks).toString('utf8')
      })
      const response = await handler(request)
      res.writeHead(response.status, { 'content-type': 'application/json' })
      res.end(await response.text())
    })
  })
  await new Promise<void>((resolve) => webhookServer.listen(0, resolve))
  webhookUrl = `http://127.0.0.1:${(webhookServer.address() as AddressInfo).port}/tidebase/recover`
})

afterAll(async () => {
  await new Promise((resolve) => webhookServer.close(resolve))
  await new Promise((resolve) => tidebaseServer.close(resolve))
})

describe('crash and resume via recovery webhook (the core product promise)', () => {
  it('a crashed run resumes from the last checkpoint and never re-executes completed steps', async () => {
    const executions = { fetch: 0, write: 0, finalize: 0 }
    let crashOnce = true

    const workflow = async (run: RunContext) => {
      const data = await run.step('fetch', { input: { order: 7 } }, async () => {
        executions.fetch += 1
        return { rows: 3 }
      })
      await run.step(
        'write',
        { sideEffects: ['db:write'], idempotencyKey: 'order-7' },
        async () => {
          executions.write += 1
          return 'written'
        }
      )
      return run.step('finalize', async () => {
        executions.finalize += 1
        if (crashOnce) {
          crashOnce = false
          throw new Error('process crashed')
        }
        return { rows: data.rows, done: true }
      })
    }
    tide.workflow('order-report', workflow)

    const run = await tide.runs.create('order-report', { recoveryWebhook: webhookUrl })

    // First execution crashes in `finalize`; the fail report triggers the recovery
    // webhook, which re-runs the workflow in-line before the error propagates.
    await expect(
      tide.run('order-report', { runId: run.id }, workflow)
    ).rejects.toThrow('process crashed')

    const detail = await tide.runs.get(run.id)
    expect(detail.run.status).toBe('completed')
    expect(detail.run.result).toEqual({ rows: 3, done: true })

    // Completed checkpoints were served from storage, not re-executed.
    expect(executions).toEqual({ fetch: 1, write: 1, finalize: 2 })

    const eventTypes = detail.events.map((event) => event.type)
    expect(eventTypes).toContain('recovery.started')
    expect(eventTypes).toContain('recovery.delivered')

    const attempts = detail.recoveryAttempts as Array<{ status: string }>
    expect(attempts[0]?.status).toBe('delivered')
  })

  it('re-running a completed run returns the stored result without executing the workflow', async () => {
    let executed = 0
    const workflow = async (run: RunContext) => {
      return run.step('only', async () => {
        executed += 1
        return 'value'
      })
    }
    const result = await tide.run('cached-workflow', {}, workflow)
    expect(result).toBe('value')

    const runs = await tide.runs.list()
    const run = runs.runs.find((r) => r.workflowName === 'cached-workflow' && r.status === 'completed')
    expect(run).toBeDefined()

    const replayed = await tide.run('cached-workflow', { runId: run!.id }, workflow)
    expect(replayed).toBe('value')
    expect(executed).toBe(1)
  })

  it('step input hashing is stable across object key order, so resumes hit the cache', async () => {
    let executed = 0
    let crash = true
    const run = await tide.runs.create('hash-stability')

    const attempt = (input: Record<string, unknown>) =>
      tide.run('hash-stability', { runId: run.id }, async (ctx) => {
        await ctx.step('compute', { input }, async () => {
          executed += 1
          return 'computed'
        })
        if (crash) {
          crash = false
          throw new Error('halt')
        }
        return 'done'
      })

    await expect(attempt({ a: 1, nested: { x: 1, y: 2 } })).rejects.toThrow('halt')
    // Same logical input, different key order — must replay from cache.
    const result = await attempt({ nested: { y: 2, x: 1 }, a: 1 })
    expect(result).toBe('done')
    expect(executed).toBe(1)
  })

  it('SDK retries re-acquire the lease and commit the eventual success', async () => {
    let attempts = 0
    const run = await tide.runs.create('retry-workflow')
    const result = await tide.run('retry-workflow', { runId: run.id }, async (ctx) => {
      return ctx.step('flaky', { retries: 2 }, async () => {
        attempts += 1
        if (attempts < 3) throw new Error('transient')
        return 'eventually'
      })
    })
    expect(result).toBe('eventually')
    expect(attempts).toBe(3)

    const detail = await tide.runs.get(run.id)
    expect(detail.run.status).toBe('completed')
    const step = (detail.steps as any[]).find((s) => s.name === 'flaky')
    expect(step.status).toBe('completed')
    expect(step.attempt).toBe(3)
    expect(step.output).toBe('eventually')
  })
})

describe('SDK resume-decision classification matches the server contract', () => {
  async function failWorkflow(workflowName: string, stepOptions: Record<string, unknown>) {
    const run = await tide.runs.create(workflowName)
    await expect(
      tide.run(workflowName, { runId: run.id }, async (ctx) =>
        ctx.step('doomed', stepOptions as any, async () => {
          throw new Error('nope')
        })
      )
    ).rejects.toThrow('nope')
    const detail = await tide.runs.get(run.id)
    const step = (detail.steps as any[]).find((s) => s.name === 'doomed')
    const event = detail.events.find((e) => e.type === 'step.failed') as any
    return { step, decision: event.payload.resumeDecision }
  }

  it('a plain step with no declared side effects is safe to replay', async () => {
    const { step, decision } = await failWorkflow('classify-plain', {})
    expect(decision).toBe('safe_replay')
    expect(step.status).toBe('failed')
  })

  it('read-only side effects are safe to replay', async () => {
    const { decision } = await failWorkflow('classify-read', { sideEffects: ['read'] })
    expect(decision).toBe('safe_replay')
  })

  it('unkeyed external writes park in manual_review', async () => {
    const { step, decision } = await failWorkflow('classify-write', {
      sideEffects: ['email:send']
    })
    expect(decision).toBe('manual_review')
    expect(step.status).toBe('manual_review')
  })

  it('an idempotency key downgrades the same failure to safe_replay', async () => {
    const { decision } = await failWorkflow('classify-keyed', {
      sideEffects: ['email:send'],
      idempotencyKey: 'k-1'
    })
    expect(decision).toBe('safe_replay')
  })
})

describe('gates end-to-end', () => {
  it('a workflow blocks on a gate until a human resolves it, and replays the decision on resume', async () => {
    const run = await tide.runs.create('gated-workflow')
    let gateExecutions = 0

    const workflow = (ctx: RunContext) =>
      ctx.gate('ship-it', { prompt: 'Ship to production?', pollMs: 25 }).then((decision) => {
        gateExecutions += 1
        return decision.decision
      })

    const pending = tide.run('gated-workflow', { runId: run.id }, workflow)

    // Wait until the gate exists, then approve it with the resolve token.
    let gate: any
    for (let i = 0; i < 100 && !gate; i += 1) {
      const detail = await tide.runs.get(run.id)
      gate = (detail.gates as any[])[0]
      if (!gate) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(gate).toBeDefined()
    expect(gate.status).toBe('pending')

    await tide.request(`/runs/${run.id}/gates/${gate.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ token: gate.resolveToken, decision: 'approved', actor: 'reviewer' })
    })

    await expect(pending).resolves.toBe('approved')
    expect(gateExecutions).toBe(1)

    // A resumed run sees the recorded decision immediately.
    const replay = await tide.run('gated-workflow', { runId: run.id }, workflow)
    expect(replay).toBe('approved')
  })
})
