import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { defaultContext } from './context.js'
import { migrate, pendingMigrations } from './db.js'
import { startReconciler } from './reconciler.js'

const port = Number(process.env.PORT ?? 7373)
const autoMigrate = process.env.TIDEBASE_AUTO_MIGRATE !== '0'

const ctx = defaultContext()

if (autoMigrate) {
  await migrate(ctx.pool)
} else {
  const pending = await pendingMigrations(ctx.pool)
  if (pending.length > 0) {
    console.error(
      `refusing to start: ${pending.length} pending migration(s) (${pending.join(', ')}). ` +
        'Run `pnpm migrate` (node dist/migrate.js) first, or unset TIDEBASE_AUTO_MIGRATE=0.'
    )
    process.exit(1)
  }
}

serve({
  fetch: createApp(ctx).fetch,
  port
})

startReconciler(ctx)

console.log(`Tidebase server listening on http://localhost:${port}`)
