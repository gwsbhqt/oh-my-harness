"""`repl.agent(prompt, ...)`: start a subagent and get its result back in Python.

The `subagent` tool returns only an id and reports to the model, so code can
fan work out but never use what comes back. This asks the host to start the
child through DSH's subagent service with the result returned to the caller
(src/agent-runs.ts), the way DSH's workflow engine does for its `agent()`:
the call waits for the child, then returns its final text, or with a schema
its structured value, or None when the child failed. The child belongs to the
cell or `repl.background` job that started it and is stopped when that ends.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

_LABEL_CHARS = 80
#: Cancel notices in flight; the loop keeps only weak references to tasks.
_SENDING: set[asyncio.Task] = set()


def _check_schema(schema: Any) -> None:
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise TypeError("schema must be a JSON Schema for an object, e.g. {'type': 'object', 'properties': {...}, 'required': [...]}")


def _cancel(call_id: str) -> None:
    import dsh_kernel

    async def send() -> None:
        try:
            await dsh_kernel._host_request({"kind": "agent", "op": "cancel", "epoch": dsh_kernel._epoch_value, "callId": call_id})
        except Exception:  # noqa: BLE001 - the host is gone, and the child with it
            pass

    task = asyncio.get_running_loop().create_task(send())
    _SENDING.add(task)
    task.add_done_callback(_SENDING.discard)


async def run(prompt: str, *, schema: dict | None = None, model: str | None = None,
              provider: str | None = None, label: str | None = None) -> Any:
    """Start one subagent with `prompt`; return its final text, its structured value with `schema`, or None if it failed."""
    import dsh_kernel

    if not isinstance(prompt, str) or not prompt.strip():
        raise TypeError("repl.agent() needs a non-empty prompt string: the complete, self-contained task")
    if schema is not None:
        _check_schema(schema)
    run_id = dsh_kernel._current_run_id()
    if run_id is None or dsh_kernel._host_request is None:
        raise RuntimeError("repl.agent() must be called from a cell or from repl.background work")
    call_id = uuid.uuid4().hex
    payload: dict[str, Any] = {
        "kind": "agent", "op": "run", "epoch": dsh_kernel._epoch_value, "runId": run_id, "callId": call_id,
        "prompt": prompt, "label": (label or " ".join(prompt.split()))[:_LABEL_CHARS],
    }
    job_id = dsh_kernel._job_var.get()
    if job_id is not None:
        payload["jobId"] = job_id
    for key, value in (("schema", schema), ("model", model), ("provider", provider)):
        if value is not None:
            payload[key] = value
    try:
        json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise dsh_kernel.ToolCallError("repl.agent", f"arguments are not JSON-serializable: {exc}") from None
    try:
        envelope = await dsh_kernel._host_request(payload)
    except asyncio.CancelledError:
        _cancel(call_id)
        raise
    if not isinstance(envelope, dict):
        raise dsh_kernel.ToolCallError("repl.agent", f"malformed host reply: {envelope!r}")
    if envelope.get("status") != "ok":
        message = str(envelope.get("error", "repl.agent failed"))
        if envelope.get("cancelled"):
            raise asyncio.CancelledError(message)
        raise dsh_kernel.ToolCallError("repl.agent", message)
    result = envelope.get("result") or {}
    if result.get("stopReason") != "completed":
        return None
    if schema is not None:
        return result.get("structured")
    return result.get("text", "")
