import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { reconcileTick } from '../src/reconciler'
import { pool } from '../src/db'
import { api, getRunDetail } from './helpers'

const app = createApp()

// A queued job IS a run: enqueue creates status='queued', claim transitions
// it to 'running' under the existing lease machinery. Invariants: dedupe is
// exact under contention, claims are exclusive, caps hold, retries requeue
// with backoff, and exhausting attempts classifies as max_retries.

const q = () => `q-${randomUUID().slice(0, 8)}`

describe('queue primitive', () => {
  it('enqueue → claim → complete walks the queued/running/completed lifecycle', async () => {
    const queue = q()
    const enq = await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      input: { n: 1 }
    })
    expect(enq.body.run.status).toBe('queued')
    expect(enq.body.run.queue).toBe(queue)

    const claim = await api(app, 'POST', '/queues/claim', { queues: [queue], leaseOwner: 'w1' })
    expect(claim.body.runs).toHaveLength(1)
    expect(claim.body.runs[0].status).toBe('running')

    const done = await api(app, 'POST', `/runs/${claim.body.runs[0].id}/complete`, { result: 1 })
    expect(done.body.run.status).toBe('completed')
  })

  it('dedupe: concurrent enqueues with one key produce exactly one active run', async () => {
    const queue = q()
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(app, 'POST', `/queues/${queue}/enqueue`, {
          workflowName: 'wf',
          dedupeKey: 'once'
        })
      )
    )
    const ids = new Set(results.map((r) => r.body.run.id))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.body.deduplicated).length).toBe(5)

    // a terminal run frees the key
    const claim = await api(app, 'POST', '/queues/claim', { queues: [queue] })
    await api(app, 'POST', `/runs/${claim.body.runs[0].id}/complete`, {})
    const again = await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      dedupeKey: 'once'
    })
    expect(again.body.deduplicated).toBe(false)
  })

  it('delayed jobs are invisible to claim until run_at', async () => {
    const queue = q()
    await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      delayMs: 60_000
    })
    const claim = await api(app, 'POST', '/queues/claim', { queues: [queue] })
    expect(claim.body.runs).toHaveLength(0)
  })

  it('two concurrent claimers never get the same run', async () => {
    const queue = q()
    for (let i = 0; i < 6; i += 1) {
      await api(app, 'POST', `/queues/${queue}/enqueue`, { workflowName: 'wf', input: { i } })
    }
    const [a, b] = await Promise.all([
      api(app, 'POST', '/queues/claim', { queues: [queue], leaseOwner: 'wa', limit: 3 }),
      api(app, 'POST', '/queues/claim', { queues: [queue], leaseOwner: 'wb', limit: 3 })
    ])
    const idsA = a.body.runs.map((r: any) => r.id)
    const idsB = b.body.runs.map((r: any) => r.id)
    expect(idsA.length + idsB.length).toBe(6)
    expect(new Set([...idsA, ...idsB]).size).toBe(6)
  })

  it('per-queue concurrency cap holds across claims', async () => {
    const queue = q()
    await api(app, 'PUT', `/queues/${queue}/config`, { concurrency: 1 })
    await api(app, 'POST', `/queues/${queue}/enqueue`, { workflowName: 'wf', input: { i: 1 } })
    await api(app, 'POST', `/queues/${queue}/enqueue`, { workflowName: 'wf', input: { i: 2 } })

    const first = await api(app, 'POST', '/queues/claim', { queues: [queue], limit: 5 })
    expect(first.body.runs).toHaveLength(1)
    const blocked = await api(app, 'POST', '/queues/claim', { queues: [queue], limit: 5 })
    expect(blocked.body.runs).toHaveLength(0)

    await api(app, 'POST', `/runs/${first.body.runs[0].id}/complete`, {})
    const next = await api(app, 'POST', '/queues/claim', { queues: [queue], limit: 5 })
    expect(next.body.runs).toHaveLength(1)
  })

  it('a failed claim retries with backoff, then classifies max_retries', async () => {
    const queue = q()
    const enq = await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      maxAttempts: 2
    })
    const runId = enq.body.run.id

    const claim1 = await api(app, 'POST', '/queues/claim', { queues: [queue] })
    const fail1 = await api(app, 'POST', `/runs/${runId}/fail`, { error: { message: 'boom' } })
    expect(fail1.body.requeued).toBe(true)
    expect(fail1.body.run.status).toBe('queued')
    expect(new Date(fail1.body.run.runAt).getTime()).toBeGreaterThan(Date.now())

    // pull the retry forward and claim again
    await pool.query(`update runs set run_at = now() where id = $1`, [runId])
    const claim2 = await api(app, 'POST', '/queues/claim', { queues: [queue] })
    expect(claim2.body.runs).toHaveLength(1)

    const fail2 = await api(app, 'POST', `/runs/${runId}/fail`, { error: { message: 'boom' } })
    expect(fail2.body.requeued).toBe(false)
    expect(fail2.body.run.status).toBe('failed')
    expect(fail2.body.run.failureClass).toBe('max_retries')

    const detail = await getRunDetail(app, runId)
    expect(detail.events.some((e: any) => e.type === 'run.requeued')).toBe(true)
    expect(claim1.body.runs).toHaveLength(1)
  })

  it('reconciler requeues an expired-lease queue run and fails it at max attempts', async () => {
    const queue = q()
    const enq = await api(app, 'POST', `/queues/${queue}/enqueue`, {
      workflowName: 'wf',
      maxAttempts: 2
    })
    const runId = enq.body.run.id
    await api(app, 'POST', '/queues/claim', { queues: [queue], leaseOwner: 'dead-worker' })
    // worker dies: expire the lease manually
    await pool.query(`update runs set lease_expires_at = now() - interval '1 second' where id = $1`, [runId])

    const report1 = await reconcileTick()
    expect(report1!.requeued).toBeGreaterThanOrEqual(1)
    let detail = await getRunDetail(app, runId)
    expect(detail.run.status).toBe('queued')

    await pool.query(`update runs set run_at = now() where id = $1`, [runId])
    await api(app, 'POST', '/queues/claim', { queues: [queue], leaseOwner: 'dead-worker-2' })
    await pool.query(`update runs set lease_expires_at = now() - interval '1 second' where id = $1`, [runId])

    const report2 = await reconcileTick()
    expect(report2!.failed).toBeGreaterThanOrEqual(1)
    detail = await getRunDetail(app, runId)
    expect(detail.run.status).toBe('failed')
    expect(detail.run.failureClass).toBe('max_retries')
  })

  it('queue stats report depth per lifecycle state', async () => {
    const queue = q()
    await api(app, 'POST', `/queues/${queue}/enqueue`, { workflowName: 'wf' })
    const stats = await api(app, 'GET', '/queues')
    const mine = stats.body.queues.find((x: any) => x.name === queue)
    expect(mine.queued).toBe(1)
  })
})
