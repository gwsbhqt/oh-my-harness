#!/usr/bin/env python3
"""SessionStart hook: inject a concise notice only when a saved session snapshot exists."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


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

    conv_id = payload.get("conversationId")
    if not isinstance(conv_id, str) or not conv_id:
        print(json.dumps({}))
        return

    snap_dir = _data_dir() / "snapshots"
    key = _sanitize(conv_id)
    snap_path = snap_dir / f"{key}.dill"
    manifest_path = snap_dir / f"{key}.manifest.json"
    if not (snap_path.is_file() and manifest_path.is_file()):
        print(json.dumps({}))
        return

    msg = "Saved Python REPL snapshot ready for this session; `run_code` will auto-restore it."
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        saved_names = manifest.get("savedNames") or []
        if isinstance(saved_names, list) and saved_names:
            preview_names = ", ".join(str(n) for n in saved_names[:12])
            more = f" (+{len(saved_names) - 12} more)" if len(saved_names) > 12 else ""
            msg = f"Saved Python REPL snapshot ready (vars: {preview_names}{more}); `run_code` will auto-restore it."
    except Exception:
        pass

    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}))


if __name__ == "__main__":
    main()
