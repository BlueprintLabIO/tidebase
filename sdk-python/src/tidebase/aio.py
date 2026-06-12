"""Async support for the Tidebase Python SDK.

`AsyncTidebase` mirrors `tidebase.Tidebase` for asyncio codebases: workflows
and steps may be `async def`, HTTP calls run off the event loop via
`asyncio.to_thread`, and cancellation (`tidebase.RunCancelled`) propagates
through awaits like any other exception — no cleanup branch can miss it.

    from tidebase.aio import AsyncTidebase

    tide = AsyncTidebase()

    @tide.workflow("generate-report")
    async def generate_report(run, input):
        plan = await run.step("plan", lambda: make_plan(input))      # sync step
        text = await run.step("draft", draft_async)                   # async step
        decision = await run.gate("approve", "Send it?")
        return await run.step("send", lambda: send(text))

    await tide.run("generate-report", generate_report, input={...})
    # or: await tide.work(["default"])   # async worker loop
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable, Optional

from . import (
    GateDecision,
    RunCancelled,
    RunContext,
    RunSession,
    Tidebase,
    _classify_resume_decision,
    _hash_stable,
    _serialize_error,
)

__all__ = ["AsyncTidebase", "AsyncRunContext", "AsyncRunSession"]


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class AsyncRunContext:
    """Async run context: same checkpoint protocol as RunContext, but the
    user's step function may be `async def` and is awaited on the event loop
    (only the HTTP calls run in a thread)."""

    def __init__(self, inner: RunContext):
        self._inner = inner
        self._client = inner._client  # noqa: SLF001 — same package
        self.run_id = inner.run_id

    async def _request(self, method: str, path: str, body: Any = None) -> Any:
        return await asyncio.to_thread(self._client.request, method, path, body)

    async def step(
        self,
        name: str,
        fn: Callable[[], Any],
        *,
        input: Any = None,
        input_hash: Optional[str] = None,
        retries: int = 0,
        side_effects: Optional[list] = None,
        idempotency_key: Optional[str] = None,
        replay: Optional[str] = None,
        checkpoint_invariant: Any = None,
    ) -> Any:
        options: dict = {}
        if input is not None:
            options["input"] = input
        if retries:
            options["retries"] = retries
        if side_effects is not None:
            options["sideEffects"] = side_effects
        if idempotency_key is not None:
            options["idempotencyKey"] = idempotency_key
        if replay is not None:
            options["replay"] = replay
        if checkpoint_invariant is not None:
            options["checkpointInvariant"] = checkpoint_invariant

        resolved_hash = input_hash or _hash_stable(input if input is not None else None)

        async def begin() -> dict:
            return await self._request(
                "POST",
                f"/runs/{self.run_id}/steps/begin",
                {
                    "name": name,
                    "inputHash": resolved_hash,
                    "input": input,
                    "options": options,
                    "leaseOwner": self._inner._lease_owner,  # noqa: SLF001
                },
            )

        current = await begin()
        if current["action"] == "return":
            return current["output"]
        if current["action"] == "cancelled":
            raise RunCancelled(self.run_id)
        if current["action"] in ("locked", "input_mismatch"):
            raise RuntimeError(f"Step {name}: {current['action']}")

        attempts = max(1, retries + 1)
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                current = await begin()
                if current["action"] == "return":
                    return current["output"]
                if current["action"] == "cancelled":
                    raise RunCancelled(self.run_id)
                if current["action"] in ("locked", "input_mismatch"):
                    raise RuntimeError(f"Step {name}: {current['action']}")
            try:
                result = await _maybe_await(fn())
                await self._request(
                    "POST",
                    f"/runs/{self.run_id}/steps/{current['step']['id']}/complete",
                    {"leaseOwner": current["leaseOwner"], "output": result},
                )
                return result
            except BaseException as error:
                retryable = attempt < attempts
                try:
                    await self._request(
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

    async def gate(self, name: str, prompt: str, **options: Any) -> GateDecision:
        return await asyncio.to_thread(self._inner.gate, name, prompt, **options)

    async def state_set(self, value: Any, **options: Any) -> Any:
        return await asyncio.to_thread(self._inner.state.set, value, **options)

    async def state_patch(self, value: dict, **options: Any) -> Any:
        return await asyncio.to_thread(self._inner.state.patch, value, **options)

    async def state_save(self, label: str, **options: Any) -> Any:
        return await asyncio.to_thread(self._inner.state.save, label, **options)

    async def usage_record(self, **options: Any) -> Any:
        return await asyncio.to_thread(self._inner.usage.record, **options)


class AsyncRunSession(AsyncRunContext):
    """Async view of a session run (see tidebase.RunSession): same step/gate/
    state surface as AsyncRunContext, plus explicit lifecycle. The lease
    heartbeat runs on its own daemon thread either way."""

    def __init__(self, inner: RunSession):
        super().__init__(inner)
        self.run = inner.run

    async def heartbeat(self) -> dict:
        return await asyncio.to_thread(self._inner.heartbeat)

    async def complete(self, result: Any = None) -> dict:
        return await asyncio.to_thread(self._inner.complete, result)

    async def fail(self, error: Any) -> dict:
        return await asyncio.to_thread(self._inner.fail, error)

    def close(self) -> None:
        self._inner.close()

    async def gates_begin(self, name: str, prompt: str, **options: Any) -> dict:
        return await asyncio.to_thread(self._inner.gates.begin, name, prompt, **options)

    async def gates_get(self, gate_id: str) -> dict:
        return await asyncio.to_thread(self._inner.gates.get, gate_id)


class AsyncTidebase:
    def __init__(self, url: Optional[str] = None, api_key: Optional[str] = None):
        self._sync = Tidebase(url=url, api_key=api_key)
        self._workflows: dict = {}
        self.runs = self._sync.runs
        self.queues = self._sync.queues
        self.schedules = self._sync.schedules

    def workflow(self, name: str, fn: Optional[Callable] = None):
        if fn is None:
            def decorator(f):
                self._workflows[name] = f
                return f
            return decorator
        self._workflows[name] = fn
        return fn

    async def run(
        self,
        workflow_name: str,
        workflow: Optional[Callable] = None,
        *,
        run_id: Optional[str] = None,
        input: Any = None,
        **create_options: Any,
    ) -> Any:
        workflow = workflow or self._workflows.get(workflow_name)
        if workflow is None:
            raise ValueError(f"no workflow registered for {workflow_name}")

        if run_id is None:
            run = await asyncio.to_thread(
                self._sync.runs.create, workflow_name, input=input, **create_options
            )
        else:
            detail = await asyncio.to_thread(self._sync.runs.get, run_id)
            run = detail["run"]
        if run["status"] == "completed":
            return run["result"]

        begin = await asyncio.to_thread(self._sync.request, "POST", f"/runs/{run['id']}/begin")
        return await self._execute(run["id"], run["input"], begin["leaseOwner"], workflow)

    async def _execute(self, run_id: str, input: Any, lease_owner: str, workflow: Callable) -> Any:
        context = AsyncRunContext(RunContext(self._sync, run_id, lease_owner))
        try:
            result = await _maybe_await(workflow(context, input))
            await asyncio.to_thread(
                self._sync.request, "POST", f"/runs/{run_id}/complete", {"result": result}
            )
            return result
        except RunCancelled:
            raise
        except BaseException as error:
            try:
                await asyncio.to_thread(
                    self._sync.request,
                    "POST",
                    f"/runs/{run_id}/fail",
                    {"error": _serialize_error(error)},
                )
            except Exception:
                pass
            raise

    async def attach(self, workflow_name: str, **options: Any) -> AsyncRunSession:
        """Async counterpart of tide.runs.attach(): returns an AsyncRunSession
        holding the run lease via a background heartbeat."""
        session = await asyncio.to_thread(
            self._sync.runs.attach, workflow_name, **options
        )
        return AsyncRunSession(session)

    async def enqueue(self, workflow_name: str, **options: Any) -> dict:
        return await asyncio.to_thread(self._sync.enqueue, workflow_name, **options)

    async def cancel(self, run_id: str, reason: Optional[str] = None, actor: Optional[str] = None) -> dict:
        return await asyncio.to_thread(self._sync.runs.cancel, run_id, reason, actor)

    async def work(
        self,
        queues: Optional[list] = None,
        *,
        poll_s: float = 1.0,
        limit: int = 1,
        on_error: Optional[Callable[[BaseException, dict], None]] = None,
    ) -> None:
        """Async worker loop. Cancel the surrounding task to stop."""
        queues = queues or ["default"]
        while True:
            claim = await asyncio.to_thread(
                self._sync.request, "POST", "/queues/claim", {"queues": queues, "limit": limit}
            )
            for run in claim["runs"]:
                workflow = self._workflows.get(run["workflowName"])
                if workflow is None:
                    continue
                try:
                    await self._execute(run["id"], run["input"], claim["leaseOwner"], workflow)
                except asyncio.CancelledError:
                    raise
                except BaseException as error:
                    if on_error:
                        on_error(error, run)
            if not claim["runs"]:
                await asyncio.sleep(poll_s)
