// The reconciler is Tidebase's only background loop. One tick, serialized
// across replicas by an advisory lock, handles:
//   1. expired run leases  → queue runs requeue (or fail at max attempts);
//                            webhook runs get a recovery dispatch
//   2. deadlines           → overdue runs are cancelled (reason 'deadline')
//   3. due cron schedules  → enqueued with a dedupe key derived from the fire
//                            time, so a double-fire is structurally impossible
//   4. push-mode queues    → ready runs are dispatched to the queue's
//                            invokeUrl as signed run.invoke webhooks
// Tidebase still never executes user code: every path here either updates
// lifecycle state in Postgres or fires a signed HTTP invocation at YOUR app.
import { defaultContext, type ServerContext } from './context.js'
import { appendEvent } from './events.js'
import { dispatchRecovery, mapRun, retryBackoffMs } from './app.js'
import { nextFire } from './cron.js'

const TICK_LOCK = 0x74646202 // 'tdb' 02
const tickMs = Number(process.env.TIDEBASE_RECONCILE_MS ?? 5_000)

export type TickReport = {
  requeued: number
  failed: number
  recovered: number
  cancelledByDeadline: number
  scheduled: number
  invoked: number
}

export async function reconcileTick(
  now = new Date(),
  ctx: ServerContext = defaultContext()
): Promise<TickReport | null> {
  const lockClient = await ctx.pool.connect()
  const report: TickReport = {
    requeued: 0,
    failed: 0,
    recovered: 0,
    cancelledByDeadline: 0,
    scheduled: 0,
    invoked: 0
  }
  try {
    const lock = await lockClient.query('select pg_try_advisory_lock($1) as ok', [TICK_LOCK])
    if (!lock.rows[0].ok) return null // another replica is ticking

    await sweepExpiredLeases(ctx, report, now)
    await sweepDeadlines(ctx, report, now)
    await sweepSchedules(ctx, report, now)
    await sweepPushQueues(ctx, report, now)
    return report
  } finally {
    await lockClient.query('select pg_advisory_unlock($1)', [TICK_LOCK]).catch(() => undefined)
    lockClient.release()
  }
}

async function sweepExpiredLeases(ctx: ServerContext, report: TickReport, now: Date) {
  // Only actionable rows: a plain run (no queue, no recovery webhook) is
  // deliberately left running-with-expired-lease for manual takeover, so it
  // must not occupy the sweep window — otherwise enough of them permanently
  // starve the limit-100 sweep and queue/webhook runs are never reclaimed.
  const expired = await ctx.pool.query(
    `select * from runs
     where status = 'running' and lease_expires_at is not null and lease_expires_at < $1
       and (queue_name is not null or recovery_webhook is not null)
     order by lease_expires_at
     limit 100`,
    [now]
  )
  for (const row of expired.rows) {
    if (row.queue_name) {
      if (Number(row.attempt) < Number(row.max_attempts)) {
        await ctx.tx(async (client) => {
          const update = await client.query(
            `update runs
             set status = 'queued', lease_owner = null, lease_expires_at = null,
                 run_at = now() + ($2 || ' milliseconds')::interval, updated_at = now()
             where id = $1 and status = 'running' and lease_expires_at < $3
             returning *`,
            [row.id, retryBackoffMs(Number(row.attempt)), now]
          )
          if (update.rows[0]) {
            await appendEvent(client, row.id, 'run.requeued', {
              reason: 'lease_expired',
              attempt: Number(row.attempt),
              maxAttempts: Number(row.max_attempts)
            })
            report.requeued += 1
          }
        })
      } else {
        await ctx.tx(async (client) => {
          const update = await client.query(
            `update runs
             set status = 'failed', failure_class = 'max_retries',
                 error_json = $2, lease_owner = null, lease_expires_at = null, updated_at = now()
             where id = $1 and status = 'running' and lease_expires_at < $3
             returning *`,
            [row.id, JSON.stringify({ message: 'lease expired with no attempts remaining' }), now]
          )
          if (update.rows[0]) {
            await appendEvent(client, row.id, 'run.failed', {
              failureClass: 'max_retries',
              reason: 'lease_expired'
            })
            report.failed += 1
          }
        })
      }
    } else if (row.recovery_webhook) {
      // Non-queue stalled run: nudge the owning app over its recovery
      // webhook, throttled to one attempt per lease window.
      const recent = await ctx.pool.query(
        `select 1 from recovery_attempts
         where run_id = $1 and created_at > now() - interval '60 seconds'
         limit 1`,
        [row.id]
      )
      if (!recent.rows[0]) {
        await dispatchRecovery(ctx, mapRun(row), 'lease_expired')
        report.recovered += 1
      }
    }
  }
}

