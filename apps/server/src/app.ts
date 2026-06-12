import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { appendEvent, listEvents, subscribe } from './events.js'
import { nextFire, parseCron } from './cron.js'

const leaseMs = Number(process.env.TIDEBASE_LEASE_MS ?? 60_000)
const webhookSecret = process.env.TIDEBASE_WEBHOOK_SECRET
const publicUrl = (process.env.TIDEBASE_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 7373}`).replace(/\/$/, '')

function timingSafeEqualString(a: string, b: string) {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

const jsonRecord = z.record(z.string(), z.unknown())
const channelSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.string()).optional()
})

const createRunSchema = z.object({
  input: z.unknown().optional(),
  metadata: jsonRecord.optional(),
  recoveryWebhook: z.string().url().optional(),
  channels: z.array(channelSchema).optional()
})

const beginStepSchema = z.object({
  name: z.string().min(1),
  inputHash: z.string().min(1),
  input: z.unknown().optional(),
  options: jsonRecord.optional(),
  leaseOwner: z.string().optional()
})

const completeStepSchema = z.object({
  leaseOwner: z.string(),
  output: z.unknown().optional()
})

const failStepSchema = z.object({
  leaseOwner: z.string(),
  error: z.unknown(),
  retryable: z.boolean().optional(),
  resumeDecision: z.enum(['auto_retry', 'safe_replay', 'manual_review', 'fail_hard']).optional()
})

const stateSchema = z.object({
  value: z.unknown(),
  stream: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  reason: z.string().optional(),
  importance: z.enum(['transient', 'normal', 'checkpoint', 'milestone']).optional(),
  metadata: jsonRecord.optional(),
  createdBy: z.string().optional()
})

const stateSaveSchema = z.object({
  stream: z.string().min(1).optional(),
  label: z.string().min(1),
  reason: z.string().optional(),
  importance: z.enum(['transient', 'normal', 'checkpoint', 'milestone']).optional(),
  metadata: jsonRecord.optional(),
  createdBy: z.string().optional()
})

const snapshotSchema = z.object({
  label: z.string().min(1),
  target: z.object({
    type: z.string().min(1),
    id: z.string().min(1)
  }).optional(),
  state: z.unknown(),
  reason: z.string().optional(),
  metadata: jsonRecord.optional(),
  createdBy: z.string().optional()
})

const createChildRunSchema = z.object({
  name: z.string().min(1),
  workflowName: z.string().min(1),
  input: z.unknown().optional(),
  metadata: jsonRecord.optional(),
  recoveryWebhook: z.string().url().optional(),
  channels: z.array(channelSchema).optional(),
  edgeType: z.string().min(1).optional(),
  edgeMetadata: jsonRecord.optional()
})

const usageSchema = z.object({
  stepId: z.string().optional(),
  kind: z.string().min(1).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  label: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  metadata: jsonRecord.optional()
})

const gateBeginSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  data: z.unknown().optional(),
  channels: z.array(channelSchema).optional(),
  capability: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional()
})

const gateResolveSchema = z.object({
  token: z.string().min(1),
  decision: z.enum(['approved', 'rejected', 'canceled']),
  actor: z.string().optional(),
  payload: z.unknown().optional()
})

const cancelRunSchema = z.object({
  reason: z.string().optional(),
  actor: z.string().optional()
})

const enqueueSchema = z.object({
  workflowName: z.string().min(1),
  input: z.unknown().optional(),
  metadata: jsonRecord.optional(),
  recoveryWebhook: z.string().url().optional(),
  channels: z.array(channelSchema).optional(),
  dedupeKey: z.string().min(1).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  runAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().positive().optional(),
  priority: z.number().int().optional(),
  deadlineMs: z.number().int().positive().optional()
})

const claimSchema = z.object({
  queues: z.array(z.string().min(1)).min(1),
  leaseOwner: z.string().optional(),
  limit: z.number().int().positive().max(100).optional()
})

const queueConfigSchema = z.object({
  concurrency: z.number().int().positive().nullable().optional(),
  ratePerMinute: z.number().int().positive().nullable().optional(),
  invokeUrl: z.string().url().nullable().optional()
})

const scheduleSchema = z.object({
  cron: z.string().min(1),
  workflowName: z.string().min(1),
  input: z.unknown().optional(),
  queue: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive().optional(),
  enabled: z.boolean().optional()
})

export function retryBackoffMs(attempt: number) {
  // 5s, 10s, 20s, … capped at 5 minutes
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt - 1))
}

export type CreateAppOptions = {
  apiKey?: string
}

export function createApp(options: CreateAppOptions = {}) {
  const apiKey = options.apiKey ?? process.env.TIDEBASE_API_KEY
  const app = new Hono()
  app.use('*', cors())
  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'invalid request body', issues: error.issues }, 400)
    }
    console.error(error)
    return c.json({ error: 'internal server error' }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true }))

  // Shared-token auth: opt-in by setting TIDEBASE_API_KEY. /health stays open
  // for probes. The SSE endpoint also accepts ?token= because EventSource
  // cannot set request headers.
  if (apiKey) {
    app.use('*', async (c, next) => {
      const header = c.req.header('authorization')
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
      const isEventStream = /^\/runs\/[^/]+\/events$/.test(c.req.path)
      const candidate = bearer ?? (isEventStream ? c.req.query('token') ?? null : null)
      if (!candidate || !timingSafeEqualString(candidate, apiKey)) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      await next()
    })
  }

  app.post('/runs/:workflowName', async (c) => {
    const workflowName = c.req.param('workflowName')
    const body = createRunSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const runResult = await client.query(
        `insert into runs (workflow_name, input_json, metadata_json, recovery_webhook)
         values ($1, $2, $3, $4)
         returning *`,
        [
          workflowName,
          json(body.input ?? {}),
          json(body.metadata ?? {}),
          body.recoveryWebhook ?? null
        ]
      )
      const run = mapRun(runResult.rows[0])
      for (const channel of body.channels ?? []) {
        await client.query(
          `insert into channels (run_id, type, config_json, events_json)
           values ($1, $2, $3, $4)`,
          [
            run.id,
            channel.type,
            json({ url: channel.url, secret: channel.secret ?? null }),
            json(channel.events ?? [])
          ]
        )
      }
      await appendEvent(client, run.id, 'run.created', {
        workflowName,
        input: body.input ?? {},
        channels: body.channels?.map((channel) => ({
          type: channel.type,
          url: channel.url,
          events: channel.events ?? []
        })) ?? []
      })
      return run
    })
    return c.json({ run: result })
  })

  app.get('/runs', async (c) => {
    const result = await pool.query(
      'select * from runs order by created_at desc limit 100'
    )
    return c.json({ runs: result.rows.map(mapRun) })
  })

  // ---- lifecycle: cancellation ----------------------------------------
  // Cancellation is authoritative and one-way: status flips to 'cancelled'
  // immediately (externally observable), in-flight workers discover it at
  // their next step/gate boundary, and complete/fail can never resurrect a
  // cancelled run. Idempotent: cancelling twice returns the same run.
  app.post('/runs/:runId/cancel', async (c) => {
    const runId = c.req.param('runId')
    const body = cancelRunSchema.parse(await c.req.json().catch(() => ({})))
    const result = await tx(async (client) => {
      const existing = await client.query('select * from runs where id = $1 for update', [runId])
      const row = existing.rows[0]
      if (!row) return null
      if (row.status === 'cancelled') return { run: mapRun(row), deliveries: [] as QueuedChannelDelivery[], already: true }
      if (row.status === 'completed') {
        return { run: mapRun(row), deliveries: [] as QueuedChannelDelivery[], terminal: true }
      }
      const update = await client.query(
        `update runs
         set status = 'cancelled',
             cancel_requested_at = coalesce(cancel_requested_at, now()),
             cancelled_at = now(),
             cancel_reason = $2,
             cancel_actor = $3,
             lease_owner = null,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
         where id = $1
         returning *`,
        [runId, body.reason ?? null, body.actor ?? null]
      )
      const run = mapRun(update.rows[0])
      await appendEvent(client, runId, 'run.cancelled', {
        reason: body.reason ?? null,
        actor: body.actor ?? null
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'run.cancelled', { run })
      return { run, deliveries }
    })
    if (!result) return c.json({ error: 'run not found' }, 404)
    if ('terminal' in result) {
      return c.json({ error: 'run already completed', run: result.run }, 409)
    }
    await dispatchChannelDeliveries(result.deliveries)
    return c.json({ run: result.run })
  })

  // ---- queues -----------------------------------------------------------
  // A queued job IS a run (status 'queued'): one lifecycle authority, no
  // parallel job table to drift. Dedupe is enforced by a partial unique
  // index over active runs.
  app.post('/queues/:queue/enqueue', async (c) => {
    const queue = c.req.param('queue')
    const body = enqueueSchema.parse(await c.req.json())
    const runAt = body.runAt
      ? new Date(body.runAt)
      : new Date(Date.now() + (body.delayMs ?? 0))
    const deadlineAt = body.deadlineMs ? new Date(Date.now() + body.deadlineMs) : null
    try {
      const result = await tx(async (client) => {
        const inserted = await client.query(
          `insert into runs (workflow_name, input_json, metadata_json, recovery_webhook,
                             status, queue_name, dedupe_key, priority, run_at, max_attempts, deadline_at)
           values ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10)
           returning *`,
          [
            body.workflowName,
            json(body.input ?? {}),
            json(body.metadata ?? {}),
            body.recoveryWebhook ?? null,
            queue,
            body.dedupeKey ?? null,
            body.priority ?? 0,
            runAt,
            body.maxAttempts ?? 1,
            deadlineAt
          ]
        )
        const run = mapRun(inserted.rows[0])
        for (const channel of body.channels ?? []) {
          await client.query(
            `insert into channels (run_id, type, config_json, events_json)
             values ($1, $2, $3, $4)`,
            [
              run.id,
              channel.type,
              json({ url: channel.url, secret: channel.secret ?? null }),
              json(channel.events ?? [])
            ]
          )
        }
        await appendEvent(client, run.id, 'run.enqueued', { queue, runAt: runAt.toISOString() })
        return run
      })
      return c.json({ run: result, deduplicated: false })
    } catch (error) {
      if ((error as { code?: string }).code === '23505' && body.dedupeKey) {
        const existing = await pool.query(
          `select * from runs
           where queue_name = $1 and dedupe_key = $2 and status in ('queued', 'running')
           limit 1`,
          [queue, body.dedupeKey]
        )
        if (existing.rows[0]) {
          return c.json({ run: mapRun(existing.rows[0]), deduplicated: true })
        }
      }
      throw error
    }
  })

  // Pull-mode dispatch: claim ready queued runs with SKIP LOCKED, honoring
  // per-queue concurrency caps and rate limits. A claim acquires the run
  // lease directly, so worker death is handled by the existing lease-expiry
  // machinery (the reconciler requeues or fails it).
  app.post('/queues/claim', async (c) => {
    const body = claimSchema.parse(await c.req.json())
    const leaseOwner = body.leaseOwner ?? randomUUID()
    const limit = body.limit ?? 1
    const claimed: ReturnType<typeof mapRun>[] = []
    await tx(async (client) => {
      for (const queue of body.queues) {
        if (claimed.length >= limit) break
        // Serialize claims per queue so cap math can't race between claimers.
        await client.query(`select pg_advisory_xact_lock(hashtext('queue:' || $1))`, [queue])
        const configResult = await client.query('select * from queue_configs where name = $1', [queue])
        const config = configResult.rows[0]
        let capacity = limit - claimed.length
        if (config?.concurrency != null) {
          const running = await client.query(
            `select count(*)::int as n from runs where queue_name = $1 and status = 'running'`,
            [queue]
          )
          capacity = Math.min(capacity, Math.max(0, config.concurrency - running.rows[0].n))
        }
        if (config?.rate_per_minute != null) {
          const recent = await client.query(
            `select count(*)::int as n from runs
             where queue_name = $1 and claimed_at > now() - interval '1 minute'`,
            [queue]
          )
          capacity = Math.min(capacity, Math.max(0, config.rate_per_minute - recent.rows[0].n))
        }
        if (capacity <= 0) continue
        const ready = await client.query(
          `select id from runs
           where queue_name = $1 and status = 'queued' and run_at <= now()
           order by priority desc, run_at asc
           limit $2
           for update skip locked`,
          [queue, capacity]
        )
        for (const row of ready.rows) {
          const update = await client.query(
            `update runs
             set status = 'running',
                 lease_owner = $2,
                 lease_expires_at = now() + ($3 || ' milliseconds')::interval,
                 attempt = attempt + 1,
                 claimed_at = now(),
                 updated_at = now()
             where id = $1
             returning *`,
            [row.id, leaseOwner, leaseMs]
          )
          await appendEvent(client, row.id, 'run.claimed', { leaseOwner, queue })
          claimed.push(mapRun(update.rows[0]))
        }
      }
    })
    return c.json({ runs: claimed, leaseOwner })
  })

  app.get('/queues', async (c) => {
    const stats = await pool.query(
      `select queue_name,
              count(*) filter (where status = 'queued')::int as queued,
              count(*) filter (where status = 'running')::int as running,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'completed')::int as completed,
              count(*) filter (where status = 'cancelled')::int as cancelled
       from runs where queue_name is not null
       group by queue_name`
    )
    const configs = await pool.query('select * from queue_configs')
    const configByName = new Map(configs.rows.map((row) => [row.name, row]))
    const queues = stats.rows.map((row) => ({
      name: row.queue_name,
      queued: row.queued,
      running: row.running,
      failed: row.failed,
      completed: row.completed,
      cancelled: row.cancelled,
      config: mapQueueConfig(configByName.get(row.queue_name))
    }))
    for (const [name, config] of configByName) {
      if (!queues.some((q) => q.name === name)) {
        queues.push({
          name,
          queued: 0,
          running: 0,
          failed: 0,
          completed: 0,
          cancelled: 0,
          config: mapQueueConfig(config)
        })
      }
    }
    return c.json({ queues })
  })

  app.put('/queues/:queue/config', async (c) => {
    const queue = c.req.param('queue')
    const body = queueConfigSchema.parse(await c.req.json())
    const result = await pool.query(
      `insert into queue_configs (name, concurrency, rate_per_minute, invoke_url)
       values ($1, $2, $3, $4)
       on conflict (name) do update set
         concurrency = coalesce($2, queue_configs.concurrency),
         rate_per_minute = coalesce($3, queue_configs.rate_per_minute),
         invoke_url = coalesce($4, queue_configs.invoke_url),
         updated_at = now()
       returning *`,
      [queue, body.concurrency ?? null, body.ratePerMinute ?? null, body.invokeUrl ?? null]
    )
    return c.json({ config: mapQueueConfig(result.rows[0]) })
  })

  // ---- schedules ----------------------------------------------------------
  app.put('/schedules/:name', async (c) => {
    const name = c.req.param('name')
    const body = scheduleSchema.parse(await c.req.json())
    parseCron(body.cron) // validate before persisting
    const next = nextFire(body.cron, new Date())
    const result = await pool.query(
      `insert into schedules (name, cron, workflow_name, input_json, queue_name, max_attempts, enabled, next_run_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (name) do update set
         cron = $2, workflow_name = $3, input_json = $4, queue_name = $5,
         max_attempts = $6, enabled = $7, next_run_at = $8, updated_at = now()
       returning *`,
      [
        name,
        body.cron,
        body.workflowName,
        json(body.input ?? {}),
        body.queue ?? 'default',
        body.maxAttempts ?? 1,
        body.enabled ?? true,
        next
      ]
    )
    return c.json({ schedule: mapSchedule(result.rows[0]) })
  })

  app.get('/schedules', async (c) => {
    const result = await pool.query('select * from schedules order by name asc')
    return c.json({ schedules: result.rows.map(mapSchedule) })
  })

  app.delete('/schedules/:name', async (c) => {
    const result = await pool.query('delete from schedules where name = $1 returning name', [
      c.req.param('name')
    ])
    if (!result.rows[0]) return c.json({ error: 'schedule not found' }, 404)
    return c.json({ deleted: result.rows[0].name })
  })

  app.get('/runs/:runId', async (c) => {
    const runId = c.req.param('runId')
    const [runResult, stepsResult, stateResult, streamsResult, versionsResult, edgeResult, childRunsResult, recoveryResult, channelsResult, deliveriesResult, gatesResult, usageResult, events] = await Promise.all([
      pool.query('select * from runs where id = $1', [runId]),
      pool.query('select * from steps where run_id = $1 order by created_at asc', [
        runId
      ]),
      pool.query('select * from run_state where run_id = $1', [runId]),
      pool.query('select * from state_streams where run_id = $1 order by created_at asc', [runId]),
      pool.query(
        `select v.*
         from state_versions v
         join state_streams s on s.id = v.stream_id
         where s.run_id = $1
         order by s.name asc, v.version asc`,
        [runId]
      ),
      pool.query('select * from run_edges where parent_run_id = $1 order by created_at asc', [runId]),
      pool.query(
        `select r.*
         from runs r
         join run_edges e on e.child_run_id = r.id
         where e.parent_run_id = $1
         order by e.created_at asc`,
        [runId]
      ),
      pool.query(
        'select * from recovery_attempts where run_id = $1 order by created_at desc',
        [runId]
      ),
      pool.query('select * from channels where run_id = $1 order by created_at asc', [runId]),
      pool.query(
        'select * from channel_deliveries where run_id = $1 order by created_at desc limit 100',
        [runId]
      ),
      pool.query('select * from gates where run_id = $1 order by created_at asc', [runId]),
      pool.query('select * from usage_records where run_id = $1 order by created_at asc', [runId]),
      listEvents(runId)
    ])
    if (!runResult.rows[0]) return c.json({ error: 'run not found' }, 404)
    return c.json({
      run: mapRun(runResult.rows[0]),
      steps: stepsResult.rows.map(mapStep),
      state: stateResult.rows[0] ? mapState(stateResult.rows[0]) : null,
      stateStreams: streamsResult.rows.map(mapStateStream),
      stateVersions: versionsResult.rows.map(mapStateVersion),
      runEdges: edgeResult.rows.map(mapRunEdge),
      childRuns: childRunsResult.rows.map(mapRun),
      recoveryAttempts: recoveryResult.rows.map(mapRecoveryAttempt),
      channels: channelsResult.rows.map(mapChannel),
      channelDeliveries: deliveriesResult.rows.map(mapChannelDelivery),
      gates: gatesResult.rows.map(mapGate),
      usage: usageResult.rows.map(mapUsageRecord),
      events
    })
  })

  app.post('/runs/:runId/children', async (c) => {
    const parentRunId = c.req.param('runId')
    const body = createChildRunSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const parent = await client.query('select * from runs where id = $1 for update', [parentRunId])
      if (!parent.rows[0]) return null

      const existing = await client.query(
        `select
           r.*,
           e.id as edge_id,
           e.parent_run_id as edge_parent_run_id,
           e.child_run_id as edge_child_run_id,
           e.name as edge_name,
           e.edge_type as edge_edge_type,
           e.metadata_json as edge_metadata_json,
           e.created_at as edge_created_at
         from run_edges e
         join runs r on r.id = e.child_run_id
         where e.parent_run_id = $1 and e.name = $2`,
        [parentRunId, body.name]
      )
      if (existing.rows[0]) {
        return {
          run: mapRun(existing.rows[0]),
          edge: mapRunEdge(existing.rows[0]),
          created: false
        }
      }

      const runResult = await client.query(
        `insert into runs (workflow_name, input_json, metadata_json, recovery_webhook)
         values ($1, $2, $3, $4)
         returning *`,
        [
          body.workflowName,
          json(body.input ?? {}),
          json({
            ...(body.metadata ?? {}),
            parentRunId,
            parentEdgeName: body.name
          }),
          body.recoveryWebhook ?? null
        ]
      )
      const childRun = mapRun(runResult.rows[0])
      for (const channel of body.channels ?? []) {
        await client.query(
          `insert into channels (run_id, type, config_json, events_json)
           values ($1, $2, $3, $4)`,
          [
            childRun.id,
            channel.type,
            json({ url: channel.url, secret: channel.secret ?? null }),
            json(channel.events ?? [])
          ]
        )
      }
      const edgeResult = await client.query(
        `insert into run_edges (parent_run_id, child_run_id, name, edge_type, metadata_json)
         values ($1, $2, $3, $4, $5)
         returning *`,
        [
          parentRunId,
          childRun.id,
          body.name,
          body.edgeType ?? 'child',
          json(body.edgeMetadata ?? {})
        ]
      )
      const edge = mapRunEdge(edgeResult.rows[0])
      await appendEvent(client, childRun.id, 'run.created', {
        workflowName: body.workflowName,
        input: body.input ?? {},
        parentRunId,
        edgeName: body.name,
        channels: body.channels?.map((channel) => ({
          type: channel.type,
          url: channel.url,
          events: channel.events ?? []
        })) ?? []
      })
      await appendEvent(client, parentRunId, 'run.child.created', {
        childRun,
        edge
      })
      return { run: childRun, edge, created: true }
    })
    if (!result) return c.json({ error: 'parent run not found' }, 404)
    return c.json(result)
  })

  app.post('/runs/:runId/begin', async (c) => {
    const runId = c.req.param('runId')
    const leaseOwner = c.req.header('x-tidebase-worker') ?? randomUUID()
    const run = await tx(async (client) => {
      const result = await client.query(
        `select * from runs where id = $1 for update`,
        [runId]
      )
      const row = result.rows[0]
      if (!row) return null
      if (row.status === 'completed') return mapRun(row)
      if (row.status === 'cancelled') return { cancelled: true, run: mapRun(row) }
      if (
        row.lease_owner &&
        row.lease_expires_at &&
        new Date(row.lease_expires_at).getTime() > Date.now() &&
        row.lease_owner !== leaseOwner
      ) {
        return { locked: true, leaseOwner: row.lease_owner }
      }
      const update = await client.query(
        `update runs
         set status = 'running',
             lease_owner = $2,
             lease_expires_at = now() + ($3 || ' milliseconds')::interval,
             attempt = attempt + 1,
             updated_at = now()
         where id = $1
         returning *`,
        [runId, leaseOwner, leaseMs]
      )
      await appendEvent(client, runId, 'run.started', { leaseOwner })
      return mapRun(update.rows[0])
    })
    if (!run) return c.json({ error: 'run not found' }, 404)
    if ('cancelled' in run) {
      return c.json({ error: 'run is cancelled', code: 'run_cancelled', run: run.run }, 409)
    }
    if ('locked' in run) return c.json({ error: 'run is leased', leaseOwner: run.leaseOwner }, 409)
    return c.json({ run, leaseOwner })
  })

  app.post('/runs/:runId/complete', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json()
    const result = await tx(async (client) => {
      // Cancellation is one-way: a worker finishing after cancel cannot
      // resurrect the run.
      const update = await client.query(
        `update runs
         set status = 'completed',
             result_json = $2,
             error_json = null,
             lease_owner = null,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
         where id = $1 and status <> 'cancelled'
         returning *`,
        [runId, json(body.result ?? null)]
      )
      if (!update.rows[0]) {
        const existing = await client.query('select * from runs where id = $1', [runId])
        if (!existing.rows[0]) return null
        return { run: mapRun(existing.rows[0]), deliveries: [] as QueuedChannelDelivery[] }
      }
      await appendEvent(client, runId, 'run.completed', {
        result: body.result ?? null
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'run.completed', {
        run: mapRun(update.rows[0])
      })
      return { run: mapRun(update.rows[0]), deliveries }
    })
    if (!result) return c.json({ error: 'run not found' }, 404)
    await dispatchChannelDeliveries(result.deliveries)
    return c.json({ run: result.run })
  })

  app.post('/runs/:runId/fail', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json()
    const result = await tx(async (client) => {
      const existing = await client.query('select * from runs where id = $1 for update', [runId])
      const row = existing.rows[0]
      if (!row) return null
      if (row.status === 'cancelled') {
        return { run: mapRun(row), deliveries: [] as QueuedChannelDelivery[], requeued: false, skipRecovery: true }
      }
      // Queue runs with attempts remaining go back to 'queued' with backoff
      // instead of failing — retries are a lifecycle transition, not app glue.
      if (row.queue_name && Number(row.attempt) < Number(row.max_attempts)) {
        const backoff = retryBackoffMs(Number(row.attempt))
        const update = await client.query(
          `update runs
           set status = 'queued',
               error_json = $2,
               lease_owner = null,
               lease_expires_at = null,
               run_at = now() + ($3 || ' milliseconds')::interval,
               updated_at = now()
           where id = $1
           returning *`,
          [runId, json(body.error ?? {}), backoff]
        )
        const run = mapRun(update.rows[0])
        await appendEvent(client, runId, 'run.requeued', {
          error: body.error ?? {},
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
          nextRunAt: run.runAt
        })
        return { run, deliveries: [] as QueuedChannelDelivery[], requeued: true, skipRecovery: true }
      }
      const failureClass =
        row.queue_name && Number(row.max_attempts) > 1 ? 'max_retries' : (body.failureClass ?? null)
      const update = await client.query(
        `update runs
         set status = 'failed',
             error_json = $2,
             failure_class = $3,
             lease_owner = null,
             lease_expires_at = null,
             updated_at = now()
         where id = $1
         returning *`,
        [runId, json(body.error ?? {}), failureClass]
      )
      await appendEvent(client, runId, 'run.failed', {
        error: body.error ?? {},
        failureClass
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'run.failed', {
        run: mapRun(update.rows[0]),
        error: body.error ?? {}
      })
      return { run: mapRun(update.rows[0]), deliveries, requeued: false, skipRecovery: false }
    })
    if (!result) return c.json({ error: 'run not found' }, 404)
    await dispatchChannelDeliveries(result.deliveries)
    if (!result.skipRecovery) await dispatchRecovery(result.run, 'run_failed')
    return c.json({ run: result.run, requeued: result.requeued })
  })

  app.post('/runs/:runId/gates/begin', async (c) => {
    const runId = c.req.param('runId')
    const body = gateBeginSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const runRow = await client.query('select status from runs where id = $1', [runId])
      if (runRow.rows[0]?.status === 'cancelled') {
        return { cancelled: true as const }
      }
      // Same gap as steps/begin: concurrent first-begins would both insert and
      // one would abort on unique(run_id, name).
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1 || ':gate:' || $2))`,
        [runId, body.name]
      )
      const existing = await client.query(
        `select * from gates where run_id = $1 and name = $2 for update`,
        [runId, body.name]
      )
      if (existing.rows[0]) {
        return { gate: mapGate(existing.rows[0]), deliveries: [] as QueuedChannelDelivery[] }
      }

      const inserted = await client.query(
        `insert into gates (run_id, name, prompt, data_json, capability_json, channels_json)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          runId,
          body.name,
          body.prompt,
          json(body.data ?? {}),
          json(body.capability ?? null),
          json(body.channels ?? [])
        ]
      )
      const gate = mapGate(inserted.rows[0])
      await appendEvent(client, runId, 'gate.created', {
        gate: publicGate(gate)
      })
      const deliveries = await queueChannelDeliveries(
        client,
        runId,
        'gate.created',
        { gate: publicGate(gate) },
        body.channels ?? [],
        gate.id
      )
      return { gate, deliveries }
    })
    if ('cancelled' in result) {
      return c.json({ error: 'run is cancelled', code: 'run_cancelled' }, 409)
    }
    await dispatchChannelDeliveries(result.deliveries)
    return c.json({ action: result.gate.status === 'pending' ? 'wait' : 'return', gate: result.gate })
  })

  app.get('/runs/:runId/gates/:gateId', async (c) => {
    const result = await pool.query(
      `select g.*, r.status as run_status
       from gates g join runs r on r.id = g.run_id
       where g.run_id = $1 and g.id = $2`,
      [c.req.param('runId'), c.req.param('gateId')]
    )
    if (!result.rows[0]) return c.json({ error: 'gate not found' }, 404)
    return c.json({ gate: mapGate(result.rows[0]), runStatus: result.rows[0].run_status })
  })

  app.post('/runs/:runId/gates/:gateId/resolve', async (c) => {
    const runId = c.req.param('runId')
    const gateId = c.req.param('gateId')
    const body = gateResolveSchema.parse(await c.req.json())
    const gate = await tx(async (client) => {
      const update = await client.query(
        `update gates
         set status = $4,
             decision = $4,
             actor = $5,
             decision_json = $6,
             resolved_at = now(),
             updated_at = now()
         where run_id = $1 and id = $2 and resolve_token = $3 and status = 'pending'
         returning *`,
        [
          runId,
          gateId,
          body.token,
          body.decision,
          body.actor ?? null,
          json(body.payload ?? {})
        ]
      )
      if (!update.rows[0]) return null
      const resolved = mapGate(update.rows[0])
      await appendEvent(client, runId, 'gate.resolved', {
        gate: publicGate(resolved)
      })
      const deliveries = await queueChannelDeliveries(
        client,
        runId,
        'gate.resolved',
        { gate: publicGate(resolved) },
        resolved.channels,
        gateId
      )
      return { gate: resolved, deliveries }
    })
    if (!gate) return c.json({ error: 'gate not found, already resolved, or invalid token' }, 409)
    await dispatchChannelDeliveries(gate.deliveries)
    return c.json({ gate: gate.gate })
  })

  app.post('/runs/:runId/recover', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json().catch(() => ({}))
    const result = await pool.query('select * from runs where id = $1', [runId])
    const row = result.rows[0]
    if (!row) return c.json({ error: 'run not found' }, 404)
    const attempt = await dispatchRecovery(mapRun(row), body.reason ?? 'manual')
    if (!attempt) {
      return c.json({ error: 'run has no recoveryWebhook configured' }, 422)
    }
    return c.json({ recoveryAttempt: attempt })
  })

  app.post('/runs/:runId/steps/begin', async (c) => {
    const runId = c.req.param('runId')
    const body = beginStepSchema.parse(await c.req.json())
    const leaseOwner = body.leaseOwner ?? randomUUID()

    const result = await tx(async (client) => {
      // Cancellation is enforced at step boundaries: an in-flight worker
      // discovers it here and unwinds instead of starting new work.
      const runRow = await client.query('select status from runs where id = $1', [runId])
      if (runRow.rows[0]?.status === 'cancelled') {
        return { action: 'cancelled' }
      }
      // `for update` cannot lock a row that does not exist yet, so concurrent
      // first-begins of the same step would race past the lease check below.
      await client.query(
        `select pg_advisory_xact_lock(hashtext($1 || ':step:' || $2))`,
        [runId, body.name]
      )
      const existing = await client.query(
        `select * from steps where run_id = $1 and name = $2 for update`,
        [runId, body.name]
      )
      const existingStep = existing.rows[0]
      if (existingStep && existingStep.input_hash !== body.inputHash) {
        return {
          action: 'input_mismatch',
          step: mapStep(existingStep),
          expectedInputHash: existingStep.input_hash,
          actualInputHash: body.inputHash
        }
      }
      if (existingStep?.status === 'completed') {
        return { action: 'return', step: mapStep(existingStep), output: existingStep.output_json }
      }
      if (
        existingStep &&
        existingStep.lease_owner &&
        existingStep.lease_expires_at &&
        new Date(existingStep.lease_expires_at).getTime() > Date.now() &&
        existingStep.lease_owner !== leaseOwner
      ) {
        return { action: 'locked', step: mapStep(existingStep) }
      }

      const upsert = await client.query(
        `insert into steps
          (run_id, name, input_hash, input_json, options_json, status, lease_owner, lease_expires_at, attempt, started_at, updated_at)
         values
          ($1, $2, $3, $4, $5, 'running', $6, now() + ($7 || ' milliseconds')::interval, 1, now(), now())
         on conflict (run_id, name)
         do update set
          input_hash = excluded.input_hash,
          input_json = excluded.input_json,
          options_json = excluded.options_json,
          status = 'running',
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          attempt = steps.attempt + 1,
          started_at = coalesce(steps.started_at, now()),
          updated_at = now()
         returning *`,
        [
          runId,
          body.name,
          body.inputHash,
          json(body.input ?? {}),
          json(body.options ?? {}),
          leaseOwner,
          leaseMs
        ]
      )
      await appendEvent(client, runId, 'step.started', {
        stepId: upsert.rows[0].id,
        name: body.name,
        attempt: upsert.rows[0].attempt,
        resumeContract: normalizeResumeContract(upsert.rows[0].options_json)
      })
      return { action: 'execute', step: mapStep(upsert.rows[0]), leaseOwner }
    })

    return c.json(result)
  })

  app.post('/runs/:runId/steps/:stepId/complete', async (c) => {
    const runId = c.req.param('runId')
    const stepId = c.req.param('stepId')
    const body = completeStepSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const update = await client.query(
        `update steps
         set status = 'completed',
             output_json = $4,
             error_json = null,
             lease_owner = null,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
         where id = $1 and run_id = $2 and lease_owner = $3
         returning *`,
        [stepId, runId, body.leaseOwner, json(body.output ?? null)]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'step.completed', {
        stepId,
        name: update.rows[0].name,
        checkpointInvariant: normalizeResumeContract(update.rows[0].options_json).checkpointInvariant,
        verifiedBy: normalizeResumeContract(update.rows[0].options_json).verifiedBy
      })
      return mapStep(update.rows[0])
    })
    if (!result) return c.json({ error: 'step not found or lease lost' }, 409)
    return c.json({ step: result })
  })

  app.post('/runs/:runId/steps/:stepId/fail', async (c) => {
    const runId = c.req.param('runId')
    const stepId = c.req.param('stepId')
    const body = failStepSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const existing = await client.query(
        `select options_json from steps where id = $1 and run_id = $2`,
        [stepId, runId]
      )
      const resumeDecision =
        body.resumeDecision ?? classifyResumeDecision(existing.rows[0]?.options_json, body.retryable ?? false)
      const update = await client.query(
        `update steps
         set status = $5,
             error_json = $4,
             lease_owner = null,
             lease_expires_at = null,
             updated_at = now()
         where id = $1 and run_id = $2 and lease_owner = $3
         returning *`,
        [
          stepId,
          runId,
          body.leaseOwner,
          json(body.error),
          statusForResumeDecision(body.retryable ?? false, resumeDecision)
        ]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'step.failed', {
        stepId,
        name: update.rows[0].name,
        retryable: body.retryable ?? false,
        resumeDecision,
        resumeContract: normalizeResumeContract(update.rows[0].options_json),
        error: body.error
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'step.failed', {
        step: mapStep(update.rows[0]),
        retryable: body.retryable ?? false,
        resumeDecision,
        error: body.error
      })
      return { step: mapStep(update.rows[0]), deliveries }
    })
    if (!result) return c.json({ error: 'step not found or lease lost' }, 409)
    await dispatchChannelDeliveries(result.deliveries)
    return c.json({ step: result.step })
  })

  app.put('/runs/:runId/state', async (c) => {
    const runId = c.req.param('runId')
    const body = stateSchema.parse(await c.req.json())
    const state = await tx(async (client) => {
      const result = await client.query(
        `insert into run_state (run_id, value_json, version, updated_at)
         values ($1, $2, 1, now())
         on conflict (run_id)
         do update set value_json = excluded.value_json,
                       version = run_state.version + 1,
                       updated_at = now()
         returning *`,
        [runId, json(body.value ?? {})]
      )
      const version = await recordStateVersion(client, runId, {
        streamName: body.stream ?? 'run',
        targetType: 'run',
        targetId: runId,
        value: body.value ?? {},
        patch: null,
        label: body.label ?? null,
        reason: body.reason ?? null,
        importance: body.importance ?? 'normal',
        metadata: body.metadata ?? {},
        createdBy: body.createdBy ?? null
      })
      await appendEvent(client, runId, 'state.updated', {
        value: body.value,
        stateVersion: publicStateVersion(version)
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'state.updated', {
        state: mapState(result.rows[0]),
        stateVersion: publicStateVersion(version)
      })
      return { state: mapState(result.rows[0]), deliveries }
    })
    await dispatchChannelDeliveries(state.deliveries)
    return c.json({ state: state.state })
  })

  app.patch('/runs/:runId/state', async (c) => {
    const runId = c.req.param('runId')
    const body = stateSchema.parse(await c.req.json())
    const state = await tx(async (client) => {
      const result = await client.query(
        `insert into run_state (run_id, value_json, version, updated_at)
         values ($1, $2, 1, now())
         on conflict (run_id)
         do update set value_json = run_state.value_json || excluded.value_json,
                       version = run_state.version + 1,
                       updated_at = now()
         returning *`,
        [runId, json(body.value ?? {})]
      )
      const version = await recordStateVersion(client, runId, {
        streamName: body.stream ?? 'run',
        targetType: 'run',
        targetId: runId,
        value: result.rows[0].value_json,
        patch: body.value ?? {},
        label: body.label ?? null,
        reason: body.reason ?? null,
        importance: body.importance ?? 'normal',
        metadata: body.metadata ?? {},
        createdBy: body.createdBy ?? null
      })
      await appendEvent(client, runId, 'state.updated', {
        value: result.rows[0].value_json,
        patch: body.value ?? {},
        stateVersion: publicStateVersion(version)
      })
      const deliveries = await queueChannelDeliveries(client, runId, 'state.updated', {
        state: mapState(result.rows[0]),
        stateVersion: publicStateVersion(version)
      })
      return { state: mapState(result.rows[0]), deliveries }
    })
    await dispatchChannelDeliveries(state.deliveries)
    return c.json({ state: state.state })
  })

  app.post('/runs/:runId/state/save', async (c) => {
    const runId = c.req.param('runId')
    const body = stateSaveSchema.parse(await c.req.json())
    const version = await tx(async (client) => {
      const streamName = body.stream ?? 'run'
      const current =
        streamName === 'run'
          ? await client.query(
              `select value_json as value_json, 'run'::text as target_type, $1::text as target_id
               from run_state
               where run_id = $1`,
              [runId]
            )
          : await client.query(
              `select current_value_json as value_json, target_type, target_id
               from state_streams
               where run_id = $1 and name = $2`,
              [runId, streamName]
            )
      if (!current.rows[0]) return null
      const saved = await recordStateVersion(client, runId, {
        streamName,
        targetType: current.rows[0].target_type,
        targetId: current.rows[0].target_id,
        value: current.rows[0].value_json,
        patch: null,
        label: body.label,
        reason: body.reason ?? null,
        importance: body.importance ?? 'milestone',
        metadata: body.metadata ?? {},
        createdBy: body.createdBy ?? null
      })
      await appendEvent(client, runId, 'state.saved', {
        stateVersion: publicStateVersion(saved)
      })
      return saved
    })
    if (!version) return c.json({ error: 'run state not found' }, 404)
    return c.json({ stateVersion: version })
  })

  app.get('/runs/:runId/state/versions', async (c) => {
    const runId = c.req.param('runId')
    const stream = c.req.query('stream')
    const labeled = c.req.query('labeled') === 'true'
    const result = await pool.query(
      `select v.*
       from state_versions v
       join state_streams s on s.id = v.stream_id
       where s.run_id = $1
         and ($2::text is null or s.name = $2)
         and ($3::boolean = false or v.label is not null)
       order by s.name asc, v.version asc`,
      [runId, stream ?? null, labeled]
    )
    return c.json({ stateVersions: result.rows.map(mapStateVersion) })
  })

  app.post('/runs/:runId/snapshots', async (c) => {
    const runId = c.req.param('runId')
    const body = snapshotSchema.parse(await c.req.json())
    const target = body.target ?? { type: 'run', id: runId }
    const version = await tx(async (client) => {
      const saved = await recordStateVersion(client, runId, {
        streamName: `${target.type}:${target.id}`,
        targetType: target.type,
        targetId: target.id,
        value: body.state ?? {},
        patch: null,
        label: body.label,
        reason: body.reason ?? null,
        importance: 'milestone',
        metadata: body.metadata ?? {},
        createdBy: body.createdBy ?? null
      })
      await appendEvent(client, runId, 'snapshot.created', {
        stateVersion: publicStateVersion(saved)
      })
      return saved
    })
    return c.json({ snapshot: version })
  })

  app.get('/runs/:runId/snapshots', async (c) => {
    const runId = c.req.param('runId')
    const result = await pool.query(
      `select v.*
       from state_versions v
       join state_streams s on s.id = v.stream_id
       where s.run_id = $1 and v.label is not null
       order by v.created_at desc`,
      [runId]
    )
    return c.json({ snapshots: result.rows.map(mapStateVersion) })
  })

  app.post('/runs/:runId/usage', async (c) => {
    const runId = c.req.param('runId')
    const body = usageSchema.parse(await c.req.json())
    const usage = await tx(async (client) => {
      const result = await client.query(
        `insert into usage_records
          (run_id, step_id, kind, provider, model, label, quantity, unit, input_tokens, output_tokens, total_tokens, cost_usd, metadata_json)
         values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         returning *`,
        [
          runId,
          body.stepId ?? null,
          body.kind ?? 'custom',
          body.provider ?? null,
          body.model ?? null,
          body.label ?? null,
          body.quantity ?? null,
          body.unit ?? null,
          body.inputTokens ?? null,
          body.outputTokens ?? null,
          usageTotalTokens(body),
          body.costUsd ?? null,
          json(body.metadata ?? {})
        ]
      )
      const record = mapUsageRecord(result.rows[0])
      await appendEvent(client, runId, 'usage.recorded', { usage: record })
      const deliveries = await queueChannelDeliveries(client, runId, 'usage.recorded', {
        usage: record
      })
      return { usage: record, deliveries }
    })
    await dispatchChannelDeliveries(usage.deliveries)
    return c.json({ usage: usage.usage })
  })

  app.get('/runs/:runId/events', async (c) => {
    const runId = c.req.param('runId')
    const after = Number(c.req.query('after') ?? 0)
    return streamSSE(c, async (stream) => {
      for (const event of await listEvents(runId, after)) {
        await stream.writeSSE({
          id: String(event.seq),
          data: JSON.stringify(event)
        })
      }
      const unsubscribe = subscribe(runId, (event) => {
        void stream.writeSSE({
          id: String(event.seq),
          data: JSON.stringify(event)
        })
      })
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe()
          resolve()
        })
      })
    })
  })

  return app
}

export async function dispatchRecovery(
  run: ReturnType<typeof mapRun>,
  reason: string,
  payloadType: 'run.resume' | 'run.invoke' = 'run.resume',
  webhookUrl?: string
) {
  const url = webhookUrl ?? run.recoveryWebhook
  if (!url) return null
  const payload = {
    type: payloadType,
    runId: run.id,
    workflowName: run.workflowName,
    reason,
    attempt: run.attempt
  }
  const body = JSON.stringify(payload)
  const signature = webhookSecret
    ? createHmac('sha256', webhookSecret).update(body).digest('hex')
    : undefined

  const created = await tx(async (client) => {
    const result = await client.query(
      `insert into recovery_attempts (run_id, reason, webhook_url, status)
       values ($1, $2, $3, 'pending')
       returning *`,
      [run.id, reason, url]
    )
    await appendEvent(client, run.id, 'recovery.started', {
      recoveryAttemptId: result.rows[0].id,
      reason
    })
    return mapRecoveryAttempt(result.rows[0])
  })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'tidebase-recovery/0.5.0',
        ...(signature ? { 'x-tidebase-signature': `sha256=${signature}` } : {})
      },
      body
    })
    const responseBody = await response.text()
    return await tx(async (client) => {
      const result = await client.query(
        `update recovery_attempts
         set status = $2,
             http_status = $3,
             response_body = $4,
             completed_at = now()
         where id = $1
         returning *`,
        [
          created.id,
          response.ok ? 'delivered' : 'failed',
          response.status,
          responseBody.slice(0, 8000)
        ]
      )
      await appendEvent(client, run.id, response.ok ? 'recovery.delivered' : 'recovery.failed', {
        recoveryAttemptId: created.id,
        httpStatus: response.status
      })
      return mapRecoveryAttempt(result.rows[0])
    })
  } catch (error) {
    return await tx(async (client) => {
      const result = await client.query(
        `update recovery_attempts
         set status = 'failed',
             error_text = $2,
             completed_at = now()
         where id = $1
         returning *`,
        [created.id, error instanceof Error ? error.message : String(error)]
      )
      await appendEvent(client, run.id, 'recovery.failed', {
        recoveryAttemptId: created.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return mapRecoveryAttempt(result.rows[0])
    })
  }
}

async function recordStateVersion(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }> },
  runId: string,
  options: {
    streamName: string
    targetType: string
    targetId: string | null
    value: unknown
    patch: unknown
    label: string | null
    reason: string | null
    importance: string
    metadata: Record<string, unknown>
    createdBy: string | null
  }
) {
  const streamResult = await client.query(
    `insert into state_streams
      (run_id, name, target_type, target_id, current_version, current_value_json, metadata_json, updated_at)
     values
      ($1, $2, $3, $4, 0, '{}'::jsonb, '{}'::jsonb, now())
     on conflict (run_id, name)
     do update set
      target_type = excluded.target_type,
      target_id = excluded.target_id,
      updated_at = now()
     returning *`,
    [runId, options.streamName, options.targetType, options.targetId]
  )
  const stream = streamResult.rows[0]
  const nextVersion = Number(stream.current_version) + 1
  const versionResult = await client.query(
    `insert into state_versions
      (stream_id, run_id, version, value_json, patch_json, label, reason, importance, metadata_json, created_by)
     values
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      stream.id,
      runId,
      nextVersion,
      json(options.value ?? {}),
      options.patch == null ? null : json(options.patch),
      options.label,
      options.reason,
      options.importance,
      json(options.metadata ?? {}),
      options.createdBy
    ]
  )
  await client.query(
    `update state_streams
     set current_version = $2,
         current_value_json = $3,
         updated_at = now()
     where id = $1`,
    [stream.id, nextVersion, json(options.value ?? {})]
  )
  return mapStateVersion(versionResult.rows[0])
}

