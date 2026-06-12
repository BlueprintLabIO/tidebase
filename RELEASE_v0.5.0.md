# Tidebase v0.5.0

The "production posture" release: authoritative lifecycle, queues, schedules, cancellation, real migrations, opt-in auth, and a production-grade Python SDK. Tidebase still never executes your code — v0.5 adds the power to decide *when* it runs.

## Authoritative lifecycle & cancellation

- Single-source run lifecycle: `pending/queued → running → completed/failed/cancelled`, with `failure_class` (e.g. `max_retries`) recorded on terminal failures.
- `POST /runs/:id/cancel` — durable, idempotent, one-way. In-flight workers observe cancellation at step/gate boundaries (`RunCancelledError` / `RunCancelled`); `complete`/`fail` after cancel are refused.
- Run deadlines (`deadlineMs`): overdue runs are cancelled automatically with reason `deadline`.

## Queues (a job IS a run)

- `POST /queues/:queue/enqueue` / `tide.enqueue()` — dedupe keys (exactly one active run per key, enforced by a partial unique index), delayed jobs, priority, `maxAttempts` with exponential backoff.
- Pull dispatch: `POST /queues/claim` (`SKIP LOCKED`, per-queue concurrency caps and rate limits) + `tide.work()` worker loops in both SDKs.
- Push dispatch: configure a queue `invokeUrl` and Tidebase delivers signed `run.invoke` webhooks to your app.

## Cron schedules

- `PUT /schedules/:name` with 5-field UTC cron (dependency-free parser). Fires enqueue with a fire-time dedupe key, making double-fires structurally impossible across replicas.

## Reconciler

One advisory-locked loop: requeues/fails expired-lease runs, dispatches recovery webhooks for stalled runs, cancels past-deadline runs, enqueues due schedules, dispatches push queues. Multi-replica safe.

## Migrations

Versioned runner (`schema_migrations`, advisory-locked, applied in order). `pnpm migrate` standalone; `TIDEBASE_AUTO_MIGRATE=0` makes boot fail fast on pending migrations for expand/contract deploy discipline. The v0.5 migration is expand-only.

## Auth (from the v0.4 line, included here)

Opt-in shared-token auth via `TIDEBASE_API_KEY` — timing-safe bearer on every surface except `/health`, `?token=` on the SSE endpoint only, Studio support via `VITE_TIDEBASE_API_KEY`.

## Python SDK

`sdk-python/` (PyPI: `tidebase`, zero dependencies): full run/step/state/gate/fanout/usage parity, queues/schedules/cancel, `@tide.workflow` decorators, `tide.work()` loops, and **`tidebase.aio.AsyncTidebase`** — `async def` workflows and steps with the same checkpoint protocol.

## Studio

Queues view (depth, caps, dispatch mode), schedules view, and a Cancel button on active runs.

## Tests

84 TypeScript tests (76 server + 8 SDK) and 9 Python integration tests, all invariant-driven against real Postgres, including concurrency probes for dedupe, claims, caps, cron double-fire, and cancellation. New: [docs/production.md](docs/production.md) — the operational model, replay contract, and failure modes in one page.
