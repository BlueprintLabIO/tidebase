import { createHmac, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { pool, tx } from './db.js'
import { appendEvent, listEvents, subscribe } from './events.js'

const leaseMs = Number(process.env.TIDEBASE_LEASE_MS ?? 60_000)
const webhookSecret = process.env.TIDEBASE_WEBHOOK_SECRET

const jsonRecord = z.record(z.string(), z.unknown())

const createRunSchema = z.object({
  input: z.unknown().optional(),
  metadata: jsonRecord.optional(),
  recoveryWebhook: z.string().url().optional()
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
  retryable: z.boolean().optional()
})

const stateSchema = z.object({
  value: z.unknown()
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
          body.input ?? {},
          body.metadata ?? {},
          body.recoveryWebhook ?? null
        ]
      )
      const run = mapRun(runResult.rows[0])
      await appendEvent(client, run.id, 'run.created', {
        workflowName,
        input: body.input ?? {}
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
    const [runResult, stepsResult, stateResult, recoveryResult, events] = await Promise.all([
      pool.query('select * from runs where id = $1', [runId]),
      pool.query('select * from steps where run_id = $1 order by created_at asc', [
        runId
      ]),
      pool.query('select * from run_state where run_id = $1', [runId]),
      pool.query(
        'select * from recovery_attempts where run_id = $1 order by created_at desc',
        [runId]
      ),
      listEvents(runId)
    ])
    if (!runResult.rows[0]) return c.json({ error: 'run not found' }, 404)
    return c.json({
      run: mapRun(runResult.rows[0]),
      steps: stepsResult.rows.map(mapStep),
      state: stateResult.rows[0] ? mapState(stateResult.rows[0]) : null,
      recoveryAttempts: recoveryResult.rows.map(mapRecoveryAttempt),
      events
    })
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
             lease_owner = null,
             lease_expires_at = null,
             completed_at = now(),
             updated_at = now()
         where id = $1
         returning *`,
        [runId, body.result ?? null]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'run.completed', {
        result: body.result ?? null
      })
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
        [runId, body.error ?? {}]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'run.failed', { error: body.error ?? {} })
      return mapRun(update.rows[0])
    })
    if (!run) return c.json({ error: 'run not found' }, 404)
    await dispatchRecovery(run, 'run_failed')
    return c.json({ run })
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
          body.input ?? {},
          body.options ?? {},
          leaseOwner,
          leaseMs
        ]
      )
      await appendEvent(client, runId, 'step.started', {
        stepId: upsert.rows[0].id,
        name: body.name,
        attempt: upsert.rows[0].attempt
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
        [stepId, runId, body.leaseOwner, body.output ?? null]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'step.completed', {
        stepId,
        name: update.rows[0].name
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
          body.error,
          body.retryable ? 'failed_retryable' : 'failed'
        ]
      )
      if (!update.rows[0]) return null
      await appendEvent(client, runId, 'step.failed', {
        stepId,
        name: update.rows[0].name,
        retryable: body.retryable ?? false,
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
        [runId, body.value ?? {}]
      )
      await appendEvent(client, runId, 'state.updated', { value: body.value })
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
        [runId, body.value ?? {}]
      )
      await appendEvent(client, runId, 'state.updated', { value: result.rows[0].value_json })
      return mapState(result.rows[0])
    })
    return c.json({ state })
  })

  app.get('/runs/:runId/events', async (c) => {
    const runId = c.req.param('runId')
    const after = Number(c.req.query('after') ?? 0)
    return streamSSE(c, async (stream) => {
      for (const event of await listEvents(runId, after)) {
        await stream.writeSSE({
          event: event.type,
          id: String(event.seq),
          data: JSON.stringify(event)
        })
      }
      const unsubscribe = subscribe(runId, (event) => {
        void stream.writeSSE({
          event: event.type,
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
        'user-agent': 'tidebase-recovery/0.0.0',
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

function mapStep(row: Record<string, any>) {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    name: row.name as string,
    inputHash: row.input_hash as string,
    input: row.input_json,
    options: row.options_json,
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

function mapState(row: Record<string, any>) {
  return {
    runId: row.run_id as string,
    value: row.value_json,
    version: Number(row.version),
    updatedAt: row.updated_at.toISOString()
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
