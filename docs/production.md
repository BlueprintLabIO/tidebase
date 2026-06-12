# Production posture

The operational model, replay contract, and failure modes — what Tidebase guarantees, what it asks of your code, and what happens when machines die. Every guarantee below is enforced by an invariant test (see [testing.md](testing.md)).

## The execution model

Tidebase never executes your code. Your app, worker, or job process runs workflows; the Tidebase server records lifecycle, checkpoints, state, gates, and usage in your Postgres. v0.5 adds *triggering*: Tidebase can decide **when** your code runs (queues, schedules, push webhooks) — but the runtime, secrets, and dependencies stay yours.

## The authoritative lifecycle

A run's status lives in exactly one place — the `runs` row — and moves through:

```
pending ──► running ──► completed
queued ──► running ──► failed (failure_class: max_retries | …)
   ▲            │
   └── requeue ─┘        any non-terminal state ──► cancelled
```

- **`queued`** — created by `enqueue` (or a schedule); waiting for a claim or push dispatch, invisible until `run_at`.
- **`running`** — a worker holds the lease. Leases are exclusive and fenced: a zombie worker cannot write back stale results.
- **`completed` / `failed`** — terminal. Failed queue runs with attempts remaining transition back to `queued` with exponential backoff (5s · 2^attempt, capped at 5 min); exhausting `maxAttempts` is recorded as `failure_class = 'max_retries'`.
- **`cancelled`** — terminal, one-way, and impossible to miss: the status flips immediately on `POST /runs/:id/cancel`, in-flight workers observe it at their next step or gate boundary (`RunCancelledError` / `RunCancelled`), and `complete`/`fail` arriving afterwards are refused. Deadlines (`deadlineMs`) cancel automatically with reason `deadline`.

Do not mirror this status into your own tables; query it (`GET /runs`, `GET /runs/:id`) or subscribe to events. Duplicated lifecycle drifts — that's the failure Tidebase exists to remove.

## Worker death and recovery

What happens when a process dies mid-run, a machine is replaced, or a deploy interrupts everything:

1. **Completed steps are safe.** Their outputs are committed to Postgres; replay returns them without re-execution.
2. **The run lease expires** (default 60s, `TIDEBASE_LEASE_MS`).
3. **The reconciler** — one loop, advisory-locked so multi-replica deployments tick exactly once — then:
   - requeues expired queue runs (with backoff) or fails them at max attempts,
   - fires the signed recovery webhook for stalled webhook-configured runs (throttled),
   - cancels runs past their deadline,
   - enqueues due schedules,
   - dispatches push-mode queues.
4. **Re-invocation replays**: completed steps return from checkpoints; the first incomplete step executes. Input-hash drift on replay is rejected loudly rather than silently reusing a stale checkpoint.

## Deterministic replay contract

- **Granularity:** the step is the replay unit. Code *between* steps re-executes on resume; keep it cheap and pure, or make it a step.
- **Determinism requirement:** none beyond step identity — a step's `name` and input hash must be stable across re-invocations. The hash uses key-order-independent JSON (identical in the TypeScript and Python SDKs).
- **Step versioning / schema evolution:** changing a step's logic is safe for *new* runs. For in-flight runs, completed steps replay their **recorded** outputs — old shape included. If a change alters a step's input, replay fails with `input_mismatch` (by design). To evolve a step's input shape, add a new step name (`fetch-sources-v2`) — expand/contract, applied to workflows.
- **Side effects:** Tidebase cannot make external systems exactly-once. Declare them (`sideEffects` + `idempotencyKey`) and final failures classify `safe_replay` vs `manual_review` instead of guessing.

## Queues and scheduling semantics

- **A job is a run.** `enqueue` creates a run with status `queued`; there is no parallel job table to drift.
- **Dedupe:** at most one *active* (queued/running) run per `(queue, dedupeKey)`; terminal runs free the key. Enforced by a partial unique index, exact under concurrency.
- **Claims:** `SKIP LOCKED` + per-queue advisory serialization. Two claimers can never receive the same run; concurrency caps and per-minute rate limits hold across competing workers.
- **Cron:** 5-field UTC expressions. A schedule's fire enqueues with dedupe key `sched:<name>:<fireTime>`, so a double-fire is structurally impossible even across replicas.
- **Push dispatch:** queues with an `invokeUrl` get signed `run.invoke` webhooks (same HMAC as recovery). Delivery is at-least-once with a redelivery horizon; the run stays `queued` until your app begins it.

## Deploying

- **Migrations:** versioned files in `migrations/`, applied in order under an advisory lock, recorded in `schema_migrations`. Dev default auto-migrates on boot; for expand/contract discipline set `TIDEBASE_AUTO_MIGRATE=0` (boot fails fast if migrations are pending) and run `node dist/migrate.js` as a release step. All v0.5 migrations are expand-only.
- **Auth:** set `TIDEBASE_API_KEY` (server + SDKs + Studio via `VITE_TIDEBASE_API_KEY`). Timing-safe bearer check on every surface except `/health`; SSE accepts `?token=` (EventSource cannot set headers). Recovery/invoke/channel webhooks are HMAC-signed with `TIDEBASE_WEBHOOK_SECRET`; SDK handlers reject unsigned or tampered payloads.
- **Replicas:** the server is stateless apart from Postgres. Reconciler ticks and migrations are advisory-locked; claims are safe under contention. Run as many replicas as you like behind a load balancer.
- **Observability:** append-only, gap-free event log per run; queue depth and schedule state via `GET /queues` / `GET /schedules` and Studio; failure class, cancellation reason, retry history, and recovery attempts all queryable in your own Postgres. OpenTelemetry export is on the roadmap.

## Known limits (v0.5)

- Single shared API key — no multi-tenant/org isolation yet.
- Push dispatch is at-least-once; your webhook handler must tolerate redelivery (begin-by-runId already makes this safe).
- The usage ledger records what you report; it does not meter providers directly.
- Maturity: the invariants are tested against real Postgres with concurrency probes, but Tidebase has not yet carried years of production load. Read the [invariant map](testing.md) and judge for your workload.