export function mapRun(row: Record<string, any>) {
  return {
    id: row.id as string,
    workflowName: row.workflow_name as string,
    input: row.input_json,
    metadata: row.metadata_json,
    status: row.status as string,
    result: row.result_json,
    error: row.error_json,
    recoveryWebhook: row.recovery_webhook as string | null,
    leaseOwner: row.lease_owner as string | null,
    leaseExpiresAt: row.lease_expires_at?.toISOString?.() ?? null,
    attempt: Number(row.attempt),
    queue: (row.queue_name as string | null) ?? null,
    dedupeKey: (row.dedupe_key as string | null) ?? null,
    priority: row.priority != null ? Number(row.priority) : 0,
    runAt: row.run_at?.toISOString?.() ?? null,
    maxAttempts: row.max_attempts != null ? Number(row.max_attempts) : 1,
    deadlineAt: row.deadline_at?.toISOString?.() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString?.() ?? null,
    cancelledAt: row.cancelled_at?.toISOString?.() ?? null,
    cancelReason: (row.cancel_reason as string | null) ?? null,
    cancelActor: (row.cancel_actor as string | null) ?? null,
    failureClass: (row.failure_class as string | null) ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString?.() ?? null
  }
}

function json(value: unknown) {
  return JSON.stringify(value)
}

