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


from agy_python_repl.session_routing import SERVER_NAME


START_GUIDANCE = (
    f"Use mcp_{SERVER_NAME}_run_code for Python cells and mcp_{SERVER_NAME}_kernel_state for recovery. "
    f"For deferred tools, call_mcp_tool with ServerName={SERVER_NAME} and the requested ToolName. "
    "Reuse the live repo, Path objects, functions and complete results for follow-up. "
    "For source reviews, follow any required SKILL.md read_file and search only the relevant files. "
    "Compute and check counts in one cell. Leave a single value last, or print one labeled line per named "
    "value in the user's language. For tests check exitCode and show ok or the failing cases and errors."
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
