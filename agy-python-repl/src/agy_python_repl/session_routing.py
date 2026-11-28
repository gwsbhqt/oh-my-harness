"""Side-channel session and workspace routing between Antigravity hooks and the MCP server."""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SERVER_NAME = "agy-python-repl_agy-python-repl"
SCOPED_TOOLS = ("run_code", "kernel_state")
DIRECT_NAMES = {f"mcp_{SERVER_NAME}_{name}" for name in SCOPED_TOOLS}

LOCK_BUCKETS = 64
PENDING_TTL_SECONDS = 300.0
STALE_COLLISION_AGE_SECONDS = 8.0
COLLISION_WAIT_SECONDS = 8.0
COLLISION_POLL_SECONDS = 0.015


class SessionRoutingError(RuntimeError):
    """A scoped tool could not establish its conversation before execution."""


def require_conversation_id(value: object) -> str:
    if not isinstance(value, str) or value.strip() in ("", "default"):
        raise SessionRoutingError("The Python REPL needs an active conversation ID before it can run this tool.")
    return value


def data_dir_from_env() -> Path:
    """Resolve the persistent plugin data directory from environment variables."""
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


def scope_kernel(raw_kernel: object, conv_id: str) -> str:
    """Scope a kernel name to an Antigravity conversation ID."""
    kernel = raw_kernel if isinstance(raw_kernel, str) and raw_kernel.strip() else "default"
    if kernel in ("default", conv_id):
        return conv_id
    if kernel.startswith(f"{conv_id}:"):
        return kernel
    if kernel.startswith(f"{conv_id}__"):
        return f"{conv_id}:{kernel.removeprefix(f'{conv_id}__')}"
    return f"{conv_id}:{kernel}"


def resolve_workspace(payload: dict[str, Any]) -> str | None:
    """Extract the conversation's default workspace directory from a hook payload."""
    paths = payload.get("workspacePaths")
    if isinstance(paths, list) and paths and isinstance(paths[0], str) and paths[0]:
        return paths[0]
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd
    return None


def extract_repl_call(payload: dict[str, Any]) -> tuple[str, dict[str, Any], bool, str] | None:
    """Return (tool_name, args, is_deferred, tool_call_id) if payload targets a scoped REPL tool."""
    call = payload.get("toolCall")
    if not isinstance(call, dict):
        return None
    tool_name = call.get("name")
    args = call.get("args", {})
    deferred = tool_name == "call_mcp_tool"
    if deferred:
        if not isinstance(args, dict) or args.get("ServerName") != SERVER_NAME:
            return None
        target_tool = args.get("ToolName")
        if target_tool not in SCOPED_TOOLS:
            return None
        args = args.get("Arguments", {})
    elif isinstance(tool_name, str) and tool_name in DIRECT_NAMES:
        target_tool = tool_name.removeprefix(f"mcp_{SERVER_NAME}_")
    else:
        return None
    if not isinstance(args, dict):
        raise SessionRoutingError("The Python REPL could not read this tool's arguments to route it.")

    raw_id = call.get("id")
    call_id = raw_id if isinstance(raw_id, str) else ""
    step = payload.get("stepIdx")
    if not call_id and type(step) is int and step >= 0:
        # The documented hook payload carries a conversation-local step index.
        call_id = f"{payload.get('conversationId')}:step:{step}"
    return target_tool, args, deferred, call_id


def call_key(tool_name: str, args: dict[str, Any]) -> str:
    """Compute a canonical SHA-256 key from MCP-visible arguments only."""
    raw_cwd = args.get("cwd")
    cwd = str(raw_cwd) if isinstance(raw_cwd, str) and raw_cwd else None
    if tool_name == "run_code":
        raw_timeout = args.get("timeout_seconds")
        try:
            timeout = 60.0 if raw_timeout is None else float(raw_timeout)
        except (TypeError, ValueError):
            timeout = 60.0
        canonical: dict[str, Any] = {
            "tool": "run_code",
            "code": args.get("code") if isinstance(args.get("code"), str) else "",
            "timeout_seconds": timeout,
            "cwd": cwd,
        }
    elif tool_name == "kernel_state":
        canonical = {
            "tool": "kernel_state",
            "action": args.get("action") if isinstance(args.get("action"), str) else "",
            "cwd": cwd,
        }
    else:
        raise ValueError(f"Unsupported scoped tool: {tool_name!r}")
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _routing_root(data_dir: Path) -> Path:
    return data_dir / "session-routing"


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"), ensure_ascii=False)
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    finally:
        Path(tmp_name).unlink(missing_ok=True)