function mapQueueConfig(row: Record<string, any> | undefined) {
  if (!row) return null
  return {
    name: row.name as string,
    concurrency: row.concurrency != null ? Number(row.concurrency) : null,
    ratePerMinute: row.rate_per_minute != null ? Number(row.rate_per_minute) : null,
    invokeUrl: (row.invoke_url as string | null) ?? null
  }
}

function mapSchedule(row: Record<string, any>) {
  return {
    name: row.name as string,
    cron: row.cron as string,
    workflowName: row.workflow_name as string,
    input: row.input_json,
    queue: row.queue_name as string,
    maxAttempts: Number(row.max_attempts),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at?.toISOString?.() ?? null,
    lastEnqueuedAt: row.last_enqueued_at?.toISOString?.() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

type QueuedChannelDelivery = {
  deliveryId: string
  runId: string
  gateId: string | null
  eventType: string
  payload: unknown
  url: string
  secret: string | null
}

// Runs inside the endpoint transaction: selects matching channels and records
// pending delivery rows. The actual HTTP dispatch happens after commit via
// dispatchChannelDeliveries so a slow webhook never holds row or event locks.
async function queueChannelDeliveries(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }> },
  runId: string,
  eventType: string,
  payload: unknown,
  inlineChannels: unknown[] = [],
  gateId: string | null = null
): Promise<QueuedChannelDelivery[]> {
  const stored = await client.query('select * from channels where run_id = $1', [runId])
  const channels = [
    ...stored.rows.map(mapChannel),
    ...inlineChannels.map((channel) => normalizeInlineChannel(channel)).filter((channel): channel is ReturnType<typeof normalizeInlineChannel> & {} => Boolean(channel))
  ].filter((channel) => channelMatchesEvent(channel, eventType))

  const queued: QueuedChannelDelivery[] = []
  for (const channel of channels) {
    if (channel.type !== 'webhook') continue
    const delivery = await client.query(
      `insert into channel_deliveries (run_id, channel_id, gate_id, event_type, payload_json, status)
       values ($1, $2, $3, $4, $5, 'pending')
       returning *`,
      [runId, 'id' in channel ? channel.id : null, gateId, eventType, json(payload ?? {})]
    )
    queued.push({
      deliveryId: delivery.rows[0].id as string,
      runId,
      gateId,
      eventType,
      payload,
      url: channel.config.url,
      secret: channel.config.secret
    })
  }
  return queued
}

