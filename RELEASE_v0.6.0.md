# Tidebase v0.6.0 — Session Runs

v0.6.0 adds **session runs**: a run handle for execution that is not shaped like a workflow function — protocol gateways in front of agents, REPLs, runs that span many HTTP requests. The function-shaped `tide.run()` is unchanged; sessions decouple its three ingredients (lease, context, terminal report) for code that needs to hold a run open.

## Server

- **`POST /runs/:runId/heartbeat`** — extend-only lease renewal, fenced by `leaseOwner`. No attempt bump, no `run.started` event spam. A worker that lost its lease (takeover, reconciler reclaim) gets `409 lease_lost` and cannot resurrect it; a cancelled run answers `409 run_cancelled`.

## TypeScript SDK (`@tidebase/sdk` 0.6.0)

- **`tide.runs.attach(workflowName, options)` → `RunSession`** — a full `RunContext` (step/gate/state/usage/snapshots all work) plus `complete(result)` / `fail(error)` and a background lease heartbeat (`heartbeatMs`, default 20s; `onLeaseLost` callback). If the process dies, the heartbeat stops, the lease expires, and the reconciler takes over — recovery webhook and requeue semantics identical to a crashed workflow worker.
- **`run.gates.begin(name, options)` / `run.gates.get(gateId)`** — the non-blocking primitives `run.gate()` is built on, now public. `begin` is idempotent per gate name within a run: re-beginning a resolved gate returns its decision immediately, so retried callers (an MCP tool call, an HTTP handler) converge on one answer without blocking on a human.

## Python SDK (`tidebase` 0.6.0)

- **`tide.runs.attach(name, run_id=…, heartbeat_s=20.0, on_lease_lost=…)` → `RunSession`** — same semantics as TypeScript; the heartbeat runs on a daemon thread.
- **`run.gates.begin(name, prompt, …)` / `run.gates.get(gate_id)`** — non-blocking gates on every `RunContext`.
- **`tidebase.aio`**: `await tide.attach(...)` → `AsyncRunSession` with `heartbeat/complete/fail/gates_begin/gates_get`.

## Reconciler fix: sweep starvation

Building the session tests surfaced a real bug: the expired-lease sweep selected *any* expired `running` run (`limit 100`, no ordering), but plain runs — no queue, no recovery webhook — are deliberately left running-with-expired-lease for manual takeover and never transition. Enough of them permanently occupied the sweep window, and queue/webhook runs behind them were **never reclaimed**. On a long-lived database this silently disables crash recovery. The sweep now selects only actionable rows, oldest lease first, and a regression test pins it (120 expired plain runs cannot starve a queue run's reclaim).

## Tests

Six new server invariants in `apps/server/test/heartbeat.test.ts` (heartbeats outlive the lease window without polluting the event log; wrong owner rejected; zombie fenced after takeover; stopped heartbeat → reconciler reclaim → stale owner fenced; cancel beats heartbeat; sweep starvation) and three new Python invariants (`PythonSdkV06Sessions`). Reconciler-dependent tests now assert run-state outcomes with tick retries instead of single-tick reports (ticks share an advisory lock across parallel test files), and the test DB is truncated per suite run. Suite totals: 82 TypeScript server tests, 8 SDK tests, 12 Python integration tests.

## Why sessions

An MCP gateway wrapping an agent's tool calls, a REPL, a run touched across requests — none of these are a function that runs to completion, which is what `tide.run()` wants. `attach()` gives them the same guarantees (checkpointed steps, fenced leases, durable gates, reconciler-backed crash recovery) without pretending to be one. See the integration guide: <https://tidebase.dev/docs/integrate/mcp-agents/>
