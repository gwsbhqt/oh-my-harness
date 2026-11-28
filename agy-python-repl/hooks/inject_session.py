#!/usr/bin/env python3
"""Bind this plugin's calls to the current Antigravity conversation and workspace via side-channel routing."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agy_python_repl.session_routing import (  # noqa: E402
    SessionRoutingError,
    consume_routing_alerts,
    data_dir_from_env,
    discard_conversation_calls,
    enqueue_call,
    extract_repl_call,
    record_workspace,
    require_conversation_id,
    resolve_workspace,
    verify_post_tool_execution,
)


def _handle_pre_tool_use(payload: dict) -> dict:
    try:
        extracted = extract_repl_call(payload)
        if extracted is None:
            return {"decision": "allow"}
        tool_name, args, _deferred, call_id = extracted
        conv_id = require_conversation_id(payload.get("conversationId"))
        data_dir = data_dir_from_env()
        work_dir = resolve_workspace(payload)
        record_workspace(data_dir, conv_id, work_dir)
        if enqueue_call(data_dir, tool_name, args, conv_id, call_id, workspace=work_dir):
            return {"decision": "allow"}
        return {
            "decision": "deny",
            "reason": "The same Python REPL arguments still have a pending route. "
                      "Wait for its conversation to finish or cancel the pending call.",
        }
    except SessionRoutingError as exc:
        return {"decision": "deny", "reason": str(exc)}
    except (OSError, ValueError, OverflowError, RuntimeError):
        return {
            "decision": "deny",
            "reason": "The Python REPL could not register this conversation in the plugin data directory.",
        }


def _handle_post_tool_use(payload: dict) -> None:
    try:
        extracted = extract_repl_call(payload)
        if extracted is None:
            return
        tool_name, args, _deferred, call_id = extracted
        conv_id = require_conversation_id(payload.get("conversationId"))
        verify_post_tool_execution(
            data_dir_from_env(),
            tool_name,
            args,
            conv_id=conv_id,
            tool_call_id=call_id,
            had_error=bool(payload.get("error")),
        )
    except (OSError, SessionRoutingError):
        pass


def _handle_post_invocation(payload: dict) -> dict:
    conv_id = payload.get("conversationId")
    if not isinstance(conv_id, str) or not conv_id:
        return {}
    data_dir = data_dir_from_env()
    try:
        alerts = consume_routing_alerts(data_dir, conv_id)
    except (OSError, SessionRoutingError):
        return {}
    if not alerts:
        return {}
    return {
        "injectSteps": [{"systemMessage": {"systemMessage": msg}} for msg in alerts],
        "terminationBehavior": "force_continue",
    }


def _handle_conversation_cleanup(payload: dict) -> None:
    if payload.get("fullyIdle") is not True:
        return
    conv_id = payload.get("conversationId")
    if not isinstance(conv_id, str) or not conv_id:
        return
    try:
        discard_conversation_calls(data_dir_from_env(), conv_id)
    except (OSError, SessionRoutingError):
        pass


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = None

    if "--post-tool-use" in sys.argv[1:]:
        if isinstance(payload, dict):
            _handle_post_tool_use(payload)
        print("{}")
        return

    if "--post-invocation" in sys.argv[1:]:
        out = _handle_post_invocation(payload) if isinstance(payload, dict) else {}
        print(json.dumps(out))
        return

    if "--sweep-conversation" in sys.argv[1:]:
        if isinstance(payload, dict):
            _handle_conversation_cleanup(payload)
        print("{}")
        return

    if isinstance(payload, dict):
        result = _handle_pre_tool_use(payload)
    else:
        result = {"decision": "deny", "reason": "The Python REPL hook received an unreadable tool invocation."}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
