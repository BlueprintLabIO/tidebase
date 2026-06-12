# MCP gateway example — wrap any MCP agent with Tidebase

`tidebase-wrap` is a ~100-line stdio proxy that sits between an MCP-speaking agent (Claude Code, a custom harness, an ACP sidecar) and its MCP server. The agent's config changes by one entry; the agent itself doesn't change. The operator gets:

- **Every tool call as a checkpointed step** — name, arguments, result in your Postgres and the Studio timeline. A retried identical call replays from the checkpoint instead of re-executing.
- **Durable approval gates** on tools you name (`TIDEBASE_GATED_TOOLS`) — the call parks until approved from Studio or a webhook channel; the agent is told to retry, and the retry converges on the same gate's decision.
- **Crash detection for free** — the session holds a run lease with a background heartbeat; if the wrapper dies, the lease expires and the reconciler marks the run for recovery.

Built entirely on the public SDK's v0.6 session-runs surface (`tide.runs.attach`, `session.gates.begin`) — no private APIs, no agent-specific code.

## Try it

With the dev server up (`docker compose up -d postgres && pnpm server`):

```bash
pnpm --filter @tidebase/example-mcp-gateway smoke
```

The smoke test drives the gateway like an agent: wraps `@modelcontextprotocol/server-everything`, lists tools through the proxy, calls `echo` twice with identical arguments (asserts one checkpoint, not two), calls a gated tool (asserts it parks pending), then verifies the run record over the API.

## Use it with a real agent

Point the agent's MCP config at the wrapper instead of the real server:

```json
"github": {
  "command": "npx",
  "args": ["tsx", "path/to/gateway.ts", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
  "env": { "TIDEBASE_GATED_TOOLS": "create_pull_request,push_files" }
}
```

Set `TIDEBASE_RUN_ID` to give a long-lived agent a stable run record across restarts. Approve pending gates from Studio (`pnpm studio`) — the agent's next retry of the same call goes through.

## Honest limits

- Replay dedup applies to *identical re-issued calls* (same tool, same arguments). Resuming the agent's own conversation is the harness's job; the gateway makes the side effects around it safe.
- Identical read calls dedupe within a run — a feature for reads; salt the step name if a tool must re-execute per call.
- The full pattern and tradeoffs: <https://tidebase.dev/docs/integrate/mcp-agents/>
