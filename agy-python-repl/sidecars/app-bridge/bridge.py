#!/usr/bin/env python3
"""Antigravity App Sidecar bridge exposing ConversationService and agentapi over a local Unix socket.

Keep compatible with Python 3.9+ standard library only so the Sidecar starts cleanly
under the host system python3 without extra dependencies.
"""

from __future__ import annotations

import asyncio
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.request


MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_CONVERSATION_SCAN = 1000
PARENT_POLL_SECONDS = 1.0


def default_socket_path() -> Path:
    explicit = os.environ.get("AGY_USE_SOCKET", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(state_home).expanduser() if state_home else Path.home() / ".local" / "state"
    return base / "agy-use" / "bridge.sock"


def metadata_path_for(sock_path: Path) -> Path:
    return sock_path.with_suffix(".json")


def app_data_dir() -> Path:
    raw = os.environ.get("ANTIGRAVITY_APP_DATA_DIR", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".gemini" / "antigravity"


def resolve_agentapi_command() -> Optional[List[str]]:
    which = shutil.which("agentapi")
    if which:
        return [which]
    candidate = app_data_dir() / "bin" / "agentapi"
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return [str(candidate)]
    exe = os.environ.get("ANTIGRAVITY_AGENTAPI_EXE", "").strip()
    if exe and Path(exe).is_file() and os.access(exe, os.X_OK):
        return [exe, "agentapi"]
    return None


def _safe_conv_id(conv_id: str) -> bool:
    if not conv_id or conv_id in (".", ".."):
        return False
    return "/" not in conv_id and "\\" not in conv_id and "\0" not in conv_id


def _read_transcript_sync(
    conv_id: str, full: bool, include_steps: bool = True,
    from_step: int = 0, limit: int = 0, last_reply_only: bool = False,
) -> Dict[str, Any]:
    if not _safe_conv_id(conv_id):
        return {"ok": False, "error_code": "invalid-argument", "error": "Invalid conversation_id"}
    if any(type(n) is not int or n < 0 for n in (from_step, limit)):
        return {"ok": False, "error_code": "invalid-argument", "error": "Expected nonnegative from_step and limit"}
    logs_dir = app_data_dir() / "brain" / conv_id / ".system_generated" / "logs"
    path = logs_dir / ("transcript_full.jsonl" if full else "transcript.jsonl")
    selected: List[Dict[str, Any]] = []
    total = matched = 0
    last_index = None
    last_reply = None
    preview = ""
    exists = True
    try:
        with path.open(encoding="utf-8") as source:
            for line in source:
                if not line.strip():
                    continue
                try:
                    step = json.loads(line)
                except ValueError:
                    if not line.endswith("\n"):
                        break  # The App may still be appending this final record.
                    raise
                if not isinstance(step, dict):
                    continue
                total += 1
                index = step.get("step_index")
                if not isinstance(index, int):
                    continue
                last_index = index
                if step.get("type") == "PLANNER_RESPONSE" and not step.get("tool_calls"):
                    text = next((step[k] for k in ("content", "response", "answer") if isinstance(step.get(k), str) and step[k].strip()), "")
                    if text:
                        preview = text[:400]
                        if last_reply_only:
                            last_reply = step
                if include_steps and not last_reply_only and index >= from_step:
                    matched += 1
                    if not limit or len(selected) < limit:
                        selected.append(step)
    except FileNotFoundError:
        exists = False
    except (OSError, ValueError) as err:
        return {"ok": False, "error_code": "transcript-read-error", "path": str(path), "error": str(err)}
    if last_reply is not None:
        selected.append(last_reply)
    return {
        "ok": True, "exists": exists, "path": str(path), "steps": selected,
        "total_steps": total, "last_step_index": last_index, "last_response_preview": preview,
        "has_more": bool(limit and matched > limit),
    }


def _ls_config() -> Tuple[str, str]:
    addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS", "").strip()
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN", "").strip()
    return addr, csrf


def _call_ls_sync(method: str, body: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    addr, csrf = _ls_config()
    if not addr or not csrf:
        return {
            "ok": False,
            "error_code": "ls-not-configured",
            "error": "ANTIGRAVITY_LS_ADDRESS or ANTIGRAVITY_CSRF_TOKEN is missing in Sidecar environment.",
        }
    url = f"http://{addr}/product.v1.ConversationService/{method}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-antigravity-csrf-token": csrf,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw.strip() else {}
            return {"ok": True, "data": data}
    except urllib.error.HTTPError as err:
        raw_err = err.read().decode("utf-8", errors="replace")
        detail: Any = raw_err
        try:
            detail = json.loads(raw_err)
        except ValueError:
            pass
        return {
            "ok": False,
            "error_code": "ls-http-error",
            "http_status": err.code,
            "error": detail.get("message", raw_err) if isinstance(detail, dict) else (raw_err or str(err)),
            "detail": detail,
        }
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as err:
        return {
            "ok": False,
            "error_code": "ls-unreachable",
            "error": str(err),
        }


async def _call_ls(method: str, body: Dict[str, Any], timeout: float = 15.0) -> Dict[str, Any]:
    return await asyncio.to_thread(_call_ls_sync, method, body, timeout)


async def _run_agentapi(args: List[str], timeout: float = 30.0) -> Dict[str, Any]:
    cmd = resolve_agentapi_command()
    if not cmd:
        return {
            "ok": False,
            "sent": False,
            "error_code": "agentapi-unavailable",
            "error": "agentapi executable was not found in Sidecar PATH or Antigravity bin directory.",
        }
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        stdout, stderr = await proc.communicate()
        return {
            "ok": False,
            "sent": None,
            "uncertain": True,
            "timed_out": True,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "error_code": "agentapi-timeout",
            "error": f"agentapi timed out after {timeout:g}s; delivery state is uncertain.",
        }
    out_text = stdout.decode("utf-8", errors="replace")
    err_text = stderr.decode("utf-8", errors="replace")
    parsed: Any = None
    if out_text.strip():
        try:
            parsed = json.loads(out_text)
        except ValueError:
            parsed = None
    if proc.returncode != 0:
        return {
            "ok": False,
            "sent": False,
            "exit_code": proc.returncode,
            "stdout": out_text,
            "stderr": err_text,
            "data": parsed,
            "error_code": "agentapi-failed",
            "error": err_text.strip() or out_text.strip() or f"agentapi exited with code {proc.returncode}",
        }
    return {
        "ok": True,
        "exit_code": 0,
        "stdout": out_text,
        "stderr": err_text,
        "data": parsed,
    }


class AppBridgeServer:
    def __init__(self, sock_path: Path) -> None:
        self.sock_path = sock_path
        self.meta_path = metadata_path_for(sock_path)
        self._socket_entry: Optional[os.stat_result] = None
        self._metadata_entry: Optional[os.stat_result] = None
        self._server: Optional[asyncio.AbstractServer] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._parent_pid = os.getppid()

    async def handle_op(self, op: str, params: Dict[str, Any]) -> Dict[str, Any]:
        timeout = float(params.get("timeout") or 15.0)

        if op == "health":
            addr, csrf = _ls_config()
            agentapi_cmd = resolve_agentapi_command()
            ls_res = await _call_ls("ListConversations", {"pageSize": 1}, timeout=min(timeout, 10.0))
            return {
                "ok": bool(ls_res.get("ok") and agentapi_cmd),
                "transport": "sidecar",
                "pid": os.getpid(),
                "socket": str(self.sock_path),
                "app_data_dir": str(app_data_dir()),
                "ls_configured": bool(addr and csrf),
                "ls_address": addr or None,
                "ls_reachable": bool(ls_res.get("ok")),
                "ls_error": None if ls_res.get("ok") else ls_res.get("error"),
                "agentapi_available": bool(agentapi_cmd),
                "agentapi_command": agentapi_cmd[0] if agentapi_cmd else None,
                "default_project_id": os.environ.get("ANTIGRAVITY_PROJECT_ID", "").strip() or None,
                "error_code": None if (ls_res.get("ok") and agentapi_cmd) else (
                    ls_res.get("error_code") if not ls_res.get("ok") else "agentapi-unavailable"
                ),
                "error": (
                    None
                    if (ls_res.get("ok") and agentapi_cmd)
                    else (ls_res.get("error") or "agentapi executable unavailable")
                ),
            }

        if op == "list_conversations":
            limit = int(params.get("limit", 20))
            page_size = int(params.get("page_size") or (100 if limit == 0 or limit > 100 else max(1, limit)))
            body: Dict[str, Any] = {
                "pageSize": min(100, max(1, page_size)),
                "includeArchived": bool(params.get("include_archived", False)),
            }
            if params.get("project_id"):
                body["projectId"] = str(params["project_id"])
            if params.get("parent_conversation_id") is not None:
                body["parentConversationId"] = str(params["parent_conversation_id"])
            if params.get("tags"):
                body["tags"] = [str(t) for t in params["tags"]]
            if params.get("page_token"):
                body["pageToken"] = str(params["page_token"])

            collected: List[Dict[str, Any]] = []
            next_token: Optional[str] = None
            scan_all = bool(params.get("scan_all", False)) or limit == 0 or limit > 100
            while True:
                req_body = dict(body)
                if next_token:
                    req_body["pageToken"] = next_token
                res = await _call_ls("ListConversations", req_body, timeout=timeout)
                if not res.get("ok"):
                    return res
                data = res["data"]
                batch = data.get("conversations") or []
                collected.extend(batch)
                next_token = data.get("nextPageToken") or None
                if not next_token or not scan_all or len(collected) >= MAX_CONVERSATION_SCAN:
                    break
                if limit > 0 and len(collected) >= limit:
                    break
            return {
                "ok": True,
                "conversations": collected,
                "next_page_token": next_token,
            }

        if op == "get_conversation":
            conv_id = str(params.get("conversation_id") or "").strip()
            if not conv_id:
                return {"ok": False, "error_code": "invalid-argument", "error": "conversation_id is required"}
            res = await _call_ls("GetConversation", {"conversationId": conv_id}, timeout=timeout)
            if not res.get("ok"):
                if res.get("http_status") == 404:
                    res["error_code"] = "target-not-found"
                return res
            out: Dict[str, Any] = {"ok": True, "conversation": res["data"]}
            if params.get("include_metadata", True):
                meta = await _run_agentapi(["get-conversation-metadata", conv_id], timeout=min(timeout, 15.0))
                if meta.get("ok") and isinstance(meta.get("data"), dict):
                    out["metadata"] = meta["data"].get("response", {}).get("conversationMetadata", meta["data"])
                else:
                    out["metadata_error"] = meta.get("error")
            return out

        if op == "create_conversation":
            body = {}
            project_id = params.get("project_id")
            if project_id is None:
                project_id = os.environ.get("ANTIGRAVITY_PROJECT_ID", "").strip() or None
            if project_id:
                body["projectId"] = str(project_id)
            if params.get("environment_id"):
                body["environmentId"] = str(params["environment_id"])
            if params.get("title"):
                body["title"] = str(params["title"])
            if params.get("model"):
                body["model"] = str(params["model"])
            if params.get("tags"):
                body["tags"] = [str(t) for t in params["tags"]]
            prompt = params.get("prompt")
            if isinstance(prompt, str) and prompt.strip():
                body["prompt"] = [{"text": prompt}]
            res = await _call_ls("CreateConversation", body, timeout=timeout)
            if not res.get("ok"):
                return res
            conv = res["data"].get("conversation", res["data"])
            return {"ok": True, "conversation": conv}

        if op == "send_message":
            conv_id = str(params.get("conversation_id") or "").strip()
            prompt = params.get("prompt")
            if not conv_id or not isinstance(prompt, str) or not prompt.strip():
                return {
                    "ok": False,
                    "sent": False,
                    "error_code": "invalid-argument",
                    "error": "conversation_id and non-empty prompt are required",
                }
            # Verify target exists before invoking agentapi send-message, because agentapi
            # may return exit 0 even when recipientId does not exist.
            check = await _call_ls("GetConversation", {"conversationId": conv_id}, timeout=min(timeout, 10.0))
            if not check.get("ok"):
                if check.get("http_status") == 404:
                    check["error_code"] = "target-not-found"
                check["sent"] = False
                return check
            if not isinstance(check.get("data"), dict) or check["data"].get("id") != conv_id:
                return {"ok": False, "sent": False, "error_code": "target-mismatch", "error": "App returned a different conversation"}

            cmd_args = ["send-message"]
            title = params.get("title")
            if isinstance(title, str) and title.strip():
                cmd_args.append(f"--title={title}")
            cmd_args.extend(["--", conv_id, prompt])
            sent = await _run_agentapi(cmd_args, timeout=timeout)
            if not sent.get("ok"):
                if sent.get("error_code") == "agentapi-failed":
                    sent.update(sent=None, uncertain=True)
                return sent
            data = sent.get("data")
            response = data.get("response") if isinstance(data, dict) else None
            echo = response.get("sendMessage") if isinstance(response, dict) else None
            if not isinstance(echo, dict) or echo.get("recipientId") != conv_id or echo.get("content") != prompt:
                return {
                    "ok": False, "sent": None, "uncertain": True, "error_code": "unconfirmed-delivery",
                    "error": "agentapi returned no matching recipient and message receipt",
                    "conversation_id": conv_id,
                }
            return {
                "ok": True,
                "sent": True,
                "conversation_id": conv_id,
                "agentapi": sent.get("data") if sent.get("data") is not None else sent.get("stdout", ""),
            }

        if op == "update_conversation":
            conv_id = str(params.get("conversation_id") or "").strip()
            annotations = params.get("annotations")
            if not conv_id or not isinstance(annotations, dict) or not annotations:
                return {
                    "ok": False,
                    "error_code": "invalid-argument",
                    "error": "conversation_id and non-empty annotations are required",
                }
            res = await _call_ls(
                "UpdateConversation",
                {"conversationId": conv_id, "annotations": annotations},
                timeout=timeout,
            )
            if not res.get("ok"):
                if res.get("http_status") == 404:
                    res["error_code"] = "target-not-found"
                return res
            return {"ok": True, "conversation": res["data"]}

        if op == "delete_conversation":
            conv_id = str(params.get("conversation_id") or "").strip()
            if not conv_id:
                return {"ok": False, "error_code": "invalid-argument", "error": "conversation_id is required"}
            res = await _call_ls("DeleteConversation", {"conversationId": conv_id}, timeout=timeout)
            if not res.get("ok"):
                if res.get("http_status") == 404:
                    res["error_code"] = "target-not-found"
                return res
            return {"ok": True, "deleted": True, "conversation_id": conv_id}

        if op == "read_transcript":
            conv_id = str(params.get("conversation_id") or "").strip()
            if not conv_id:
                return {"ok": False, "error_code": "invalid-argument", "error": "conversation_id is required"}
            full = bool(params.get("full", False))
            include_steps = bool(params.get("include_steps", True))
            return await asyncio.to_thread(
                _read_transcript_sync, conv_id, full, include_steps,
                params.get("from_step", 0), params.get("limit", 0), bool(params.get("last_reply_only")),
            )

        return {"ok": False, "error_code": "unknown-op", "error": f"Unknown operation: {op}"}

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readline(), timeout=10.0)
            if not raw:
                return
            if len(raw) > MAX_REQUEST_BYTES:
                resp = {"ok": False, "error_code": "request-too-large", "error": "Request line exceeded limit"}
            else:
                try:
                    req = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError) as err:
                    resp = {"ok": False, "error_code": "invalid-json", "error": str(err)}
                else:
                    if not isinstance(req, dict) or not isinstance(req.get("op"), str):
                        resp = {"ok": False, "error_code": "invalid-request", "error": "Expected object with string 'op'"}
                    else:
                        params = req.get("params") if isinstance(req.get("params"), dict) else {}
                        resp = await self.handle_op(req["op"], params)
            writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception as err:  # pragma: no cover - defensive boundary
            try:
                writer.write((json.dumps({"ok": False, "error_code": "bridge-error", "error": str(err)}) + "\n").encode("utf-8"))
                await writer.drain()
            except OSError:
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

    def _remove_stale_socket(self) -> None:
        try:
            entry = self.sock_path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.geteuid():
            raise RuntimeError(f"Choose an unused socket path: {self.sock_path}")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            try:
                probe.connect(str(self.sock_path))
            except ConnectionRefusedError:
                self.sock_path.unlink()
                return
            except FileNotFoundError:
                return
        raise RuntimeError(f"Another AGY App Bridge is already listening on {self.sock_path}")

    def _listen(self) -> socket.socket:
        parent = self.sock_path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            info = os.fstat(directory)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise RuntimeError(f"Use a socket directory writable only by the current user: {parent}")
            # A second startup must see either a stale socket or an already listening one.
            fcntl.flock(directory, fcntl.LOCK_EX)
            self._remove_stale_socket()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                listener.bind(str(self.sock_path))
                self._socket_entry = self.sock_path.lstat()
                os.chmod(self.sock_path, 0o600)
                listener.listen()
                listener.setblocking(False)
            except Exception:
                listener.close()
                raise
            return listener
        finally:
            os.close(directory)

    def _write_metadata(self) -> None:
        addr, csrf = _ls_config()
        payload = {
            "pid": os.getpid(),
            "socket": str(self.sock_path),
            "app_data_dir": str(app_data_dir()),
            "ls_configured": bool(addr and csrf),
            "default_project_id": os.environ.get("ANTIGRAVITY_PROJECT_ID", "").strip() or None,
            "agentapi_available": bool(resolve_agentapi_command()),
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        if self.meta_path.is_symlink():
            raise RuntimeError(f"Choose an unused metadata path: {self.meta_path}")
        if self.meta_path.exists():
            try:
                previous = json.loads(self.meta_path.read_text(encoding="utf-8")) if self.meta_path.is_file() else None
            except (OSError, ValueError):
                previous = None
            if not isinstance(previous, dict) or previous.get("socket") != str(self.sock_path):
                raise RuntimeError(f"Choose an unused metadata path: {self.meta_path}")
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.meta_path.parent, delete=False) as tmp:
            try:
                json.dump(payload, tmp, ensure_ascii=False)
                tmp.write("\n")
                tmp.flush()
                os.replace(tmp.name, self.meta_path)
                self._metadata_entry = self.meta_path.lstat()
            finally:
                Path(tmp.name).unlink(missing_ok=True)

    def _cleanup(self) -> None:
        for path, entry in ((self.meta_path, self._metadata_entry), (self.sock_path, self._socket_entry)):
            try:
                if entry is not None and os.path.samestat(entry, path.lstat()):
                    path.unlink()
            except FileNotFoundError:
                pass

    async def _watch_parent(self) -> None:
        assert self._stop_event is not None
        while os.getppid() == self._parent_pid:
            await asyncio.sleep(PARENT_POLL_SECONDS)
        self._stop_event.set()

    async def serve(self) -> int:
        self._stop_event = asyncio.Event()
        try:
            with self._listen() as listener:
                self._write_metadata()
                self._server = await asyncio.start_unix_server(
                    self._handle_client, sock=listener, limit=MAX_REQUEST_BYTES + 1,
                )
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.add_signal_handler(sig, self._stop_event.set)
                parent_task = (
                    asyncio.create_task(self._watch_parent()) if self._parent_pid > 1 else None
                )
                try:
                    async with self._server:
                        await self._stop_event.wait()
                finally:
                    if parent_task is not None:
                        parent_task.cancel()
                        await asyncio.gather(parent_task, return_exceptions=True)
        finally:
            if self._socket_entry is not None:
                self._cleanup()
        return 0


def main() -> int:
    server = AppBridgeServer(default_socket_path())
    try:
        return asyncio.run(server.serve())
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
