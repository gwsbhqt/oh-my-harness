"""Bind a desktop REPL call to its conversation before opening a kernel."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Iterator

SERVER_NAME = "agy-python-repl_conversation"
LEGACY_SERVER_NAME = "agy-python-repl_agy-python-repl"
SCOPED_TOOLS = ("run_code", "kernel_state")
ROUTE_PREFIX = "agy-repl-call:"
RELOAD_MESSAGE = (
    "Reload the Python REPL MCP server under Customizations → Installed → MCP Servers, "
    "then retry with the listed conversation server."
)


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
    call = payload.get("toolCall")
    if not isinstance(call, dict):
        return None
    name = call.get("name")
    args = call.get("args", {})
    deferred = name == "call_mcp_tool"
    if deferred and isinstance(args, dict):
        server, tool = args.get("ServerName"), args.get("ToolName")
        args = args.get("Arguments", {})
    else:
        targets = {f"mcp_{server}_{tool}": (server, tool)
                   for server in (SERVER_NAME, LEGACY_SERVER_NAME) for tool in SCOPED_TOOLS}
        server, tool = targets.get(name, (None, None)) if isinstance(name, str) else (None, None)
    if server not in (SERVER_NAME, LEGACY_SERVER_NAME) or tool not in SCOPED_TOOLS:
        return None
    if server == LEGACY_SERVER_NAME:
        raise SessionRoutingError(f"This Python REPL tool uses the previous server registration. {RELOAD_MESSAGE}")
    if not isinstance(args, dict):
        raise SessionRoutingError("The Python REPL needs an object containing the tool arguments.")
    step = payload.get("stepIdx")
    call_id = call.get("id")
    if not isinstance(call_id, str) or not call_id:
        call_id = f"step:{step}" if type(step) is int and step >= 0 else ""
    return tool, args, deferred, call_id


def call_key(tool: str, args: dict[str, Any]) -> str:
    cwd = args.get("cwd") or None
    if tool == "run_code":
        timeout = float(args.get("timeout_seconds", 60.0))
        if not math.isfinite(timeout):
            raise ValueError("The timeout must be finite.")
        fields = (tool, args["code"], timeout, cwd)
    elif tool == "kernel_state":
        fields = (tool, args["action"], cwd)
    else:
        raise ValueError("Unknown Python REPL tool.")
    return _sha256_hex(json.dumps(fields, separators=(",", ":"), ensure_ascii=False))


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


@contextmanager
def _routes(data_dir: Path) -> Iterator[sqlite3.Connection]:
    root = _routing_root(data_dir)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        with closing(sqlite3.connect(root / "conversation.sqlite3", timeout=4)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN IMMEDIATE")
            db.execute("""CREATE TABLE IF NOT EXISTS calls (
                token TEXT PRIMARY KEY, signature TEXT NOT NULL, conversation TEXT NOT NULL,
                call_id TEXT NOT NULL, kernel TEXT NOT NULL, requested_cwd TEXT, work_dir TEXT,
                plain INTEGER NOT NULL, ambiguous_id INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)""")
            db.execute("CREATE INDEX IF NOT EXISTS call_signature ON calls(signature)")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS plain_call ON calls(signature) WHERE plain = 1")
            db.execute("CREATE INDEX IF NOT EXISTS conversation_calls ON calls(conversation, call_id)")
            db.execute("CREATE TABLE IF NOT EXISTS retired (signature TEXT PRIMARY KEY)")
            yield db
    except sqlite3.Error as exc:
        raise SessionRoutingError("The Python REPL could not access its conversation routes. Retry this call.") from exc


def _retire(db: sqlite3.Connection, signature: str) -> None:
    # A late untagged delivery cannot be distinguished from a future untagged call.
    db.execute("INSERT OR IGNORE INTO retired VALUES (?)", (signature,))


def register_call(data_dir: Path, tool: str, args: dict[str, Any], conversation: str, call_id: str,
                  *, workspace: str | None = None) -> dict[str, str]:
    """Return the PreToolUse overwrite; an unambiguous ordinary call needs none."""
    require_conversation_id(conversation)
    cwd, requested_kernel = args.get("cwd"), args.get("kernel")
    if cwd is not None and not isinstance(cwd, str):
        raise SessionRoutingError("The Python REPL working directory must be a path.")
    if cwd and cwd.startswith(ROUTE_PREFIX):
        raise SessionRoutingError("For a relative directory starting with agy-repl-call:, use its absolute path or prefix it with ./.")
    if "kernel" in args and (not isinstance(requested_kernel, str) or not requested_kernel.strip()):
        raise SessionRoutingError("Use the exact name of the Python kernel to recover.")
    kernel = scope_kernel(requested_kernel, conversation)
    record_workspace(data_dir, conversation, workspace)
    work_dir = cwd or workspace or lookup_workspace(data_dir, conversation)
    signature = call_key(tool, args)
    token = secrets.token_hex(16)
    with _routes(data_dir) as db:
        identity = (signature, conversation, call_id)
        repeated = db.execute("UPDATE calls SET ambiguous_id = 1 WHERE signature = ? AND conversation = ? AND call_id = ?",
                              identity).rowcount > 0
        if repeated and db.execute("DELETE FROM calls WHERE signature = ? AND conversation = ? AND call_id = ? AND plain = 1",
                                   identity).rowcount:
            # The old untagged delivery may still arrive after this retry or its completion.
            _retire(db, signature)
        busy = db.execute("SELECT 1 FROM calls WHERE signature = ? UNION ALL SELECT 1 FROM retired WHERE signature = ? LIMIT 1",
                          (signature, signature)).fetchone()
        plain = bool(call_id and requested_kernel is None and not busy)
        db.execute("""INSERT INTO calls
                   (token, signature, conversation, call_id, kernel, requested_cwd, work_dir, plain, ambiguous_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                   (token, signature, conversation, call_id, kernel, cwd, work_dir, plain, repeated or not call_id))
    return {} if plain else {"cwd": ROUTE_PREFIX + token}


