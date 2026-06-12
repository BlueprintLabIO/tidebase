import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createApp, createContext, migrate, reconcileTick } from '../src/lib'
import type { ServerContext } from '../src/lib'
import { api, createRun } from './helpers'

// Invariant: one process can host many Tidebase instances, one per database,
// via createContext() — the embedding contract the cloud gateway depends on.
// Runs in one context are invisible to the other, per-context API keys are
// independent, and a reconciler tick only acts on its own context's database
// (its advisory tick lock is database-scoped, so ticks don't serialize across
// contexts either).

const defaultDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgres://tidebase:tidebase@localhost:7432/tidebase_test'
const embedUrl = new URL(defaultDatabaseUrl)
embedUrl.pathname = '/tidebase_test_embed'

let embedCtx: ServerContext

beforeAll(async () => {
  const adminUrl = new URL(defaultDatabaseUrl)
  adminUrl.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  const exists = await admin.query('select 1 from pg_database where datname = $1', [
    'tidebase_test_embed'
  ])
  if (exists.rows.length === 0) {
    await admin.query('create database "tidebase_test_embed"')
  }
  await admin.end()

  embedCtx = createContext({ connectionString: embedUrl.toString() })
  await migrate(embedCtx.pool)
  const tables = await embedCtx.pool.query(
    `select tablename from pg_tables
     where schemaname = 'public' and tablename <> 'schema_migrations'`
  )
  const names = tables.rows.map((r) => `"${r.tablename}"`).join(', ')
  await embedCtx.pool.query(`truncate ${names} restart identity cascade`)
})

afterAll(async () => {
  await embedCtx.close()
})

describe('embedded multi-database contexts', () => {
  it('isolates runs between contexts in the same process', async () => {
    const defaultApp = createApp()
    const embedApp = createApp(embedCtx)

    const runA = await createRun(defaultApp, 'embed-default-wf')
    const runB = await createRun(embedApp, 'embed-tenant-wf')
    expect(runA.id).not.toBe(runB.id)

    const crossA = await api(embedApp, 'GET', `/runs/${runA.id}`)
    expect(crossA.status).toBe(404)
    const crossB = await api(defaultApp, 'GET', `/runs/${runB.id}`)
    expect(crossB.status).toBe(404)

    const ownB = await api(embedApp, 'GET', `/runs/${runB.id}`)
    expect(ownB.status).toBe(200)
    expect(ownB.body.run.workflowName).toBe('embed-tenant-wf')
  })

  it('applies per-context API keys independently', async () => {
    const openApp = createApp()
    const lockedApp = createApp({ ...embedCtx, apiKey: 'tenant-key' })

    const denied = await api(lockedApp, 'GET', '/runs')
    expect(denied.status).toBe(401)
    const allowed = await api(lockedApp, 'GET', '/runs', undefined, {
      authorization: 'Bearer tenant-key'
    })
    expect(allowed.status).toBe(200)
    const open = await api(openApp, 'GET', '/runs')
    expect(open.status).toBe(200)
  })

  it('scopes reconciler ticks to their own context', async () => {
    const embedApp = createApp(embedCtx)

    const enqueued = await api(embedApp, 'POST', '/queues/embed-q/enqueue', {
      workflowName: 'embed-queued-wf',
      maxAttempts: 3
    })
    expect(enqueued.status).toBe(200)
    const runId = enqueued.body.run.id as string

    const claimed = await api(embedApp, 'POST', '/queues/claim', { queues: ['embed-q'] })
    expect(claimed.body.runs).toHaveLength(1)
    await embedCtx.pool.query(
      `update runs set lease_expires_at = now() - interval '1 second' where id = $1`,
      [runId]
    )

    // The embed database has no competing tickers, so one tick is decisive —
    // unlike the shared test database, where parallel files contend for the
    // (database-scoped) tick lock.
    const report = await reconcileTick(new Date(), embedCtx)
    expect(report).not.toBeNull()
    expect(report!.requeued).toBe(1)

    const after = await api(embedApp, 'GET', `/runs/${runId}`)
    expect(after.body.run.status).toBe('queued')
  })
})
