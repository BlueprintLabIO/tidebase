import { createServer, type ServerResponse } from 'node:http'

type GateReview = {
  id: string
  runId: string
  name: string
  prompt: string
  data: unknown
  capability: unknown
  resolveUrl: string
  resolveToken: string
}

const port = Number(process.env.PORT ?? 8788)
const reviews = new Map<string, GateReview>()

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  if (req.method === 'POST' && url.pathname === '/tidebase-events') {
    const body = await readBody(req)
    const event = JSON.parse(body) as {
      type: string
      payload?: { gate?: GateReview }
    }
    if (event.type === 'gate.created' && event.payload?.gate) {
      reviews.set(event.payload.gate.id, event.payload.gate)
      console.log(`Gate pending: http://localhost:${port}/`)
      console.log(`- ${event.payload.gate.prompt}`)
    }
    return json(res, { ok: true })
  }

  const match = url.pathname.match(/^\/gates\/([^/]+)\/(approved|rejected)$/)
  if (req.method === 'POST' && match) {
    const [, gateId, decision] = match
    const gate = reviews.get(gateId)
    if (!gate) return json(res, { error: 'gate not found' }, 404)
    const response = await fetch(gate.resolveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: gate.resolveToken,
        decision,
        actor: 'local-review',
        payload: { source: 'example-review' }
      })
    })
    if (!response.ok) return json(res, { error: await response.text() }, 502)
    reviews.delete(gateId)
    res.writeHead(303, { location: '/' })
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderPage())
    return
  }

  json(res, { error: 'not found' }, 404)
}).listen(port)

console.log(`Example review channel listening on http://localhost:${port}/`)
console.log(`Use TIDEBASE_CHANNEL_WEBHOOK=http://localhost:${port}/tidebase-events`)

function renderPage() {
  const gates = [...reviews.values()]
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tidebase Review</title>
    <style>
      body { background: #f7f1df; color: #092735; font: 15px/1.5 ui-sans-serif, system-ui; margin: 0; padding: 32px; }
      main { max-width: 820px; margin: 0 auto; }
      h1 { font-size: 34px; margin: 0 0 6px; }
      .gate { background: #fffaf0; border: 1px solid #b7ccc8; border-radius: 8px; margin-top: 18px; padding: 18px; }
      pre { background: #061f2b; border-radius: 7px; color: #dffdf9; overflow: auto; padding: 12px; }
      form { display: inline-flex; margin-right: 8px; }
      button { border: 1px solid #5e8990; border-radius: 7px; cursor: pointer; font-weight: 800; min-height: 36px; padding: 0 12px; }
      .approve { background: #dff7e9; color: #087f58; }
      .reject { background: #ffe0da; color: #bb3d32; }
      .empty { border: 1px dashed #5e8990; border-radius: 8px; margin-top: 18px; padding: 18px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tidebase Review</h1>
      <p>Local channel adapter for gate approvals.</p>
      ${gates.length === 0 ? '<div class="empty">No pending gates.</div>' : gates.map(renderGate).join('')}
    </main>
  </body>
</html>`
}

function renderGate(gate: GateReview) {
  return `<section class="gate">
  <h2>${escapeHtml(gate.name)}</h2>
  <p>${escapeHtml(gate.prompt)}</p>
  <pre>${escapeHtml(JSON.stringify({ runId: gate.runId, data: gate.data, capability: gate.capability }, null, 2))}</pre>
  <form method="post" action="/gates/${gate.id}/approved"><button class="approve">Approve</button></form>
  <form method="post" action="/gates/${gate.id}/rejected"><button class="reject">Reject</button></form>
</section>`
}

async function readBody(req: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
