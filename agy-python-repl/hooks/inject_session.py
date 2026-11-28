#!/usr/bin/env python3
"""Route desktop Python calls before the host asks for approval or dispatches them."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agy_python_repl.session_routing import (  # noqa: E402
    SessionRoutingError, data_dir_from_env, discard_conversation_calls, extract_repl_call,
    finish_call, register_call, require_conversation_id, resolve_workspace,
)


def handle(payload: dict, event: str) -> dict:
    if event == "--sweep-conversation":
        if payload.get("fullyIdle") is True:
            discard_conversation_calls(data_dir_from_env(), require_conversation_id(payload.get("conversationId")))
        return {}
    extracted = extract_repl_call(payload)
    if extracted is None:
        return {"decision": "allow"} if not event else {}
    tool, args, deferred, call_id = extracted
    conversation = require_conversation_id(payload.get("conversationId"))
    if event == "--post-tool-use":
        finish_call(data_dir_from_env(), tool, args, conversation, call_id)
        return {}
    updates = register_call(data_dir_from_env(), tool, args, conversation, call_id, workspace=resolve_workspace(payload))
    if updates:
        return {"decision": "allow", "overwrite": {"Arguments": {**args, **updates}} if deferred else updates}
    return {"decision": "allow"}


def main() -> None:
    event = next(iter(sys.argv[1:]), "")
    if event not in ("", "--post-tool-use", "--sweep-conversation"):
        print("{}")
        return
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Missing tool invocation")
        result = handle(payload, event)
    except SessionRoutingError as exc:
        result = {} if event else {"decision": "deny", "reason": str(exc)}
    except (OSError, ValueError, TypeError, OverflowError, KeyError):
        result = {} if event else {"decision": "deny", "reason": "Check the Python REPL arguments and plugin data directory, then retry."}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
