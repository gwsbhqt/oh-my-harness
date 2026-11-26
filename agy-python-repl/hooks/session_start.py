#!/usr/bin/env python3
"""Tell each conversation how to find its Python REPL and resume its data."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


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


def _sanitize(name: str) -> str:
    clean = "".join(ch if (ch.isalnum() or ch in "-_:") else "_" for ch in (name or "default"))
    return clean.replace(":", "__") or "default"


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

    snap_dir = _data_dir() / "snapshots"
    key = _sanitize(conv_id)
    snap_path = snap_dir / f"{key}.dill"
    manifest_path = snap_dir / f"{key}.manifest.json"
    msg = START_GUIDANCE
    if snap_path.is_file() and manifest_path.is_file():
        snapshot = "Saved Python REPL snapshot ready. The first cell will restore it."
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            saved_names = manifest.get("savedNames")
            if isinstance(saved_names, list) and saved_names:
                preview_names = ", ".join(str(n) for n in saved_names[:12])
                more = f" (+{len(saved_names) - 12} more)" if len(saved_names) > 12 else ""
                snapshot += f" Saved variables include {preview_names}{more}."
        except (OSError, ValueError, AttributeError):
            pass
        msg = f"{msg} {snapshot}"

    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}))


if __name__ == "__main__":
    main()
