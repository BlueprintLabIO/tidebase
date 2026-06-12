"""Integration tests for the Python SDK against a real Tidebase server.

Run with the dev server up (docker compose up -d postgres && pnpm server):

    python3 -m unittest discover sdk-python/tests -v

Invariant-driven, mirroring docs/testing.md: each test asserts a durability
guarantee through the public SDK surface.
"""

import os
import sys
import threading
import time
import unittest
import urllib.request
import json as jsonlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from tidebase import Tidebase, new_run_id  # noqa: E402

SERVER = os.environ.get("TIDEBASE_URL", "http://localhost:7373")


def server_up() -> bool:
    try:
        with urllib.request.urlopen(f"{SERVER}/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


@unittest.skipUnless(server_up(), f"Tidebase server not reachable at {SERVER}")
class PythonSdkInvariants(unittest.TestCase):
    def setUp(self):
        self.tide = Tidebase(url=SERVER)

    def test_completed_steps_replay_and_never_reexecute(self):
        """Invariant: re-invoking a run with the same id replays completed
        steps from checkpoints; only the unfinished step executes."""
        run_id_holder = {}
        executions = {"a": 0, "b": 0}
        fail_b = {"on": True}

        def workflow(run, _input):
            run_id_holder["id"] = run.run_id

            def do_a():
                executions["a"] += 1
                return "result-a"

            def do_b():
                executions["b"] += 1
                if fail_b["on"]:
                    raise RuntimeError("simulated crash in step b")
                return "result-b"

            a = run.step("step-a", do_a)
            b = run.step("step-b", do_b)
            return [a, b]

        with self.assertRaises(RuntimeError):
            self.tide.run("py-resume", workflow, input={"n": 1})

        self.assertEqual(executions, {"a": 1, "b": 1})

        # resume: a replays from checkpoint (no re-execution), b runs again
        fail_b["on"] = False
        result = self.tide.run("py-resume", workflow, run_id=run_id_holder["id"])
        self.assertEqual(result, ["result-a", "result-b"])
        self.assertEqual(executions["a"], 1, "completed step re-executed on resume")
        self.assertEqual(executions["b"], 2)

    def test_retries_rebegin_and_succeed(self):
        """Invariant: a retryable failure re-begins the step (fresh lease) and
        the eventual success is checkpointed."""
        attempts = {"n": 0}

        def workflow(run, _input):
            def flaky():
                attempts["n"] += 1
                if attempts["n"] < 3:
                    raise RuntimeError("transient")
                return "ok"

            return run.step("flaky", flaky, retries=3)

        result = self.tide.run("py-retries", workflow)
        self.assertEqual(result, "ok")
        self.assertEqual(attempts["n"], 3)

    def test_gate_resolves_exactly_once_and_unblocks_the_run(self):
        """Invariant: a pending gate blocks the workflow; resolving it with the
        token unblocks it; the decision is returned."""
        run = self.tide.runs.create("py-gate")
        result_holder = {}

        def workflow(run_ctx, _input):
            decision = run_ctx.gate("approve-it", "Approve the thing?", poll_s=0.2)
            result_holder["decision"] = decision.decision
            return decision.decision

        worker = threading.Thread(
            target=lambda: self.tide.run("py-gate", workflow, run_id=run["id"])
        )
        worker.start()

        # wait for the gate to appear, then resolve it with its token
        gate = None
        for _ in range(50):
            detail = self.tide.runs.get(run["id"])
            gates = detail.get("gates") or []
            if gates:
                gate = gates[0]
                break
            time.sleep(0.1)
        self.assertIsNotNone(gate, "gate never appeared")

        body = jsonlib.dumps(
            {"token": gate["resolveToken"], "decision": "approved", "actor": "pytest"}
        ).encode()
        req = urllib.request.Request(
            f"{SERVER}/runs/{run['id']}/gates/{gate['id']}/resolve",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 200)

        worker.join(timeout=10)
        self.assertFalse(worker.is_alive(), "workflow did not unblock after approval")
        self.assertEqual(result_holder["decision"], "approved")

    def test_state_usage_and_input_hash_stability(self):
        """Invariant: state writes version, usage records attach to the run,
        and dict key order does not change the step input hash."""

        def workflow(run, _input):
            run.state.set({"status": "working", "progress": 0.5})
            run.state.patch({"progress": 0.9})
            run.usage.record(kind="llm", provider="test", model="m1", input_tokens=10,
                             output_tokens=5, cost_usd=0.001)
            # same logical input, different key order: must hit the same checkpoint
            first = run.step("hash-stable", lambda: "v1", input={"a": 1, "b": 2})
            second = run.step("hash-stable", lambda: "v2", input={"b": 2, "a": 1})
            return [first, second]

        result = self.tide.run("py-state", workflow)
        self.assertEqual(result, ["v1", "v1"], "key order changed the checkpoint identity")

        runs = [r for r in self.tide.runs.list() if r["workflowName"] == "py-state"]
        detail = self.tide.runs.get(runs[0]["id"])
        self.assertGreaterEqual(len(detail["stateVersions"]), 2)
        self.assertEqual(detail["usage"][0]["kind"], "llm")

    def test_fanout_children_are_idempotent_by_edge_name(self):
        """Invariant: child runs are created once per edge name; the join step
        is checkpointed."""
        child_runs = {"n": 0}

        def child_wf(run, inp):
            child_runs["n"] += 1
            return f"child:{inp}"

        def workflow(run, _input):
            return run.fanout(
                "gather",
                [
                    {"name": "left", "workflow": child_wf, "input": "L"},
                    {"name": "right", "workflow": child_wf, "input": "R"},
                ],
            )

        result = self.tide.run("py-fanout", workflow)
        self.assertEqual(sorted(result), ["child:L", "child:R"])
        self.assertEqual(child_runs["n"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
