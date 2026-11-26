#!/usr/bin/env python3
"""Tell each conversation how to find its Python REPL and resume its data."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from agy_python_repl.snapshot_paths import kernel_identity, snapshot_paths
from python_repl_core.snapshot_store import open_snapshot, read_manifest


START_GUIDANCE = (
    "For data analysis, batch file reads, calculations or trusted Python skills, start with the "
    "Python REPL's run_code. Open the requested inputs in the first cell and keep the data there. "
    "Call the advertised tool directly, or read its MCP schema and use call_mcp_tool with the "
    "listed ServerName and ToolName run_code."
)


def _data_dir() -> Path:
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print(json.dumps({}))
        return

    conv_id = payload.get("conversationId") if isinstance(payload, dict) else None
    if not isinstance(conv_id, str) or not conv_id:
        print(json.dumps({}))
        return

    msg = START_GUIDANCE
    try:
        data = _data_dir()
        _, storage = kernel_identity(data, conv_id)
        with open_snapshot(*snapshot_paths(data, storage)) as pair:
            if pair is not None:
                manifest = read_manifest(pair)
                msg += " Saved Python REPL snapshot ready. The first cell will restore it."
                saved_names = manifest.get("savedNames")
                if isinstance(saved_names, list) and saved_names:
                    preview_names = ", ".join(str(n) for n in saved_names[:12])
                    more = f" (+{len(saved_names) - 12} more)" if len(saved_names) > 12 else ""
                    msg += f" Saved variables include {preview_names}{more}."
    except (OSError, ValueError):
        msg += " The saved Python REPL snapshot could not be read. The first cell will report its restore status."

    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}))


if __name__ == "__main__":
    main()
