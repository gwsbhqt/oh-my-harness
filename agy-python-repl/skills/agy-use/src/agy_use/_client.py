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
        await asyncio.wait_for(writer.drain(), timeout=min(seconds, 5.0))
        wrote = True
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
        header = _SYSTEM_MSG_HEADER_RE.fullmatch(block.group(1) if block else raw)
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
