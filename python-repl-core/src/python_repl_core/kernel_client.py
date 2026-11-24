"""Async stdio JSONL client for the vendored Prime REPL kernel (protocol 3)."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 3
DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024


@dataclass(slots=True)
class CellResult:
    cell_id: str
    status: str  # "ok" | "error"
    stdout: str = ""
    stderr: str = ""
    result: str | None = None
    displays: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    timed_out: bool = False


class KernelProtocolError(RuntimeError):
    """Raised when the kernel process exits unexpectedly or breaks protocol."""


class KernelClient:
    """Manages one Prime `rlm.repl` subprocess over newline-delimited JSON."""

    def __init__(
        self,
        *,
        python_exe: str,
        vendor_dir: Path,
        compat_dir: Path,
        cwd: Path | None = None,
        extra_pythonpath: list[Path] | None = None,
        startup_timeout_s: float = 30.0,
        max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
    ) -> None:
        self.python_exe = python_exe
        self.vendor_dir = vendor_dir
        self.compat_dir = compat_dir
        self.cwd = cwd or Path.cwd()
        self.extra_pythonpath = extra_pythonpath or []
        self.startup_timeout_s = startup_timeout_s
        self.max_frame_bytes = max_frame_bytes

        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._cell_events: dict[str, list[dict[str, Any]]] = {}
        self._ready_future: asyncio.Future[dict[str, Any]] | None = None
        self._write_lock = asyncio.Lock()
        self._exec_lock = asyncio.Lock()
        self.python_version: str = ""
        self.alive = False

    async def start(self) -> None:
        if self.alive:
            return
        pp_parts = [str(self.vendor_dir), str(self.compat_dir), *(str(p) for p in self.extra_pythonpath)]
        existing_pp = os.environ.get("PYTHONPATH")
        if existing_pp:
            pp_parts.append(existing_pp)

        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(pp_parts)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHON_REPL_OWNS_GROUP"] = "1"

        loop = asyncio.get_running_loop()
        self._ready_future = loop.create_future()

        self._proc = await asyncio.create_subprocess_exec(
            self.python_exe,
            "-u",
            "-m",
            "rlm.repl",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.cwd),
            env=env,
            start_new_session=True,
            limit=self.max_frame_bytes,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

        try:
            ready = await asyncio.wait_for(self._ready_future, timeout=self.startup_timeout_s)
        except Exception as exc:
            await self.shutdown()
            raise KernelProtocolError(f"Kernel failed to start: {exc}") from exc

        if ready.get("protocol") != PROTOCOL_VERSION:
            await self.shutdown()
            raise KernelProtocolError(f"Unsupported kernel protocol: {ready.get('protocol')}")
        self.python_version = str(ready.get("python", ""))
        self.alive = True

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                line_bytes = await self._proc.stdout.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(frame, dict):
                    continue
                self._dispatch_frame(frame)
        except Exception as exc:
            self._fail_all(KernelProtocolError(f"Kernel reader error: {exc}"))
        finally:
            self.alive = False
            self._fail_all(KernelProtocolError("Kernel process exited"))

    def _dispatch_frame(self, frame: dict[str, Any]) -> None:
        event = frame.get("event")
        if event == "ready":
            if self._ready_future and not self._ready_future.done():
                self._ready_future.set_result(frame)
            return

        req_id = frame.get("id")
        if not isinstance(req_id, str):
            return

        if event == "host_request":
            # This host does not bridge host tool calls; reply with a clear error.
            asyncio.create_task(
                self._send(
                    {
                        "type": "host_reply",
                        "id": req_id,
                        "data": {"status": "error", "error": "host_request is not supported in this host"},
                    }
                )
            )
            return

        if event in {"stdout", "stderr", "result", "display", "error"}:
            bucket = self._cell_events.get(req_id)
            if bucket is not None:
                bucket.append(frame)
            return

        if event == "done":
            fut = self._pending.pop(req_id, None)
            if fut and not fut.done():
                fut.set_result(frame)

    def _fail_all(self, exc: BaseException) -> None:
        if self._ready_future and not self._ready_future.done():
            self._ready_future.set_exception(exc)
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def _send(self, payload: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            raise KernelProtocolError("Kernel stdin is closed")
        raw = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        async with self._write_lock:
            self._proc.stdin.write(raw)
            await self._proc.stdin.drain()

    async def _request(self, req_type: str, timeout_s: float = 30.0, **fields: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if not self.alive:
            await self.start()
        req_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[req_id] = fut
        self._cell_events[req_id] = []
        try:
            await self._send({"type": req_type, "id": req_id, **fields})
            done_frame = await asyncio.wait_for(fut, timeout=timeout_s)
            events = self._cell_events.pop(req_id, [])
            return done_frame, events
        except BaseException:
            self._pending.pop(req_id, None)
            self._cell_events.pop(req_id, None)
            raise

    async def execute(self, code: str, *, timeout_s: float = 60.0) -> CellResult:
        async with self._exec_lock:
            if not self.alive:
                await self.start()
            req_id = uuid.uuid4().hex
            loop = asyncio.get_running_loop()
            fut: asyncio.Future[dict[str, Any]] = loop.create_future()
            self._pending[req_id] = fut
            self._cell_events[req_id] = []
            timed_out = False
            try:
                await self._send({"type": "execute", "id": req_id, "code": code})
                try:
                    done_frame = await asyncio.wait_for(asyncio.shield(fut), timeout=timeout_s)
                except asyncio.TimeoutError:
                    timed_out = True
                    await self.interrupt()
                    try:
                        done_frame = await asyncio.wait_for(asyncio.shield(fut), timeout=5.0)
                    except asyncio.TimeoutError:
                        await self.shutdown()
                        raise KernelProtocolError(f"Cell timed out after {timeout_s}s and failed to interrupt")
                events = self._cell_events.pop(req_id, [])
            except BaseException:
                self._pending.pop(req_id, None)
                self._cell_events.pop(req_id, None)
                raise

            stdout_parts: list[str] = []
            stderr_parts: list[str] = []
            result_text: str | None = None
            displays: list[dict[str, Any]] = []
            error_info: dict[str, Any] | None = None

            for ev in events:
                kind = ev.get("event")
                if kind == "stdout":
                    stdout_parts.append(str(ev.get("text", "")))
                elif kind == "stderr":
                    stderr_parts.append(str(ev.get("text", "")))
                elif kind == "result":
                    result_text = str(ev.get("text", ""))
                elif kind == "display":
                    displays.append(dict(ev.get("data", {})))
                elif kind == "error":
                    error_info = {
                        "ename": ev.get("ename", "Error"),
                        "evalue": ev.get("evalue", ""),
                        "traceback": ev.get("traceback", []),
                    }

            return CellResult(
                cell_id=req_id,
                status=str(done_frame.get("status", "ok")),
                stdout="".join(stdout_parts),
                stderr="".join(stderr_parts),
                result=result_text,
                displays=displays,
                error=error_info,
                timed_out=timed_out,
            )

    async def interrupt(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                await self._send({"type": "interrupt", "id": uuid.uuid4().hex})
            except Exception:
                pass
            try:
                os.killpg(self._proc.pid, signal.SIGINT)
            except OSError:
                pass

    async def list_names(self) -> dict[str, Any]:
        done, _ = await self._request("list_names", timeout_s=10.0)
        return done

    async def snapshot(self, path: Path, manifest_path: Path) -> dict[str, Any]:
        path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        done, _ = await self._request("snapshot", timeout_s=30.0, path=str(path), manifest_path=str(manifest_path))
        return done

    async def restore(self, path: Path) -> dict[str, Any]:
        done, _ = await self._request("restore", timeout_s=30.0, path=str(path))
        return done

    async def restore_if_present(self, path: Path, manifest_path: Path | None = None) -> dict[str, Any] | None:
        """Restore a Prime kernel snapshot when `path` exists; return a concise summary or None."""
        if not path.is_file():
            return None
        done = await self.restore(path)
        manifest: dict[str, Any] = {}
        if manifest_path and manifest_path.is_file():
            try:
                loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    manifest = loaded
            except Exception:
                pass
        return {
            "restored": done.get("status") == "ok",
            "status": done.get("status"),
            "snapshot_path": str(path),
            "saved_names": manifest.get("savedNames", []),
            "skipped": manifest.get("skipped", []),
            "timestamp": manifest.get("timestamp"),
        }

    async def shutdown(self) -> None:
        self.alive = False
        proc = self._proc
        self._proc = None
        if proc and proc.returncode is None:
            try:
                if proc.stdin:
                    proc.stdin.write((json.dumps({"type": "shutdown", "id": uuid.uuid4().hex}) + "\n").encode("utf-8"))
                    await proc.stdin.drain()
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except Exception:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except Exception:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except OSError:
                        pass
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        self._fail_all(KernelProtocolError("Kernel shut down"))
