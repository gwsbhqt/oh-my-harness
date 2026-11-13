"""`repl.background(work)`: long work that should not hold a cell.

The kernel serves one request at a time, so a cell that computes for minutes
blocks every later cell and the user. Handed to `repl.background`, the work
runs as an asyncio task (a plain function in a thread) after the cell ends,
and the host registers it as a DSH background job: it shows in the job panel,
`job_kill` stops it, and its end wakes the agent through the same merged
notice as bash jobs. A subagent gets no such notice: DSH stops the work when
the subagent's turn ends (src/subagent.ts), so there it must be awaited. Once its cell has ended the work still calls the cell's
DSH tools: the host sends those calls through DSH's public tool pipeline
(approval, sandbox and hooks as usual) until the job ends or is stopped
(src/background-tools.ts).
"""
from __future__ import annotations

import asyncio
import inspect
import os
import time
import traceback
from typing import Any

_HANDLES: dict[str, "BackgroundJob"] = {}
_RESULT_CHARS = 4_000
_PROGRESS_CHARS = 500
#: The kernel's event loop, so `progress` also works from work running in a thread.
_LOOP: asyncio.AbstractEventLoop | None = None
#: Progress sends in flight; the loop keeps only weak references to tasks.
_SENDING: set[asyncio.Task] = set()


class _Sent:
    """What `repl.progress` returns: nothing to wait for, but `await`ing it is harmless."""

    __slots__ = ()

    def __await__(self):
        return iter(())

    def __repr__(self) -> str:
        return "<progress sent>"


def progress(text: Any) -> _Sent:
    """Add one line to this background job's output, shown in the job panel and read by job_output."""
    import dsh_kernel

    job_id = dsh_kernel._job_var.get()
    if job_id is None:
        raise RuntimeError("repl.progress() reports from inside repl.background work; in a cell, print instead")
    line = " ".join(str(text).split())[:_PROGRESS_CHARS]
    payload = {"kind": "background", "op": "progress", "epoch": dsh_kernel._epoch_value, "jobId": job_id, "text": line}

    async def send() -> None:
        try:
            await dsh_kernel._host_request(payload)
        except Exception:  # noqa: BLE001 - a lost progress line must not fail the work
            pass

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    def schedule(on: asyncio.AbstractEventLoop) -> None:
        task = on.create_task(send())
        _SENDING.add(task)
        task.add_done_callback(_SENDING.discard)

    if loop is not None:
        schedule(loop)
    elif _LOOP is not None:
        _LOOP.call_soon_threadsafe(schedule, _LOOP)
    return _Sent()


class BackgroundJob:
    """Handle for `repl.background` work; `await job` gives its value (or raises its error)."""

    __slots__ = ("id", "label", "_task", "_thread", "__weakref__")

    def __init__(self, job_id: str, label: str, task: asyncio.Task, thread: bool) -> None:
        self.id = job_id
        self.label = label
        self._task = task
        self._thread = thread

    def done(self) -> bool:
        return self._task.done()

    def __await__(self):
        return self._wait().__await__()

    async def _wait(self) -> Any:
        import dsh_kernel

        if self._task.done():
            return self._task.result()
        cap = dsh_kernel._WAIT_MS
        if cap <= 0:
            return await asyncio.shield(self._task)
        try:
            return await asyncio.wait_for(asyncio.shield(self._task), cap / 1000)
        except TimeoutError:
            raise dsh_kernel.JobStillRunning(
                f"background job {self.id} still running after {cap / 1000:g}s; it keeps running. "
                + ("You are a subagent: ending your turn ends your run and stops this work with no notice, "
                   "so `await` this handle again to keep waiting."
                   if dsh_kernel._SUBAGENT else
                   "DSH wakes you when it finishes, so end this turn instead of waiting in a cell; "
                   "`await` this handle then returns its value at once.")
            ) from None

    def cancel(self) -> str:
        """Stop the work; a function running in a thread cannot be stopped and finishes on its own."""
        if self._task.done():
            return "already finished"
        if self._thread:
            return "runs in a thread, which cannot be stopped; it ends when the function returns"
        self._task.cancel()
        return "cancelled"

    def __repr__(self) -> str:
        if not self._task.done():
            state = "running"
        elif self._task.cancelled():
            state = "cancelled"
        elif self._task.exception() is not None:
            state = f"failed: {type(self._task.exception()).__name__}"
        else:
            state = "finished"
        return f"<background job {self.id} {state}: {self.label[:80]!r}>"


