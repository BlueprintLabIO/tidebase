import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://tidebase:tidebase@localhost:7432/tidebase'
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationPath = resolve(__dirname, '../../../migrations/001_init.sql')

export async function migrate() {
  const sql = await readFile(migrationPath, 'utf8')
  await pool.query(sql)
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
