import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { serve, type ServerType } from '@hono/node-server'
import { Tidebase, RunCancelledError } from '@tidebase/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'

let server: ServerType
let tide: Tidebase

beforeAll(() => {
  server = serve({ fetch: createApp().fetch, port: 0 })
  tide = new Tidebase({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('SDK e2e: queues and cancellation', () => {
  it('tide.enqueue + tide.work executes a registered workflow off the queue', async () => {
    const queue = `e2e-${randomUUID().slice(0, 8)}`
    const executed: unknown[] = []

    tide.workflow('queued-report', async (run, input: any) => {
      const doubled = await run.step('double', () => input.n * 2)
      executed.push(doubled)
      return doubled
    })

    const { run } = await tide.enqueue('queued-report', { queue, input: { n: 21 } })
    expect(run.status).toBe('queued')

    const controller = new AbortController()
    const worker = tide.work({ queues: [queue], pollMs: 50, signal: controller.signal })
    await waitFor(async () => (await tide.runs.get(run.id)).run.status === 'completed')
    controller.abort()
    await worker

    const detail = await tide.runs.get(run.id)
    expect(detail.run.status).toBe('completed')
    expect(detail.run.result).toBe(42)
    expect(executed).toEqual([42])
  })

  it('a worker blocked on a gate unwinds with RunCancelledError when the run is cancelled', async () => {
    const queue = `e2e-${randomUUID().slice(0, 8)}`
    let observed: unknown = null

    tide.workflow('gated-flow', async (run) => {
      await run.step('prepare', () => 'ready')
      // the gate will never be approved; cancellation must unwind this wait
      return run.gate('approve-it', { prompt: 'never answered', pollMs: 50 })
    })

    const { run } = await tide.enqueue('gated-flow', { queue })
    const controller = new AbortController()
    const worker = tide.work({
      queues: [queue],
      pollMs: 50,
      signal: controller.signal,
      onError: (error) => {
        observed = error
      }
    })

    await waitFor(async () => ((await tide.runs.get(run.id)).gates as any[]).length > 0)
    await tide.runs.cancel(run.id, { reason: 'e2e test', actor: 'vitest' })

    await waitFor(async () => observed !== null)
    controller.abort()
    await worker

    expect(observed).toBeInstanceOf(RunCancelledError)
    const detail = await tide.runs.get(run.id)
    expect(detail.run.status).toBe('cancelled')
    expect(detail.run.cancelReason).toBe('e2e test')
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor timed out')
}
