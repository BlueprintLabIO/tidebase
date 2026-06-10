import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api, createRun, getRunDetail } from './helpers'

const app = createApp()

async function beginStep(
  runId: string,
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return api(app, 'POST', `/runs/${runId}/steps/begin`, {
    name,
    inputHash: 'hash-1',
    input: { n: 1 },
    ...overrides
  })
}

describe('step checkpointing (exactly-once execution)', () => {
  it('returns the cached output on re-begin instead of executing again', async () => {
    const run = await createRun(app)
    const first = await beginStep(run.id, 'fetch', { leaseOwner: 'w1' })
    expect(first.body.action).toBe('execute')

    const complete = await api(
      app,
      'POST',
      `/runs/${run.id}/steps/${first.body.step.id}/complete`,
      { leaseOwner: 'w1', output: { rows: 42 } }
    )
    expect(complete.status).toBe(200)
    expect(complete.body.step.status).toBe('completed')

    // A resumed worker replaying the same step must get the recorded output back.
    const replay = await beginStep(run.id, 'fetch', { leaseOwner: 'w2' })
    expect(replay.body.action).toBe('return')
    expect(replay.body.output).toEqual({ rows: 42 })
  })

  it('rejects a replay whose input hash differs from the recorded one', async () => {
    const run = await createRun(app)
    const first = await beginStep(run.id, 'fetch', { leaseOwner: 'w1' })
    await api(app, 'POST', `/runs/${run.id}/steps/${first.body.step.id}/complete`, {
      leaseOwner: 'w1',
      output: 'a'
    })

    const drifted = await beginStep(run.id, 'fetch', {
      inputHash: 'hash-2',
      leaseOwner: 'w2'
    })
    expect(drifted.body.action).toBe('input_mismatch')
    expect(drifted.body.expectedInputHash).toBe('hash-1')
    expect(drifted.body.actualInputHash).toBe('hash-2')
  })

  it('a failed step can be retried and its attempt counter grows', async () => {
    const run = await createRun(app)
    const first = await beginStep(run.id, 'flaky', { leaseOwner: 'w1' })
    await api(app, 'POST', `/runs/${run.id}/steps/${first.body.step.id}/fail`, {
      leaseOwner: 'w1',
      error: { message: 'boom' },
      retryable: true
    })

    const retry = await beginStep(run.id, 'flaky', { leaseOwner: 'w1' })
    expect(retry.body.action).toBe('execute')
    expect(retry.body.step.attempt).toBe(2)
  })
})

describe('step leases (mutual exclusion + fencing)', () => {
  it('a second worker cannot begin a step while the lease is live', async () => {
    const run = await createRun(app)
    const first = await beginStep(run.id, 'guarded', { leaseOwner: 'w1' })
    expect(first.body.action).toBe('execute')

    const intruder = await beginStep(run.id, 'guarded', { leaseOwner: 'w2' })
    expect(intruder.body.action).toBe('locked')
  })

  it('the lease owner can re-begin its own running step', async () => {
    const run = await createRun(app)
    await beginStep(run.id, 'mine', { leaseOwner: 'w1' })
    const again = await beginStep(run.id, 'mine', { leaseOwner: 'w1' })
    expect(again.body.action).toBe('execute')
  })

  it('complete and fail are fenced by leaseOwner', async () => {
    const run = await createRun(app)
    const first = await beginStep(run.id, 'fenced', { leaseOwner: 'w1' })

    const staleComplete = await api(
      app,
      'POST',
      `/runs/${run.id}/steps/${first.body.step.id}/complete`,
      { leaseOwner: 'stale-worker', output: 'x' }
    )
    expect(staleComplete.status).toBe(409)

    const staleFail = await api(
      app,
      'POST',
      `/runs/${run.id}/steps/${first.body.step.id}/fail`,
      { leaseOwner: 'stale-worker', error: { message: 'x' } }
    )
    expect(staleFail.status).toBe(409)

    const ownerComplete = await api(
      app,
      'POST',
      `/runs/${run.id}/steps/${first.body.step.id}/complete`,
      { leaseOwner: 'w1', output: 'x' }
    )
    expect(ownerComplete.status).toBe(200)
  })

  it('concurrent first-begins of the same step grant execute to exactly one worker', async () => {
    const run = await createRun(app)
    const workers = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']
    const results = await Promise.all(
      workers.map((leaseOwner) => beginStep(run.id, 'contested', { leaseOwner }))
    )
    const actions = results.map((result) => result.body?.action)
    const executes = actions.filter((action) => action === 'execute')
    expect(executes).toHaveLength(1)
    expect(actions.filter((action) => action === 'locked')).toHaveLength(workers.length - 1)
  })
})

describe('run leases', () => {
  it('a second worker cannot begin a leased run', async () => {
    const run = await createRun(app)
    const first = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w1'
    })
    expect(first.status).toBe(200)

    const second = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w2'
    })
    expect(second.status).toBe(409)
    expect(second.body.leaseOwner).toBe('w1')
  })

  it('begin on a completed run returns the run without granting a new lease', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`, undefined, { 'x-tidebase-worker': 'w1' })
    await api(app, 'POST', `/runs/${run.id}/complete`, { result: { ok: true } })

    const replay = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w2'
    })
    expect(replay.status).toBe(200)
    expect(replay.body.run.status).toBe('completed')
    expect(replay.body.run.result).toEqual({ ok: true })
    expect(replay.body.run.leaseOwner).toBeNull()
  })
})

describe('resume decision classification (server-side default)', () => {
  async function failStep(options: Record<string, unknown>, retryable: boolean) {
    const run = await createRun(app)
    const begin = await beginStep(run.id, 'effectful', { leaseOwner: 'w1', options })
    const fail = await api(app, 'POST', `/runs/${run.id}/steps/${begin.body.step.id}/fail`, {
      leaseOwner: 'w1',
      error: { message: 'boom' },
      retryable
    })
    const detail = await getRunDetail(app, run.id)
    const failedEvent = detail.events.find((event: any) => event.type === 'step.failed')
    return { step: fail.body.step, event: failedEvent }
  }

  it('unkeyed external side effects park the step in manual_review', async () => {
    const { step, event } = await failStep({ sideEffects: ['email:send'] }, false)
    expect(step.status).toBe('manual_review')
    expect(event.payload.resumeDecision).toBe('manual_review')
  })

  it('an idempotency key makes the same failure safe to replay', async () => {
    const { step, event } = await failStep(
      { sideEffects: ['email:send'], idempotencyKey: 'order-1' },
      false
    )
    expect(step.status).toBe('failed')
    expect(event.payload.resumeDecision).toBe('safe_replay')
  })

  it('read-only steps default to safe_replay', async () => {
    const { event } = await failStep({ sideEffects: ['read'] }, false)
    expect(event.payload.resumeDecision).toBe('safe_replay')
  })

  it('retryable failures are marked failed_retryable regardless of contract', async () => {
    const { step, event } = await failStep({ sideEffects: ['email:send'] }, true)
    expect(step.status).toBe('failed_retryable')
    expect(event.payload.resumeDecision).toBe('auto_retry')
  })

  it('replay: never fails hard', async () => {
    const { step, event } = await failStep({ replay: 'never' }, false)
    expect(step.status).toBe('failed')
    expect(event.payload.resumeDecision).toBe('fail_hard')
  })
})
