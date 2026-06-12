<p align="center">
  <img src="apps/studio/static/tidebase-mark.svg" alt="Tidebase" width="56" height="56" />
</p>

<h1 align="center">Tidebase</h1>

<p align="center">
  Checkpoints, queues, schedules, gates, live state, and cancellation for agent workflows — in your own Postgres.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0aabc0.svg" alt="License: Apache-2.0"></a>
  <a href="https://github.com/BlueprintLabIO/tidebase/releases"><img src="https://img.shields.io/github/v/release/BlueprintLabIO/tidebase?color=0aabc0" alt="Latest release"></a>
  <a href="https://github.com/BlueprintLabIO/tidebase/actions/workflows/ci.yml"><img src="https://github.com/BlueprintLabIO/tidebase/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/SDK-TypeScript%20%C2%B7%20Python-0e6f80.svg" alt="TypeScript and Python SDKs">
  <img src="https://img.shields.io/badge/storage-Postgres-0e6f80.svg" alt="Postgres storage">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#api-shape">API</a>
  ·
  <a href="#what-tidebase-stores">Storage contract</a>
  ·
  <a href="#current-scope">Scope</a>
</p>

![Tidebase Studio](docs/assets/dashboard-shot.png)

Tidebase is an open-source checkpoint layer for AI agents: wrap your steps, and failed runs resume from the last safe point — in your own Postgres, without moving execution into a new runtime.

Your code still runs in your app, worker, or job process. Tidebase stores checkpoints, state, events, gates, channel deliveries, recovery attempts, and usage records in Postgres, so "this run died at step 7 — is it safe to rerun?" always has an answer.

Docs: <https://tidebase.dev> · Community: [Discord](https://discord.gg/JQ5sutdP8Y) · For AI assistants: [/llms.txt](https://tidebase.dev/llms.txt)

## Why Tidebase

Agent products usually grow the same operational plumbing:

- status tables for runs and steps
- checkpoint blobs for partial progress
- retry flags and manual-review states
- progress streaming to the UI
- approval gates for risky actions
- token and cost ledgers
- webhook glue for recovery and external review surfaces

Tidebase packages that layer around your existing code. It is not an LLM proxy, queue, hosted worker runtime, or secret broker.

## Quick Start

**Fastest path (no Node needed)** — prebuilt server image:

```bash
docker compose --profile server up -d   # Postgres + ghcr.io/blueprintlabio/tidebase on :7373
```

Then point any SDK at `http://localhost:7373` (`npm i @tidebase/sdk` or `pip install tidebase`).

**Dev setup (server + Studio from source):**

Start Postgres:

```bash
docker compose up -d postgres
```

Install dependencies:

```bash
pnpm install
```

Run the server and Studio:

```bash
pnpm dev
```

- Server: http://localhost:7373
- Studio: http://localhost:5173

Run the example workflow:

```bash
pnpm example
```

Force a failure after two completed checkpoints:

```bash
FAIL_WRITE=1 pnpm example
```

Copy the run id from Studio or the API, then resume:

```bash
TIDEBASE_RUN_ID=run_xxx pnpm example
```

The `plan` and `fetch-sources` steps are returned from checkpoints. Only `write-report` executes again.

<p align="center">
  <img src="docs/assets/crash-resume.gif" width="820" alt="Kill the process mid-run, re-invoke with the same run id, and the workflow resumes from the last checkpoint">
</p>

## Using Tidebase with AI coding agents

Make every AI session in your project use Tidebase correctly:

```bash
npx @tidebase/sdk init        # writes a Tidebase section into AGENTS.md/CLAUDE.md (idempotent)
```

Give your assistant direct access to runs, gates, and recovery via MCP:

```bash
claude mcp add tidebase -e TIDEBASE_URL=http://localhost:7373 -- npx -y @tidebase/mcp
```

Or install the Claude Code plugin (skill + MCP server in one):

```
/plugin marketplace add BlueprintLabIO/tidebase
/plugin install tidebase@tidebase
```

