import { createHmac, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { appendEvent, listEvents, subscribe } from './events.js'

const leaseMs = Number(process.env.TIDEBASE_LEASE_MS ?? 60_000)
const webhookSecret = process.env.TIDEBASE_WEBHOOK_SECRET
const publicUrl = (process.env.TIDEBASE_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 7373}`).replace(/\/$/, '')

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

export function createApp() {
  const app = new Hono()
  app.use('*', cors())

  app.get('/health', (c) => c.json({ ok: true }))

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
    if ('locked' in run) return c.json({ error: 'run is leased', leaseOwner: run.leaseOwner }, 409)
    return c.json({ run, leaseOwner })
  })

  app.post('/runs/:runId/complete', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json()
    const result = await tx(async (client) => {
      const update = await client.query(
        `update runs
         set status = 'completed',
             result_json = $2,
             error_json = null,
             lease_owner = null,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
         where id = $1
         returning *`,
        [runId, json(body.result ?? null)]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'run.completed', {
        result: body.result ?? null
      })
      await deliverChannels(client, runId, 'run.completed', { run: mapRun(update.rows[0]) })
      return mapRun(update.rows[0])
    })
    if (!result) return c.json({ error: 'run not found' }, 404)
    return c.json({ run: result })
  })

  app.post('/runs/:runId/fail', async (c) => {
    const runId = c.req.param('runId')
    const body = await c.req.json()
    const run = await tx(async (client) => {
      const update = await client.query(
        `update runs
         set status = 'failed',
             error_json = $2,
             lease_owner = null,
             lease_expires_at = null,
             updated_at = now()
         where id = $1
         returning *`,
        [runId, json(body.error ?? {})]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'run.failed', { error: body.error ?? {} })
      await deliverChannels(client, runId, 'run.failed', {
        run: mapRun(update.rows[0]),
        error: body.error ?? {}
      })
      return mapRun(update.rows[0])
    })
    if (!run) return c.json({ error: 'run not found' }, 404)
    await dispatchRecovery(run, 'run_failed')
    return c.json({ run })
  })

  app.post('/runs/:runId/gates/begin', async (c) => {
    const runId = c.req.param('runId')
    const body = gateBeginSchema.parse(await c.req.json())
    const result = await tx(async (client) => {
      const existing = await client.query(
        `select * from gates where run_id = $1 and name = $2 for update`,
        [runId, body.name]
      )
      if (existing.rows[0]) {
        return mapGate(existing.rows[0])
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
      await deliverChannels(client, runId, 'gate.created', { gate: publicGate(gate) }, body.channels ?? [], gate.id)
      return gate
    })
    return c.json({ action: result.status === 'pending' ? 'wait' : 'return', gate: result })
  })

  app.get('/runs/:runId/gates/:gateId', async (c) => {
    const result = await pool.query(
      'select * from gates where run_id = $1 and id = $2',
      [c.req.param('runId'), c.req.param('gateId')]
    )
    if (!result.rows[0]) return c.json({ error: 'gate not found' }, 404)
    return c.json({ gate: mapGate(result.rows[0]) })
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
      await deliverChannels(client, runId, 'gate.resolved', { gate: publicGate(resolved) }, resolved.channels, gateId)
      return resolved
    })
    if (!gate) return c.json({ error: 'gate not found, already resolved, or invalid token' }, 409)
    return c.json({ gate })
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
      await deliverChannels(client, runId, 'step.failed', {
        step: mapStep(update.rows[0]),
        retryable: body.retryable ?? false,
        resumeDecision,
        error: body.error
      })
      return mapStep(update.rows[0])
    })
    if (!result) return c.json({ error: 'step not found or lease lost' }, 409)
    return c.json({ step: result })
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
      await deliverChannels(client, runId, 'state.updated', {
        state: mapState(result.rows[0]),
        stateVersion: publicStateVersion(version)
      })
      return mapState(result.rows[0])
    })
    return c.json({ state })
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
      await deliverChannels(client, runId, 'state.updated', {
        state: mapState(result.rows[0]),
        stateVersion: publicStateVersion(version)
      })
      return mapState(result.rows[0])
    })
    return c.json({ state })
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
      await deliverChannels(client, runId, 'usage.recorded', { usage: record })
      return record
    })
    return c.json({ usage })
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

async function dispatchRecovery(run: ReturnType<typeof mapRun>, reason: string) {
  if (!run.recoveryWebhook) return null
  const payload = {
    type: 'run.resume',
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
      [run.id, reason, run.recoveryWebhook]
    )
    await appendEvent(client, run.id, 'recovery.started', {
      recoveryAttemptId: result.rows[0].id,
      reason
    })
    return mapRecoveryAttempt(result.rows[0])
  })

  try {
    const response = await fetch(run.recoveryWebhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'tidebase-recovery/0.2.0',
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

function mapRun(row: Record<string, any>) {
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString?.() ?? null
  }
}

function json(value: unknown) {
  return JSON.stringify(value)
}

async function deliverChannels(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }> },
  runId: string,
  eventType: string,
  payload: unknown,
  inlineChannels: unknown[] = [],
  gateId: string | null = null
) {
  const stored = await client.query('select * from channels where run_id = $1', [runId])
  const channels = [
    ...stored.rows.map(mapChannel),
    ...inlineChannels.map((channel) => normalizeInlineChannel(channel)).filter((channel): channel is ReturnType<typeof normalizeInlineChannel> & {} => Boolean(channel))
  ].filter((channel) => channelMatchesEvent(channel, eventType))

  for (const channel of channels) {
    if (channel.type !== 'webhook') continue
    const delivery = await client.query(
      `insert into channel_deliveries (run_id, channel_id, gate_id, event_type, payload_json, status)
       values ($1, $2, $3, $4, $5, 'pending')
       returning *`,
      [runId, 'id' in channel ? channel.id : null, gateId, eventType, json(payload ?? {})]
    )
    const deliveryId = delivery.rows[0].id as string
    try {
      const body = JSON.stringify({
        type: eventType,
        runId,
        gateId,
        deliveryId,
        payload
      })
      const secret = channel.config.secret
      const response = await fetch(channel.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'tidebase-channel/0.2.0',
          ...(secret
            ? { 'x-tidebase-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }
            : {})
        },
        body
      })
      const responseBody = await response.text()
      await client.query(
        `update channel_deliveries
         set status = $2,
             http_status = $3,
             response_body = $4,
             completed_at = now()
         where id = $1`,
        [deliveryId, response.ok ? 'delivered' : 'failed', response.status, responseBody.slice(0, 8000)]
      )
    } catch (error) {
      await client.query(
        `update channel_deliveries
         set status = 'failed',
             error_text = $2,
             completed_at = now()
         where id = $1`,
        [deliveryId, error instanceof Error ? error.message : String(error)]
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
