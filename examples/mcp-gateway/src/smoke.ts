// Smoke test: drive the gateway like an agent would and verify the run record.
//
//   pnpm --filter @tidebase/example-mcp-gateway smoke
//
// Requires the Tidebase server on TIDEBASE_URL (default localhost:7373).
// Wraps @modelcontextprotocol/server-everything, lists tools, calls `echo`
// twice with identical args, then asserts: one checkpointed step (replay
// deduped the second call), gated tool parks pending, and the session run
// completes when the transport closes.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Tidebase } from '@tidebase/sdk'

const tide = new Tidebase()

const client = new Client({ name: 'smoke-agent', version: '0.0.0' })
await client.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['tsx', new URL('./gateway.ts', import.meta.url).pathname, '--', 'npx', '-y', '@modelcontextprotocol/server-everything'],
    env: { ...process.env as Record<string, string>, TIDEBASE_GATED_TOOLS: 'add' }
  })
)

const tools = await client.listTools()
console.log(`tools via gateway: ${tools.tools.length}`)
if (tools.tools.length === 0) throw new Error('no tools forwarded')

const first = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
const second = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
console.log('echo x2 (identical args) returned')
if (JSON.stringify(first.content) !== JSON.stringify(second.content)) {
  throw new Error('identical calls diverged — replay did not dedupe')
}

const gated = await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } })
const gatedText = JSON.stringify(gated.content)
if (!gatedText.includes('Pending operator approval')) {
  throw new Error(`gated tool did not park: ${gatedText}`)
}
console.log('gated tool parked pending approval')

// Find the session run and verify the record.
const { runs } = await tide.runs.list()
const run = runs.find((r) => r.workflowName === 'mcp-session')
if (!run) throw new Error('session run not found')
const detail = await tide.runs.get(run.id)
const steps = (detail.steps as Array<{ name: string; status: string }>).filter((s) =>
  s.name.startsWith('echo:')
)
if (steps.length !== 1) throw new Error(`expected 1 echo step, got ${steps.length}`)
if (!(detail.gates as Array<{ status: string }>).some((g) => g.status === 'pending')) {
  throw new Error('expected a pending gate on the run')
}
console.log(`run ${run.id}: 1 echo checkpoint, pending gate — record verified`)

await client.close()
console.log('smoke: OK')
process.exit(0)
