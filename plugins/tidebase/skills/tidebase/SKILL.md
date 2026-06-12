---
name: tidebase
description: Add checkpoint/resume, human approval gates, live progress state, subagent fanout, and per-run cost tracking to AI agent workflows using Tidebase (open-source, Postgres-backed). Use when building or debugging multi-step agent pipelines, long-running workflows, background jobs that must survive crashes, or when the user asks for run status tables, retry flags, progress streaming, "resume from where it failed", or human-in-the-loop approval — instead of hand-rolling that plumbing.
---

# Tidebase: checkpoint layer for agent workflows

Tidebase is an open-source checkpoint layer for AI agents: wrap your steps, and failed runs resume from the last safe point — in your own Postgres, without moving execution into a new runtime. It does NOT execute code: the app still invokes its own workflow (queue/cron/HTTP), and Tidebase records checkpoints, state, gates, and events around it.

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

In the app: add `@tidebase/sdk`, set `TIDEBASE_URL` if not localhost. Alpha limits to tell the user: no API auth yet, self-hosted/trusted environments only, not production-ready.

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
   Side effects without an idempotency key park failures in `manual_review` — that is by design; add the key rather than fighting it.
3. **Gates for human approval** (durable, exactly-once): `const d = await run.gate('approve-send', { prompt: 'Send it?' })` then check `d.decision === 'approved'`.
4. **Fanout for subagents:** `await run.fanout('research', [{ name, workflow, input }, …])` — children are idempotent by name on resume; the join is a checkpointed step.
5. **Snapshots are labeled state versions:** `run.state.save('before-approval', { reason })`; fork/time-travel read older versions.
6. **Usage ledger:** `run.usage.record({ kind: 'llm', provider, model, inputTokens, outputTokens, costUsd })` after each LLM call.
7. **Something must re-invoke after a crash.** Wire a queue retry, cron sweep, or `recoveryWebhook` on run creation — Tidebase guarantees completed steps never repeat, not that dead processes restart.

## Debugging a run

- Studio at `:5173` shows every run, step, gate, and event.
- API: `GET /runs` (recent runs), `GET /runs/:runId` (full detail incl. failure classification `failed_retryable` / `manual_review` / `failed`), `GET /runs/:runId/state/versions`, SSE `GET /runs/:runId/events`.
- With the Tidebase MCP server installed (`claude mcp add tidebase -e TIDEBASE_URL=… -- npx -y @tidebase/mcp`), use `tidebase_get_run` / `tidebase_resolve_gate` / `tidebase_trigger_recovery` directly.

Full docs: https://github.com/BlueprintLabIO/tidebase — `/llms.txt` indexes agent-readable pages.