async function dispatchChannelDeliveries(deliveries: QueuedChannelDelivery[]) {
  for (const delivery of deliveries) {
    try {
      const body = JSON.stringify({
        type: delivery.eventType,
        runId: delivery.runId,
        gateId: delivery.gateId,
        deliveryId: delivery.deliveryId,
        payload: delivery.payload
      })
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'tidebase-channel/0.3.0',
          ...(delivery.secret
            ? { 'x-tidebase-signature': `sha256=${createHmac('sha256', delivery.secret).update(body).digest('hex')}` }
            : {})
        },
        body
      })
      const responseBody = await response.text()
      await pool.query(
        `update channel_deliveries
         set status = $2,
             http_status = $3,
             response_body = $4,
             completed_at = now()
         where id = $1`,
        [delivery.deliveryId, response.ok ? 'delivered' : 'failed', response.status, responseBody.slice(0, 8000)]
      )
    } catch (error) {
      await pool.query(
        `update channel_deliveries
         set status = 'failed',
             error_text = $2,
             completed_at = now()
         where id = $1`,
        [delivery.deliveryId, error instanceof Error ? error.message : String(error)]
      )
    }
  }
}

function normalizeInlineChannel(value: unknown) {
  const parsed = channelSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    type: parsed.data.type,
    config: {
      url: parsed.data.url,
      secret: parsed.data.secret ?? null
    },
    events: parsed.data.events ?? []
  }
}

