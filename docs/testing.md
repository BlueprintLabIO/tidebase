# Testing

Tidebase is infrastructure other people's agents depend on, so the test suite is
**invariant-driven, not coverage-driven**. Every test asserts a durability or
safety guarantee through the public surface (HTTP API or SDK) against a real
Postgres — the risk lives in SQL and transaction boundaries, and mocks would
hide it. A test earns its place if its failure means a user's workflow could
double-execute, double-charge, lose progress, or accept a forged webhook.

## Running the tests

```bash
docker compose up -d postgres   # same Postgres the dev server uses
pnpm test                       # builds the SDK, runs all suites
```

The server suites create and migrate an isolated `tidebase_test` database on
that Postgres instance (see `apps/server/test/global-setup.ts`), so they never
touch dev data. Override the connection with `TIDEBASE_TEST_DATABASE_URL`.

The SDK unit tests (`packages/sdk/test`) need no infrastructure.

## The invariant map

| Invariant | Why it matters | Tests |
| --- | --- | --- |
| A completed step replays from storage and never re-executes | The core checkpointing promise | `apps/server/test/steps.test.ts`, `e2e-recovery.test.ts` |
| A replay with a different input hash is rejected (`input_mismatch`) | Detects non-deterministic workflows before they corrupt a run | `steps.test.ts` |
| Step/run leases are mutually exclusive while live, and completions are fenced by `leaseOwner` | At most one worker executes a step; zombie workers cannot write back stale results | `steps.test.ts`, `lease-expiry.test.ts` |
| Expired leases can be taken over; the original owner is fenced out afterwards | Crash recovery without double execution | `lease-expiry.test.ts` |
| Concurrent first-begins of a step grant `execute` to exactly one worker | Lease exclusivity must hold before the row exists, not just after | `steps.test.ts` (advisory lock in `steps/begin`) |
| Failure classification: unkeyed side effects → `manual_review`, idempotency key or read-only → `safe_replay`, `replay: never` → `fail_hard` | The resume contract users trust for money-moving steps | `steps.test.ts` |
| The per-run event log is gap-free and strictly ordered, even under concurrent writers | Studio timeline and audit trail correctness | `state-events.test.ts` (advisory lock in `appendEvent`) |
| State versions are monotonic per stream; `save` labels without mutating; snapshots list labeled versions only | Versioned-state guarantees | `state-events.test.ts` |
| Gates begin idempotently, require the resolve token, and resolve exactly once | Approval integrity | `gates-children.test.ts` |
| Child run creation is idempotent by edge name, including under concurrency | Fan-out resume safety | `gates-children.test.ts` |
| A crashed run resumes via the recovery webhook and completes without re-executing finished steps | The end-to-end product story, exercised through the real SDK | `e2e-recovery.test.ts` |
| Step input hashing is stable across object key order | Resumed code must hit the same checkpoints | `e2e-recovery.test.ts` |
| Recovery webhooks are HMAC-signed; the SDK handler rejects unsigned, tampered, and forged payloads | Security of the recovery path | `packages/sdk/test/webhook.test.ts` |
| Channel deliveries are signed, filtered by event list, recorded win-or-lose, and dispatched after commit — a slow endpoint never blocks other writers to the run | Channels must observe runs without being able to stall them | `channels.test.ts` |
| The SDK's resume classification matches the server's: plain/read-only → `safe_replay`, unkeyed writes → `manual_review`, keyed writes → `safe_replay` | Both sides of the wire must agree on the safety contract | `e2e-recovery.test.ts` |
| With `TIDEBASE_API_KEY` set, every surface except `/health` rejects missing/wrong/malformed credentials (timing-safe compare); `?token=` is honored on the SSE endpoint only; with no key configured the API stays open | Auth must fail closed without breaking probes, EventSource, or trusted local setups | `auth.test.ts` |

## Conventions

- Tests hit `createApp()` in-process via Hono's `app.request()`; no server
  process or port is needed except in the e2e suite, which runs the real SDK
  against a real HTTP listener.
- Each test creates its own runs, so suites can run in parallel against one
  database with no cleanup step.
- Invariants that only mean something under contention get a concurrency probe
  (`Promise.all` against the same resource). If you add a uniqueness or lease
  guarantee, add the probe.
- `TIDEBASE_LEASE_MS` is read at module load, so lease-expiry tests set the env
  var and then dynamically import the app (see `lease-expiry.test.ts`).
- When a test exposes a bug, fix the bug and keep the test — three of these
  suites started life red (event seq collisions, step-lease theft on concurrent
  first-begin, SDK retries losing the lease).
