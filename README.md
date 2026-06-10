<p align="center">
  <img src="apps/studio/static/tidebase-mark.svg" alt="Tidebase" width="56" height="56" />
</p>

<h1 align="center">Tidebase</h1>

<p align="center">
  Checkpointed runs, live state, gates, and usage tracking for existing agent workflows.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0aabc0.svg" alt="License: Apache-2.0"></a>
  <a href="https://github.com/BlueprintLabIO/tidebase/releases"><img src="https://img.shields.io/github/v/release/BlueprintLabIO/tidebase?color=0aabc0" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/SDK-TypeScript-0e6f80.svg" alt="TypeScript SDK">
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

Tidebase is a self-hosted run backend for long-running agent workflows.

Your code still runs in your app, worker, or job process. Tidebase stores checkpoints, state, events, gates, channel deliveries, recovery attempts, and usage records in Postgres so failed runs can resume from the last safe point without moving execution into a hosted runtime.

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
- TypeScript SDK
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

- Tidebase-hosted code execution
- queues or worker deployment
- LLM gateway/proxying
- hosted channel adapters
- secret custody or credential brokering
- memory
- auth
- hosted cloud

## Alpha Notes

This is ready for local demos and early feedback, not production.

Important limits:

- The server currently auto-runs the SQL schema on boot; a real migration runner is planned.
- There is no API authentication yet. Run it only in trusted local/self-hosted environments.
- External side effects still need idempotency keys in user code.
- Tidebase remembers what happened and can call recovery webhooks, but it does not guarantee that user code will be available to resume.
