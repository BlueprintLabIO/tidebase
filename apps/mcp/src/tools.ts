/**
 * Tidebase product MCP tools — a thin adapter over the Tidebase REST API. The
 * server authenticates with the admin key (TIDEBASE_API_KEY); these are the
 * read/operate surface that a host (e.g. Aura) renders as a control-plane app.
 */
const TIDEBASE_URL = (process.env.TIDEBASE_URL ?? 'http://localhost:7373').replace(/\/$/, '')
const TIDEBASE_API_KEY = process.env.TIDEBASE_API_KEY

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (TIDEBASE_API_KEY) headers.authorization = `Bearer ${TIDEBASE_API_KEY}`
  const res = await fetch(`${TIDEBASE_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000)
  })
  const text = await res.text()
  const json = text ? safeJson(text) : null
  if (!res.ok) throw new Error(`Tidebase ${path} -> ${res.status}: ${typeof json === 'object' ? JSON.stringify(json) : text}`)
  return json
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'tidebase_list_runs',
    description: 'List recent agent runs (id, workflow, status, timestamps).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'tidebase_get_run',
    description: 'Get a single run with its steps, gates, grants and event timeline.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }
  },
  {
    name: 'tidebase_audit',
    description: 'Read grant.* audit receipts (authorization ledger), optionally scoped to a run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, limit: { type: 'number' } } }
  },
  {
    name: 'tidebase_approve_gate',
    description: 'Resolve a pending approval gate (approve or reject) using its resolve token.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        gateId: { type: 'string' },
        token: { type: 'string' },
        decision: { type: 'string', enum: ['approved', 'rejected'] }
      },
      required: ['runId', 'gateId', 'token']
    }
  }
]

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'tidebase_list_runs': {
      const data = (await api('/runs')) as { runs?: unknown[] } | unknown[]
      const runs = Array.isArray(data) ? data : (data?.runs ?? [])
      const limit = typeof args.limit === 'number' ? args.limit : 20
      return { runs: (runs as unknown[]).slice(0, limit) }
    }
    case 'tidebase_get_run': {
      if (typeof args.runId !== 'string') throw new Error('runId is required')
      return api(`/runs/${encodeURIComponent(args.runId)}`)
    }
    case 'tidebase_audit': {
      const qs = new URLSearchParams()
      if (typeof args.runId === 'string') qs.set('runId', args.runId)
      qs.set('limit', String(typeof args.limit === 'number' ? args.limit : 50))
      return { receipts: await api(`/audit?${qs.toString()}`) }
    }
    case 'tidebase_approve_gate': {
      if (typeof args.runId !== 'string' || typeof args.gateId !== 'string' || typeof args.token !== 'string') {
        throw new Error('runId, gateId and token are required')
      }
      return api(`/runs/${encodeURIComponent(args.runId)}/gates/${encodeURIComponent(args.gateId)}/resolve`, {
        method: 'POST',
        body: {
          token: args.token,
          decision: args.decision === 'rejected' ? 'rejected' : 'approved',
          actor: 'tidebase-studio'
        }
      })
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}
