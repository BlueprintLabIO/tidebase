#!/usr/bin/env tsx
// tidebase-wrap: a Tidebase-backed MCP gateway.
//
//   tidebase-wrap -- <command that starts the real MCP server>
//
// Sits between an MCP-speaking agent (Claude Code, a custom harness, an ACP
// sidecar) and its MCP server. The agent's config changes by one entry; the
// agent itself does not change. Every tool call becomes a checkpointed step
// in your Postgres, tools named in TIDEBASE_GATED_TOOLS park at durable
// approval gates, and the session run carries the audit trail.
//
// Environment:
//   TIDEBASE_URL          Tidebase server (default http://localhost:7373)
//   TIDEBASE_RUN_ID       resume an existing session's run record
//   TIDEBASE_GATED_TOOLS  comma-separated tool names that require approval
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { createHash } from 'node:crypto'
import { Tidebase } from '@tidebase/sdk'

const separator = process.argv.indexOf('--')
if (separator === -1 || separator === process.argv.length - 1) {
  console.error('usage: tidebase-wrap -- <command that starts the real MCP server>')
  process.exit(1)
}
const [cmd, ...args] = process.argv.slice(separator + 1)
const GATED = (process.env.TIDEBASE_GATED_TOOLS ?? '').split(',').filter(Boolean)

const upstream = new Client({ name: 'tidebase-wrap', version: '0.6.0' })
await upstream.connect(new StdioClientTransport({ command: cmd, args }))

const tide = new Tidebase()
const session = await tide.runs.attach('mcp-session', {
  runId: process.env.TIDEBASE_RUN_ID,
  input: { cmd, args },
  onLeaseLost: (error) => {
    // The server now fences this session's writes; surface why and stop.
    console.error(`tidebase-wrap: run lease lost (${error.message})`)
  }
})
console.error(`tidebase-wrap: session run ${session.runId}`)

const server = new Server(
  { name: 'tidebase-wrap', version: '0.6.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools())

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  // Content-keyed identity: a retried identical call lands on the same
  // checkpoint (and the same gate), so replays converge instead of forking.
  const key = createHash('sha256')
    .update(JSON.stringify(params.arguments ?? {}))
    .digest('hex')
    .slice(0, 8)

  if (GATED.includes(params.name)) {
    const gate = await session.gates.begin(`approve:${params.name}:${key}`, {
      prompt: `Agent wants to call ${params.name}`,
      data: params.arguments
    })
    if (gate.status === 'pending') {
      // MCP clients enforce tool timeouts; never block on a human here.
      return {
        content: [
          {
            type: 'text',
            text: 'Pending operator approval — retry this exact call once approved.'
          }
        ],
        isError: true
      }
    }
    if (gate.decision !== 'approved') {
      return { content: [{ type: 'text', text: 'Denied by operator.' }], isError: true }
    }
  }

  return session.step(
    `${params.name}:${key}`,
    { input: params.arguments, sideEffects: [params.name] },
    () => upstream.callTool(params)
  )
})

await server.connect(new StdioServerTransport())

process.stdin.on('close', async () => {
  try {
    await session.complete({})
  } finally {
    process.exit(0)
  }
})
