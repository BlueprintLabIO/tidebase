import { createServer } from 'node:http'
import { Tidebase } from '@tidebase/sdk'
import { researchReport } from './workflows.js'

const tide = new Tidebase()

tide.workflow('research-report', researchReport)

const handler = tide.webhook()
const port = Number(process.env.PORT ?? 8787)

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/tidebase') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const response = await handler(
    new Request(`http://localhost:${port}/tidebase`, {
      method: 'POST',
      headers: req.headers as HeadersInit,
      body: Buffer.concat(chunks)
    })
  )

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(port)

console.log(`Example Tidebase webhook listening on http://localhost:${port}/tidebase`)
