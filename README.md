# Tidebase Alpha

Tidebase is a self-hosted run backend for checkpointed agent workflows.

Your code still runs in your app, worker, or job process. Tidebase stores run checkpoints, state, and events in Postgres so a rerun can skip completed steps and continue from the first incomplete step.

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

Run the dogfood workflow:

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

Run a local approval channel:

```bash
pnpm example:review
```

In another terminal, start a workflow that waits for approval:

```bash
REQUIRE_APPROVAL=1 \
TIDEBASE_CHANNEL_WEBHOOK=http://localhost:8788/tidebase-events \
pnpm example
```

Open http://localhost:8788, approve the gate, and the workflow continues. Studio shows the pending gate, channel delivery, decision actor, resume contracts, and final run timeline.

## Recovery Webhooks

Tidebase can call back into your app when a run fails and has a recovery webhook configured. The SDK can handle that webhook and resume the matching workflow.

Register workflows and expose the handler:

```typescript
import { Tidebase } from '@tidebase/sdk'

const tide = new Tidebase()

tide.workflow('generate-report', async (run, input) => {
  const plan = await run.step('plan', () => makePlan(input))
  return run.step('write-report', () => writeReport(plan))
})

export const POST = tide.webhook()
```

Create a run with a recovery webhook:

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

The alpha stores this contract with the step, shows it in Studio, and records it in step events. Final step failures are classified as:

- `failed_retryable` when the SDK still has retries left.
- `manual_review` when replay is declared as manual, or when external side effects are present without an idempotency key.
- `failed` for hard failures.

This does not make external systems exactly-once. It makes the resume decision explicit instead of hiding it in logs and custom retry flags.

## Channels And Gates

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

Gates create durable decisions that can be resolved by a product UI, Slack/Teams adapter, internal tool, local review page, or Studio fallback:

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

Webhook gate payloads include `resolveUrl` and `resolveToken`. An adapter resolves the gate by posting:

```http
POST /runs/:runId/gates/:gateId/resolve
{
  "token": "resolve_token",
  "decision": "approved",
  "actor": "slack:U123",
  "payload": { "comment": "looks good" }
}
```

Credential and capability fields are audit metadata only. Tidebase does not store or broker API keys in this alpha.

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

## Current Scope

- Postgres-backed run store
- named checkpointed steps
- run and step leases
- input-hash checks to prevent stale checkpoint reuse
- step resume contracts for side effects, idempotency keys, replay policy, and checkpoint invariants
- webhook channels
- durable gates
- credential/capability audit metadata
- generic usage/resource ledger for tokens, units, and cost
- live state set/patch
- append-only run events
- SSE event stream
- signed recovery webhooks
- TypeScript SDK
- Studio run timeline
- dogfood workflow

## Not In This Alpha

- Tidebase-hosted code execution
- queues or worker deployment
- LLM gateway/proxying
- hosted channel adapters
- secret custody / credential brokering
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
