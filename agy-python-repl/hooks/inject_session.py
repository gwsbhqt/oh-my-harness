#!/usr/bin/env python3
"""PreToolUse hook: concurrency-safe injection of conversationId and workspace path."""

from __future__ import annotations

import json
import sys


def _scope_kernel(raw_kernel: object, conv_id: str) -> str:
    kernel = raw_kernel if isinstance(raw_kernel, str) and raw_kernel.strip() else "default"
    if kernel == "default":
        return conv_id
    if kernel.startswith(f"{conv_id}:") or kernel.startswith(f"{conv_id}__"):
        return kernel
    return f"{conv_id}:{kernel}"


def _resolve_workspace(payload: dict) -> str | None:
    paths = payload.get("workspacePaths")
    if isinstance(paths, list) and paths and isinstance(paths[0], str) and paths[0]:
        return paths[0]
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        return cwd
    return None


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
    work_dir = _resolve_workspace(payload)

    if tool_name == "call_mcp_tool":
        server_name = str(args.get("ServerName", ""))
        target_tool = str(args.get("ToolName", ""))
        if "agy-python-repl" not in server_name or target_tool not in {"run_code", "kernel_state"}:
            print(json.dumps({"decision": "allow"}))
            return
        inner = dict(args.get("Arguments") or {})
        inner["kernel"] = _scope_kernel(inner.get("kernel"), conv_id)
        if target_tool == "run_code" and work_dir and not inner.get("cwd"):
            inner["cwd"] = work_dir
        print(json.dumps({"decision": "allow", "overwrite": {"Arguments": inner}}))
        return

    overwrite: dict[str, str] = {"kernel": _scope_kernel(args.get("kernel"), conv_id)}
    if tool_name.endswith("run_code") and work_dir and not args.get("cwd"):
        overwrite["cwd"] = work_dir

    print(json.dumps({"decision": "allow", "overwrite": overwrite}))


if __name__ == "__main__":
    main()
