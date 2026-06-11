# Tidebase v0.3.0

v0.3.0 hardens the guarantees Tidebase already claimed. It adds the first test suite — 57 invariant tests run against real Postgres in CI — and fixes the concurrency bugs that suite uncovered.

## Highlights

- Added an invariant-driven test suite covering checkpoint replay, lease fencing, event-log integrity, gate resolution, fanout idempotence, recovery webhooks, and channel deliveries (`docs/testing.md`).
- Added GitHub Actions CI: `pnpm verify` (typecheck, build, full test suite) on every push and pull request.
- Fixed an event-sequence race: concurrent writers to the same run could collide on `unique(run_id, seq)` and fail with a 500. Event appends are now serialized per run with an advisory lock.
- Fixed a step-lease race: two workers beginning the same step for the first time concurrently could both be granted `execute`, with the second silently stealing the first worker's lease. First-begins are now serialized per `(run, step)`; the same fix covers concurrent gate begins.
- Fixed SDK step retries: a retryable failure releases the lease server-side, but the SDK retried with the dead lease and could never commit the eventual success. Each retry now re-begins the step to acquire a fresh lease.
- Channel webhook deliveries are now dispatched after the transaction commits. Previously the HTTP call to your endpoint ran inside the database transaction, so a slow or hung channel endpoint could block every other writer to the same run.
- Aligned the SDK's default resume classification with the server: a failing step with no declared side effects (or read-only ones) is now classified `safe_replay` instead of `fail_hard`. External writes without an idempotency key still park in `manual_review`.
- Request validation errors now return `400` with the Zod issues instead of a bare `500`.

## Why It Matters

Tidebase's job is to be the layer you trust when worker processes crash, retry, and race each other. That trust should rest on executable proof, not on careful reading of the SQL. The test suite encodes each product guarantee — "completed steps never re-execute", "the event log has no gaps", "a gate resolves exactly once" — as a test against a real database, with concurrency probes for the guarantees that only matter under contention.

Three of those probes failed on first run. All three bugs are fixed in this release, and the tests that caught them now run in CI on every change.

## Behavior Changes

- Channel deliveries are recorded inside the transaction (as `pending`) but delivered after commit. Delivery status still updates to `delivered` or `failed` before the triggering API call returns.
- A failing SDK step with no declared side effects reports `safe_replay` instead of `fail_hard`, matching the server's own classification. Declare `replay: 'never'` if a step must not be replayed.
- Invalid request bodies return `400` with structured issues instead of `500`.

## Compatibility Notes

No storage changes. No API shape changes. Existing workflows continue to work; SDK `retries` now actually commit their eventual success, which previously failed with a `409` after any retry.
