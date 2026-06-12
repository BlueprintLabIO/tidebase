"""Tidebase Python SDK.

Tidebase is an open-source checkpoint layer for AI agents: wrap your steps,
and failed runs resume from the last safe point — in your own Postgres,
without moving execution into a new runtime.

    from tidebase import Tidebase

    tide = Tidebase()  # reads TIDEBASE_URL, default http://localhost:7373

    def workflow(run, input):
        plan = run.step("plan", lambda: make_plan(input))
        run.state.set({"status": "writing", "progress": 0.7})
        return run.step("write-report", lambda: write_report(plan))

    tide.run("generate-report", workflow, run_id=run_id)

Zero dependencies (stdlib only). Mirrors @tidebase/sdk semantics: completed
steps replay from checkpoints, leases fence concurrent workers, gates resolve
exactly once, and unkeyed external writes classify as manual_review.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterator, Optional
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

__all__ = [
    "Tidebase",
    "RunContext",
    "TidebaseError",
    "GateDecision",
    "new_run_id",
    "verify_webhook_signature",
]


class TidebaseError(RuntimeError):
    """A Tidebase API request failed."""

    def __init__(self, status: int, body: str, path: str):
        super().__init__(f"Tidebase request failed: {status} {body} ({path})")
        self.status = status
        self.body = body
        self.path = path


class GateDecision:
    def __init__(self, gate: dict):
        self.gate_id: str = gate["id"]
        self.name: str = gate["name"]
        self.status: str = gate["status"]
        self.decision: str = gate["decision"]
        self.actor: Optional[str] = gate.get("actor")
        self.payload: Any = gate.get("decisionPayload")

    @property
    def approved(self) -> bool:
        return self.decision == "approved"


def new_run_id() -> str:
    return "run_" + uuid.uuid4().hex


def _stable_stringify(value: Any) -> str:
    """Deterministic JSON with sorted object keys.

    Matches the TypeScript SDK's stableStringify for the common JSON types so
    both SDKs compute the same input hash. (Caveat: floats that JavaScript
    prints without a fractional part, e.g. 1.0, differ — avoid mixing SDKs on
    a step whose input contains such floats.)
    """
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    return (
        "{"
        + ",".join(
            f"{json.dumps(str(k), ensure_ascii=False)}:{_stable_stringify(value[k])}"
            for k in sorted(value)
        )
        + "}"
    )


def _hash_stable(value: Any) -> str:
    return hashlib.sha256(_stable_stringify(value).encode("utf-8")).hexdigest()


def _classify_resume_decision(options: dict) -> str:
    """Mirror of the server's inferReplay and the TS SDK's classification."""
    replay = options.get("replay")
    if replay == "manual":
        return "manual_review"
    if replay == "never":
        return "fail_hard"
    if replay == "auto":
        return "safe_replay"
    side_effects = [e for e in (options.get("sideEffects") or []) if e]
    reads_only = len(side_effects) > 0 and all(e == "read" for e in side_effects)
    writes_externally = len(side_effects) > 0 and not reads_only
    if writes_externally and not options.get("idempotencyKey"):
        return "manual_review"
    return "safe_replay"


def verify_webhook_signature(body: bytes, signature_header: Optional[str], secret: str) -> bool:
    """Verify an HMAC-signed Tidebase webhook payload (timing-safe)."""
    if not signature_header:
        return False
    if signature_header.startswith("sha256="):
        signature_header = signature_header[len("sha256="):]
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def _serialize_error(error: BaseException) -> dict:
    return {"name": type(error).__name__, "message": str(error)}


class Tidebase:
    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        webhook_secret: Optional[str] = None,
    ):
        self.url = (url or os.environ.get("TIDEBASE_URL") or "http://localhost:7373").rstrip("/")
        self.api_key = api_key or os.environ.get("TIDEBASE_API_KEY")
        self.webhook_secret = webhook_secret or os.environ.get("TIDEBASE_WEBHOOK_SECRET")
        self.runs = RunsClient(self)

    # ---- transport -------------------------------------------------------

    def request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        req = urlrequest.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urlrequest.urlopen(req) as response:
                return json.loads(response.read().decode("utf-8"))
        except urlerror.HTTPError as e:
            raise TidebaseError(e.code, e.read().decode("utf-8", "replace"), path) from None

    # ---- workflows -------------------------------------------------------

    def run(
        self,
        workflow_name: str,
        workflow: Callable[["RunContext", Any], Any],
        run_id: Optional[str] = None,
        input: Any = None,
        metadata: Optional[dict] = None,
        recovery_webhook: Optional[str] = None,
        channels: Optional[list] = None,
    ) -> Any:
        """Create (or resume, when run_id is given) a run and execute the workflow.

        Completed steps inside the workflow replay from their checkpoints; only
        unfinished steps execute.
        """
        if run_id is None:
            run = self.runs.create(
                workflow_name,
                input=input,
                metadata=metadata,
                recovery_webhook=recovery_webhook,
                channels=channels,
            )
        else:
            run = self.runs.get(run_id)["run"]

        if run["workflowName"] != workflow_name:
            raise ValueError(
                f"Run {run['id']} belongs to workflow {run['workflowName']}, not {workflow_name}"
            )
        if run["status"] == "completed":
            return run["result"]

        begin = self.request("POST", f"/runs/{run['id']}/begin")
        context = RunContext(self, run["id"], begin["leaseOwner"])
        try:
            result = workflow(context, run["input"])
            self.request("POST", f"/runs/{run['id']}/complete", {"result": result})
            return result
        except BaseException as error:
            try:
                self.request("POST", f"/runs/{run['id']}/fail", {"error": _serialize_error(error)})
            except Exception:
                pass
            raise


class RunsClient:
    def __init__(self, client: Tidebase):
        self._client = client

    def create(
        self,
        workflow_name: str,
        input: Any = None,
        metadata: Optional[dict] = None,
        recovery_webhook: Optional[str] = None,
        channels: Optional[list] = None,
    ) -> dict:
        body: dict = {}
        if input is not None:
            body["input"] = input
        if metadata is not None:
            body["metadata"] = metadata
        if recovery_webhook is not None:
            body["recoveryWebhook"] = recovery_webhook
        if channels is not None:
            body["channels"] = channels
        quoted = urlparse.quote(workflow_name, safe="")
        return self._client.request("POST", f"/runs/{quoted}", body)["run"]

    def list(self) -> list:
        return self._client.request("GET", "/runs")["runs"]

    def get(self, run_id: str) -> dict:
        """Full run detail: run, steps, state, gates, events, usage, children."""
        return self._client.request("GET", f"/runs/{run_id}")

    def recover(self, run_id: str, reason: str = "manual") -> dict:
        return self._client.request("POST", f"/runs/{run_id}/recover", {"reason": reason})

    def subscribe(self, run_id: str, after: int = 0) -> Iterator[dict]:
        """Yield run events from the SSE stream (blocking generator)."""
        token = f"&token={urlparse.quote(self._client.api_key)}" if self._client.api_key else ""
        url = f"{self._client.url}/runs/{run_id}/events?after={after}{token}"
        req = urlrequest.Request(url, headers={"accept": "text/event-stream"})
        with urlrequest.urlopen(req) as response:
            for raw in response:
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("data:"):
                    yield json.loads(line[len("data:"):].strip())


class RunContext:
    def __init__(self, client: Tidebase, run_id: str, lease_owner: str):
        self._client = client
        self.run_id = run_id
        self._lease_owner = lease_owner
        self.state = RunState(client, run_id)
        self.usage = RunUsage(client, run_id)
        self.snapshots = RunSnapshots(client, run_id)

    # ---- steps -----------------------------------------------------------

    def step(
        self,
        name: str,
        fn: Callable[[], Any],
        *,
        input: Any = None,
        input_hash: Optional[str] = None,
        retries: int = 0,
        timeout_s: Optional[float] = None,
        side_effects: Optional[list] = None,
        idempotency_key: Optional[str] = None,
        replay: Optional[str] = None,
        checkpoint_invariant: Any = None,
        verified_by: Any = None,
        credentials: Optional[list] = None,
    ) -> Any:
        """Checkpoint a unit of work. On replay the stored output is returned
        without executing fn. External writes should declare side_effects and
        an idempotency_key, or final failures classify as manual_review."""
        options: dict = {}
        if input is not None:
            options["input"] = input
        if retries:
            options["retries"] = retries
        if timeout_s is not None:
            options["timeoutMs"] = int(timeout_s * 1000)
        if side_effects is not None:
            options["sideEffects"] = side_effects
        if idempotency_key is not None:
            options["idempotencyKey"] = idempotency_key
        if replay is not None:
            options["replay"] = replay
        if checkpoint_invariant is not None:
            options["checkpointInvariant"] = checkpoint_invariant
        if verified_by is not None:
            options["verifiedBy"] = verified_by
        if credentials is not None:
            options["credentials"] = credentials

        resolved_hash = input_hash or _hash_stable(input if input is not None else None)

        def begin() -> dict:
            return self._client.request(
                "POST",
                f"/runs/{self.run_id}/steps/begin",
                {
                    "name": name,
                    "inputHash": resolved_hash,
                    "input": input,
                    "options": options,
                    "leaseOwner": self._lease_owner,
                },
            )

        current = begin()
        if current["action"] == "return":
            return current["output"]
        if current["action"] == "input_mismatch":
            raise ValueError(
                f"Step {name} input hash changed for this run. "
                f"Expected {current['expectedInputHash']}, got {current['actualInputHash']}"
            )
        if current["action"] == "locked":
            raise RuntimeError(f"Step {name} is currently leased by another worker")

        attempts = max(1, retries + 1)
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                # A retryable failure released the lease server-side; re-begin
                # to acquire a fresh lease before reporting results.
                current = begin()
                if current["action"] == "return":
                    return current["output"]
                if current["action"] == "locked":
                    raise RuntimeError(f"Step {name} is currently leased by another worker")
                if current["action"] == "input_mismatch":
                    raise ValueError(f"Step {name} input hash changed for this run")
            try:
                result = fn()
                self._client.request(
                    "POST",
                    f"/runs/{self.run_id}/steps/{current['step']['id']}/complete",
                    {"leaseOwner": current["leaseOwner"], "output": result},
                )
                return result
            except BaseException as error:
                retryable = attempt < attempts
                try:
                    self._client.request(
                        "POST",
                        f"/runs/{self.run_id}/steps/{current['step']['id']}/fail",
                        {
                            "leaseOwner": current["leaseOwner"],
                            "retryable": retryable,
                            "resumeDecision": "auto_retry"
                            if retryable
                            else _classify_resume_decision(options),
                            "error": _serialize_error(error),
                        },
                    )
                except Exception:
                    pass
                if not retryable:
                    raise
        raise RuntimeError(f"Step {name} failed")

    # ---- gates -----------------------------------------------------------

    def gate(
        self,
        name: str,
        prompt: str,
        *,
        data: Any = None,
        channels: Optional[list] = None,
        capability: Optional[dict] = None,
        timeout_s: Optional[float] = None,
        poll_s: float = 1.0,
    ) -> GateDecision:
        """Pause the run on a durable gate until a human decides. The decision
        resolves exactly once and replays on resume."""
        body: dict = {
            "name": name,
            "prompt": prompt,
            "data": data if data is not None else {},
            "channels": channels or [],
            "capability": capability,
        }
        if timeout_s is not None:
            body["timeoutMs"] = int(timeout_s * 1000)
        begun = self._client.request("POST", f"/runs/{self.run_id}/gates/begin", body)

        deadline = time.monotonic() + timeout_s if timeout_s else None
        gate = begun["gate"]
        while gate["status"] == "pending":
            if deadline and time.monotonic() > deadline:
                raise TimeoutError(f"Gate {name} timed out")
            time.sleep(poll_s)
            gate = self._client.request("GET", f"/runs/{self.run_id}/gates/{gate['id']}")["gate"]

        if gate["decision"] not in ("approved", "rejected", "canceled"):
            raise RuntimeError(f"Gate {name} resolved with unsupported decision {gate['decision']}")
        return GateDecision(gate)

    # ---- children & fanout -------------------------------------------------

    def child(
        self,
        workflow_name: str,
        workflow: Callable[["RunContext", Any], Any],
        *,
        name: Optional[str] = None,
        input: Any = None,
        metadata: Optional[dict] = None,
        recovery_webhook: Optional[str] = None,
        channels: Optional[list] = None,
        edge_type: str = "child",
        edge_metadata: Optional[dict] = None,
    ) -> Any:
        """Run a child workflow. Child creation is idempotent by edge name, so a
        resumed parent reuses the existing child run."""
        body = {
            "name": name or workflow_name,
            "workflowName": workflow_name,
            "input": input,
            "metadata": metadata,
            "recoveryWebhook": recovery_webhook,
            "channels": channels,
            "edgeType": edge_type,
            "edgeMetadata": edge_metadata,
        }
        response = self._client.request(
            "POST",
            f"/runs/{self.run_id}/children",
            {k: v for k, v in body.items() if v is not None},
        )
        return self._client.run(workflow_name, workflow, run_id=response["run"]["id"])

    def fanout(self, name: str, children: list, *, checkpoint: Optional[str] = None) -> list:
        """Run children in parallel as child runs and join durably. Each child
        is a dict: {"name", "workflow", optional "workflow_name", "input"}."""
        with ThreadPoolExecutor(max_workers=max(1, len(children))) as pool:
            futures = [
                pool.submit(
                    self.child,
                    child.get("workflow_name") or child["name"],
                    child["workflow"],
                    name=child["name"],
                    input=child.get("input"),
                    metadata=child.get("metadata"),
                    edge_type="fanout",
                    edge_metadata={"fanout": name},
                )
                for child in children
            ]
            results = [f.result() for f in futures]

        return self.step(
            f"join:{checkpoint or name}",
            lambda: results,
            input={
                "fanout": name,
                "join": "all",
                "children": [child["name"] for child in children],
            },
            replay="auto",
            checkpoint_invariant="all child run results were collected",
        )


class RunState:
    def __init__(self, client: Tidebase, run_id: str):
        self._client = client
        self._run_id = run_id

    def _write(self, method: str, value: Any, **options: Any) -> Any:
        body = {"value": value, **_state_options(options)}
        return self._client.request(method, f"/runs/{self._run_id}/state", body)

    def set(self, value: Any, **options: Any) -> Any:
        return self._write("PUT", value, **options)

    def patch(self, value: dict, **options: Any) -> Any:
        return self._write("PATCH", value, **options)

    def save(self, label: str, **options: Any) -> dict:
        body = {"label": label, **_state_options(options)}
        return self._client.request("POST", f"/runs/{self._run_id}/state/save", body)

    def versions(self, stream: Optional[str] = None, labeled: Optional[bool] = None) -> list:
        params = []
        if stream:
            params.append(f"stream={urlparse.quote(stream)}")
        if labeled is not None:
            params.append(f"labeled={'true' if labeled else 'false'}")
        suffix = "?" + "&".join(params) if params else ""
        return self._client.request("GET", f"/runs/{self._run_id}/state/versions{suffix}")[
            "stateVersions"
        ]


def _state_options(options: dict) -> dict:
    mapping = {
        "stream": "stream",
        "label": "label",
        "reason": "reason",
        "importance": "importance",
        "metadata": "metadata",
        "created_by": "createdBy",
    }
    return {mapping[k]: v for k, v in options.items() if v is not None and k in mapping}


class RunUsage:
    def __init__(self, client: Tidebase, run_id: str):
        self._client = client
        self._run_id = run_id

    def record(
        self,
        *,
        step_id: Optional[str] = None,
        kind: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        label: Optional[str] = None,
        quantity: Optional[float] = None,
        unit: Optional[str] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        total_tokens: Optional[int] = None,
        cost_usd: Optional[float] = None,
        metadata: Optional[dict] = None,
    ) -> Any:
        body = {
            "stepId": step_id,
            "kind": kind,
            "provider": provider,
            "model": model,
            "label": label,
            "quantity": quantity,
            "unit": unit,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "costUsd": cost_usd,
            "metadata": metadata,
        }
        body = {k: v for k, v in body.items() if v is not None}
        return self._client.request("POST", f"/runs/{self._run_id}/usage", body)


class RunSnapshots:
    def __init__(self, client: Tidebase, run_id: str):
        self._client = client
        self._run_id = run_id

    def create(
        self,
        label: str,
        state: Any,
        *,
        target: Optional[dict] = None,
        reason: Optional[str] = None,
        metadata: Optional[dict] = None,
        created_by: Optional[str] = None,
    ) -> dict:
        body: dict = {"label": label, "state": state}
        if target is not None:
            body["target"] = target
        if reason is not None:
            body["reason"] = reason
        if metadata is not None:
            body["metadata"] = metadata
        if created_by is not None:
            body["createdBy"] = created_by
        return self._client.request("POST", f"/runs/{self._run_id}/snapshots", body)

    def list(self) -> list:
        return self._client.request("GET", f"/runs/{self._run_id}/snapshots")["snapshots"]