function channelMatchesEvent(
  channel: { events: string[] },
  eventType: string
) {
  return channel.events.length === 0 || channel.events.includes(eventType)
}

function publicGate(gate: ReturnType<typeof mapGate>) {
  return {
    id: gate.id,
    runId: gate.runId,
    name: gate.name,
    prompt: gate.prompt,
    data: gate.data,
    status: gate.status,
    decision: gate.decision,
    actor: gate.actor,
    capability: gate.capability,
    resolveUrl: `${publicUrl}/runs/${gate.runId}/gates/${gate.id}/resolve`,
    resolveToken: gate.resolveToken
  }
}

function normalizeResumeContract(optionsJson: unknown) {
  const options = isRecord(optionsJson) ? optionsJson : {}
  const legacySideEffect = typeof options.sideEffect === 'string' ? options.sideEffect : 'none'
  const sideEffects = Array.isArray(options.sideEffects)
    ? options.sideEffects.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : legacySideEffect !== 'none'
      ? [legacySideEffect]
      : []
  const replay =
    options.replay === 'auto' || options.replay === 'manual' || options.replay === 'never'
      ? options.replay
      : options.onAmbiguousFailure === 'retry'
        ? 'auto'
        : options.onAmbiguousFailure === 'review'
          ? 'manual'
          : options.onAmbiguousFailure === 'fail'
            ? 'never'
            : inferReplay(sideEffects, typeof options.idempotencyKey === 'string')

  return {
    sideEffects,
    idempotencyKey: typeof options.idempotencyKey === 'string' ? options.idempotencyKey : null,
    replay,
    checkpointInvariant: options.checkpointInvariant ?? null,
    verifiedBy: options.verifiedBy ?? null,
    credentials: Array.isArray(options.credentials) ? options.credentials : []
  }
}

