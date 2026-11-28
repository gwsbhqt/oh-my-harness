"""Unix socket client and transcript helpers for the Antigravity App Sidecar bridge."""
from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import re
from typing import Any


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_SYSTEM_MSG_BLOCK_RE = re.compile(r"(?:^|\n)<SYSTEM_MESSAGE>\n(.*)\n</SYSTEM_MESSAGE>\s*\Z", re.DOTALL)
_SYSTEM_MSG_HEADER_RE = re.compile(r"\[Message\][^\n]*?\bsender=(\S+)[^\n]*?\bcontent=(.*)", re.DOTALL)
_SYSTEM_MSG_PRIORITY_RE = re.compile(r"(?:^|\s)priority=(\S+)")
_USER_REQUEST_BLOCK_RE = re.compile(r"<USER_REQUEST>\s*\n?(.*?)\n?</USER_REQUEST>", re.DOTALL)


def validate_seconds(timeout: float, *, allow_zero: bool = False, name: str = "timeout") -> float:
    if (
        isinstance(timeout, (int, float))
        and not isinstance(timeout, bool)
        and math.isfinite(timeout)
        and (timeout > 0 or (allow_zero and timeout == 0))
    ):
        return float(timeout)
    expected = "非负" if allow_zero else "正"
    raise ValueError(f"{name} 必须是{expected}的有限秒数")


def is_full_uuid(value: str) -> bool:
    return bool(_UUID_RE.fullmatch(value))


def default_socket_path(socket_path: str | Path | None = None) -> Path:
    if socket_path is not None:
        raw = str(socket_path).strip()
        if not raw:
            raise ValueError("socket_path 不能为空")
        return Path(raw).expanduser()
    env_sock = os.environ.get("AGY_USE_SOCKET", "").strip()
    if env_sock:
        return Path(env_sock).expanduser()
    state_home = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(state_home).expanduser() if state_home else Path.home() / ".local" / "state"
    return base / "agy-use" / "bridge.sock"


