"""通过 Antigravity App 的官方 Sidecar 控制桌面会话。"""
from __future__ import annotations

import asyncio
from pathlib import Path
import time
from typing import Any

from ._client import (
    call_bridge,
    diagnose_turn,
    has_truncated_fields,
    is_final_planner_response,
    is_input_or_receipt_step,
    last_model_response,
    last_turn_segment,
    normalize_conversation,
    receipt_matches,
    resolve_conversation,
    step_text,
    steps_after,
    validate_seconds,
)

__all__ = [
    "health",
    "sessions",
    "get",
    "new",
    "send",
    "wait",
    "read",
    "last",
    "rename",
    "archive",
    "update",
    "delete",
]


async def health(*, socket_path: str | Path | None = None, timeout: float = 10) -> dict[str, Any]:
    """检查 Antigravity App Sidecar 桥接、ConversationService 和 agentapi 状态。"""
    return await call_bridge("health", socket_path=socket_path, timeout=validate_seconds(timeout))


async def sessions(
    *,
    query: str | None = None,
    project_id: str | None = None,
    tags: list[str] | None = None,
    include_archived: bool = False,
    limit: int = 20,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """列出或按关键词筛选 Antigravity App 桌面会话。limit=0 返回全部已扫描会话。"""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
        raise ValueError("limit 必须是非负整数")
    if not isinstance(include_archived, bool):
        raise ValueError("include_archived 必须是布尔值")
    needle = query.strip().lower() if isinstance(query, str) and query.strip() else None
    params: dict[str, Any] = {
        "include_archived": include_archived,
        "limit": 0 if needle else limit,
        "scan_all": bool(needle) or limit == 0 or limit > 100,
    }
    if project_id is not None:
        if not isinstance(project_id, str) or not project_id.strip():
            raise ValueError("project_id 不能为空")
        params["project_id"] = project_id.strip()
    if tags is not None:
        params["tags"] = [str(t) for t in tags]

    resp = await call_bridge("list_conversations", params, socket_path=socket_path, timeout=validate_seconds(timeout))
    if not resp.get("ok"):
        return resp
    items = [normalize_conversation(c) for c in resp.get("conversations", []) if isinstance(c, dict)]
    if needle:
        items = [
            item
            for item in items
            if needle in (item.get("id") or "").lower()
            or needle in (item.get("title") or "").lower()
            or needle in (item.get("summary") or "").lower()
        ]
    matched = len(items)
    shown_items = items if limit == 0 else items[:limit]
    return {
        "ok": True,
        "timed_out": False,
        "socket": resp.get("socket"),
        "sessions": shown_items,
        "meta": {
            "shown": len(shown_items),
            "matched": matched,
            "include_archived": include_archived,
            "next_page_token": resp.get("next_page_token"),
        },
    }


async def get(
    conversation_id: str,
    *,
    include_archived: bool = True,
    include_metadata: bool = True,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """定位并读取指定 Antigravity App 桌面会话的状态、元数据和本地转录摘要。"""
    seconds = validate_seconds(timeout)
    resolved = await resolve_conversation(
        conversation_id,
        include_archived=include_archived,
        include_metadata=include_metadata,
        socket_path=socket_path,
        timeout=seconds,
    )
    if not resolved.get("ok"):
        return resolved
    exact_id = resolved["conversation_id"]
    transcript = await call_bridge(
        "read_transcript",
        {"conversation_id": exact_id, "full": False, "include_steps": False},
        socket_path=socket_path,
        timeout=seconds,
    )
    return {
        "ok": True,
        "timed_out": False,
        "socket": resolved.get("socket"),
        "conversation_id": exact_id,
        "conversation": normalize_conversation(resolved["conversation"]),
        "raw_conversation": resolved["conversation"],
        "metadata": resolved.get("metadata"),
        "transcript": {
            "exists": bool(transcript.get("exists", False)),
            "path": transcript.get("path"),
            "total_steps": transcript.get("total_steps", 0),
            "last_step_index": transcript.get("last_step_index"),
            "last_response_preview": transcript.get("last_response_preview", "") if transcript.get("ok") else "",
        },
    }


async def _load_full_if_truncated(
    exact_id: str,
    steps: list[dict[str, Any]],
    candidate_steps: list[dict[str, Any]],
    *,
    from_step: int = 0,
    last_reply_only: bool = False,
    socket_path: str | Path | None,
    timeout: float,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if not any(has_truncated_fields(s) for s in candidate_steps):
        return steps, None
    full_res = await call_bridge(
        "read_transcript",
        {"conversation_id": exact_id, "full": True, "from_step": from_step, "last_reply_only": last_reply_only},
        socket_path=socket_path,
        timeout=timeout,
    )
    if not full_res.get("ok"):
        return steps, full_res
    if full_res.get("exists") and isinstance(full_res.get("steps"), list):
        full_steps = full_res["steps"]
        full_by_idx = {
            s.get("step_index"): s
            for s in full_steps
            if isinstance(s.get("step_index"), int) and not isinstance(s.get("step_index"), bool)
        }
        missing = [
            s.get("step_index")
            for s in candidate_steps
            if (
                not isinstance(s.get("step_index"), int)
                or isinstance(s.get("step_index"), bool)
                or s.get("step_index") not in full_by_idx
                or (has_truncated_fields(s) and has_truncated_fields(full_by_idx[s["step_index"]]))
            )
        ]
        if not missing:
            return full_steps, None
        return steps, {
            "ok": False,
            "error_code": "transcript-incomplete",
            "error": f"完整转录落后于短转录，尚缺少或未解截断候选步骤 {missing!r}",
        }
    return steps, {"ok": False, "error_code": "transcript-incomplete", "error": "完整转录尚不可用，暂时无法核实全文"}


_RECEIPT_ONLY_FIELDS = (
    "ok",
    "status",
    "timed_out",
    "cancelled",
    "sent",
    "uncertain",
    "receipt_confirmed",
    "conversation_id",
    "since_step",
    "receipt_step_index",
    "last_step_index",
    "matching_receipt_steps",
    "run_state",
    "update_time",
    "error_code",
    "error",
    "scan_incomplete",
)


def _compact_receipt_payload(
    payload: dict[str, Any],
    *,
    exact_id: str | None = None,
    sent: bool | None = None,
    since_step: int | None = None,
) -> dict[str, Any]:
    """裁剪只等收件确认的返回值，剔除转录事件、会话资料、baseline 与 agentapi 原文。"""
    out = {k: payload[k] for k in _RECEIPT_ONLY_FIELDS if k in payload}
    if exact_id is not None:
        out["conversation_id"] = exact_id
    if sent is not None:
        out["sent"] = sent
    if since_step is not None:
        out["since_step"] = since_step
    out["receipt_confirmed"] = bool(out.get("ok") is True and out.get("receipt_confirmed") is True)
    return out


async def wait(
    conversation_id: str,
    *,
    since_step: int | None = None,
    since_time: str | None = None,
    expected_prompt: str | None = None,
    allow_user_input: bool = False,
    receipt_only: bool = False,
    timeout: float = 120,
    poll_interval: float = 0.5,
    socket_path: str | Path | None = None,
) -> dict[str, Any]:
    """等待指定的 Antigravity App 桌面会话完成收件（及可选非空最终答复）。"""
    seconds = validate_seconds(timeout, allow_zero=True)
    interval = validate_seconds(poll_interval, name="poll_interval")
    if since_step is not None and (isinstance(since_step, bool) or not isinstance(since_step, int) or since_step < -1):
        raise ValueError("since_step 必须是大于等于 -1 的整数")
    if expected_prompt is not None and (not isinstance(expected_prompt, str) or not expected_prompt.strip()):
        raise ValueError("expected_prompt 不能为空")
    if not isinstance(allow_user_input, bool):
        raise ValueError("allow_user_input 必须是布尔值")
    if not isinstance(receipt_only, bool):
        raise ValueError("receipt_only 必须是布尔值")
    if receipt_only and expected_prompt is None:
        raise ValueError("receipt_only=True 需要提供 expected_prompt")
    if receipt_only and since_step is None:
        raise ValueError("receipt_only=True 需要提供大于等于 -1 的整数 since_step")

    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=min(15.0, seconds) if seconds else 15.0,
    )
    if not resolved.get("ok"):
        return _compact_receipt_payload(resolved, since_step=since_step) if receipt_only else resolved
    exact_id = resolved["conversation_id"]
    socket_used = resolved.get("socket")

    deadline = None if seconds == 0 else (time.monotonic() + seconds)
    seen_running = False
    idle_grace_used = False
    last_run_state = ""
    last_update_time = ""
    last_step_index: int | None = None
    last_events: list[dict[str, Any]] = []
    receipt_idx: int | None = None
    last_conv = resolved["conversation"]

    def _receipt_fields() -> dict[str, Any]:
        if receipt_idx is None:
            return {}
        return {"receipt_confirmed": True, "receipt_step_index": receipt_idx, "since_step": since_step}

    def _unanswered_payload(diag_steps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        diag = diagnose_turn(
            diag_steps if diag_steps is not None else last_events,
            last_run_state,
            has_receipt=receipt_idx is not None,
        )
        return {
            "ok": False,
            "timed_out": False,
            "status": "unanswered",
            "error_code": "no-final-response",
            "error": "未观察到本轮最终答复，原因未知。请读取原会话，不要重发。",
            "socket": socket_used,
            "conversation_id": exact_id,
            "run_state": last_run_state,
            "update_time": last_update_time,
            "last_step_index": last_step_index,
            "diagnosis": diag,
            "events": last_events,
            "conversation": normalize_conversation(last_conv),
            **_receipt_fields(),
        }

    def _timeout_payload(err_msg: str | None = None, diag_steps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if receipt_only:
            return _compact_receipt_payload({
                "ok": False,
                "timed_out": True,
                "status": "timeout",
                "error_code": "wait-timeout",
                "error": err_msg or f"等待会话 {exact_id} 收件确认超过 {seconds:g} 秒",
                "run_state": last_run_state,
                "update_time": last_update_time,
                "last_step_index": last_step_index,
            }, exact_id=exact_id, since_step=since_step)
        diag = diagnose_turn(
            diag_steps if diag_steps is not None else last_events,
            last_run_state,
            has_receipt=receipt_idx is not None,
        )
        return {
            "ok": False,
            "timed_out": True,
            "status": "timeout",
            "error_code": "wait-timeout",
            "error": err_msg or f"等待会话 {exact_id} 完成超过 {seconds:g} 秒",
            "socket": socket_used,
            "conversation_id": exact_id,
            "run_state": last_run_state,
            "update_time": last_update_time,
            "last_step_index": last_step_index,
            "diagnosis": diag,
            "events": last_events,
            "conversation": normalize_conversation(last_conv),
            **_receipt_fields(),
        }

    async def _sleep_or_timeout(
        err_msg: str | None = None,
        diag_steps: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return _timeout_payload(err_msg, diag_steps=diag_steps)
            await asyncio.sleep(min(interval, remaining))
        else:
            await asyncio.sleep(interval)
        return None

    try:
        while True:
            step_timeout = 10.0 if deadline is None else max(0.5, min(10.0, deadline - time.monotonic()))
            current = await call_bridge(
                "get_conversation",
                {"conversation_id": exact_id, "include_metadata": False},
                socket_path=socket_path,
                timeout=step_timeout,
            )
            if not current.get("ok"):
                if receipt_only:
                    return _compact_receipt_payload(current, exact_id=exact_id, since_step=since_step)
                current["conversation_id"] = exact_id
                current["events"] = last_events
                return current

            last_conv = current["conversation"]
            state_obj = last_conv.get("state") if isinstance(last_conv.get("state"), dict) else {}
            last_run_state = str(state_obj.get("runState") or "")
            last_update_time = str(state_obj.get("updateTime") or "")
            if last_run_state in ("RUN_STATE_RUNNING", "RUN_STATE_CANCELLING"):
                seen_running = True
                idle_grace_used = False

            first_step = max(0, since_step + 1) if since_step is not None else 0
            if since_step is not None and expected_prompt is None:
                first_step = max(0, since_step)
            transcript = await call_bridge(
                "read_transcript",
                {"conversation_id": exact_id, "full": False, "from_step": first_step},
                socket_path=socket_path,
                timeout=step_timeout,
            )
            if not transcript.get("ok"):
                if receipt_only:
                    return _compact_receipt_payload(transcript, exact_id=exact_id, since_step=since_step)
                transcript["conversation_id"] = exact_id
                transcript["events"] = last_events
                return transcript

            steps = transcript.get("steps", [])
            last_step_index = transcript.get("last_step_index")
            new_steps = steps_after(steps, since_step)
            steps, full_err = await _load_full_if_truncated(
                exact_id, steps, new_steps, from_step=first_step, socket_path=socket_path, timeout=step_timeout,
            )
            if full_err is not None:
                if full_err.get("error_code") == "transcript-incomplete":
                    timed = await _sleep_or_timeout(str(full_err.get("error") or ""))
                    if timed is not None:
                        return timed
                    continue
                if receipt_only:
                    return _compact_receipt_payload(full_err, exact_id=exact_id, since_step=since_step)
                full_err["conversation_id"] = exact_id
                full_err["events"] = last_events
                return full_err
            new_steps = steps_after(steps, since_step)
            last_events = new_steps
            diag_steps_cur = new_steps

            if expected_prompt is not None:
                receipt_idx = None
                matching = [
                    s for s in new_steps
                    if receipt_matches(s, expected_prompt, exact_id, allow_user_input=allow_user_input)
                ]
                if len(matching) > 1:
                    if receipt_only:
                        return _compact_receipt_payload({
                            "ok": False,
                            "timed_out": False,
                            "status": "ambiguous",
                            "error_code": "ambiguous-reply",
                            "error": f"基线之后出现 {len(matching)} 条同正文收件步骤，存在并发歧义，拒绝确认收件",
                            "run_state": last_run_state,
                            "update_time": last_update_time,
                            "last_step_index": last_step_index,
                            "matching_receipt_steps": [s.get("step_index") for s in matching],
                        }, exact_id=exact_id, since_step=since_step)
                    return {
                        "ok": False,
                        "timed_out": False,
                        "status": "ambiguous",
                        "error_code": "ambiguous-reply",
                        "error": f"基线之后出现 {len(matching)} 条同正文收件步骤，存在并发歧义，拒绝确认回复",
                        "socket": socket_used,
                        "conversation_id": exact_id,
                        "run_state": last_run_state,
                        "update_time": last_update_time,
                        "last_step_index": last_step_index,
                        "matching_receipt_steps": [s.get("step_index") for s in matching],
                        "events": new_steps,
                        "conversation": normalize_conversation(last_conv),
                    }
                if len(matching) == 1:
                    receipt_step = matching[0]
                    match_idx = receipt_step.get("step_index")
                    if receipt_only:
                        valid_idx = (
                            isinstance(match_idx, int)
                            and not isinstance(match_idx, bool)
                            and (since_step is None or match_idx > since_step)
                        )
                        if not valid_idx:
                            return _compact_receipt_payload({
                                "ok": False,
                                "timed_out": False,
                                "status": "error",
                                "receipt_confirmed": False,
                                "error_code": "invalid-receipt-step",
                                "error": f"收件步骤索引 {match_idx!r} 未严格大于基线 since_step={since_step!r}",
                                "run_state": last_run_state,
                                "update_time": last_update_time,
                                "last_step_index": last_step_index,
                            }, exact_id=exact_id, since_step=since_step)
                        return _compact_receipt_payload({
                            "ok": True,
                            "timed_out": False,
                            "status": "received",
                            "receipt_confirmed": True,
                            "receipt_step_index": match_idx,
                            "run_state": last_run_state,
                            "update_time": last_update_time,
                            "last_step_index": last_step_index,
                        }, exact_id=exact_id, since_step=since_step)
                    if not isinstance(match_idx, int) or isinstance(match_idx, bool):
                        timed = await _sleep_or_timeout()
                        if timed is not None:
                            return timed
                        continue
                    receipt_idx = match_idx
                    segment: list[dict[str, Any]] = []
                    bounded_by_next_input = False
                    for s in new_steps:
                        idx = s.get("step_index")
                        if isinstance(idx, int) and idx > receipt_idx:
                            if is_input_or_receipt_step(s, exact_id):
                                bounded_by_next_input = True
                                break
                            # The App can post its SDK startup notice before the model begins work.
                            if s.get("type") == "SYSTEM_MESSAGE" and s.get("source") == "SYSTEM_SDK":
                                continue
                            segment.append(s)

                    finals = [s for s in segment if is_final_planner_response(s)]
                    non_empty = [s for s in finals if step_text(s).strip()]
                    diag_seg = diagnose_turn(segment, last_run_state, has_receipt=True)
                    if last_run_state == "RUN_STATE_IDLE":
                        if diag_seg["classification"] == "completed" and non_empty:
                            reply_step = non_empty[-1]
                            return {
                                "ok": True,
                                "timed_out": False,
                                "status": "completed",
                                "socket": socket_used,
                                "conversation_id": exact_id,
                                "run_state": last_run_state,
                                "update_time": last_update_time,
                                "last_step_index": last_step_index,
                                "receipt_step_index": receipt_idx,
                                "reply_step_index": reply_step.get("step_index"),
                                "diagnosis": diag_seg,
                                "events": new_steps,
                                "response": step_text(reply_step),
                                "conversation": normalize_conversation(last_conv),
                            }
                        if diag_seg["classification"] == "empty_response":
                            return {
                                "ok": False,
                                "timed_out": False,
                                "status": "failed",
                                "error_code": "empty-response",
                                "error": "目标会话在收到消息后返回了空回复",
                                "socket": socket_used,
                                "conversation_id": exact_id,
                                "run_state": last_run_state,
                                "update_time": last_update_time,
                                "last_step_index": last_step_index,
                                "receipt_step_index": receipt_idx,
                                "diagnosis": diag_seg,
                                "events": new_steps,
                                "conversation": normalize_conversation(last_conv),
                            }
                        if (
                            idle_grace_used
                            or bounded_by_next_input
                            or diag_seg["classification"] in ("transport_error", "step_error", "user_cancelled")
                        ):
                            return _unanswered_payload(segment)
                        if seen_running or segment:
                            idle_grace_used = True
                    elif bounded_by_next_input and diag_seg["classification"] != "completed":
                        return _unanswered_payload(segment)
                    diag_steps_cur = segment
            else:
                segment = new_steps
                bounded_by_next_input = False
                if since_step is not None:
                    baseline_ended = since_step == -1 or any(
                        step.get("step_index") == since_step and is_final_planner_response(step)
                        for step in steps
                    )
                    for position, step in enumerate(new_steps):
                        if position == 0 and baseline_ended:
                            continue
                        if is_input_or_receipt_step(step, exact_id):
                            segment = new_steps[:position]
                            bounded_by_next_input = True
                            break
                finals = [s for s in segment if is_final_planner_response(s)]
                non_empty = [s for s in finals if step_text(s).strip()]
                diag_steps_cur = segment
                diag_seg = diagnose_turn(segment, last_run_state)
                if last_run_state == "RUN_STATE_IDLE":
                    if since_step is not None:
                        if diag_seg["classification"] == "completed" and non_empty:
                            reply_step = non_empty[-1]
                            return {
                                "ok": True,
                                "timed_out": False,
                                "status": "completed",
                                "socket": socket_used,
                                "conversation_id": exact_id,
                                "run_state": last_run_state,
                                "update_time": last_update_time,
                                "last_step_index": last_step_index,
                                "reply_step_index": reply_step.get("step_index"),
                                "diagnosis": diag_seg,
                                "events": new_steps,
                                "response": step_text(reply_step),
                                "conversation": normalize_conversation(last_conv),
                            }
                        if diag_seg["classification"] == "empty_response":
                            return {
                                "ok": False,
                                "timed_out": False,
                                "status": "failed",
                                "error_code": "empty-response",
                                "error": "目标会话返回了空回复",
                                "socket": socket_used,
                                "conversation_id": exact_id,
                                "run_state": last_run_state,
                                "update_time": last_update_time,
                                "last_step_index": last_step_index,
                                "diagnosis": diag_seg,
                                "events": new_steps,
                                "conversation": normalize_conversation(last_conv),
                            }
                        if (
                            bounded_by_next_input
                            or (seen_running and idle_grace_used)
                            or diag_seg["classification"] in ("transport_error", "step_error", "user_cancelled")
                        ):
                            return _unanswered_payload(segment)
                        if seen_running:
                            idle_grace_used = True
                    elif since_time is not None:
                        if (last_update_time > since_time) or seen_running:
                            if diag_seg["classification"] == "completed" and non_empty:
                                reply_step = non_empty[-1]
                                return {
                                    "ok": True,
                                    "timed_out": False,
                                    "status": "completed",
                                    "socket": socket_used,
                                    "conversation_id": exact_id,
                                    "run_state": last_run_state,
                                    "update_time": last_update_time,
                                    "last_step_index": last_step_index,
                                    "reply_step_index": reply_step.get("step_index"),
                                    "diagnosis": diag_seg,
                                    "events": new_steps,
                                    "response": step_text(reply_step),
                                    "conversation": normalize_conversation(last_conv),
                                }
                            if diag_seg["classification"] == "empty_response":
                                return {
                                    "ok": False,
                                    "timed_out": False,
                                    "status": "failed",
                                    "error_code": "empty-response",
                                    "error": "目标会话返回了空回复",
                                    "socket": socket_used,
                                    "conversation_id": exact_id,
                                    "run_state": last_run_state,
                                    "update_time": last_update_time,
                                    "last_step_index": last_step_index,
                                    "diagnosis": diag_seg,
                                    "events": new_steps,
                                    "conversation": normalize_conversation(last_conv),
                                }
                            if diag_seg["classification"] in ("transport_error", "step_error", "user_cancelled"):
                                return _unanswered_payload(segment)
                    else:
                        last_seg = last_turn_segment(steps, exact_id)
                        diag_last = diagnose_turn(last_seg, last_run_state)
                        if diag_last["classification"] in ("transport_error", "step_error", "user_cancelled"):
                            return _unanswered_payload(last_seg)
                        reply_step = last_model_response(last_seg)
                        return {
                            "ok": True,
                            "timed_out": False,
                            "status": "completed",
                            "socket": socket_used,
                            "conversation_id": exact_id,
                            "run_state": last_run_state,
                            "update_time": last_update_time,
                            "last_step_index": last_step_index,
                            "diagnosis": diag_last,
                            "events": new_steps,
                            "response": step_text(reply_step) if reply_step else "",
                            "conversation": normalize_conversation(last_conv),
                        }

            timed = await _sleep_or_timeout(diag_steps=diag_steps_cur)
            if timed is not None:
                return timed
    except asyncio.CancelledError as cancelled:
        cancelled_out: dict[str, Any] = {
            "ok": False,
            "cancelled": True,
            "timed_out": False,
            "status": "cancelled",
            "conversation_id": exact_id,
            "run_state": last_run_state,
            "update_time": last_update_time,
            "last_step_index": last_step_index,
        }
        if receipt_only:
            cancelled.receipt = _compact_receipt_payload(cancelled_out, exact_id=exact_id, since_step=since_step)  # type: ignore[attr-defined]
        else:
            cancelled_out.update(_receipt_fields())
            cancelled_out["cancellation_scope"] = "wait"
            cancelled_out["socket"] = socket_used
            cancelled_out["events"] = last_events
            cancelled.receipt = cancelled_out  # type: ignore[attr-defined]
        raise


async def new(
    prompt: str = "",
    *,
    project_id: str | None = None,
    environment_id: str | None = None,
    title: str | None = None,
    model: str | None = None,
    tags: list[str] | None = None,
    wait: bool = False,
    timeout: float = 120,
    poll_interval: float = 0.5,
    socket_path: str | Path | None = None,
) -> dict[str, Any]:
    """在 Antigravity App 中创建一个新的桌面会话，可选发送首条提示并等待完成。"""
    if not isinstance(prompt, str):
        raise ValueError("prompt 必须是字符串")
    if not isinstance(wait, bool):
        raise ValueError("wait 必须是布尔值")
    seconds = validate_seconds(timeout, allow_zero=wait)

    params: dict[str, Any] = {}
    if project_id is not None:
        params["project_id"] = str(project_id)
    if environment_id is not None:
        params["environment_id"] = str(environment_id)
    if title is not None:
        params["title"] = str(title)
    if model is not None:
        params["model"] = str(model)
    if tags is not None:
        params["tags"] = [str(t) for t in tags]
    has_prompt = bool(prompt.strip())
    if has_prompt:
        params["prompt"] = prompt

    created = await call_bridge(
        "create_conversation",
        params,
        socket_path=socket_path,
        timeout=min(30.0, seconds) if seconds else 30.0,
    )
    if not created.get("ok"):
        return created

    conv = created["conversation"]
    conv_id = conv.get("id")
    receipt = {
        "conversation_id": conv_id,
        "created": True,
        "sent": has_prompt,
        "since_step": -1,
    }
    if has_prompt:
        receipt["prompt"] = prompt
    if not wait or not has_prompt or not isinstance(conv_id, str):
        return {
            "ok": True,
            "timed_out": False,
            "status": "created",
            "socket": created.get("socket"),
            "conversation_id": conv_id,
            "conversation": normalize_conversation(conv),
            "receipt": receipt,
        }

    waited = await globals()["wait"](
        conv_id,
        since_step=-1,
        expected_prompt=prompt,
        allow_user_input=True,
        timeout=seconds,
        poll_interval=poll_interval,
        socket_path=socket_path,
    )
    return {**waited, "created": True, "sent": True, "receipt": receipt}


async def send(
    conversation_id: str,
    prompt: str,
    *,
    title: str | None = None,
    wait: bool = False,
    wait_receipt: bool = False,
    timeout: float = 120,
    poll_interval: float = 0.5,
    socket_path: str | Path | None = None,
) -> dict[str, Any]:
    """向 Antigravity App 中指定的已有会话发送消息，返回回执并可选核对收件或等待回复。"""
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt 不能为空")
    if not isinstance(wait, bool):
        raise ValueError("wait 必须是布尔值")
    if not isinstance(wait_receipt, bool):
        raise ValueError("wait_receipt 必须是布尔值")
    if wait and wait_receipt:
        raise ValueError("wait 与 wait_receipt 不能同时为 True")
    waiting = wait or wait_receipt
    seconds = validate_seconds(timeout, allow_zero=waiting)
    if waiting:
        validate_seconds(poll_interval, name="poll_interval")

    pre_timeout = max(5.0, min(15.0, seconds)) if (waiting and seconds) else (min(15.0, seconds) if seconds else 15.0)
    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=pre_timeout,
    )
    if not resolved.get("ok"):
        return _compact_receipt_payload(resolved, sent=False) if wait_receipt else {**resolved, "sent": False}

    exact_id = resolved["conversation_id"]
    conv = resolved["conversation"]
    state_obj = conv.get("state") if isinstance(conv.get("state"), dict) else {}
    transcript = await call_bridge(
        "read_transcript",
        {"conversation_id": exact_id, "full": False, "include_steps": False},
        socket_path=socket_path,
        timeout=pre_timeout,
    )
    if not transcript.get("ok"):
        if wait_receipt:
            return _compact_receipt_payload(transcript, exact_id=exact_id, sent=False)
        return {**transcript, "conversation_id": exact_id, "sent": False}

    last_idx = transcript.get("last_step_index")
    total_steps = transcript.get("total_steps", 0)
    valid_nonempty = isinstance(last_idx, int) and not isinstance(last_idx, bool) and last_idx >= 0
    valid_empty = (
        last_idx is None
        and isinstance(total_steps, int)
        and not isinstance(total_steps, bool)
        and total_steps == 0
    )
    if not (valid_nonempty or valid_empty):
        err_out: dict[str, Any] = {
            "ok": False,
            "timed_out": False,
            "sent": False,
            "uncertain": False,
            "conversation_id": exact_id,
            "error_code": "invalid-baseline",
            "error": f"发送前非空转录缺少合法基准步号 (total_steps={total_steps!r}, last_step_index={last_idx!r})，拒绝发送",
        }
        if wait_receipt:
            return _compact_receipt_payload(err_out, exact_id=exact_id, sent=False)
        err_out["baseline"] = {
            "last_step_index": last_idx,
            "total_steps": total_steps,
            "update_time": str(state_obj.get("updateTime") or ""),
            "run_state": str(state_obj.get("runState") or ""),
        }
        return err_out

    baseline = {
        "last_step_index": last_idx,
        "total_steps": total_steps,
        "update_time": str(state_obj.get("updateTime") or ""),
        "run_state": str(state_obj.get("runState") or ""),
    }

    send_params: dict[str, Any] = {"conversation_id": exact_id, "prompt": prompt}
    if title is not None:
        send_params["title"] = str(title)
    send_timeout = max(5.0, min(30.0, seconds)) if (waiting and seconds) else (min(30.0, seconds) if seconds else 30.0)
    sent = await call_bridge(
        "send_message",
        send_params,
        socket_path=socket_path,
        timeout=send_timeout,
    )
    since_step = baseline["last_step_index"] if baseline["last_step_index"] is not None else -1
    if not sent.get("ok"):
        if wait_receipt:
            return _compact_receipt_payload(sent, exact_id=exact_id, since_step=since_step)
        return {
            **sent,
            "conversation_id": exact_id,
            "baseline": baseline,
        }

    receipt = {
        "conversation_id": exact_id,
        "sent": True,
        "since_step": since_step,
        "prompt": prompt,
        "baseline": baseline,
        "agentapi": sent.get("agentapi"),
    }
    if not waiting:
        return {
            "ok": True,
            "timed_out": False,
            "status": "sent",
            "socket": sent.get("socket"),
            "conversation_id": exact_id,
            "sent": True,
            "baseline": baseline,
            "receipt": receipt,
        }

    try:
        waited = await globals()["wait"](
            exact_id,
            since_step=since_step,
            since_time=baseline["update_time"] or None,
            expected_prompt=prompt,
            receipt_only=wait_receipt,
            timeout=seconds,
            poll_interval=poll_interval,
            socket_path=socket_path,
        )
    except asyncio.CancelledError as cancelled:
        if wait_receipt:
            existing = getattr(cancelled, "receipt", None)
            base = existing if isinstance(existing, dict) else {}
            cancelled.receipt = _compact_receipt_payload(  # type: ignore[attr-defined]
                {
                    "ok": False,
                    "cancelled": True,
                    "timed_out": False,
                    "status": "cancelled",
                    **base,
                },
                exact_id=exact_id,
                sent=True,
                since_step=since_step,
            )
        else:
            existing = getattr(cancelled, "receipt", None)
            cancelled.receipt = {  # type: ignore[attr-defined]
                "ok": False,
                "cancelled": True,
                "timed_out": False,
                "status": "cancelled",
                "cancellation_scope": "wait",
                "conversation_id": exact_id,
                **(existing if isinstance(existing, dict) else {}),
                "sent": True,
                "baseline": baseline,
                "receipt": receipt,
            }
        raise
    if wait_receipt:
        return _compact_receipt_payload(waited, exact_id=exact_id, sent=True, since_step=since_step)
    return {**waited, "sent": True, "baseline": baseline, "receipt": receipt}


async def read(
    conversation_id: str,
    *,
    from_step: int = 0,
    limit: int = 50,
    full: bool = False,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """读取指定 Antigravity App 桌面会话的转录步骤和当前运行状态。"""
    if isinstance(from_step, bool) or not isinstance(from_step, int) or from_step < 0:
        raise ValueError("from_step 必须是非负整数")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
        raise ValueError("limit 必须是非负整数")
    if not isinstance(full, bool):
        raise ValueError("full 必须是布尔值")
    seconds = validate_seconds(timeout)

    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=seconds,
    )
    if not resolved.get("ok"):
        return resolved
    exact_id = resolved["conversation_id"]
    transcript = await call_bridge(
        "read_transcript",
        {"conversation_id": exact_id, "full": full, "from_step": from_step, "limit": limit},
        socket_path=socket_path,
        timeout=seconds,
    )
    if not transcript.get("ok"):
        return {**transcript, "conversation_id": exact_id}

    conv_norm = normalize_conversation(resolved["conversation"])
    steps = transcript["steps"]
    last_idx = transcript.get("last_step_index")
    total_steps = transcript.get("total_steps", 0)
    has_more = bool(transcript["has_more"])
    observed_from = steps[0].get("step_index") if steps else None
    observed_to = steps[-1].get("step_index") if steps else None
    observed_range = (
        [observed_from, observed_to]
        if isinstance(observed_from, int) and isinstance(observed_to, int)
        else None
    )
    has_turn_start = any(is_input_or_receipt_step(s, exact_id) for s in steps)
    missing_head = from_step > 0 and not has_turn_start
    truncated_tail = has_more or (
        isinstance(observed_to, int)
        and isinstance(last_idx, int)
        and observed_to < last_idx
    )
    if not steps:
        observation_scope = "empty_window" if (from_step > 0 or total_steps > 0) else "full_transcript"
        window_complete = observation_scope == "full_transcript"
    elif missing_head and truncated_tail:
        observation_scope = "partial_window_middle"
        window_complete = False
    elif truncated_tail:
        observation_scope = "partial_window_truncated_tail"
        window_complete = False
    elif missing_head:
        observation_scope = "tail_window_missing_head"
        window_complete = False
    else:
        observation_scope = "full_turn"
        window_complete = True

    diag = diagnose_turn(
        last_turn_segment(steps, exact_id),
        conv_norm["run_state"],
        window_complete=window_complete,
        observation_scope=observation_scope,
        observed_step_range=observed_range,
        tail_truncated=truncated_tail,
    )
    return {
        "ok": True,
        "timed_out": False,
        "socket": resolved.get("socket"),
        "conversation_id": exact_id,
        "conversation": conv_norm,
        "transcript_path": transcript.get("path"),
        "exists": bool(transcript.get("exists", False)),
        "total_steps": total_steps,
        "last_step_index": last_idx,
        "has_more": has_more,
        "diagnosis": diag,
        "steps": steps,
    }


async def last(
    conversation_id: str,
    *,
    chars: int = 4000,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """读取指定 Antigravity App 桌面会话的最近一条助手回复与当前状态。"""
    if isinstance(chars, bool) or not isinstance(chars, int) or chars < 0:
        raise ValueError("chars 必须是非负整数")
    seconds = validate_seconds(timeout)

    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=seconds,
    )
    if not resolved.get("ok"):
        return resolved
    exact_id = resolved["conversation_id"]
    transcript = await call_bridge(
        "read_transcript",
        {"conversation_id": exact_id, "full": False, "last_reply_only": True},
        socket_path=socket_path,
        timeout=seconds,
    )
    if not transcript.get("ok"):
        return {**transcript, "conversation_id": exact_id}

    steps = transcript.get("steps", [])
    reply_step = last_model_response(steps)
    if reply_step is not None and has_truncated_fields(reply_step):
        steps, full_err = await _load_full_if_truncated(
            exact_id, steps, [reply_step], last_reply_only=True, socket_path=socket_path, timeout=seconds,
        )
        if full_err is not None:
            return {**full_err, "conversation_id": exact_id}
        reply_step = last_model_response(steps)
    full_text = step_text(reply_step) if reply_step else ""
    truncated = chars > 0 and len(full_text) > chars
    shown = full_text[:chars] if truncated else full_text
    return {
        "ok": True,
        "timed_out": False,
        "socket": resolved.get("socket"),
        "conversation_id": exact_id,
        "conversation": normalize_conversation(resolved["conversation"]),
        "last_step_index": transcript.get("last_step_index"),
        "reply_step_index": reply_step.get("step_index") if reply_step else None,
        "model": reply_step.get("model") if reply_step else None,
        "created_at": reply_step.get("created_at") if reply_step else None,
        "response": shown,
        "total_chars": len(full_text),
        "truncated": truncated,
    }


async def update(
    conversation_id: str,
    *,
    title: str | None = None,
    archived: bool | None = None,
    pinned: bool | None = None,
    starred: bool | None = None,
    tags: list[str] | None = None,
    group_id: str | None = None,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """更新指定 Antigravity App 桌面会话的标题、归档、置顶、加星、标签或分组。"""
    annotations: dict[str, Any] = {}
    if title is not None:
        annotations["title"] = str(title)
    if archived is not None:
        if not isinstance(archived, bool):
            raise ValueError("archived 必须是布尔值")
        annotations["archived"] = archived
    if pinned is not None:
        if not isinstance(pinned, bool):
            raise ValueError("pinned 必须是布尔值")
        annotations["pinned"] = pinned
    if starred is not None:
        if not isinstance(starred, bool):
            raise ValueError("starred 必须是布尔值")
        annotations["starred"] = starred
    if tags is not None:
        annotations["tags"] = [str(t) for t in tags]
    if group_id is not None:
        annotations["conversationGroupId"] = str(group_id)
    if not annotations:
        raise ValueError("至少需要指定一项要更新的属性")

    seconds = validate_seconds(timeout)
    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=seconds,
    )
    if not resolved.get("ok"):
        return resolved
    exact_id = resolved["conversation_id"]
    updated = await call_bridge(
        "update_conversation",
        {"conversation_id": exact_id, "annotations": annotations},
        socket_path=socket_path,
        timeout=seconds,
    )
    if not updated.get("ok"):
        return updated
    return {
        "ok": True,
        "timed_out": False,
        "socket": updated.get("socket"),
        "conversation_id": exact_id,
        "conversation": normalize_conversation(updated["conversation"]),
    }


async def rename(
    conversation_id: str,
    title: str,
    *,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """重命名指定 Antigravity App 桌面会话。"""
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title 不能为空")
    return await update(conversation_id, title=title.strip(), socket_path=socket_path, timeout=timeout)


async def archive(
    conversation_id: str,
    *,
    archived: bool = True,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """归档或取消归档指定 Antigravity App 桌面会话。"""
    return await update(conversation_id, archived=archived, socket_path=socket_path, timeout=timeout)


async def delete(
    conversation_id: str,
    *,
    socket_path: str | Path | None = None,
    timeout: float = 15,
) -> dict[str, Any]:
    """永久删除指定 Antigravity App 桌面会话（不可撤销）。"""
    seconds = validate_seconds(timeout)
    resolved = await resolve_conversation(
        conversation_id,
        include_archived=True,
        include_metadata=False,
        socket_path=socket_path,
        timeout=seconds,
    )
    if not resolved.get("ok"):
        return resolved
    exact_id = resolved["conversation_id"]
    return await call_bridge(
        "delete_conversation",
        {"conversation_id": exact_id},
        socket_path=socket_path,
        timeout=seconds,
    )