Agent-readable docs live at [tidebase.dev/llms.txt](https://tidebase.dev/llms.txt); every docs page also serves a raw `.md` twin.

## Queues, schedules, and cancellation (v0.5)

Tidebase can now decide **when** your code runs — while still never executing it:

```typescript
// durable queue: dedupe, delay, retries with backoff, concurrency caps
await tide.enqueue('generate-report', {
  queue: 'reports',
  input: { topic },
  dedupeKey: `report:${topic}`,
  maxAttempts: 3,
  deadlineMs: 600_000
})

// pull-mode worker: claims ready runs and executes registered workflows
tide.workflow('generate-report', generateReport)
await tide.work({ queues: ['reports'] })

// cron (UTC, 5-field) — double-fires are structurally impossible
await tide.schedules.set('daily-digest', {
  cron: '0 9 * * *',
  workflowName: 'daily-digest'
})

// authoritative, one-way cancellation — workers observe it at step/gate
// boundaries; complete/fail can never resurrect a cancelled run
await tide.runs.cancel(runId, { reason: 'customer asked', actor: 'support' })
```

Push-mode dispatch is also available: configure a queue with an `invokeUrl` and Tidebase delivers signed `run.invoke` webhooks to your app instead of waiting for a claim. A queued job IS a run — `queued` is a lifecycle state, not a second table — so status never drifts.

See [docs/production.md](docs/production.md) for the full lifecycle, replay contract, worker-death recovery model, and deploy discipline (versioned migrations via `pnpm migrate`, `TIDEBASE_AUTO_MIGRATE=0` for expand/contract deploys).

## Testing

```bash
pnpm test
```

The suite (84 TypeScript tests + 9 Python integration tests, run in CI on every push) uses the same Postgres in an isolated `tidebase_test` database. It is invariant-driven rather than coverage-driven: every test asserts a durability or safety guarantee through the public API or SDK, against real Postgres, including concurrency probes for the guarantees that only matter under contention.

What it proves:

- completed steps replay from storage and never re-execute, including across crash + recovery-webhook resume
- step and run leases are mutually exclusive and fenced — zombie workers cannot write back stale results
- input-hash drift on replay is rejected before it can corrupt a run
- failure classification honors the resume contract: unkeyed external writes park in `manual_review`, idempotency-keyed and read-only steps are `safe_replay`
- per-run event logs are gap-free and strictly ordered under concurrent writers
- gates resolve exactly once, require the resolve token, and replay their decision on resume
- child runs are idempotent by edge name, so resumed fanouts reuse children
- recovery webhooks and channel deliveries are HMAC-signed; the SDK rejects unsigned, tampered, or forged payloads
- a slow or hung channel endpoint never blocks other writers to the run

See [docs/testing.md](docs/testing.md) for the full invariant map and conventions.

## API Shape

```typescript
import { Tidebase } from '@tidebase/sdk'

const tide = new Tidebase()

await tide.run('generate-report', { runId }, async (run, input) => {
  const plan = await run.step('plan', () => makePlan(input))

  await run.state.set({
    status: 'writing',
    progress: 0.7
  })

  return run.step('write-report', () => writeReport(plan))
})
```

## Session Runs

`tide.run()` fits work shaped like a function. For open-ended execution — a protocol gateway in front of an agent, a REPL, a run that spans many requests — attach to a run as a session instead:

```typescript
const session = await tide.runs.attach('mcp-session', { input: { agent: 'hermes' } })

// session is a RunContext: step/gate/state/usage/snapshots all work unchanged
await session.step('tool-call', { input: args }, () => callTool(args))

await session.complete({ calls: 12 }) // or session.fail(err)
```

The session holds the run lease with a background heartbeat (`heartbeatMs`, default 20s). If the process dies, the heartbeat stops, the lease expires, and the reconciler takes over — requeue or recovery webhook, exactly as if a workflow worker had crashed. A session that loses its lease (`onLeaseLost`) is a zombie: the server fences its writes. Pass `runId` to resume an existing session's run; completed steps replay from storage.

For a complete worked example — an MCP gateway that wraps any agent's MCP server in checkpointed tool calls and durable approval gates with one config-line change — see [`examples/mcp-gateway/`](examples/mcp-gateway/).

## Resume Contracts

Each step can declare the operational contract Tidebase should record for replay:

```typescript
await run.step(
  'send-email',
  {
    input: { userId },
    sideEffects: ['email.send'],
    idempotencyKey: `welcome:${userId}`,
    replay: 'auto',
    checkpointInvariant: 'provider accepted the message id',
    verifiedBy: 'email provider response'
  },
  () => sendWelcomeEmail(userId)
)
```

Tidebase records that contract with the step and shows it in Studio. Final step failures are classified as:

- `failed_retryable` when SDK retries remain.
- `manual_review` when replay is manual, or when side effects exist without an idempotency key.
- `failed` for hard failures.

This does not make external systems exactly-once. It makes the resume decision explicit instead of hiding it in logs and custom retry flags.

## Versioned State And Snapshots

`run.state.set()` and `run.state.patch()` still update the current live run state. In v0.2 they also append a version to Tidebase's state history.

```typescript
await run.state.patch({
  status: 'writing',
  progress: 0.7
})
```

You can label the current state when it becomes a meaningful review or restore point:

```typescript
await run.state.save('before-approval', {
  reason: 'the user is about to approve sending'
})
```

Snapshots are a convenience API over labeled state versions for external targets such as reports, artifacts, workspaces, documents, or app state:

```typescript
await run.snapshots.create('draft-v1', {
  target: { type: 'report', id: reportId },
  state: draft,
  reason: 'first complete draft'
})
```

The model is intentionally small:

```text
current state = latest version in a stream
snapshot = labeled state version
time travel = read an older version
fork = create new app/run context from an older version
restore = append a new version based on an older version
```

Tidebase stores and exposes the versions. Your app decides what restore or fork means for its own state targets.

<p align="center">
  <img src="docs/assets/time-travel.gif" width="820" alt="Rewind a run to an earlier step, swap the model, and fork a new branch — completed steps replay from checkpoints">
</p>

## Child Runs And Fanout

Longer agent workflows often fan out to subagents and rejoin their results. Tidebase v0.2 models that as parent/child run edges plus a checkpointed join step.

```typescript
const results = await run.fanout('research-options', [
  {
    name: 'flights',
    workflow: researchFlights,
    input: { destination }
  },
  {
    name: 'hotels',
    workflow: researchHotels,
    input: { destination }
  },
  {
    name: 'food',
    workflow: researchFood,
    input: { destination }
  }
])
```

Child run creation is idempotent by parent run and edge name. If the parent resumes, Tidebase returns the existing child runs instead of creating duplicates. The joined result is stored in a normal checkpointed step named `join:<fanout-name>`.

<p align="center">
  <img src="docs/assets/fanout.gif" width="820" alt="Parallel sub-agents run as child runs, each checkpointed independently, and join on completion">
</p>

## Gates And Channels

Channels deliver Tidebase events to external surfaces. The alpha supports webhook channels:

```typescript
await tide.run(
  'generate-report',
  {
    input: { topic: 'channels' },
    channels: [{
      type: 'webhook',
      url: 'https://your-app.example.com/api/tidebase-events',
      events: ['run.failed', 'step.failed', 'gate.created']
    }]
  },
  workflow
)
```

Gates create durable approval decisions that can be resolved by Studio, a product UI, Slack/Teams adapter, internal tool, or local review page:

```typescript
const decision = await run.gate('approve-send', {
  prompt: 'Send this report to the customer?',
  data: { reportId },
  channels: [{ type: 'webhook', url: process.env.REVIEW_WEBHOOK_URL! }],
  capability: {
    name: 'report.send',
    scopes: ['report:send'],
    reason: 'agent wants to send an external report'
  }
})

if (decision.decision !== 'approved') {
  throw new Error('Report was not approved')
}
```

Webhook gate payloads include a `resolveUrl` and `resolveToken`. Credential and capability fields are audit metadata only; Tidebase does not store or broker API keys in this alpha.

When you cannot block on a human — an HTTP handler, a bot, a protocol gateway — use the non-blocking split that `run.gate()` is built on:

```typescript
const gate = await run.gates.begin('approve-send', { prompt: 'Send it?', data: { reportId } })
if (gate.status === 'pending') {
  // return now; check back with run.gates.get(gate.gateId) on a later request
}
```

Gate begin is idempotent per name within a run: re-beginning a resolved gate returns its decision immediately, so retried callers converge on one answer.

<p align="center">
  <img src="docs/assets/gates.gif" width="820" alt="A run pauses at a durable gate, a human approves the capability, and the workflow continues — fully audited">
</p>

Run a local approval channel:

```bash
pnpm example:review
```

In another terminal:

```bash
REQUIRE_APPROVAL=1 \
TIDEBASE_CHANNEL_WEBHOOK=http://localhost:8788/tidebase-events \
pnpm example
```

Open http://localhost:8788, approve the gate, and the workflow continues.

## Recovery Webhooks

Tidebase can call back into your app when a run fails and has a recovery webhook configured. The SDK can handle that webhook and resume the matching workflow.

```typescript
const run = await tide.runs.create('generate-report', {
  input: { topic: 'checkpoints' },
  recoveryWebhook: 'https://your-app.example.com/api/tidebase'
})
```

Tidebase records each recovery attempt with delivery status, HTTP status, response body, and errors. If `TIDEBASE_WEBHOOK_SECRET` is set on both the server and SDK, recovery payloads are signed with `x-tidebase-signature`.

The example includes a local webhook server:

```bash
pnpm example:webhook
```

## Usage Tracking

Tidebase can record generic resource usage for a run without proxying model or provider calls:

```typescript
await run.usage.record({
  kind: 'llm',
  provider: 'openai',
  model: 'gpt-4.1-mini',
  label: 'draft-response',
  inputTokens: 1200,
  outputTokens: 420,
  costUsd: 0.012
})
```

Usage records are stored with the run, emitted as `usage.recorded` events, and summarized in Studio. The same ledger can track non-LLM resources:

```typescript
await run.usage.record({
  kind: 'tool',
  provider: 'internal-search',
  quantity: 8,
  unit: 'queries',
  costUsd: 0.004
})
```

## What Tidebase Stores

- runs and attempts
- named checkpointed steps
- input hashes to prevent stale checkpoint reuse
- step resume contracts
- live run state
- versioned state streams
- labeled state versions and snapshots
- parent/child run edges
- append-only run events
- recovery attempts
- webhook channel deliveries
- durable gates and decisions
- credential/capability audit metadata
- generic usage records for tokens, units, and cost

Everything is backed by Postgres and designed for self-hosting from day one.

## Current Scope

- Postgres-backed run store
- authoritative run lifecycle with first-class cancellation and deadlines
- durable queues (dedupe, delay, priority, retries/backoff, concurrency and rate caps)
- cron schedules (UTC, double-fire-proof)
- pull-mode workers (`tide.work`) and push-mode signed invocation webhooks
- reconciler (lease-expiry requeue/recovery, deadline cancels, cron, dispatch)
- versioned migration runner
- TypeScript SDK
- Python SDK incl. asyncio (`sdk-python/`, `tidebase.aio`)
- SvelteKit Studio
- live state set/patch
- state history and labeled snapshots
- child runs and fanout joins
- SSE event stream
- signed recovery webhooks
- webhook channels
- durable gates
- usage/resource ledger
- dogfood workflow

## Not In This Alpha

As of **v0.6.0 (June 2026)**. Earlier alphas listed queues, schedules, cancellation, approval gates, and API auth here — those shipped in v0.5–v0.6 (durable queues with retries/backoff, cron, authoritative cancel, exactly-once gates, session runs, opt-in bearer auth, and a reconciler that detects dead workers and re-dispatches automatically). What remains deliberately out of scope:

- Tidebase-hosted code execution (your runtime stays yours — this one is permanent, not pending)
- LLM gateway/proxying
- hosted channel adapters
- secret custody or credential brokering
- agent memory (conversation or embedding storage)
- multi-tenant auth (single shared API key today)
- hosted cloud

## Alpha Notes

This is ready for local demos and early feedback, not production.

Important limits:

- Migrations are versioned and advisory-locked; dev auto-migrates on boot, and `TIDEBASE_AUTO_MIGRATE=0` + `pnpm migrate` gives expand/contract deploy discipline.
- API auth is opt-in: set `TIDEBASE_API_KEY` on the server and the SDK (Studio: `VITE_TIDEBASE_API_KEY`). Without it the API is open — use only in trusted local/self-hosted environments.
- External side effects still need idempotency keys in user code.
- Tidebase remembers what happened and can call recovery webhooks, but it does not guarantee that user code will be available to resume.
