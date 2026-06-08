import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { migrate } from './db.js'

const port = Number(process.env.PORT ?? 7373)

await migrate()

serve({
  fetch: createApp().fetch,
  port
})

console.log(`Tidebase server listening on http://localhost:${port}`)