function inferReplay(sideEffects: string[], hasIdempotencyKey: boolean) {
  if (sideEffects.length === 0 || sideEffects.every((effect) => effect === 'read')) return 'auto'
  return hasIdempotencyKey ? 'auto' : 'manual'
}

function classifyResumeDecision(optionsJson: unknown, retryable: boolean) {
  if (retryable) return 'auto_retry'
  const contract = normalizeResumeContract(optionsJson)
  if (contract.replay === 'manual') return 'manual_review'
  if (contract.replay === 'auto') return 'safe_replay'
  return 'fail_hard'
}

function statusForResumeDecision(retryable: boolean, decision: string) {
  if (retryable || decision === 'auto_retry') return 'failed_retryable'
  if (decision === 'manual_review') return 'manual_review'
  return 'failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mapStep(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    name: row.name as string,
    inputHash: row.input_hash as string,
    input: row.input_json,
    options: row.options_json,
    resumeContract: normalizeResumeContract(row.options_json),
    status: row.status as string,
    output: row.output_json,
    error: row.error_json,
    leaseOwner: row.lease_owner as string | null,
    leaseExpiresAt: row.lease_expires_at?.toISOString?.() ?? null,
    attempt: Number(row.attempt),
    startedAt: row.started_at?.toISOString?.() ?? null,
    completedAt: row.completed_at?.toISOString?.() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

function mapChannel(row: Record<string, any>) {
  const config = isRecord(row.config_json) ? row.config_json : {}
  return {
    id: row.id as string,
    runId: row.run_id as string | null,
    type: row.type as string,
    config: {
      url: typeof config.url === 'string' ? config.url : '',
      secret: typeof config.secret === 'string' ? config.secret : null
    },
    events: Array.isArray(row.events_json)
      ? row.events_json.filter((event): event is string => typeof event === 'string')
      : [],
    createdAt: row.created_at.toISOString()
  }
}

function mapChannelDelivery(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string | null,
    channelId: row.channel_id as string | null,
    gateId: row.gate_id as string | null,
    eventType: row.event_type as string,
    payload: row.payload_json,
    status: row.status as string,
    httpStatus: row.http_status as number | null,
    responseBody: row.response_body as string | null,
    errorText: row.error_text as string | null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString?.() ?? null
  }
}

