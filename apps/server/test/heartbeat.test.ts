import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { api, createRun, getRunDetail, sleep } from './helpers'

// Lease duration is read at module load, so it must be set before importing the app.
process.env.TIDEBASE_LEASE_MS = '250'
const { createApp } = await import('../src/app')
const { reconcileTick } = await import('../src/reconciler')

const app = createApp()

// Heartbeat is extend-only lease renewal for session-shaped runs: it must
// keep a live session owned indefinitely, it must never resurrect a lost
// lease, and it must stay invisible in the audit trail (no attempt bumps,
// no run.started spam).

describe('run lease heartbeat', () => {
  it('keeps a session alive past the lease window without polluting the event log', async () => {
    const run = await createRun(app)
    const begin = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w1'
    })
    expect(begin.status).toBe(200)

    // Outlive the 250ms lease on heartbeats alone.
    for (let i = 0; i < 3; i += 1) {
      await sleep(150)
      const hb = await api(app, 'POST', `/runs/${run.id}/heartbeat`, { leaseOwner: 'w1' })
      expect(hb.status).toBe(200)
      expect(hb.body.run.status).toBe('running')
    }

    // Another worker still cannot take over: the lease is genuinely extended.
    const takeover = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w2'
    })
    expect(takeover.status).toBe(409)

    const detail = await getRunDetail(app, run.id)
    const started = detail.events.filter((e: { type: string }) => e.type === 'run.started')
    expect(started).toHaveLength(1)
  })

  it('rejects a heartbeat from a worker that does not own the lease', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`, undefined, { 'x-tidebase-worker': 'w1' })

    const hb = await api(app, 'POST', `/runs/${run.id}/heartbeat`, { leaseOwner: 'w2' })
    expect(hb.status).toBe(409)
    expect(hb.body.code).toBe('lease_lost')
  })

  it('a zombie cannot heartbeat its way back after a takeover', async () => {
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/begin`, undefined, { 'x-tidebase-worker': 'w1' })

    await sleep(400)
    const takeover = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w2'
    })
    expect(takeover.status).toBe(200)

    const stale = await api(app, 'POST', `/runs/${run.id}/heartbeat`, { leaseOwner: 'w1' })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('lease_lost')
  })

  it('a stopped heartbeat lets the reconciler reclaim a queued run, fencing the old owner', async () => {
    const queue = `q-${randomUUID().slice(0, 8)}`
    const enq = await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      maxAttempts: 3
    })
    const claim = await api(app, 'POST', '/queues/claim', {
      queues: [queue],
      leaseOwner: 'w1'
    })
    const runId = claim.body.runs[0].id

    // Heartbeats keep it claimed; the reconciler must not touch a live session.
    await sleep(150)
    await api(app, 'POST', `/runs/${runId}/heartbeat`, { leaseOwner: claim.body.leaseOwner })
    await reconcileTick()
    expect((await getRunDetail(app, runId)).run.status).toBe('running')

    // The worker dies: heartbeats stop, the lease expires, the reconciler requeues.
    await sleep(400)
    await reconcileTick()
    expect((await getRunDetail(app, runId)).run.status).toBe('queued')

    const stale = await api(app, 'POST', `/runs/${runId}/heartbeat`, {
      leaseOwner: claim.body.leaseOwner
    })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('lease_lost')

    expect(enq.status).toBe(200)
  })

  it('heartbeat on a cancelled run reports run_cancelled, not lease_lost', async () => {
    const run = await createRun(app)
    const begin = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w1'
    })
    expect(begin.status).toBe(200)

    await api(app, 'POST', `/runs/${run.id}/cancel`, { reason: 'test' })

    const hb = await api(app, 'POST', `/runs/${run.id}/heartbeat`, { leaseOwner: 'w1' })
    expect(hb.status).toBe(409)
    expect(hb.body.code).toBe('run_cancelled')
  })
})
