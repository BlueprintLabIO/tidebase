import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { nextFire, parseCron } from '../src/cron'
import { reconcileTick } from '../src/reconciler'
import { pool } from '../src/db'
import { api } from './helpers'

const app = createApp()

describe('cron parser', () => {
  it('computes standard next-fire times in UTC', () => {
    const from = new Date('2026-06-12T10:30:30Z')
    expect(nextFire('* * * * *', from).toISOString()).toBe('2026-06-12T10:31:00.000Z')
    expect(nextFire('0 * * * *', from).toISOString()).toBe('2026-06-12T11:00:00.000Z')
    expect(nextFire('*/15 * * * *', from).toISOString()).toBe('2026-06-12T10:45:00.000Z')
    expect(nextFire('0 9 * * *', from).toISOString()).toBe('2026-06-13T09:00:00.000Z')
    expect(nextFire('0 0 1 * *', from).toISOString()).toBe('2026-07-01T00:00:00.000Z')
    // 2026-06-12 is a Friday; next Monday is the 15th
    expect(nextFire('30 8 * * 1', from).toISOString()).toBe('2026-06-15T08:30:00.000Z')
    // 7 means Sunday, same as 0
    expect(nextFire('0 0 * * 7', from).toISOString()).toBe('2026-06-14T00:00:00.000Z')
  })

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/)
    expect(() => parseCron('61 * * * *')).toThrow(/invalid cron value/)
    expect(() => parseCron('* * * * 9')).toThrow(/invalid cron value/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid cron step/)
  })
})

describe('schedules', () => {
  it('a due schedule enqueues exactly once even across concurrent ticks', async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`
    const queue = `sq-${randomUUID().slice(0, 8)}`
    const put = await api(app, 'PUT', `/schedules/${name}`, {
      cron: '* * * * *',
      workflowName: 'scheduled-wf',
      queue,
      input: { from: 'cron' }
    })
    expect(put.status).toBe(200)
    // force it due
    await pool.query(`update schedules set next_run_at = now() - interval '1 minute' where name = $1`, [name])

    // Two replicas tick at once: the advisory lock serializes them, and the
    // fire-time dedupe key makes a double enqueue structurally impossible.
    await Promise.all([reconcileTick(), reconcileTick()])
    // run a third tick to prove the advanced next_run_at prevents refiring
    await reconcileTick()

    const runs = await pool.query(
      `select * from runs where queue_name = $1 and workflow_name = 'scheduled-wf'`,
      [queue]
    )
    expect(runs.rows).toHaveLength(1)
    expect(runs.rows[0].dedupe_key).toMatch(new RegExp(`^sched:${name}:`))

    const after = await api(app, 'GET', '/schedules')
    const mine = after.body.schedules.find((s: any) => s.name === name)
    expect(new Date(mine.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(mine.lastEnqueuedAt).not.toBeNull()
  })

  it('rejects an invalid cron at write time and deletes cleanly', async () => {
    const name = `sched-${randomUUID().slice(0, 8)}`
    const bad = await api(app, 'PUT', `/schedules/${name}`, {
      cron: 'not a cron',
      workflowName: 'wf'
    })
    expect(bad.status).toBe(500) // parse error surfaces before persisting

    await api(app, 'PUT', `/schedules/${name}`, { cron: '0 9 * * *', workflowName: 'wf' })
    const del = await api(app, 'DELETE', `/schedules/${name}`)
    expect(del.body.deleted).toBe(name)
    const missing = await api(app, 'DELETE', `/schedules/${name}`)
    expect(missing.status).toBe(404)
  })

  it('push-mode queues dispatch signed run.invoke webhooks and back off redelivery', async () => {
    const queue = `pq-${randomUUID().slice(0, 8)}`
    // unreachable endpoint: delivery is recorded win-or-lose
    await api(app, 'PUT', `/queues/${queue}/config`, {
      invokeUrl: 'http://127.0.0.1:9/unreachable'
    })
    const enq = await api(app, 'POST', `/queues/${queue}/enqueue`, { workflowName: 'wf' })

    const report = await reconcileTick()
    expect(report!.invoked).toBeGreaterThanOrEqual(1)

    const attempts = await pool.query(
      `select * from recovery_attempts where run_id = $1`,
      [enq.body.run.id]
    )
    expect(attempts.rows.length).toBe(1)
    expect(attempts.rows[0].reason).toBe('queue_dispatch')

    // still queued (the app never began it), but pushed beyond the horizon —
    // an immediate second tick must not double-dispatch
    const again = await reconcileTick()
    const attemptsAfter = await pool.query(
      `select count(*)::int as n from recovery_attempts where run_id = $1`,
      [enq.body.run.id]
    )
    expect(attemptsAfter.rows[0].n).toBe(1)
    expect(again).not.toBeNull()
  })
})