function usageTotalTokens(body: z.infer<typeof usageSchema>) {
  if (body.totalTokens != null) return body.totalTokens
  if (body.inputTokens == null && body.outputTokens == null) return null
  return (body.inputTokens ?? 0) + (body.outputTokens ?? 0)
}

function mapUsageRecord(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    stepId: row.step_id as string | null,
    kind: row.kind as string,
    provider: row.provider as string | null,
    model: row.model as string | null,
    label: row.label as string | null,
    quantity: row.quantity == null ? null : Number(row.quantity),
    unit: row.unit as string | null,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    totalTokens: row.total_tokens as number | null,
    costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
    metadata: row.metadata_json,
    createdAt: row.created_at.toISOString()
  }
}

function mapGate(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    data: row.data_json,
    status: row.status as string,
    decision: row.decision as string | null,
    actor: row.actor as string | null,
    decisionPayload: row.decision_json,
    capability: row.capability_json,
    channels: Array.isArray(row.channels_json) ? row.channels_json : [],
    resolveToken: row.resolve_token as string,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString?.() ?? null
  }
}

function mapState(row: Record<string, any>) {
  return {
    runId: row.run_id as string,
    value: row.value_json,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString()
  }
}

function mapStateStream(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string | null,
    name: row.name as string,
    targetType: row.target_type as string,
    targetId: row.target_id as string | null,
    currentVersion: Number(row.current_version),
    currentValue: row.current_value_json,
    metadata: row.metadata_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

function mapStateVersion(row: Record<string, any>) {
  return {
    id: row.id as string,
    streamId: row.stream_id as string,
    runId: row.run_id as string | null,
    stepId: row.step_id as string | null,
    version: Number(row.version),
    value: row.value_json,
    patch: row.patch_json,
    label: row.label as string | null,
    reason: row.reason as string | null,
    importance: row.importance as string,
    metadata: row.metadata_json,
    createdBy: row.created_by as string | null,
    createdAt: row.created_at.toISOString()
  }
}

function publicStateVersion(version: ReturnType<typeof mapStateVersion>) {
  return {
    id: version.id,
    streamId: version.streamId,
    runId: version.runId,
    version: version.version,
    label: version.label,
    reason: version.reason,
    importance: version.importance,
    createdAt: version.createdAt
  }
}

function mapRunEdge(row: Record<string, any>) {
  return {
    id: (row.edge_id ?? row.id) as string,
    parentRunId: (row.edge_parent_run_id ?? row.parent_run_id) as string,
    childRunId: (row.edge_child_run_id ?? row.child_run_id) as string,
    name: (row.edge_name ?? row.name) as string,
    edgeType: (row.edge_edge_type ?? row.edge_type) as string,
    metadata: row.edge_metadata_json ?? row.metadata_json,
    createdAt: (row.edge_created_at ?? row.created_at).toISOString()
  }
}

function mapRecoveryAttempt(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    reason: row.reason as string,
    webhookUrl: row.webhook_url as string,
    status: row.status as string,
    httpStatus: row.http_status as number | null,
    responseBody: row.response_body as string | null,
    errorText: row.error_text as string | null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString?.() ?? null
  }
}
