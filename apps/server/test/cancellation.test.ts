import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { reconcileTick } from '../src/reconciler'
import { api, createRun, getRunDetail } from './helpers'

const app = createApp()

// Invariants: cancellation is authoritative, one-way, idempotent, observable
// at every worker boundary, and impossible to miss because user code skipped
// a cleanup branch.

describe('cancellation lifecycle', () => {
  it('cancels a pending run immediately and idempotently', async () => {
    const run = await createRun(app)
    const first = await api(app, 'POST', `/runs/${run.id}/cancel`, {
      reason: 'operator request',
      actor: 'yao'
    })
    expect(first.status).toBe(200)
    expect(first.body.run.status).toBe('cancelled')
    expect(first.body.run.cancelReason).toBe('operator request')

    const second = await api(app, 'POST', `/runs/${run.id}/cancel`, {})
    expect(second.status).toBe(200)
    expect(second.body.run.status).toBe('cancelled')
    expect(second.body.run.cancelReason).toBe('operator request') // unchanged

    const detail = await getRunDetail(app, run.id)
    expect(detail.events.some((e: any) => e.type === 'run.cancelled')).toBe(true)
  })

  it('blocks new steps, gates, and run begin on a cancelled run', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`)
    await api(app, 'POST', `/runs/${run.id}/cancel`, { reason: 'stop' })

    const step = await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 'next-step',
      inputHash: 'h',
      leaseOwner: 'w1'
    })
    expect(step.body.action).toBe('cancelled')

    const gate = await api(app, 'POST', `/runs/${run.id}/gates/begin`, {
      name: 'approve',
      prompt: 'ok?'
    })
    expect(gate.status).toBe(409)
    expect(gate.body.code).toBe('run_cancelled')

    const begin = await api(app, 'POST', `/runs/${run.id}/begin`)
    expect(begin.status).toBe(409)
    expect(begin.body.code).toBe('run_cancelled')
  })

  it('never resurrects a cancelled run via complete or fail', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`)
    await api(app, 'POST', `/runs/${run.id}/cancel`, {})

    const complete = await api(app, 'POST', `/runs/${run.id}/complete`, { result: 42 })
    expect(complete.body.run.status).toBe('cancelled')

    const fail = await api(app, 'POST', `/runs/${run.id}/fail`, { error: { message: 'x' } })
    expect(fail.body.run.status).toBe('cancelled')
  })

  it('cancelling a completed run is a refused no-op', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`)
    await api(app, 'POST', `/runs/${run.id}/complete`, { result: 'done' })
    const res = await api(app, 'POST', `/runs/${run.id}/cancel`, {})
    expect(res.status).toBe(409)
    expect(res.body.run.status).toBe('completed')
  })

  it('gate polling exposes the run status so a waiting worker can unwind', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`)
    const gate = await api(app, 'POST', `/runs/${run.id}/gates/begin`, {
      name: 'wait-here',
      prompt: 'pending decision'
    })
    await api(app, 'POST', `/runs/${run.id}/cancel`, {})
    const poll = await api(app, 'GET', `/runs/${run.id}/gates/${gate.body.gate.id}`)
    expect(poll.body.runStatus).toBe('cancelled')
  })

  it('reconciler cancels runs past their deadline with reason "deadline"', async () => {
    const enqueue = await api(app, 'POST', '/queues/deadline-q/enqueue', {
      workflowName: 'slow-workflow',
      deadlineMs: 1 // already overdue by the time the tick runs
    })
    expect(enqueue.status).toBe(200)
    await new Promise((r) => setTimeout(r, 5))
    const report = await reconcileTick()
    expect(report).not.toBeNull()
    expect(report!.cancelledByDeadline).toBeGreaterThanOrEqual(1)
    const detail = await getRunDetail(app, enqueue.body.run.id)
    expect(detail.run.status).toBe('cancelled')
    expect(detail.run.cancelReason).toBe('deadline')
  })
})