def _route_token(cwd: object) -> str | None:
    if not isinstance(cwd, str) or not cwd.startswith(ROUTE_PREFIX):
        return None
    token = cwd[len(ROUTE_PREFIX):]
    if not re.fullmatch("[0-9a-f]{32}", token):
        raise SessionRoutingError("Invalid Python REPL call reference. Retry the original tool call.")
    return token


def _matches_call(row: sqlite3.Row | None, tool: str, args: dict[str, Any]) -> bool:
    if row is None or call_key(tool, {**args, "cwd": row["requested_cwd"]}) != row["signature"]:
        return False
    named = args.get("kernel")
    return named is None or scope_kernel(named, row["conversation"]) == row["kernel"]


def finish_call(data_dir: Path, tool: str, args: dict[str, Any], conversation: str, call_id: str) -> None:
    """Release exactly the registration the completed hook can identify."""
    token = _route_token(args.get("cwd"))
    with _routes(data_dir) as db:
        if token is not None:
            row = db.execute("SELECT * FROM calls WHERE token = ? AND conversation = ? AND call_id = ? AND plain = 0",
                             (token, conversation, call_id)).fetchone()
            if _matches_call(row, tool, args):
                db.execute("DELETE FROM calls WHERE token = ?", (token,))
            return
        signature = call_key(tool, args)
        matching = (signature, conversation, call_id)
        rows = db.execute("SELECT * FROM calls WHERE signature = ? AND conversation = ? AND call_id = ?",
                          matching).fetchall()
        for row in rows:
            # Some hosts return the original arguments. An ambiguous completion can only retire a spent ticket.
            if row["ambiguous_id"] and not row["claimed"]:
                continue
            if row["plain"] and not row["claimed"]:
                _retire(db, signature)
            db.execute("DELETE FROM calls WHERE token = ?", (row["token"],))


def discard_conversation_calls(data_dir: Path, conversation: str) -> None:
    if not (_routing_root(data_dir) / "conversation.sqlite3").is_file():
        return
    with _routes(data_dir) as db:
        db.execute("""INSERT OR IGNORE INTO retired SELECT signature FROM calls
                   WHERE conversation = ? AND plain = 1""", (conversation,))
        db.execute("DELETE FROM calls WHERE conversation = ?", (conversation,))


def require_standalone_directory(data_dir: Path) -> None:
    configured = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if not configured or not Path(configured).expanduser().is_absolute():
        raise SessionRoutingError("Standalone Python REPL requires its own absolute data directory.")
    resolved = data_dir.resolve()
    if Path(configured).expanduser().resolve() != resolved:
        raise SessionRoutingError("The Python REPL manager and launcher must use the same data directory.")
    managed = any(resolved.is_relative_to((Path.home() / ".gemini" / app / "plugin_data" / "agy-python-repl").resolve())
                  for app in ("antigravity", "antigravity-cli", "antigravity-ide"))
    root = _routing_root(data_dir)
    if (managed or os.environ.get("PLUGIN_ROOT") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
            or (data_dir / "routing-guidance").exists() or (root.exists() and any(p.name != "locks" for p in root.iterdir()))):
        raise SessionRoutingError(f"Standalone clients need a separate Python REPL data directory. {RELOAD_MESSAGE}")


def mark_conversation_service(data_dir: Path) -> None:
    root = _routing_root(data_dir)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        # Reserve this store for the desktop even before its first call. The read-only panel needs no routes.
        (root / "conversation.sqlite3").touch(mode=0o600, exist_ok=False)
    except FileExistsError:
        pass


def resolve_execution_context(data_dir: Path, tool: str, args: dict[str, Any], *, managed: bool) -> tuple[str, Path | None]:
    cwd, named = args.get("cwd"), args.get("kernel")
    try:
        if not managed:
            require_standalone_directory(data_dir)
            if named is not None and (not isinstance(named, str) or not named.strip()):
                raise SessionRoutingError("Use the exact name of the Python kernel to recover.")
            return named or "default", Path(cwd).expanduser() if cwd else None
        token = _route_token(cwd)
        with _routes(data_dir) as db:
            if token is None:
                row = db.execute("SELECT * FROM calls WHERE signature = ? AND plain = 1 AND claimed = 0",
                                 (call_key(tool, args),)).fetchone()
            else:
                row = db.execute("SELECT * FROM calls WHERE token = ? AND plain = 0 AND claimed = 0", (token,)).fetchone()
            if not _matches_call(row, tool, args):
                raise SessionRoutingError(f"No matching Python REPL conversation route. Retry from this conversation. {RELOAD_MESSAGE}")
            db.execute("UPDATE calls SET claimed = 1 WHERE token = ?", (row["token"],))
            return row["kernel"], Path(row["work_dir"]).expanduser() if row["work_dir"] else None
    except OSError as exc:
        raise SessionRoutingError("The Python REPL could not access the conversation route before execution.") from exc