async def call_bridge(
    op: str,
    params: dict[str, Any] | None = None,
    *,
    socket_path: str | Path | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Send one JSON-line request to the App Sidecar Unix socket and return its response."""
    seconds = validate_seconds(timeout)
    sock = default_socket_path(socket_path)
    payload = json.dumps({"op": op, "params": {**(params or {}), "timeout": seconds}}, ensure_ascii=False) + "\n"
    writer = None
    wrote = False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(sock), limit=32 * 1024 * 1024),
            timeout=min(seconds, 5.0),
        )
        writer.write(payload.encode("utf-8"))
        wrote = True
        await asyncio.wait_for(writer.drain(), timeout=min(seconds, 5.0))
        raw = await asyncio.wait_for(reader.readline(), timeout=seconds)
    except asyncio.LimitOverrunError as err:
        return {
            "ok": False,
            "timed_out": False,
            "uncertain": wrote,
            "sent": None if wrote else False,
            "socket": str(sock),
            "error_code": "bridge-response-too-large",
            "error": f"AGY App Sidecar 单条响应超过限制: {err}",
        }
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "timed_out": True,
            "uncertain": wrote,
            "sent": None if wrote else False,
            "socket": str(sock),
            "error_code": "bridge-timeout",
            "error": f"等待 AGY App Sidecar ({op}) 超过 {seconds:g} 秒",
        }
    except (FileNotFoundError, ConnectionRefusedError, OSError) as err:
        return {
            "ok": False,
            "timed_out": False,
            "uncertain": wrote,
            "sent": None if wrote else False,
            "socket": str(sock),
            "error_code": "sidecar-unavailable" if not wrote else "bridge-disconnected",
            "error": (
                f"无法连接 AGY App Sidecar ({sock}): {err}。"
                "请确认 Antigravity App 正在运行并已启用 agy-python-repl/app-bridge Sidecar。"
            ),
        }
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        return {
            "ok": False,
            "timed_out": False,
            "uncertain": True,
            "sent": None if op == "send_message" else False,
            "socket": str(sock),
            "error_code": "bridge-empty-response",
            "error": "AGY App Sidecar 未返回响应即关闭连接",
        }
    try:
        data = json.loads(text)
    except ValueError as err:
        return {
            "ok": False,
            "timed_out": False,
            "uncertain": True,
            "socket": str(sock),
            "error_code": "invalid-bridge-json",
            "error": f"Sidecar 返回无效 JSON: {err}",
            "raw": text,
        }
    if not isinstance(data, dict):
        return {
            "ok": False,
            "timed_out": False,
            "socket": str(sock),
            "error_code": "invalid-bridge-response",
            "error": "Sidecar 返回格式不是 JSON 对象",
        }
    data.setdefault("socket", str(sock))
    data.setdefault("timed_out", False)
    return data


def normalize_conversation(conv: dict[str, Any]) -> dict[str, Any]:
    meta = conv.get("metadata") if isinstance(conv.get("metadata"), dict) else {}
    ann = conv.get("annotations") if isinstance(conv.get("annotations"), dict) else {}
    state = conv.get("state") if isinstance(conv.get("state"), dict) else {}
    return {
        "id": conv.get("id"),
        "title": ann.get("title") or state.get("summary") or "",
        "custom_title": ann.get("title") or "",
        "summary": state.get("summary") or "",
        "run_state": state.get("runState") or "",
        "update_time": state.get("updateTime") or "",
        "create_time": meta.get("createTime") or "",
        "project_id": meta.get("projectId") or "",
        "parent_conversation_id": meta.get("parentConversationId") or "",
        "root_conversation_id": meta.get("rootConversationId") or "",
        "tags": ann.get("tags") or meta.get("tags") or [],
        "archived": bool(ann.get("archived", False)),
        "pinned": bool(ann.get("pinned", False)),
        "starred": bool(ann.get("starred", False)),
        "conversation_group_id": ann.get("conversationGroupId") or "",
    }


async def _get_exact(exact_id: str, include_metadata: bool, socket_path: str | Path | None, timeout: float) -> dict[str, Any]:
    result = await call_bridge(
        "get_conversation", {"conversation_id": exact_id, "include_metadata": include_metadata},
        socket_path=socket_path, timeout=timeout,
    )
    if not result.get("ok"):
        return result
    conversation = result.get("conversation")
    if not isinstance(conversation, dict) or conversation.get("id") != exact_id:
        return {"ok": False, "error_code": "target-mismatch", "error": "App 返回的会话编号与请求不符"}
    return {**result, "conversation_id": exact_id}


async def resolve_conversation(
    target: str,
    *,
    include_archived: bool = True,
    include_metadata: bool = False,
    socket_path: str | Path | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Verify a full UUID directly, or resolve a unique prefix (>=4 chars) from a complete scan."""
    if not isinstance(target, str) or not target.strip():
        raise ValueError("conversation_id 不能为空")
    needle = target.strip()

    if is_full_uuid(needle):
        return await _get_exact(needle.lower(), include_metadata, socket_path, timeout)

    if len(needle) < 4:
        return {
            "ok": False,
            "timed_out": False,
            "error_code": "target-not-found",
            "error": f"未找到会话 {needle!r}（简写匹配至少需要 4 个字符）",
        }

    listed = await call_bridge(
        "list_conversations",
        {"include_archived": include_archived, "scan_all": True, "limit": 0},
        socket_path=socket_path,
        timeout=timeout,
    )
    if not listed.get("ok"):
        return listed

    scan_incomplete = bool(listed.get("next_page_token"))
    matches = [
        conv for conv in listed.get("conversations", [])
        if isinstance(conv, dict) and isinstance(conv.get("id"), str) and conv["id"].startswith(needle)
    ]
    if len(matches) > 1:
        return {
            "ok": False,
            "timed_out": False,
            "error_code": "ambiguous-target",
            "error": f"前缀 {needle!r} 匹配到 {len(matches)} 个会话，请提供更完整的编号",
            "candidates": [normalize_conversation(c) for c in matches[:10]],
            "socket": listed.get("socket"),
        }
    if scan_incomplete:
        return {
            "ok": False,
            "timed_out": False,
            "scan_incomplete": True,
            "error_code": "incomplete-prefix-scan",
            "error": f"前缀 {needle!r} 的会话扫描未完成（仍有未扫描页），拒绝判定唯一，请提供完整 UUID",
            "candidates": [normalize_conversation(c) for c in matches[:10]],
            "socket": listed.get("socket"),
        }
    if not matches:
        return {
            "ok": False,
            "timed_out": False,
            "error_code": "target-not-found",
            "error": f"未找到匹配 {needle!r} 的 Antigravity App 会话",
            "socket": listed.get("socket"),
        }

    return await _get_exact(matches[0]["id"], include_metadata, socket_path, timeout)


def step_text(step: dict[str, Any]) -> str:
    for key in ("content", "response", "answer"):
        val = step.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def has_truncated_fields(step: dict[str, Any]) -> bool:
    tf = step.get("truncated_fields")
    return isinstance(tf, list) and len(tf) > 0


def has_tool_calls(step: dict[str, Any]) -> bool:
    tc = step.get("tool_calls")
    return isinstance(tc, list) and len(tc) > 0


def is_final_planner_response(step: dict[str, Any]) -> bool:
    if step.get("type") != "PLANNER_RESPONSE":
        return False
    if has_tool_calls(step):
        return False
    status = step.get("status")
    if isinstance(status, str) and status and status != "DONE":
        return False
    return True


def is_model_reply_step(step: dict[str, Any]) -> bool:
    return is_final_planner_response(step)


def is_input_or_receipt_step(step: dict[str, Any], conversation_id: str) -> bool:
    return step.get("type") == "USER_INPUT" or extract_receipt_body(step, conversation_id) is not None


def extract_receipt_body(step: dict[str, Any], conversation_id: str, *, allow_user_input: bool = False) -> str | None:
    kind = step.get("type")
    raw = step_text(step).replace("\r\n", "\n")
    if kind == "SYSTEM_MESSAGE" and step.get("source", "SYSTEM") == "SYSTEM":
        block = _SYSTEM_MSG_BLOCK_RE.search(raw)
        header_text = block.group(1) if block else raw
        header = _SYSTEM_MSG_HEADER_RE.fullmatch(header_text)
        if header:
            sender, body = header.groups()
            # The App posts this conversation's background tool completions into the same inbox.
            task_prefix = conversation_id + "/task-"
            if not (sender.startswith(task_prefix) and sender[len(task_prefix):].isdigit()):
                return body
    if allow_user_input and kind == "USER_INPUT":
        block = _USER_REQUEST_BLOCK_RE.search(raw)
        return block.group(1) if block else raw
    return None


def is_low_priority_system_message(step: dict[str, Any]) -> bool:
    if step.get("type") != "SYSTEM_MESSAGE" or step.get("source", "SYSTEM") != "SYSTEM":
        return False
    raw = step_text(step).replace("\r\n", "\n")
    block = _SYSTEM_MSG_BLOCK_RE.search(raw)
    header_text = block.group(1) if block else raw
    header = _SYSTEM_MSG_HEADER_RE.fullmatch(header_text)
    if not header:
        return False
    sender, _ = header.groups()
    priority = _SYSTEM_MSG_PRIORITY_RE.search(header_text[:header.start(2)])
    return sender == "system" and priority is not None and priority.group(1) == "MESSAGE_PRIORITY_LOW"


def receipt_matches(step: dict[str, Any], expected_prompt: str, conversation_id: str, *, allow_user_input: bool = False) -> bool:
    body = extract_receipt_body(step, conversation_id, allow_user_input=allow_user_input)
    return body is not None and body == expected_prompt.replace("\r\n", "\n")


def steps_after(steps: list[dict[str, Any]], since_step: int | None) -> list[dict[str, Any]]:
    if since_step is None:
        return list(steps)
    return [s for s in steps if isinstance(s.get("step_index"), int) and s["step_index"] > since_step]


def last_model_response(steps: list[dict[str, Any]]) -> dict[str, Any] | None:
    for step in reversed(steps):
        if is_final_planner_response(step) and step_text(step).strip():
            return step
    for step in reversed(steps):
        if is_final_planner_response(step):
            return step
    return None


_TRANSPORT_ERROR_RE = re.compile(
    r"(transport|connection\s*error|connection\s*reset|econnrefused|econnreset|"
    r"socket\s*hang\s*up|network\s*error|upstream|timed?\s*out|\b50[234]\b)",
    re.IGNORECASE,
)


def last_turn_segment(steps: list[dict[str, Any]], conversation_id: str = "") -> list[dict[str, Any]]:
    """Return the trailing turn segment starting at the last input or receipt step."""
    last_start = -1
    for idx, step in enumerate(steps):
        if is_input_or_receipt_step(step, conversation_id):
            last_start = idx
    return list(steps[last_start:]) if last_start >= 0 else list(steps)


def diagnose_turn(
    steps: list[dict[str, Any]],
    run_state: str,
    *,
    has_receipt: bool = False,
    window_complete: bool = True,
    observation_scope: str = "full_turn",
    observed_step_range: list[int] | None = None,
    tail_truncated: bool = False,
) -> dict[str, Any]:
    """Classify turn outcome and in-flight tool state from latest chronological evidence only."""
    normalized_state = str(run_state or "")
    error_step_indices: list[int] = []
    error_kinds: list[str] = []
    tool_names: list[str] = []
    tool_calls_count = 0
    done_tool_steps = 0
    pending_tool_results = 0
    has_running_step = False
    has_cancelled_step = False
    has_errored_tool = False
    latest_outcome: str | None = None

    for step in steps:
        kind = step.get("type")
        status = str(step.get("status") or "")
        err_val = step.get("error")
        err_text = str(err_val) if isinstance(err_val, str) else ""
        is_explicit_error = status == "ERROR" or (isinstance(kind, str) and "ERROR" in kind)

        if status == "RUNNING":
            has_running_step = True
            latest_outcome = "still_running"
        elif status in ("CANCELED", "CANCELLED"):
            has_cancelled_step = True
            latest_outcome = "user_cancelled"

        if kind == "PLANNER_RESPONSE" and has_tool_calls(step):
            calls = step.get("tool_calls") or []
            tool_calls_count += len(calls)
            pending_tool_results += len(calls)
            for tc in calls:
                if isinstance(tc, dict) and isinstance(tc.get("name"), str) and tc["name"] not in tool_names:
                    tool_names.append(tc["name"])
            if not is_explicit_error and status not in ("RUNNING", "CANCELED", "CANCELLED"):
                latest_outcome = "tool_activity"
        elif kind == "GENERIC":
            if status == "DONE":
                done_tool_steps += 1
                if pending_tool_results > 0:
                    pending_tool_results -= 1
                latest_outcome = "tool_activity"
            elif is_explicit_error or status == "RUNNING":
                has_errored_tool = True

        # Inspect explicit error fields/markers only; never scan ordinary content or echo raw text.
        if is_explicit_error:
            step_idx = step.get("step_index")
            if isinstance(step_idx, int) and not isinstance(step_idx, bool):
                error_step_indices.append(step_idx)
            err_kind = "transport_error" if _TRANSPORT_ERROR_RE.search(err_text) else "step_error"
            if err_kind not in error_kinds:
                error_kinds.append(err_kind)
            latest_outcome = err_kind
        elif is_final_planner_response(step):
            latest_outcome = "completed" if step_text(step).strip() else "empty_response"

    unsettled_tool_calls = pending_tool_results > 0 or (tool_calls_count > 0 and has_errored_tool)

    if tail_truncated or observation_scope == "empty_window":
        classification = "partial_window"
    elif normalized_state == "RUN_STATE_CANCELLING":
        classification = "cancelling"
    elif normalized_state == "RUN_STATE_RUNNING" or has_running_step:
        classification = "still_running"
    elif latest_outcome == "user_cancelled" or (has_cancelled_step and latest_outcome != "completed"):
        classification = "user_cancelled"
    elif latest_outcome in ("transport_error", "step_error"):
        classification = latest_outcome
    elif latest_outcome == "completed":
        classification = "completed" if window_complete else "partial_window"
    elif latest_outcome == "empty_response":
        classification = "empty_response" if window_complete else "partial_window"
    elif not steps and not has_receipt and window_complete and normalized_state in ("", "RUN_STATE_IDLE"):
        classification = "empty_transcript"
    else:
        classification = "unknown_idle" if window_complete else "partial_window"

    if classification == "partial_window":
        next_action = "read_full_turn_before_acting"
        can_continue_explicitly = False
    elif classification == "completed":
        next_action = "do_not_resend_completed_turn"
        can_continue_explicitly = False
    elif classification == "still_running":
        next_action = "wait_in_same_conversation_do_not_resend"
        can_continue_explicitly = False
    elif classification == "cancelling":
        next_action = "wait_for_cancel_then_confirm_with_user"
        can_continue_explicitly = False
    elif classification == "user_cancelled":
        next_action = "do_not_auto_continue_user_cancelled"
        can_continue_explicitly = False
    elif not window_complete:
        next_action = "read_full_turn_before_acting"
        can_continue_explicitly = False
    elif unsettled_tool_calls or tool_calls_count > 0:
        next_action = "inspect_side_effects_before_explicit_follow_up"
        can_continue_explicitly = False
    elif classification == "transport_error":
        next_action = "continue_explicitly_without_repeating_prompt"
        can_continue_explicitly = True
    else:
        next_action = "inspect_conversation_then_decide_explicit_follow_up"
        can_continue_explicitly = False

    return {
        "classification": classification,
        "run_state": normalized_state,
        "observation_scope": observation_scope,
        "window_complete": window_complete,
        "observed_step_range": observed_step_range,
        "next_action": next_action,
        "can_continue_explicitly": can_continue_explicitly,
        "tool_calls_observed": tool_calls_count,
        "completed_tool_steps": done_tool_steps,
        "unsettled_tool_calls": unsettled_tool_calls,
        "tool_names": tool_names,
        "has_error_steps": bool(error_kinds),
        "error_step_indices": error_step_indices,
        "error_kinds": error_kinds,
    }
