#!/usr/bin/env python3
"""Bind this plugin's calls to the current Antigravity conversation and workspace."""

from __future__ import annotations

import json
import sys


SERVER_NAME = "agy-python-repl_agy-python-repl"
SCOPED_TOOLS = ("run_code", "kernel_state")
DIRECT_NAMES = {f"mcp_{SERVER_NAME}_{name}" for name in SCOPED_TOOLS}


def _scope_kernel(raw_kernel: object, conv_id: str) -> str:
    kernel = raw_kernel if isinstance(raw_kernel, str) and raw_kernel.strip() else "default"
    if kernel in ("default", conv_id):
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


def _overwrite(payload: dict) -> dict:
    conv_id = payload.get("conversationId")
    call = payload.get("toolCall")
    if not isinstance(conv_id, str) or not conv_id or not isinstance(call, dict):
        return {}

    tool_name = call.get("name")
    args = call.get("args", {})
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return {}
    deferred = tool_name == "call_mcp_tool"
    if deferred:
        if args.get("ServerName") != SERVER_NAME or args.get("ToolName") not in SCOPED_TOOLS:
            return {}
        args = args.get("Arguments", {})
        if not isinstance(args, dict):
            return {}
    elif tool_name not in DIRECT_NAMES:
        return {}

    updates = {"kernel": _scope_kernel(args.get("kernel"), conv_id)}
    work_dir = _resolve_workspace(payload)
    if work_dir and not args.get("cwd"):
        updates["cwd"] = work_dir
    if deferred:
        # AGY shallow-merges the outer call. Keep the arguments that the model supplied.
        return {"Arguments": {**args, **updates}}
    return updates


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = None
    result: dict[str, object] = {"decision": "allow"}
    if isinstance(payload, dict):
        overwrite = _overwrite(payload)
        if overwrite:
            result["overwrite"] = overwrite
    print(json.dumps(result))


if __name__ == "__main__":
    main()
