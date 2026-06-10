import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const testDatabaseUrl =
  process.env.TIDEBASE_TEST_DATABASE_URL ??
  'postgres://tidebase:tidebase@localhost:7432/tidebase_test'

export default async function setup() {
  const url = new URL(testDatabaseUrl)
  const testDbName = url.pathname.slice(1)
  const adminUrl = new URL(testDatabaseUrl)
  adminUrl.pathname = '/postgres'

  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  const exists = await admin.query('select 1 from pg_database where datname = $1', [testDbName])
  if (exists.rows.length === 0) {
    await admin.query(`create database "${testDbName}"`)
  }
  await admin.end()

  const client = new pg.Client({ connectionString: testDatabaseUrl })
  await client.connect()
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../migrations/001_init.sql'
  )
  await client.query(await readFile(migrationPath, 'utf8'))
  await client.end()
}
