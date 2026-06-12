import { readFile, readdir } from 'node:fs/promises'
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

  // Apply every migration in order, mirroring the server's runner.
  const client = new pg.Client({ connectionString: testDatabaseUrl })
  await client.connect()
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations')
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await client.query(await readFile(resolve(migrationsDir, file), 'utf8'))
  }
  await client.end()
}
