#!/usr/bin/env python3
"""Tell each conversation how to find its Python REPL and resume its data."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


START_GUIDANCE = (
    "Continue in the persistent Python run_code workbench. Reuse earlier variables and functions. Once repo "
    "exists, use repo / 'tests'. Only if unsure, check 'repo' in globals(). read, write, edit, bash, glob and "
    "grep are ready to use. Keep complete results in variables. For several named values use one print per "
    "value, one labeled line each in the user's language. A single value can be the final expression. "
    "For a source review, follow any required SKILL.md read_file, then narrow "
    "the search and keep its results for follow-up. For a count or comparison, go straight from all inputs to "
    "the aggregate in the same cell. Keep rows, validation tables and intermediate diagnostics in variables. "
    "Validate inside the computing cell before printing. When the requested lines are on screen, answer "
    "from them. Open another cell only for an unresolved problem. Keep samples and audit data in variables. "
    "Pass Path objects straight to file helpers. If you need the layout, inspect column names alone. "
    "Define repeated work once. For tests inspect exitCode "
    "and return ok or the failing cases and errors. If run_code is deferred, call it via call_mcp_tool."
)


def _data_dir() -> Path:
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


def _claim_guidance(data: Path, conversation: str) -> bool:
    # A changed instruction must also reach conversations opened before the update.
    key = hashlib.sha256((conversation + "\0" + START_GUIDANCE).encode()).hexdigest()
    directory = data / "routing-guidance"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        (directory / key).touch(mode=0o600, exist_ok=False)
    except FileExistsError:
        return False
    return True


def _snapshot_hint(data: Path, conversation: str) -> str:
    from agy_python_repl.builtin_tools import BUILTIN_TOOL_NAMES
    from agy_python_repl.snapshot_paths import kernel_identity, snapshot_paths
    from python_repl_core.snapshot_store import open_snapshot, read_manifest

    try:
        _, storage = kernel_identity(data, conversation)
        with open_snapshot(*snapshot_paths(data, storage), wait=False) as pair:
            if pair is None:
                return ""
            manifest = read_manifest(pair)
    except BlockingIOError:
        # Keep the hook within its deadline. The first cell waits for the snapshot.
        return ""
    except (OSError, ValueError):
        return "The saved Python REPL snapshot could not be read. The first cell will report its restore status."

    msg = "Saved Python REPL snapshot ready. The first run_code cell will restore it."
    saved_names = manifest.get("savedNames")
    if isinstance(saved_names, list) and saved_names:
        preview_names = ", ".join(str(n) for n in saved_names[:12])
        more = f" (+{len(saved_names) - 12} more)" if len(saved_names) > 12 else ""
        msg += f" Saved variables include {preview_names}{more}."
        shadowed = sorted(name for name in saved_names if isinstance(name, str) and name in BUILTIN_TOOL_NAMES)
        if shadowed:
            msg += (f" Saved names match built-in helpers ({', '.join(shadowed)}). The first restore receipt will"
                    " report which user values took precedence. Keep an alias for any value you need before using"
                    f" await repl.restore_binding({shadowed[0]!r}).")
    return msg


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = None
    conv_id = payload.get("conversationId") if isinstance(payload, dict) else None
    if not isinstance(conv_id, str) or not conv_id:
        print("{}")
        return

    from agy_python_repl.session_routing import record_workspace, resolve_workspace

    starting = "--pre-invocation" not in sys.argv[1:]
    data = _data_dir()
    try:
        record_workspace(data, conv_id, resolve_workspace(payload))
    except OSError:
        pass
    try:
        first = _claim_guidance(data, conv_id)
    except OSError:
        # Without a receipt only SessionStart is known to run once.
        first = starting
    hint = _snapshot_hint(data, conv_id) if starting or first else ""
    msg = " ".join(filter(None, (START_GUIDANCE if first else "", hint)))
    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]} if msg else {}))


if __name__ == "__main__":
    main()
