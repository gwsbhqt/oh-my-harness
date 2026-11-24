#!/usr/bin/env python3
"""PreToolUse hook: record conversationId and cwd out-of-band without rewriting tool args."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path


def _data_dir() -> Path:
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


def _route_key(tool_name: str, inner_args: dict) -> str:
    if tool_name == "run_code":
        code = str(inner_args.get("code", ""))
        digest = hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]
        return f"run_{digest}"
    action = str(inner_args.get("action", "list"))
    return f"state_{action}"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"decision": "allow"}))
        return

    conv_id = payload.get("conversationId") or ""
    if not isinstance(conv_id, str) or not conv_id:
        print(json.dumps({"decision": "allow"}))
        return

    tool_call = payload.get("toolCall") or {}
    tool_name = str(tool_call.get("name", ""))
    args = tool_call.get("args") or {}

    if tool_name == "call_mcp_tool":
        server_name = str(args.get("ServerName", ""))
        target_tool = str(args.get("ToolName", ""))
        if "agy-python-repl" not in server_name or target_tool not in {"run_code", "kernel_state"}:
            print(json.dumps({"decision": "allow"}))
            return
        inner = dict(args.get("Arguments") or {})
    elif tool_name.endswith("run_code"):
        target_tool = "run_code"
        inner = dict(args)
    elif tool_name.endswith("kernel_state"):
        target_tool = "kernel_state"
        inner = dict(args)
    else:
        print(json.dumps({"decision": "allow"}))
        return

    routing_dir = _data_dir() / "routing"
    routing_dir.mkdir(parents=True, exist_ok=True)
    key = _route_key(target_tool, inner)
    route_file = routing_dir / f"{key}.json"
    route_file.write_text(
        json.dumps(
            {
                "conversationId": conv_id,
                "cwd": payload.get("cwd") or "",
                "ts": time.time(),
            }
        ),
        encoding="utf-8",
    )

    print(json.dumps({"decision": "allow"}))


if __name__ == "__main__":
    main()
