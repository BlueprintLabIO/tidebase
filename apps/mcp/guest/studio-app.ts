/**
 * Tidebase Studio guest — a real MCP-App. Runs inside the host's sandboxed
 * iframe, connects to the host over the MCP-Apps protocol (ui/initialize
 * handshake via PostMessageTransport), and calls server tools through the host
 * (which routes them through governance). Bundled self-contained by esbuild and
 * inlined into the ui:// resource — no CDN, no external deps at runtime.
 */
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps'

type Run = { id: string; status?: string; workflowName?: string; workflow_name?: string }

const STYLES = `
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 12px; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 8px; margin-bottom: 6px; }
  .muted { opacity: 0.6; }
  .status { font-weight: 600; }
  .status.running { color: #2563eb; } .status.completed { color: #16a34a; }
  .status.failed { color: #dc2626; } .status.cancelled { color: #d97706; }
  .err { color: #dc2626; white-space: pre-wrap; }
`

function el(tag: string, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

async function callJson(app: App, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await app.callServerTool({ name, arguments: args })
  const blocks = (res.content as Array<{ type?: string; text?: string }> | undefined) ?? []
  const text = blocks.find((b) => typeof b.text === 'string')?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function loadRuns(app: App) {
  const statusEl = document.getElementById('status')!
  const runsEl = document.getElementById('runs')!
  try {
    const data = await callJson(app, 'tidebase_list_runs', { limit: 20 })
    const runs: Run[] = (data && data.runs) || []
    document.getElementById('count')!.textContent = '(' + runs.length + ')'
    statusEl.style.display = 'none'
    runsEl.innerHTML = ''
    if (!runs.length) runsEl.appendChild(el('div', 'muted', 'No runs yet.'))
    for (const run of runs) {
      const row = el('div', 'row')
      row.appendChild(el('span', 'status ' + (run.status || ''), run.status || '?'))
      row.appendChild(el('span', undefined, run.workflowName || run.workflow_name || run.id))
      row.appendChild(el('span', 'muted', String(run.id).slice(0, 18)))
      runsEl.appendChild(row)
    }
  } catch (err: any) {
    statusEl.className = 'err'
    statusEl.textContent = 'Failed to load runs: ' + (err?.message || err)
  }
}

async function main() {
  document.body.innerHTML =
    `<style>${STYLES}</style>` +
    `<h1>Tidebase Studio <span id="count" class="muted"></span></h1>` +
    `<div id="status" class="muted">Connecting…</div>` +
    `<div id="runs"></div>`

  const app = new App({ name: 'tidebase-studio', version: '0.1.0' }, {})
  await app.connect() // ui/initialize handshake over PostMessageTransport
  document.getElementById('status')!.textContent = 'Loading runs…'
  await loadRuns(app)
}

main().catch((err: any) => {
  document.body.innerHTML = `<pre class="err">Studio crashed: ${err?.message || err}</pre>`
})
