import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handleMcp } from './server.js'

/**
 * Tidebase product MCP server (standalone). Exposes the control-plane tools +
 * the ui:// Studio app over the same plain-JSON-RPC subset Aura's capability
 * client speaks. Reaches the Tidebase server via TIDEBASE_URL / TIDEBASE_API_KEY.
 */
const port = Number(process.env.MCP_PORT ?? 7377)
const app = new Hono()
app.use('*', cors())
app.get('/health', (c) => c.json({ ok: true, server: 'tidebase-mcp' }))

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const response = await handleMcp(body)
  if (response === null) return c.body(null, 202) // notification(s) only
  return c.json(response)
})

serve({ fetch: app.fetch, port })
console.log(`Tidebase MCP server listening on http://localhost:${port} (target: ${process.env.TIDEBASE_URL ?? 'http://localhost:7373'})`)