async function sweepDeadlines(ctx: ServerContext, report: TickReport, now: Date) {
  const overdue = await ctx.pool.query(
    `select id from runs
     where deadline_at is not null and deadline_at < $1 and status in ('pending', 'queued', 'running')
     limit 100`,
    [now]
  )
  for (const row of overdue.rows) {
    await ctx.tx(async (client) => {
      const update = await client.query(
        `update runs
         set status = 'cancelled', cancelled_at = now(), cancel_requested_at = now(),
             cancel_reason = 'deadline', lease_owner = null, lease_expires_at = null,
             completed_at = now(), updated_at = now()
         where id = $1 and status in ('pending', 'queued', 'running')
         returning *`,
        [row.id]
      )
      if (update.rows[0]) {
        await appendEvent(client, row.id, 'run.cancelled', { reason: 'deadline', actor: 'reconciler' })
        report.cancelledByDeadline += 1
      }
    })
  }
}

async function sweepSchedules(ctx: ServerContext, report: TickReport, now: Date) {
  const due = await ctx.pool.query(
    `select * from schedules where enabled and next_run_at is not null and next_run_at <= $1`,
    [now]
  )
  for (const schedule of due.rows) {
    const fireTime = new Date(schedule.next_run_at).toISOString()
    // The dedupe key carries the fire time: even if two replicas raced past
    // the advisory lock, only one enqueue can win.
    try {
      await ctx.tx(async (client) => {
        await client.query(
          `insert into runs (workflow_name, input_json, status, queue_name, dedupe_key, run_at, max_attempts, metadata_json)
           values ($1, $2, 'queued', $3, $4, now(), $5, $6)`,
          [
            schedule.workflow_name,
            JSON.stringify(schedule.input_json ?? {}),
            schedule.queue_name,
            `sched:${schedule.name}:${fireTime}`,
            schedule.max_attempts,
            JSON.stringify({ schedule: schedule.name, fireTime })
          ]
        )
        report.scheduled += 1
      })
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error // dedupe hit = already fired
    }
    await ctx.pool.query(
      `update schedules set last_enqueued_at = now(), next_run_at = $2, updated_at = now() where name = $1`,
      [schedule.name, nextFire(schedule.cron, now)]
    )
  }
}

async function sweepPushQueues(ctx: ServerContext, report: TickReport, now: Date) {
  const pushQueues = await ctx.pool.query(`select * from queue_configs where invoke_url is not null`)
  for (const config of pushQueues.rows) {
    let capacity = 10
    if (config.concurrency != null) {
      const running = await ctx.pool.query(
        `select count(*)::int as n from runs where queue_name = $1 and status = 'running'`,
        [config.name]
      )
      capacity = Math.min(capacity, Math.max(0, config.concurrency - running.rows[0].n))
    }
    if (capacity <= 0) continue
    const ready = await ctx.pool.query(
      `select * from runs
       where queue_name = $1 and status = 'queued' and run_at <= $2
       order by priority desc, run_at asc
       limit $3`,
      [config.name, now, capacity]
    )
    for (const row of ready.rows) {
      // Push the redelivery horizon forward BEFORE dispatching so a slow
      // endpoint can't cause a duplicate dispatch on the next tick. The run
      // stays 'queued' until the app's webhook handler begins it.
      await ctx.pool.query(`update runs set run_at = now() + interval '60 seconds' where id = $1`, [
        row.id
      ])
      await dispatchRecovery(ctx, mapRun(row), 'queue_dispatch', 'run.invoke', config.invoke_url)
      report.invoked += 1
    }
  }
}

export function startReconciler(ctx: ServerContext = defaultContext()) {
  if (process.env.TIDEBASE_RECONCILER === '0') return
  const timer = setInterval(() => {
    reconcileTick(new Date(), ctx).catch((error) => console.error('reconciler tick failed:', error))
  }, tickMs)
  timer.unref?.()
  return timer
}
