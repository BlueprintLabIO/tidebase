// Standalone migration entry: `pnpm migrate` (or node dist/migrate.js).
import { migrate, pool } from './db.js'

const applied = await migrate()
console.log(applied.length === 0 ? 'no pending migrations' : `applied ${applied.length} migration(s)`)
await pool.end()
