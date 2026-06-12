import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://tidebase:tidebase@localhost:7432/tidebase'
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(__dirname, '../../../migrations')

// Versioned migration runner. Files in migrations/ are applied in
// lexicographic order, exactly once, recorded in schema_migrations, under an
// advisory lock so concurrent replicas can boot safely. Run standalone with
// `pnpm migrate`; set TIDEBASE_AUTO_MIGRATE=0 to forbid boot-time DDL and
// fail fast when migrations are pending (expand/contract deploy discipline).
const MIGRATION_LOCK = 0x74646201 // 'tdb' 01

export async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`
    )
    const appliedResult = await client.query('select name from schema_migrations')
    const applied = new Set(appliedResult.rows.map((row) => row.name))
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
    const pending = files.filter((f) => !applied.has(f))
    for (const file of pending) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        console.log(`migrated ${file}`)
      } catch (error) {
        await client.query('rollback')
        throw new Error(`migration ${file} failed: ${(error as Error).message}`)
      }
    }
    return pending
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined)
    client.release()
  }
}

export async function pendingMigrations() {
  const exists = await pool.query(
    `select 1 from information_schema.tables where table_name = 'schema_migrations'`
  )
  const applied = exists.rows[0]
    ? new Set(
        (await pool.query('select name from schema_migrations')).rows.map((r) => r.name)
      )
    : new Set<string>()
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  return files.filter((f) => !applied.has(f))
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>) {
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
}
