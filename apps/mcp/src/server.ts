import { STUDIO_URI, studioResource } from './ui.js'
import { TOOL_DEFS, callTool } from './tools.js'

/**
 * Minimal MCP-over-plain-JSON-RPC handler (the same subset Aura's capability
 * client speaks): initialize, ping, tools/list, tools/call, plus resources/list
 * and resources/read so a host can fetch the ui:// Studio app.
 */
const MCP_PROTOCOL_VERSION = '2025-06-18'

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value }
}
function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
function toolText(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError }
}

export async function handleMcp(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const out: JsonRpcResponse[] = []
    for (const entry of body) {
      const r = await handleSingle(entry as JsonRpcRequest)
      if (r) out.push(r)
    }
    return out.length ? out : null
  }
  return handleSingle(body as JsonRpcRequest)
}

async function handleSingle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return error(null, -32600, 'invalid JSON-RPC request')
  }
  const id = req.id ?? null
  const isNotification = req.id === undefined
  const params = req.params ?? {}

  switch (req.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'tidebase-studio', version: '0.1.0' }
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools: TOOL_DEFS })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        return result(id, toolText(await callTool(name, args)))
      } catch (e) {
        // Tool-level failure → tool result the caller can read (MCP convention).
        return result(id, toolText({ error: e instanceof Error ? e.message : String(e) }, true))
      }
    }
    case 'resources/list':
      return result(id, {
        resources: [
          { uri: STUDIO_URI, name: 'Tidebase Studio', description: 'Runs, grants, approvals', mimeType: 'text/html' }
        ]
      })
    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : ''
      if (uri !== STUDIO_URI) return error(id, -32602, `unknown resource ${uri}`)
      // studioResource() returns an MCP embedded-resource block { type:'resource', resource:{...} }.
      const res = studioResource() as { resource: unknown }
      return result(id, { contents: [res.resource] })
    }
    default:
      if (isNotification) return null
      return error(id, -32601, `method not found: ${req.method}`)
  }
}
