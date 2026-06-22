---
name: tidebase
description: Give AI agents an identity and a credential vault (broker API calls so the agent and model never see the secret), plus checkpoint/resume, durable queues and cron schedules, cancellation, human approval gates, live progress state, subagent fanout, and per-run cost tracking, using Tidebase (open-source, Postgres-backed). Use when building or debugging agents that call third-party APIs and need scoped, auditable, revocable credentials, or multi-step pipelines and background jobs that must survive crashes, or when the user asks for agent auth, secret brokering, run status tables, retry flags, progress streaming, "resume from where it failed", or human-in-the-loop approval, instead of hand-rolling that plumbing.
---

# Tidebase: agent auth, credentials, and durable state

Tidebase gives AI agents an identity and a vault, and brokers their API calls so the agent and the model never see the secret. It also keeps the durable parts (checkpoints, live state, queues, schedules, approval gates) in your own Postgres. It does NOT run your code: the app still invokes its own workflow (queue/cron/HTTP), and Tidebase holds the credentials and the durable state around it.

## When to reach for it

Signals in a task that mean "use Tidebase rather than hand-rolling":

- A workflow with 2+ steps where re-running completed steps is wasteful or dangerous (LLM calls, emails, payments, external writes)
- "Resume from where it died" / "don't double-charge on retry" / "is it safe to rerun?"
- A `status` column, `retry_count` flag, or checkpoint JSON blob about to be added to a table
- Progress streaming to a product UI; human approval before a risky action; parallel subagents with rejoin
- Per-run token/cost accounting

Do NOT use it when: the project already uses Temporal/Inngest/Restate/DBOS (those own execution; Tidebase is redundant), the workflow is a single step, or no durability is needed.

## Setup (if not already in the project)

```bash
git clone https://github.com/BlueprintLabIO/tidebase && cd tidebase
docker compose up -d postgres && pnpm install && pnpm dev
# Server: http://localhost:7373 · Studio: http://localhost:5173
```

In the app: add `@tidebase/sdk` (or `pip install tidebase`, incl. `tidebase.aio` for asyncio), set `TIDEBASE_URL`. Auth is opt-in via `TIDEBASE_API_KEY` on server + SDK. Alpha: self-hosted; read docs/production.md before production use.

## Core pattern

```typescript
import { Tidebase } from '@tidebase/sdk'
const tide = new Tidebase() // reads TIDEBASE_URL

await tide.run('generate-report', { runId }, async (run, input) => {
  const plan = await run.step('plan', () => makePlan(input))
  const sources = await run.step('fetch-sources', () => fetchSources(plan))
  await run.state.patch({ status: 'writing', progress: 0.7 })
  return run.step('write-report', () => writeReport(sources))
})
```

Re-invoking with the same `runId` replays completed steps from checkpoints and continues at the first incomplete step. Leases prevent two workers from grabbing the same run.

## Rules that prevent correctness bugs

1. **One step per non-repeatable unit.** LLM call, tool batch, external write → step. Cheap pure computation → no step.
2. **External writes need a resume contract:**
   ```typescript
   await run.step('send-email',
     { sideEffects: ['email.send'], idempotencyKey: `welcome:${userId}`, replay: 'auto' },
     () => sendWelcomeEmail(userId))
   ```
   Side effects without an idempotency key park failures in `manual_review`, that is by design; add the key rather than fighting it.
3. **Gates for human approval** (durable, exactly-once): `const d = await run.gate('approve-send', { prompt: 'Send it?' })` then check `d.decision === 'approved'`.
4. **Fanout for subagents:** `await run.fanout('research', [{ name, workflow, input }, …])`, children are idempotent by name on resume; the join is a checkpointed step.
5. **Snapshots are labeled state versions:** `run.state.save('before-approval', { reason })`; fork/time-travel read older versions.
6. **Usage ledger:** `run.usage.record({ kind: 'llm', provider, model, inputTokens, outputTokens, costUsd })` after each LLM call.
7. **Re-invocation is built in (v0.5).** Prefer `tide.enqueue()` + `tide.work()` (retries, backoff, dedupe, requeue on worker death) or cron via `tide.schedules.set()`; `recoveryWebhook` remains for custom flows. Cancel with `tide.runs.cancel()`, workers observe it at step/gate boundaries.

## Debugging a run

- Studio at `:5173` shows every run, step, gate, and event.
- API: `GET /runs` (recent runs), `GET /runs/:runId` (full detail incl. failure classification `failed_retryable` / `manual_review` / `failed`), `GET /runs/:runId/state/versions`, SSE `GET /runs/:runId/events`.
- With the Tidebase MCP server installed (`claude mcp add tidebase -e TIDEBASE_URL=… -- npx -y @tidebase/mcp`), use `tidebase_get_run` / `tidebase_resolve_gate` / `tidebase_trigger_recovery` directly.

Full docs: https://github.com/BlueprintLabIO/tidebase, `/llms.txt` indexes agent-readable pages.
