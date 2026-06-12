// A ServerContext carries everything that varies per Tidebase instance: the
// Postgres pool and the config that used to live in module-level env reads
// (API key, webhook secret, public URL, lease window). The default boot path
// (index.ts) builds one from the environment, so self-hosted behavior is
// unchanged. Embedders can create many contexts in one process — one per
// tenant database — and pass each to createApp()/reconcileTick(); every
// advisory lock Tidebase takes is scoped to the context's database, so
// instances never interfere.
import pg from 'pg'
import { pool as defaultPool } from './db.js'

export type ServerContext = {
  pool: pg.Pool
  apiKey?: string
  webhookSecret?: string
  publicUrl: string
  leaseMs: number
  tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>
  /** Ends the pool iff this context created it (not when one was passed in). */
  close(): Promise<void>
}

export type CreateContextOptions = {
  /** Use an existing pool; close() will not end it. */
  pool?: pg.Pool
  /** Connection string for a context-owned pool. Defaults to DATABASE_URL. */
  connectionString?: string
  /** Max connections for a context-owned pool. */
  maxConnections?: number
  apiKey?: string
  webhookSecret?: string
  publicUrl?: string
  leaseMs?: number
}

export function createContext(options: CreateContextOptions = {}): ServerContext {
  const ownedPool = options.pool
    ? null
    : new pg.Pool({
        connectionString:
          options.connectionString ??
          process.env.DATABASE_URL ??
          'postgres://tidebase:tidebase@localhost:7432/tidebase',
        ...(options.maxConnections ? { max: options.maxConnections } : {})
      })
  const pool = options.pool ?? ownedPool!
  return {
    pool,
    apiKey: options.apiKey ?? process.env.TIDEBASE_API_KEY,
    webhookSecret: options.webhookSecret ?? process.env.TIDEBASE_WEBHOOK_SECRET,
    publicUrl: (
      options.publicUrl ??
      process.env.TIDEBASE_PUBLIC_URL ??
      `http://localhost:${process.env.PORT ?? 7373}`
    ).replace(/\/$/, ''),
    leaseMs: options.leaseMs ?? Number(process.env.TIDEBASE_LEASE_MS ?? 60_000),
    async tx(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await fn(client)
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    },
    async close() {
      if (ownedPool) await ownedPool.end()
    }
  }
}

/** Env-configured context over the shared default pool (db.ts). */
export function defaultContext(): ServerContext {
  return createContext({ pool: defaultPool })
}