@contextmanager
def _queue_lock(data_dir: Path, key: str) -> Iterator[None]:
    locks_dir = _routing_root(data_dir) / "locks"
    locks_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    bucket = int(key[:2], 16) % LOCK_BUCKETS
    lock_path = locks_dir / f"bucket_{bucket:02d}.lock"
    with lock_path.open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _read_queue(queue_path: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads(queue_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except ValueError as exc:
        raise SessionRoutingError("The Python REPL could not read the pending conversation route.") from exc
    if not isinstance(raw, list):
        raise SessionRoutingError("The Python REPL found an invalid conversation route.")
    for item in raw:
        if not isinstance(item, dict):
            raise SessionRoutingError("The Python REPL found an invalid conversation route.")
        require_conversation_id(item.get("conversation_id"))
        created_at = item.get("created_at")
        if (
            not isinstance(item.get("tool_call_id"), str)
            or not isinstance(created_at, (int, float))
            or not math.isfinite(created_at)
            or (item.get("workspace") is not None and not isinstance(item["workspace"], str))
        ):
            raise SessionRoutingError("The Python REPL found an invalid conversation route.")
    return raw


def _write_or_remove_queue(queue_path: Path, entries: list[dict[str, Any]]) -> None:
    if entries:
        _atomic_write_json(queue_path, entries)
    else:
        queue_path.unlink(missing_ok=True)


def record_workspace(data_dir: Path, conv_id: str, work_dir: str | None) -> None:
    """Persist the conversation's workspace directory for server-side lookup."""
    if not conv_id or not work_dir:
        return
    path = _routing_root(data_dir) / "workspaces" / f"{_sha256_hex(conv_id)}.json"
    try:
        if path.is_file():
            existing = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and (existing.get("conversation_id"), existing.get("cwd")) == (conv_id, work_dir):
                return
    except (OSError, ValueError):
        pass
    _atomic_write_json(
        path,
        {"conversation_id": conv_id, "cwd": work_dir, "updated_at": time.time()},
    )


def lookup_workspace(data_dir: Path, conv_id: str) -> str | None:
    """Return the saved workspace directory for a conversation, if recorded."""
    if not conv_id:
        return None
    path = _routing_root(data_dir) / "workspaces" / f"{_sha256_hex(conv_id)}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError as exc:
        raise SessionRoutingError("The Python REPL could not read this conversation's workspace.") from exc
    if not isinstance(data, dict) or data.get("conversation_id") != conv_id or not isinstance(data.get("cwd"), str):
        raise SessionRoutingError("The Python REPL found an invalid workspace for this conversation.")
    return data["cwd"] or None


def enqueue_call(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    conv_id: str,
    tool_call_id: str = "",
    *,
    workspace: str | None = None,
    wait_seconds: float = COLLISION_WAIT_SECONDS,
    stale_age_seconds: float = STALE_COLLISION_AGE_SECONDS,
    ttl_seconds: float = PENDING_TTL_SECONDS,
    poll_seconds: float = COLLISION_POLL_SECONDS,
) -> bool:
    """Reserve these arguments for one conversation; return False on unresolved contention."""
    require_conversation_id(conv_id)
    if workspace is None and not args.get("cwd"):
        workspace = lookup_workspace(data_dir, conv_id)
    key = call_key(tool_name, args)
    queue_path = _routing_root(data_dir) / "queues" / f"{key}.json"
    deadline = time.monotonic() + max(0.0, wait_seconds)
    while True:
        with _queue_lock(data_dir, key):
            entries = _read_queue(queue_path)
            now = time.time()
            # An approval prompt can outlive either deadline. Only consumption or
            # the owning conversation's cleanup can release its reservation.
            if any(now - e["created_at"] > ttl_seconds for e in entries):
                return False
            conflicts = [
                e for e in entries
                if e["conversation_id"] != conv_id or (not args.get("cwd") and e.get("workspace") != workspace)
            ]
            if not conflicts:
                entries.append({
                    "tool_call_id": tool_call_id, "conversation_id": conv_id,
                    "created_at": now, "workspace": workspace,
                })
                _atomic_write_json(queue_path, entries)
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0 or any(now - e["created_at"] >= stale_age_seconds for e in conflicts):
                return False
        time.sleep(min(poll_seconds, remaining))


def _claim_call(
    data_dir: Path, tool_name: str, args: dict[str, Any], *, ttl_seconds: float
) -> dict[str, Any] | None:
    key = call_key(tool_name, args)
    queue_path = _routing_root(data_dir) / "queues" / f"{key}.json"
    with _queue_lock(data_dir, key):
        entries = _read_queue(queue_path)
        if not entries:
            return None
        claimed = entries[0]
        if any(e["conversation_id"] != claimed["conversation_id"] for e in entries):
            raise SessionRoutingError("These Python REPL arguments have conflicting conversation routes.")
        if time.time() - claimed["created_at"] > ttl_seconds:
            return None
        _write_or_remove_queue(queue_path, entries[1:])
        return claimed


def claim_call_with_id(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    *,
    ttl_seconds: float = PENDING_TTL_SECONDS,
) -> tuple[str, str] | None:
    """Pop the oldest unexpired (conversation_id, tool_call_id) claim matching this MCP call."""
    claimed = _claim_call(data_dir, tool_name, args, ttl_seconds=ttl_seconds)
    return (claimed["conversation_id"], claimed["tool_call_id"]) if claimed else None


def claim_call(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    *,
    ttl_seconds: float = PENDING_TTL_SECONDS,
) -> str | None:
    """Pop the oldest unexpired conversation claim matching this exact MCP call."""
    claimed = claim_call_with_id(data_dir, tool_name, args, ttl_seconds=ttl_seconds)
    return claimed[0] if claimed is not None else None


def _is_standalone(data_dir: Path) -> bool:
    configured = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    directory = Path(configured).expanduser() if configured else None
    resolved = data_dir.resolve()
    if directory is not None and directory.resolve() != resolved:
        raise SessionRoutingError("The Python REPL manager and hook must use the same data directory.")
    if os.environ.get("PLUGIN_ROOT") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID"):
        return False
    for app in ("antigravity", "antigravity-cli", "antigravity-ide"):
        managed = Path.home() / ".gemini" / app / "plugin_data" / "agy-python-repl"
        if resolved.is_relative_to(managed.resolve()):
            return False
    try:
        (data_dir / "routing-guidance").stat()
        return False
    except FileNotFoundError:
        pass
    try:
        # Older standalone lookups created lock buckets even when there was no hook.
        if any(p.name != "locks" for p in _routing_root(data_dir).iterdir()):
            return False
    except FileNotFoundError:
        pass
    if directory is None or not directory.is_absolute():
        raise SessionRoutingError("Standalone Python REPL requires its own absolute PLUGIN_DATA or AGY_PYTHON_REPL_DATA directory.")
    return True


def resolve_execution_context(
    data_dir: Path, tool_name: str, args: dict[str, Any], *, cwd: str | None
) -> tuple[str, Path | None]:
    """Resolve a scoped tool before the manager can open or change any kernel."""
    try:
        if _is_standalone(data_dir):
            return "default", Path(cwd).expanduser() if cwd else None
        claim = _claim_call(data_dir, tool_name, args, ttl_seconds=PENDING_TTL_SECONDS)
        if claim is None:
            raise SessionRoutingError(
                "No matching Python REPL conversation route. Check that the session hook and the MCP "
                "server use the same plugin data and restart the Python REPL MCP server after an upgrade."
            )
        conv_id = claim["conversation_id"]
        work_dir = cwd
        if not work_dir:
            work_dir = claim["workspace"] if "workspace" in claim else lookup_workspace(data_dir, conv_id)
        kernel = scope_kernel("default", conv_id)
        record_execution_receipt(data_dir, claim["tool_call_id"], conv_id, kernel)
        return kernel, Path(work_dir).expanduser() if work_dir else None
    except OSError as exc:
        raise SessionRoutingError("The Python REPL could not access the conversation route before execution.") from exc


def _receipt_path(data_dir: Path, conv_id: str, tool_call_id: str) -> Path:
    key = _sha256_hex(json.dumps([conv_id, tool_call_id], separators=(",", ":")))
    return _routing_root(data_dir) / "receipts" / f"{key}.json"


def record_execution_receipt(
    data_dir: Path,
    tool_call_id: str,
    conv_id: str,
    kernel: str,
) -> None:
    """Record the kernel selected for a claimed tool call before invoking the manager."""
    if not tool_call_id:
        return
    receipt_path = _receipt_path(data_dir, conv_id, tool_call_id)
    _atomic_write_json(
        receipt_path,
        {
            "tool_call_id": tool_call_id,
            "conversation_id": conv_id,
            "kernel": kernel,
            "created_at": time.time(),
        },
    )


def record_unmatched_execution(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    kernel: str,
) -> None:
    """Record that the server executed this call_key without a matching PreToolUse claim."""
    key = call_key(tool_name, args)
    path = _routing_root(data_dir) / "unmatched" / f"{key}.json"
    now = time.time()
    with _queue_lock(data_dir, key):
        entries: list[dict[str, Any]] = []
        if path.is_file():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    entries = [
                        e for e in raw
                        if isinstance(e, dict)
                        and isinstance(e.get("created_at"), (int, float))
                        and now - float(e["created_at"]) <= 60.0
                    ]
            except (OSError, ValueError):
                entries = []
        entries.append({"kernel": kernel, "created_at": now})
        _atomic_write_json(path, entries)


def _pop_unmatched_execution(data_dir: Path, tool_name: str, args: dict[str, Any]) -> str | None:
    key = call_key(tool_name, args)
    path = _routing_root(data_dir) / "unmatched" / f"{key}.json"
    if not path.is_file():
        return None
    now = time.time()
    with _queue_lock(data_dir, key):
        if not path.is_file():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            path.unlink(missing_ok=True)
            return None
        if not isinstance(raw, list):
            path.unlink(missing_ok=True)
            return None
        valid = [
            e for e in raw
            if isinstance(e, dict)
            and isinstance(e.get("created_at"), (int, float))
            and now - float(e["created_at"]) <= 60.0
        ]
        if not valid:
            path.unlink(missing_ok=True)
            return None
        popped = valid.pop(0)
        _write_or_remove_queue(path, valid)
        kernel = popped.get("kernel")
        return kernel if isinstance(kernel, str) else "default"


def _read_alerts(path: Path, conv_id: str) -> list[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []
    if not isinstance(raw, dict) or raw.get("conversation_id") != conv_id:
        return []
    messages = raw.get("messages")
    return [str(m) for m in messages] if isinstance(messages, list) else []


def _record_routing_alert(data_dir: Path, conv_id: str, message: str) -> None:
    key = _sha256_hex(conv_id)
    path = _routing_root(data_dir) / "alerts" / f"{key}.json"
    with _queue_lock(data_dir, key):
        messages = _read_alerts(path, conv_id)
        messages.append(message)
        _atomic_write_json(path, {"conversation_id": conv_id, "messages": messages})


def consume_routing_alerts(data_dir: Path, conv_id: str) -> list[str]:
    """Read and clear any routing mismatch alerts queued for this conversation."""
    if not conv_id:
        return []
    key = _sha256_hex(conv_id)
    path = _routing_root(data_dir) / "alerts" / f"{key}.json"
    if not path.is_file():
        return []
    with _queue_lock(data_dir, key):
        messages = _read_alerts(path, conv_id)
        path.unlink(missing_ok=True)
        return messages


def verify_post_tool_execution(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    *,
    conv_id: str | None,
    tool_call_id: str,
    had_error: bool = False,
) -> bool:
    """Check the server's route receipt and alert the conversation if it cannot be confirmed."""
    if not conv_id or not tool_call_id:
        return True
    discard_call(data_dir, tool_name, args, tool_call_id, conv_id=conv_id)
    receipt_path = _receipt_path(data_dir, conv_id, tool_call_id)
    legacy = not receipt_path.is_file()
    if legacy:
        receipt_path = _routing_root(data_dir) / "receipts" / f"{_sha256_hex(tool_call_id)}.json"
    if receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            receipt = None
        actual_conv = receipt.get("conversation_id") if isinstance(receipt, dict) else None
        actual_kernel = receipt.get("kernel") if isinstance(receipt, dict) else None
        # Older servers used a global call ID. Leave a different conversation's receipt for its own hook.
        if not legacy or actual_conv == conv_id:
            receipt_path.unlink(missing_ok=True)
        if (
            isinstance(receipt, dict) and receipt.get("tool_call_id") == tool_call_id
            and actual_conv == conv_id and actual_kernel == scope_kernel("default", conv_id)
        ):
            return True
        message = (f"Expected conversation/kernel {conv_id!r}. The server recorded conversation {actual_conv!r} "
                   f"and kernel {actual_kernel!r}.")
    elif had_error:
        return True
    else:
        unmatched_kernel = _pop_unmatched_execution(data_dir, tool_name, args)
        if unmatched_kernel is None:
            message = "The tool returned without a receipt for its conversation. An older MCP server may still be running."
        else:
            message = f"The server recorded an unmatched execution in kernel {unmatched_kernel!r}."
    _record_routing_alert(data_dir, conv_id, (
        f"Python REPL routing could not be confirmed for {tool_name} (call {tool_call_id}). {message} "
        "Check the previous call's effects and the MCP server version before continuing."
    ))
    return False


def discard_call(
    data_dir: Path,
    tool_name: str,
    args: dict[str, Any],
    tool_call_id: str,
    *,
    conv_id: str | None = None,
    ttl_seconds: float = PENDING_TTL_SECONDS,
) -> bool:
    """Remove an unconsumed claim by tool_call_id (or oldest matching conv_id if id is absent)."""
    if not tool_call_id and not conv_id:
        return False
    key = call_key(tool_name, args)
    queue_path = _routing_root(data_dir) / "queues" / f"{key}.json"
    with _queue_lock(data_dir, key):
        entries = _read_queue(queue_path)
        if tool_call_id:
            kept = [
                e for e in entries
                if e["tool_call_id"] != tool_call_id or (conv_id is not None and e["conversation_id"] != conv_id)
            ]
        else:
            removed_one = False
            kept = []
            for e in entries:
                if not removed_one and e["conversation_id"] == conv_id:
                    removed_one = True
                    continue
                kept.append(e)
        removed = len(kept) != len(entries)
        if removed:
            _write_or_remove_queue(queue_path, kept)
        return removed


def discard_conversation_calls(
    data_dir: Path,
    conv_id: str,
    *,
    ttl_seconds: float = PENDING_TTL_SECONDS,
) -> int:
    """Release remaining reservations after the conversation is fully idle."""
    if not conv_id:
        return 0
    queues_dir = _routing_root(data_dir) / "queues"
    if not queues_dir.is_dir():
        return 0
    removed_count = 0
    for queue_path in sorted(queues_dir.glob("*.json")):
        key = queue_path.stem
        if len(key) < 2:
            continue
        try:
            int(key[:2], 16)
        except ValueError:
            continue
        with _queue_lock(data_dir, key):
            try:
                entries = _read_queue(queue_path)
            except SessionRoutingError:
                continue  # This route cannot be attributed to the conversation being swept.
            kept = [e for e in entries if e["conversation_id"] != conv_id]
            delta = len(entries) - len(kept)
            if delta > 0:
                removed_count += delta
                _write_or_remove_queue(queue_path, kept)
    return removed_count