def _summary(value: Any) -> str:
    try:
        text = repr(value)
    except Exception as exc:  # noqa: BLE001 - a broken repr must not lose the outcome
        text = f"<repr failed: {type(exc).__name__}>"
    return text if len(text) <= _RESULT_CHARS else text[:_RESULT_CHARS] + f"… ({len(text)} characters; the whole value is in the handle)"


async def _report(job_id: str, status: str, detail: str, text: str) -> None:
    import dsh_kernel

    # Progress lines still on their way must land before the end, which retires the job on the host.
    pending = list(_SENDING)
    if pending:
        await asyncio.wait(pending, timeout=2)
    try:
        await dsh_kernel._host_request({"kind": "background", "op": "end", "epoch": dsh_kernel._epoch_value,
                                        "jobId": job_id, "status": status, "detail": detail, "text": text})
    except Exception:  # noqa: BLE001 - the host is gone; nothing is left to tell
        pass


async def start(work: Any, label: str | None = None) -> BackgroundJob:
    """Run `work` (a coroutine, or a function to call in a thread) as a DSH background job."""
    import dsh_kernel

    thread = False
    if inspect.iscoroutine(work):
        coro = work
    elif inspect.iscoroutinefunction(work):
        coro = work()
    elif callable(work):
        coro, thread = asyncio.to_thread(work), True
    else:
        raise TypeError("repl.background() takes a coroutine, an async function, or a plain function to run in a thread")
    name = label or getattr(work, "__qualname__", None) or getattr(getattr(work, "cr_code", None), "co_name", None) or "python work"
    run_id = dsh_kernel._current_run_id()
    if run_id is None or dsh_kernel._host_request is None:
        if inspect.iscoroutine(coro):
            coro.close()
        raise RuntimeError("repl.background() must be called from a cell")
    try:
        reply = await dsh_kernel._host_request({"kind": "background", "op": "start", "epoch": dsh_kernel._epoch_value,
                                                "runId": run_id, "label": str(name)[:200]})
    except BaseException:
        if inspect.iscoroutine(coro):
            coro.close()
        raise
    if not isinstance(reply, dict) or reply.get("status") != "ok":
        if inspect.iscoroutine(coro):
            coro.close()
        reason = reply.get("error") if isinstance(reply, dict) else reply
        raise dsh_kernel.ToolCallError("repl.background", f"the host could not register the job: {reason}")
    job_id = reply["result"]["jobId"]

    async def run() -> Any:
        # Calls from this task and the tasks it starts carry the job id (dsh_kernel._call_tool).
        dsh_kernel._job_var.set(job_id)
        started = time.monotonic()
        try:
            value = await coro
            if thread and inspect.iscoroutine(value):
                value.close()
                raise TypeError("repl.background() function returned a coroutine; pass the coroutine or async function directly")
        except asyncio.CancelledError:
            await _report(job_id, "killed", "cancelled", "")
            raise
        except BaseException as exc:  # noqa: BLE001 - every failure is reported, then re-raised to the handle
            text = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            await _report(job_id, "failed", text[:300], text)
            raise
        await _report(job_id, "completed", f"finished in {time.monotonic() - started:.1f}s", _summary(value))
        return value

    global _LOOP
    _LOOP = asyncio.get_running_loop()
    task = _LOOP.create_task(run())
    # The handle owns the outcome; this keeps asyncio from warning about an exception nobody read yet.
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    handle = BackgroundJob(job_id, str(name), task, thread)
    _HANDLES[job_id] = handle
    # Only job_kill looks here; a finished job's value stays reachable through the handle the cell holds.
    task.add_done_callback(lambda _t: _HANDLES.pop(job_id, None))
    return handle


def cancel(job_id: str) -> str:
    """Host side of job_kill on a `repl.background` job."""
    handle = _HANDLES.get(job_id)
    return "unknown or already finished job" if handle is None else handle.cancel()
