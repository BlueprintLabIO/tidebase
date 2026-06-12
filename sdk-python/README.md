# tidebase (Python SDK)

Python SDK for [Tidebase](https://tidebase.dev) — the open-source checkpoint layer for AI agents: wrap your steps, and failed runs resume from the last safe point — in your own Postgres, without moving execution into a new runtime.

Zero dependencies (stdlib only), Python 3.9+.

```python
from tidebase import Tidebase

tide = Tidebase()  # reads TIDEBASE_URL (default http://localhost:7373) and TIDEBASE_API_KEY

def workflow(run, input):
    plan = run.step("plan", lambda: make_plan(input))
    sources = run.step("fetch-sources", lambda: fetch_sources(plan))

    run.state.set({"status": "writing", "progress": 0.7})

    decision = run.gate("approve-report", "Send the report to the customer?")
    if not decision.approved:
        raise RuntimeError("not approved")

    return run.step("write-report", lambda: write_report(sources))

tide.run("generate-report", workflow, run_id=run_id)
```

Re-invoke with the same `run_id` after a crash: completed steps return from their checkpoints instantly; only unfinished steps execute.

## Surface

| Call | Does |
|---|---|
| `tide.run(name, workflow, run_id=…, input=…)` | Create or resume a run |
| `run.step(name, fn, side_effects=…, idempotency_key=…, retries=…)` | Checkpoint a unit of work; replays from storage on resume |
| `run.state.set / patch / save / versions` | Live state + versioned history (snapshot = labeled version) |
| `run.gate(name, prompt)` | Durable human approval; resolves exactly once |
| `run.child(...)` / `run.fanout(name, children)` | Subagents as child runs, idempotent by edge name, durable join |
| `run.usage.record(kind=…, input_tokens=…, cost_usd=…)` | Per-run token/cost ledger, no LLM proxy |
| `tide.runs.create / get / list / recover / subscribe` | Run API + SSE event stream |
| `tide.runs.attach(name, run_id=…, heartbeat_s=…)` | Session runs (v0.6): a RunSession holding the lease via background heartbeat, with `complete()` / `fail()` — for gateways, REPLs, multi-request runs |
| `run.gates.begin(name, prompt) / run.gates.get(gate_id)` | Non-blocking gates (v0.6): begin is idempotent per name; retried callers converge on one decision |
| `tidebase.verify_webhook_signature(body, header, secret)` | Verify signed recovery/channel webhooks |

External writes should declare `side_effects` and an `idempotency_key`; otherwise a final failure is classified `manual_review` instead of silently retrying — that's the [replay contract](https://tidebase.dev/docs/replay-contract-is-it-safe-to-rerun/).

## Tests

Integration tests assert the durability invariants against a real server:

```bash
docker compose up -d postgres && pnpm server   # in the repo root
python3 -m unittest discover sdk-python/tests -v
```

## Status

Alpha, like the rest of Tidebase. The step input hash matches the TypeScript SDK for common JSON types, so both SDKs can drive the same run (caveat: floats like `1.0` hash differently between the two — avoid mixing SDKs on steps whose input contains them).
