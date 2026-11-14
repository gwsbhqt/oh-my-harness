"""Bounded per-target CDP recording and interception; callbacks never call CDP."""
from __future__ import annotations

import base64
import copy
import fnmatch
import hashlib
import json
import os
import queue
import re
import stat
import tempfile
import threading
import time
import uuid
from collections import Counter, OrderedDict, deque
from concurrent.futures import Future, TimeoutError
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from .checks import boolean, gone, integer, origin as checked_origin, string, url_origin
from .errors import BrowserUseError
from . import scratch
from .lane import LaneCheck, requested as _lane_requested


_SENSITIVE = re.compile(r"authorization|cookie|token|secret|api[-_]?key|password", re.I)
_PARAMS = {
    "requests": {"filter", "url", "method", "status", "limit", "raw", "resource_types", "page", "page_size",
                 "after", "include_previous_navigations"},
    "request": {"id", "requestId", "body", "postData", "raw", "save_body", "save_post_data"},
    "request_body": {"id", "requestId", "raw"},
    "ws_frames": {"connectionId", "after", "limit"},
    "ws_connections": {"limit"},
    "cache": {"disabled"},
    "service_worker": {"bypass"},
    "controls": set(),
    "override": {"url", "pattern", "file", "status", "headers", "method"},
    "unoverride": {"routeId", "id"},
    "clear": set(),
    "har_start": {"body", "raw", "content"},
    "har_stop": set(),
    "route": {"url", "pattern", "action", "body", "file", "status", "headers", "method", "errorReason",
              "rewrite", "transform"},
    "unroute": {"routeId", "id"},
    "console": {"limit", "types", "after", "page_size", "include_previous_navigations"},
    "errors": {"limit", "types", "after", "page_size", "include_previous_navigations"},
    "console_message": {"id", "property_limit"},
    "headers_set": {"headers", "origin", "replace"},
    "headers_get": {"raw"},
    "headers_clear": {"origin", "names"},
    "auth_set": {"username", "password", "origin", "authorized"},
    "auth_clear": {"origin"},
}
_EVENTS = (
    "Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo",
    "Network.responseReceived", "Network.responseReceivedExtraInfo",
    "Network.loadingFinished", "Network.loadingFailed",
    "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded",
    "Fetch.requestPaused", "Fetch.authRequired", "Network.webSocketCreated", "Network.webSocketClosed",
    "Network.webSocketFrameSent", "Network.webSocketFrameReceived", "Network.webSocketFrameError",
    "Page.frameNavigated", "Audits.issueAdded",
)
_RESOURCE_TYPES = {name.lower() for name in (
    "Document", "Stylesheet", "Image", "Media", "Font", "Script", "TextTrack", "XHR", "Fetch", "Prefetch",
    "EventSource", "WebSocket", "Manifest", "SignedExchange", "Ping", "CSPViolationReport", "Preflight",
    "FedCM", "Other")}
_CONSOLE_TYPES = {name.lower() for name in (
    "log", "debug", "info", "error", "warning", "dir", "dirxml", "table", "trace", "clear", "startGroup",
    "startGroupCollapsed", "endGroup", "assert", "profile", "profileEnd", "count", "timeEnd", "verbose", "issue")}
_ERROR_TYPES = {"error", "assert", "exception", "log", "network", "websocket", "route", "auth", "recorder", "control"}
# 这些头由网络栈维护，页面级附加会破坏请求帧或连接复用。
_FORBIDDEN_EXTRA = {"host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer",
                    "keep-alive", "proxy-connection"}
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_TEXT_MIME = re.compile(r"^text/|json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|csv|yaml", re.I)
_MESSAGE_ID = re.compile(r"msg-(0|[1-9][0-9]*)")
_RELEASE = {"extraHeaders": "Network.setExtraHTTPHeaders {} on every applied session",
            "originHeaders": "Fetch rules removed; Fetch.disable when no route remains",
            "auth": "password dropped from memory; Fetch.disable when no route remains",
            "authCache": "浏览器可能已缓存成功的 HTTP 认证，CDP 无清除接口；共享浏览器需授权"}


def lane_headers(params):
    """泳道参数 → {小写头名: 值}，按页面附加头的规则查头名；在发出任何 CDP 命令前调用。"""
    headers = _lane_requested(params)
    if len(headers) > 64:
        raise BrowserUseError("泳道一次最多设置 64 个请求头", 2)
    for name in headers:
        if not _HEADER_NAME.fullmatch(name):
            raise BrowserUseError(f"泳道请求头名称 {name!r} 不是合法的 HTTP 名称", 2)
        if name in _FORBIDDEN_EXTRA:
            raise BrowserUseError(f"{name} 由浏览器网络栈维护，不能作为泳道请求头", 2)
    if sum(len(k) + len(v) for k, v in headers.items()) > 32 * 1024:
        raise BrowserUseError("泳道请求头总长度超过 32KB", 2)
    return headers


def _headers(value, raw=False):
    return {str(k): str(v) if raw or not _SENSITIVE.search(str(k)) else "[REDACTED]"
            for k, v in (value or {}).items()}


def _types(value, allowed, name):
    if not isinstance(value, list) or not value or any(not isinstance(v, str) or not v for v in value):
        raise BrowserUseError(f"{name} 必须是非空字符串列表", 2)
    result = set()
    for item in value:
        key = "warning" if item.lower() == "warn" else item.lower()
        if key not in allowed:
            raise BrowserUseError(f"{name} 不支持 {item}", 2)
        result.add(key)
    return result


def _status_range(value):
    if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
        return value, value
    if isinstance(value, str):
        match = re.fullmatch(r"([1-5])xx", value, re.I)
        if match:
            return int(match.group(1)) * 100, int(match.group(1)) * 100 + 99
        match = re.fullmatch(r"([1-5][0-9]{2})-([1-5][0-9]{2})", value)
        if match and int(match.group(1)) <= int(match.group(2)):
            return int(match.group(1)), int(match.group(2))
    raise BrowserUseError("请求过滤状态码必须是 100 到 599 之间的整数、'2xx' 形式或 '400-499' 范围", 2)


def _clip(value, limit=1000):
    return value[:limit] if isinstance(value, str) and len(value) > limit else value


def _remote(value, limit=1000):
    value = value or {}
    result = {k: value[k] for k in ("type", "subtype", "className", "unserializableValue") if k in value}
    for key in ("value", "description"):
        if key in value:
            result[key] = _clip(value[key], limit)
            if isinstance(value[key], str) and len(value[key]) > limit:
                result[key + "Truncated"] = True
    return result


def _arg(value):
    result = _remote(value, 10000)
    if "preview" in value:
        result["preview"] = value["preview"]
    return result


def _args_text(args):
    parts = []
    for arg in args:
        if "value" in arg:
            parts.append(arg["value"] if isinstance(arg["value"], str) else json.dumps(arg["value"], ensure_ascii=False))
        elif "unserializableValue" in arg:
            parts.append(arg["unserializableValue"])
        else:
            parts.append(arg.get("description", arg.get("type", "")))
    return " ".join(str(part) for part in parts)


class NetworkRecorder:
    def __init__(self, driver, *, max_requests=1000, max_events=2000,
                 max_console=500, max_body_bytes=2 * 1024 * 1024,
                 max_total_body_bytes=8 * 1024 * 1024, max_event_bytes=256 * 1024):
        self.driver = driver
        self.session_id = driver.session_id
        self.max_requests = integer(max_requests, "max_requests", 1)
        self.max_console = integer(max_console, "max_console", 1)
        self.max_body_bytes = integer(max_body_bytes, "max_body_bytes", 1)
        self.max_total_body_bytes = integer(max_total_body_bytes, "max_total_body_bytes", 1)
        self.max_event_bytes = integer(max_event_bytes, "max_event_bytes", 1)
        self._queue = queue.Queue(integer(max_events, "max_events", 1))
        self._lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._command_timeout = 25
        self._last_cdp_loss = getattr(driver.cdp, "event_loss", 0)
        self._correlation_lost = False
        self._closing = threading.Event()
        self._closed = threading.Event()
        self._overflow = threading.Event()
        self._records = OrderedDict()
        self._chains = OrderedDict()
        self._console = deque(maxlen=self.max_console)
        self._errors = deque(maxlen=self.max_console)
        self._dropped = Counter()
        self._body_bytes = 0
        self._routes = OrderedDict()
        self._pending_pauses = OrderedDict()
        self._ws_connections = OrderedDict()
        self._ws_frames = deque(maxlen=integer(max_events, "max_events", 1))
        self._ws_sequence = 0
        self._controls = {}
        self._route_number = 0
        self._routing_disabled_reason = None
        self._fetch_enabled = False
        self._fetch_sessions = set()
        self._enabled_sessions = set()
        self._session_errors = {}
        self._last_known_sessions = {self.session_id}
        self._ready = False
        self._har = None
        self._message_seq = 0
        self._request_seq = 0
        self._evicted = {"console": 0, "errors": 0, "requests": 0}
        self._navigation = 0
        self._navigation_counter = 0
        self._navigations = OrderedDict()
        self._main_frame_id = getattr(driver, "target_id", None)
        self._extra_headers = {}
        self._lane = {}
        self.lane_check = LaneCheck()
        self._extra_sessions = set()
        self._extra_failed = {}
        self._origin_headers = {}
        self._auth = {}
        self._auth_origins_used = set()
        self._auth_attempts = OrderedDict()
        self._auth_counts = Counter()
        self._audits_failed = {}
        self._artifact_root = None
        self.close_errors = []
        self._unsubscribers = []
        self._worker = threading.Thread(target=self._run, name="browser-use-network-worker", daemon=True)
        self._worker.start()
        try:
            for event in _EVENTS:
                self._unsubscribers.append(driver.cdp.on(event, self._callback(event)))
            self._invoke(lambda: self._enable())
        except BaseException:
            self.close()
            raise

    def _call(self, method, params=None, *, session_id=None, timeout=20):
        if session_id is None or session_id == self.session_id:
            return self.driver.call(method, params, timeout=timeout)
        return self.driver.call(method, params, timeout=timeout, session_id=session_id)

    def _known_sessions(self):
        try:
            known = set(getattr(self.driver, "session_ids", (self.session_id,))) | {self.session_id}
        except RuntimeError:
            self._loss("sessionDiscoveryErrors")
            return set(self._last_known_sessions)
        self._last_known_sessions = known
        return known

    def _supports_sessions(self):
        return "session_ids" in getattr(self.driver, "__dict__", {}) or hasattr(type(self.driver), "session_ids")

    def _enable_session(self, session_id):
        self._call("Network.enable", {"maxTotalBufferSize": self.max_total_body_bytes,
                                      "maxResourceBufferSize": self.max_body_bytes}, session_id=session_id)
        self._call("Runtime.enable", session_id=session_id)
        self._call("Log.enable", session_id=session_id)
        try:
            self._call("Audits.enable", session_id=session_id)
            self._audits_failed.pop(session_id, None)
        except Exception as exc:
            # 问题面板只是附加信息，不能因它拖垮整个会话的记录。
            self._audits_failed[session_id] = str(exc)
        self._enabled_sessions.add(session_id)
        for name, value in self._controls.items():
            self._apply_control(name, value, session_id)
        if self._page_headers():
            self._apply_extra(session_id)
        if self._fetch_needed():
            self._enable_fetch_session(session_id)

    def _enable(self):
        self._enable_session(self.session_id)
        self._ready = True
        self._sync_sessions()

    def _sync_sessions(self):
        if not self._ready:
            return
        known = self._known_sessions()
        self._enabled_sessions.intersection_update(known)
        self._fetch_sessions.intersection_update(known)
        self._extra_sessions.intersection_update(known)
        for session_id in set(self._session_errors) - known:
            del self._session_errors[session_id]
        for session_id in known - self._enabled_sessions - set(self._session_errors):
            try:
                self._enable_session(session_id)
            except Exception as exc:
                self._enabled_sessions.discard(session_id)
                self._session_errors[session_id] = str(exc)
                self._error({"source": "recorder", "sessionId": session_id, "text": str(exc)})
                if self._fetch_sessions:
                    self._disable_routes("session_enable_failed")

    def _loss(self, name, count=1):
        with self._lock:
            self._dropped[name] += count

    def _callback(self, event):
        def receive(params, session_id):
            with self._state_lock:
                if session_id not in self._known_sessions():
                    return
                if event in ("Fetch.requestPaused", "Fetch.authRequired"):
                    if len(self._pending_pauses) >= self._queue.maxsize:
                        self._loss("untrackedPauses")
                        self._overflow.set()
                        return
                    self._pending_pauses[self._pause_key(event, params, session_id)] = None
                if self._closing.is_set():
                    return
                self._enqueue_event(event, params, session_id)
        return receive

    @staticmethod
    def _pause_key(event, params, session_id):
        # 同一 Fetch requestId 会先后在请求阶段、响应阶段和认证质询各暂停一次，按阶段分开登记。
        if event == "Fetch.authRequired":
            stage = "auth"
        else:
            stage = "response" if "responseStatusCode" in params or "responseErrorReason" in params else "request"
        return session_id, params["requestId"], stage

    def _enqueue_event(self, event, params, session_id):
        try:
            if len(json.dumps(params, ensure_ascii=False).encode("utf-8")) > self.max_event_bytes:
                self._loss("oversizedEvents")
                if event in ("Network.webSocketFrameSent", "Network.webSocketFrameReceived"):
                    response = dict(params.get("response", {}))
                    payload = response.get("payloadData", "")
                    response["_payloadBytes"] = len(payload.encode("utf-8"))
                    response["payloadData"] = payload.encode("utf-8")[:max(1, self.max_event_bytes // 2)].decode("utf-8", errors="ignore")
                    params = dict(params, response=response)
                    self._loss("webSocketPayloads")
                    self._queue.put_nowait((event, (params, session_id)))
                    return
                if event.startswith("Network."):
                    self._correlation_lost = True
                if event in ("Fetch.requestPaused", "Fetch.authRequired"):
                    self._loss("routeEvents")
                    self._overflow.set()
                return
            self._queue.put_nowait((event, (params, session_id)))
        except queue.Full:
            self._loss("events")
            if event.startswith("Network."):
                self._correlation_lost = True
            if event in ("Fetch.requestPaused", "Fetch.authRequired"):
                self._loss("routeEvents")
                self._overflow.set()

    def _invoke(self, operation):
        if threading.current_thread() is self._worker:
            return operation()
        future = Future()
        with self._state_lock:
            if self._closing.is_set():
                raise BrowserUseError("网络记录器已关闭", 4)
            try:
                self._queue.put_nowait((future, operation))
            except queue.Full as exc:
                raise BrowserUseError("网络记录线程已满；命令未发送", 4, outcome="not_sent") from exc
        try:
            return future.result(timeout=self._command_timeout)
        except TimeoutError as exc:
            if future.cancel():
                raise BrowserUseError("网络命令排队超时；命令未发送", 4, outcome="not_sent") from exc
            raise BrowserUseError("网络命令等待超时；未自动重发", 4, outcome="unknown") from exc

    def _check_cdp_loss(self):
        cdp_loss = getattr(self.driver.cdp, "event_loss", 0)
        if cdp_loss > self._last_cdp_loss:
            self._last_cdp_loss = cdp_loss
            self._correlation_lost = True
            if self._fetch_enabled:
                self._disable_routes("cdp_event_loss")

    def _run(self):
        try:
            while not self._closing.is_set():
                self._check_cdp_loss()
                self._sync_sessions()
                if self._overflow.is_set():
                    self._overflow.clear()
                    self._disable_routes("queue_overflow")
                try:
                    kind, value = self._queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                self._check_cdp_loss()
                self._sync_sessions()
                if isinstance(kind, Future):
                    if not kind.set_running_or_notify_cancel():
                        continue
                    try:
                        kind.set_result(value())
                    except BaseException as exc:
                        kind.set_exception(exc)
                else:
                    try:
                        self._event(kind, *value)
                    except Exception as exc:
                        self._error({"source": "recorder", "event": kind, "text": str(exc)})
        finally:
            try:
                self._disable_routes("closed")
                for name in self._controls:
                    for sid in self._enabled_sessions & self._known_sessions():
                        try:
                            self._apply_control(name, False, sid)
                        except Exception as exc:
                            self._error({"source": "control", "text": str(exc), "sessionId": sid, "outcome": "unknown"})
                            if not gone(exc):
                                self.close_errors.append({"domain": "network", "action": name + "_reset", "sessionId": sid,
                                                          "error": str(exc), "outcome": "unknown"})
                self._release_extra_headers()
            finally:
                while True:
                    try:
                        kind, _ = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if isinstance(kind, Future) and not kind.cancelled():
                        kind.set_exception(BrowserUseError("网络记录器已关闭；命令未发送", 4, outcome="not_sent"))
                    else:
                        self._loss("eventsOnClose")
                self._closed.set()

    def _release_extra_headers(self):
        sessions = (self._extra_sessions | set(self._extra_failed)) & self._known_sessions()
        for sid in sorted(sessions):
            try:
                self._call("Network.setExtraHTTPHeaders", {"headers": {}}, session_id=sid, timeout=3)
            except Exception as exc:
                if not gone(exc):
                    self.close_errors.append({"domain": "network", "action": "extra_headers_reset", "sessionId": sid,
                                              "error": str(exc), "outcome": getattr(exc, "outcome", None) or "unknown"})
        self._extra_headers.clear()
        self._lane.clear()
        self.lane_check.reset({})
        self._extra_sessions.clear()
        self._extra_failed.clear()

    def _disable_routes(self, reason):
        self._routes.clear()
        # 源级请求头与认证都靠 Fetch 拦截；拦截撤掉后保留它们只会让查询结果撒谎。
        self._origin_headers.clear()
        self._auth.clear()
        self._auth_attempts.clear()
        self._routing_disabled_reason = reason
        with self._state_lock:
            pending = list(self._pending_pauses)
            self._pending_pauses.clear()
        deadline = time.monotonic() + 5
        for session_id, request_id, kind in pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._error({"source": "route", "requestId": request_id, "sessionId": session_id,
                             "text": reason + ": terminal cleanup budget exhausted; Fetch.disable requested",
                             "outcome": "unknown", "terminalAttempt": "Fetch.disable"})
            else:
                self._terminate_pause(request_id, session_id, reason, timeout=min(0.5, remaining), kind=kind)
        sessions = self._fetch_sessions | (self._known_sessions() if reason == "queue_overflow" else set())
        for session_id in sessions:
            try:
                self._call("Fetch.disable", session_id=session_id, timeout=3)
            except Exception as exc:
                self._error({"source": "route", "sessionId": session_id, "text": str(exc), "outcome": "unknown"})
                if reason == "closed" and not gone(exc):
                    self.close_errors.append({"domain": "network", "action": "fetch_disable", "sessionId": session_id,
                                              "error": str(exc), "outcome": "unknown"})
        self._fetch_sessions.clear()
        self._fetch_enabled = False

    def close(self):
        with self._state_lock:
            self._closing.set()
            unsubscribers, self._unsubscribers = self._unsubscribers, []
        for unsubscribe in unsubscribers:
            try:
                unsubscribe()
            except Exception:
                self._loss("unsubscribeErrors")
        if threading.current_thread() is not self._worker:
            self._worker.join(timeout=25)
            if self._worker.is_alive():
                self._auth.clear()
            if self._worker.is_alive() and not any(e.get("action") == "worker_stop" for e in self.close_errors):
                self.close_errors.append({"domain": "network", "action": "worker_stop", "outcome": "unknown",
                                          "error": "网络记录线程尚未停止；拦截、请求头与认证的撤销结果未知"})

    def _chain(self, request_id):
        chain = self._chains.get(request_id)
        if chain is None:
            chain = {"hop": -1, "latest": None, "requestSlots": deque(), "responseSlots": deque(),
                     "requestExtra": deque(), "responseExtra": deque()}
            self._chains[request_id] = chain
        self._chains.move_to_end(request_id)
        while len(self._chains) > self.max_requests:
            _, dropped_chain = self._chains.popitem(last=False)
            self._loss("correlations")
            if dropped_chain["requestExtra"] or dropped_chain["responseExtra"]:
                self._correlation_lost = True
        return chain

    def _bounded_append(self, collection, value):
        pending = sum(len(chain[name]) for chain in self._chains.values()
                      for name in ("requestSlots", "responseSlots", "requestExtra", "responseExtra"))
        if pending >= self.max_requests * 4:
            for chain in self._chains.values():
                for name in ("requestSlots", "responseSlots", "requestExtra", "responseExtra"):
                    chain[name].clear()
            self._loss("correlations", pending)
            self._correlation_lost = True
        collection.append(value)

    def _merge_extras(self, chain, side):
        slots, extras = chain[side + "Slots"], chain[side + "Extra"]
        while slots and extras:
            key, extra = slots.popleft(), extras.popleft()
            record = self._records.get(key)
            if record is not None:
                headers = record[side + "Headers"]
                if side == "request" and self._lane and not self._correlation_lost:
                    self.lane_check.observe(record["url"], headers, extra.get("headers", {}))
                for name, value in extra.get("headers", {}).items():
                    for old_name in list(headers):
                        if old_name.lower() == name.lower():
                            del headers[old_name]
                    headers[name] = value
                record[side + "HeadersFinal"] = True
                if side == "response" and "statusCode" in extra:
                    record["status"] = extra["statusCode"]

    def _record_for(self, params):
        chain = self._chains.get(params.get("requestId"))
        return self._records.get(chain["latest"]) if chain else None

    def _evict(self):
        while len(self._records) > self.max_requests:
            _, old = self._records.popitem(last=False)
            self._evicted["requests"] = old["seq"]
            self._body_bytes -= old.get("_bodySize", 0)
            self._loss("requests")

    def _response(self, record, response, extra_expected):
        record.update(status=response.get("status", 0), statusText=response.get("statusText", ""),
                      mimeType=response.get("mimeType", ""), protocol=response.get("protocol", ""),
                      responseHeaders=dict(response.get("headers", {})), responseHeadersFinal=not extra_expected)
        record["responseReceived"] = True
        if extra_expected:
            chain = self._chains.get(record["_chainId"])
            if chain:
                self._bounded_append(chain["responseSlots"], record["id"])
                self._merge_extras(chain, "response")

    def _event(self, event, params, session_id):
        if event == "Fetch.requestPaused":
            self._paused(params, session_id)
            return
        if event == "Fetch.authRequired":
            self._auth_required(params, session_id)
            return
        if event == "Page.frameNavigated":
            self._navigated(params, session_id)
            return
        if event == "Audits.issueAdded":
            issue = params.get("issue", {})
            details = json.dumps(issue.get("details", {}), ensure_ascii=False)
            self._console_append({"source": "issue", "type": "issue", "level": "warning", "sessionId": session_id,
                                  "text": _clip(issue.get("code", "") + (": " + details if details != "{}" else "")),
                                  "issue": issue, "timestamp": time.time()}, [])
            return
        if event.startswith("Network.webSocket"):
            self._websocket(event, params, session_id)
            return
        params = dict(params)
        if "requestId" in params:
            params["_originalRequestId"] = params["requestId"]
            if session_id != self.session_id:
                params["requestId"] = f"{session_id}/{params['requestId']}"
        if event.endswith("ExtraInfo"):
            side = "request" if "requestWill" in event else "response"
            chain = self._chain(params["requestId"])
            self._bounded_append(chain[side + "Extra"], params)
            self._merge_extras(chain, side)
            return
        if event == "Network.requestWillBeSent":
            request_id = params["requestId"]
            chain = self._chain(request_id)
            previous = self._records.get(chain["latest"])
            if previous and "redirectResponse" in params:
                self._response(previous, params["redirectResponse"], params.get("redirectHasExtraInfo", False))
                previous.update(finished=True, redirected=True, bodyReason="redirect_body_unavailable",
                                endTimestamp=params.get("timestamp"))
            chain["hop"] += 1
            key = request_id if chain["hop"] == 0 else f"{request_id}:{chain['hop']}"
            request = params.get("request", {})
            self._request_seq += 1
            record = {"id": key, "seq": self._request_seq, "navigation": self._navigation,
                      "requestId": params["_originalRequestId"], "sessionId": session_id,
                      "_chainId": request_id, "redirectIndex": chain["hop"],
                      "url": request.get("url", ""), "method": request.get("method", "GET"),
                      "type": params.get("type", ""), "timestamp": params.get("timestamp", 0),
                      "wallTime": params.get("wallTime", time.time()),
                      "requestHeaders": dict(request.get("headers", {})), "requestHeadersFinal": False,
                      "responseHeaders": {}, "responseHeadersFinal": False, "responseReceived": False,
                      "postData": request.get("postData"), "postDataCoverage": "CDP 文本正文；multipart 文件内容可能省略", "hasPostData": request.get("hasPostData", "postData" in request),
                      "postDataAvailable": "postData" in request,
                      "postDataReason": None if "postData" in request else "not_requested",
                      "finished": False, "failed": False,
                      "bodyAvailable": False, "bodyReason": "not_requested"}
            if record["postDataAvailable"]:
                size = len(record["postData"].encode("utf-8"))
                if size > self.max_body_bytes or self._body_bytes + size > self.max_total_body_bytes:
                    record.update(postData=None, postDataAvailable=False, postDataReason="body_limit", _postDataAttempted=True)
                    self._loss("postData")
                else:
                    record["_bodySize"] = size
                    self._body_bytes += size
            self._records[key] = record
            chain["latest"] = key
            self._bounded_append(chain["requestSlots"], key)
            self._merge_extras(chain, "request")
            self._evict()
            return
        if event.startswith("Network."):
            record = self._record_for(params)
            if record is None:
                self._loss("unmatchedEvents")
                return
            if event == "Network.responseReceived":
                self._response(record, params.get("response", {}), params.get("hasExtraInfo", False))
                record["responseTimestamp"] = params.get("timestamp")
            elif event == "Network.loadingFinished":
                record.update(finished=True, endTimestamp=params.get("timestamp"),
                              encodedDataLength=params.get("encodedDataLength", 0))
                if self._har and (self._har["content"] == "all" or
                                  self._har["content"] == "text" and _TEXT_MIME.search(record.get("mimeType") or "")):
                    self._body(record)
            elif event == "Network.loadingFailed":
                record.update(finished=True, failed=True, endTimestamp=params.get("timestamp"),
                              error=params.get("errorText", ""), canceled=params.get("canceled", False),
                              bodyReason="loading_failed")
                self._error({"source": "network", "requestId": record["id"], "url": record["url"],
                             "text": record["error"], "canceled": record["canceled"]})
            return
        if event == "Runtime.consoleAPICalled":
            raw_args = params.get("args", [])
            args = [_arg(arg) for arg in raw_args]
            kind = params.get("type") or "log"
            stack = params.get("stackTrace")
            top = (stack or {}).get("callFrames", [{}])[:1] or [{}]
            value = {"source": "console", "type": kind,
                     "level": {"error": "error", "assert": "error", "warning": "warning", "debug": "verbose"}.get(kind, "info"),
                     "text": _clip(_args_text(args)), "args": args, "sessionId": session_id,
                     "timestamp": params.get("timestamp"), "stackTrace": stack,
                     "url": top[0].get("url"), "lineNumber": top[0].get("lineNumber"),
                     "columnNumber": top[0].get("columnNumber")}
            record = self._console_append(value, [arg.get("objectId") for arg in raw_args])
            if kind in ("error", "assert"):
                self._error(record)
        elif event == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails", {})
            exception = details.get("exception") or {}
            self._error({"source": "javascript", "type": "exception", "level": "error", "sessionId": session_id,
                         "timestamp": params.get("timestamp"),
                         "text": exception.get("description", details.get("text", "")),
                         "exception": _remote(exception, 10000) or None,
                         "url": details.get("url"), "lineNumber": details.get("lineNumber"),
                         "columnNumber": details.get("columnNumber"), "stackTrace": details.get("stackTrace")},
                        objects=[exception.get("objectId")])
        elif event == "Log.entryAdded":
            entry = params.get("entry", {})
            level = entry.get("level", "info")
            common = {"sessionId": session_id, "text": entry.get("text", ""), "url": entry.get("url"),
                      "lineNumber": entry.get("lineNumber"), "timestamp": entry.get("timestamp"),
                      "stackTrace": entry.get("stackTrace"), "logSource": entry.get("source")}
            if level == "error":
                self._error({"source": entry.get("source", "log"), "type": "log", "level": "error", **common,
                             "args": [_arg(a) for a in entry.get("args", [])]},
                            objects=[a.get("objectId") for a in entry.get("args", [])])
            else:
                self._console_append({"source": "log", "type": level, "level": level, **common,
                                      "args": [_arg(a) for a in entry.get("args", [])]},
                                     [a.get("objectId") for a in entry.get("args", [])])

    def _navigated(self, params, session_id):
        frame = params.get("frame", {})
        if session_id != self.session_id or frame.get("parentId"):
            return
        self._navigation_counter += 1
        self._navigation = self._navigation_counter
        loader = frame.get("loaderId")
        # 主文档请求在提交前就发出；提交后把同一 loader 的请求归入新导航。
        for record in self._records.values():
            if loader and record["sessionId"] == self.session_id and record["_chainId"] == loader:
                record["navigation"] = self._navigation
        self._navigations[self._navigation] = {"navigation": self._navigation, "url": frame.get("url", ""),
                                               "loaderId": loader, "timestamp": time.time()}
        while len(self._navigations) > 100:
            self._navigations.popitem(last=False)

    def _next_message(self, value, objects):
        self._message_seq += 1
        value = dict(value, id=f"msg-{self._message_seq}", navigation=self._navigation)
        value["_seq"] = self._message_seq
        value["_objects"] = list(objects or [])
        return value

    def _bounded(self, name, collection, value):
        if len(collection) == collection.maxlen:
            self._loss(name)
            self._evicted[name] = collection[0]["_seq"]
        collection.append(value)

    def _console_append(self, value, objects):
        record = self._next_message(value, objects)
        self._bounded("console", self._console, record)
        return record

    def _error(self, error, objects=()):
        if "_seq" in error:
            record = dict(error)
        else:
            error = dict(error)
            error.setdefault("type", {"javascript": "exception"}.get(error.get("source"), error.get("source", "recorder")))
            error.setdefault("level", "error")
            record = self._next_message(error, objects)
        self._bounded("errors", self._errors, record)

    def _body(self, record):
        if record["bodyAvailable"] or record.get("_bodyAttempted"):
            return
        if not record["finished"]:
            record["bodyReason"] = "request_not_finished"
            return
        if record["failed"] or record.get("redirected"):
            return
        record["_bodyAttempted"] = True
        if record.get("encodedDataLength", 0) > self.max_body_bytes:
            record["bodyReason"] = "body_limit"
            self._loss("bodies")
            return
        try:
            if record["sessionId"] not in self._known_sessions():
                record["bodyReason"] = "frame_session_detached"
                return
            result = self._call("Network.getResponseBody", {"requestId": record["requestId"]},
                                session_id=record["sessionId"])
            text, encoded = result.get("body", ""), result.get("base64Encoded", False)
            size = len(base64.b64decode(text, validate=True)) if encoded else len(text.encode("utf-8"))
            if size > self.max_body_bytes or self._body_bytes + size > self.max_total_body_bytes:
                record["bodyReason"] = "body_limit"
                self._loss("bodies")
                return
            record.update(body=text, base64Encoded=encoded, bodyAvailable=True, bodyReason=None, _bodySize=record.get("_bodySize", 0) + size, _responseBodySize=size)
            self._body_bytes += size
        except Exception as exc:
            record.update(bodyAvailable=False, bodyReason="cdp_body_unavailable", bodyError=str(exc))

    def _record_headers(self, record, side, raw):
        values = _headers(record[side + "Headers"], raw)
        if raw and side == "request" and url_origin(record["url"]) in self._auth_origins_used:
            # auth_set 的凭据只在内存里；raw 也不能借 Authorization 头把它带出去。
            values = {k: "[REDACTED:auth_set]" if k.lower() in ("authorization", "proxy-authorization") else v
                      for k, v in values.items()}
        return values

    def _view(self, record, raw=False, include_body=False):
        result = {k: copy.deepcopy(v) for k, v in record.items() if not k.startswith("_") and k != "body"}
        result["requestHeaders"] = self._record_headers(record, "request", raw)
        result["responseHeaders"] = self._record_headers(record, "response", raw)
        result["finalHeadersKnown"] = (record["requestHeadersFinal"] and record["responseHeadersFinal"]
                                       and not self._correlation_lost)
        if self._correlation_lost:
            result["headersReason"] = "event_loss_correlation_uncertain"
        if include_body and "body" in record:
            result["body"] = record["body"]
        return result

    def _stats(self):
        with self._lock:
            dropped = dict(self._dropped)
        return {"dropped": dropped, "cdpEventLoss": getattr(self.driver.cdp, "event_loss", 0),
                "retainedRequests": len(self._records), "retainedBodyBytes": self._body_bytes,
                "retainedWebSocketFrames": len(self._ws_frames),
                "pendingPauses": len(self._pending_pauses),
                "routingDisabledReason": self._routing_disabled_reason,
                "headerCorrelationLost": self._correlation_lost,
                "navigation": self._navigation,
                "interception": {"routes": len(self._routes), "originHeaders": sorted(self._origin_headers),
                                 "authOrigins": sorted(self._auth), "handleAuthRequests": bool(self._auth),
                                 "pageHeaders": len(self._extra_headers)},
                "scope": "target_frame_sessions" if self._supports_sessions() else "main_target_session",
                "coverage": {"scope": "target_frame_sessions" if self._supports_sessions() else "main_target_session",
                             "enabledSessionIds": sorted(self._enabled_sessions),
                             "pendingSessionIds": sorted(self._known_sessions() - self._enabled_sessions - set(self._session_errors)),
                             "failedSessions": dict(self._session_errors),
                             "auditsFailedSessions": dict(self._audits_failed),
                             "complete": False,
                             "reason": "新 frame 接入前的流量及 worker/service worker 不保证覆盖",
                             "privacy": "默认只对敏感请求头和响应头脱敏；URL、正文和控制台可能包含隐私",
                             "discoveryIntervalMs": 50,
                             "discoveryDependsOnPageDrain": hasattr(self.driver, "_drain"),
                             "sessionDiscoveryErrors": dropped.get("sessionDiscoveryErrors", 0)},
                "limits": {"requests": self.max_requests, "events": self._queue.maxsize,
                           "console": self.max_console, "bodyBytes": self.max_body_bytes,
                           "totalBodyBytes": self.max_total_body_bytes, "eventBytes": self.max_event_bytes}}

    def dispatch(self, action, params=None):
        if not isinstance(action, str) or action not in _PARAMS:
            raise BrowserUseError(f"未知网络操作：{action}", 2)
        if params is not None and not isinstance(params, dict):
            raise BrowserUseError("网络操作参数必须是键值对象", 2)
        params = dict(params or {})
        unknown = set(params) - _PARAMS[action]
        if unknown:
            raise BrowserUseError(f"网络操作 {action} 不支持参数：{', '.join(sorted(map(str, unknown)))}", 2)
        flags = {"raw", "disabled", "bypass", "include_previous_navigations", "replace", "authorized"}
        if action in ("request", "har_start"):
            flags.add("body")
        if action == "request":
            flags.add("postData")
        for flag in flags & set(params):
            boolean(params[flag], flag)
        if "method" in params:
            string(params["method"], "method")
        if action in ("request", "request_body", "unroute", "unoverride"):
            for key in {"id", "requestId", "routeId"} & set(params):
                string(params[key], key)
        validated = self._validate(action, params)
        return self._invoke(lambda: self._dispatch(action, params, validated))

    def _validate(self, action, params):
        """在发出任何 CDP 命令前把新增参数全部解析成内部值。"""
        result = {}
        if action == "requests":
            if "status" in params:
                result["status"] = _status_range(params["status"])
            if "resource_types" in params:
                result["types"] = _types(params["resource_types"], _RESOURCE_TYPES, "resource_types")
            self._paging(params, result, "req")
        elif action in ("console", "errors"):
            if "types" in params:
                result["types"] = _types(params["types"], _CONSOLE_TYPES if action == "console" else _ERROR_TYPES, "types")
            self._paging(params, result, "msg", page=False)
        elif action == "console_message":
            if not isinstance(params.get("id"), str) or not _MESSAGE_ID.fullmatch(params["id"]):
                raise BrowserUseError("console_message 需要 msg-数字 形式的 id", 2)
            result["seq"] = int(params["id"][4:])
            result["property_limit"] = integer(params.get("property_limit", 50), "property_limit", 1, 200)
        elif action == "request":
            for key in ("save_body", "save_post_data"):
                if key in params:
                    result[key] = self._save_target(params[key], key)
            if result.get("save_body") and result.get("save_body") == result.get("save_post_data"):
                raise BrowserUseError("save_body 与 save_post_data 不能写同一路径", 2)
        elif action == "har_start":
            if "content" in params:
                if "body" in params:
                    raise BrowserUseError("content 与旧参数 body 只能提供一个", 2)
                if params["content"] not in ("none", "text", "all"):
                    raise BrowserUseError("content 只能是 none、text 或 all", 2)
                result["content"] = params["content"]
            else:
                result["content"] = "text" if params.get("body") else "none"
        elif action == "headers_set":
            headers = params.get("headers")
            if not isinstance(headers, dict) or not headers:
                raise BrowserUseError("headers_set 需要非空 headers 对象", 2)
            if len(headers) > 64:
                raise BrowserUseError("一次最多设置 64 个请求头", 2)
            parsed, _ = self._header_rules(headers)
            for name in parsed:
                if name.lower() in _FORBIDDEN_EXTRA:
                    raise BrowserUseError(f"{name} 由浏览器网络栈维护，不能作为额外请求头", 2)
            if sum(len(k) + len(v) for k, v in parsed.items()) > 32 * 1024:
                raise BrowserUseError("额外请求头总长度超过 32KB", 2)
            result["headers"] = parsed
            result["origin"] = checked_origin(params["origin"], fetch_pattern=True) if "origin" in params else None
        elif action == "headers_clear":
            result["origin"] = checked_origin(params["origin"], fetch_pattern=True) if "origin" in params else None
            if "names" in params:
                names = params["names"]
                if not isinstance(names, list) or not names:
                    raise BrowserUseError("names 必须是非空请求头名称列表", 2)
                for name in names:
                    self._header_name(name, request=True)
                result["names"] = {name.lower() for name in names}
        elif action == "auth_set":
            username, password = params.get("username"), params.get("password")
            if "origin" not in params:
                raise BrowserUseError("auth_set 必须指定 origin；不向其他来源提供凭据", 2)
            result["origin"] = checked_origin(params["origin"], fetch_pattern=True)
            if (not isinstance(username, str) or not username or len(username) > 1024
                    or any(c in username for c in ":\r\n\x00")):
                raise BrowserUseError("username 必须是非空字符串，不含冒号、换行或空字符", 2)
            if not isinstance(password, str) or len(password) > 4096 or any(c in password for c in "\r\n\x00"):
                raise BrowserUseError("password 必须是字符串，不含换行或空字符", 2)
            if getattr(self.driver, "browser_owned", False) is not True and params.get("authorized") is not True:
                raise BrowserUseError("浏览器会缓存认证成功的凭据并作用于同一资料的其他标签页；共享浏览器需 authorized=true", 6)
        elif action == "auth_clear":
            result["origin"] = checked_origin(params["origin"], fetch_pattern=True) if "origin" in params else None
        return result

    def _paging(self, params, result, prefix, page=True):
        if "limit" in params:
            result["limit"] = integer(params["limit"], "limit", 1)
        if "page_size" in params:
            result["page_size"] = integer(params["page_size"], "page_size", 1, 1000)
        if page and "page" in params:
            result["page"] = integer(params["page"], "page", 1)
        if "after" in params:
            value = params["after"]
            if not isinstance(value, str) or not re.fullmatch(prefix + r"-(0|[1-9][0-9]*)", value):
                raise BrowserUseError(f"after 必须是本动作返回的 {prefix}-数字 游标", 2)
            result["after"] = int(value.split("-", 1)[1])
        if "limit" in result and ({"page_size", "page", "after"} & set(result)):
            raise BrowserUseError("limit 是取最近 N 条；分页请用 page_size 配合 page 或 after", 2)
        if "page" in result and "after" in result:
            raise BrowserUseError("page 与 after 只能使用一种分页方式", 2)

    def _save_target(self, value, name):
        if value is True:
            return True
        if not isinstance(value, str) or not value or not Path(value).is_absolute():
            raise BrowserUseError(f"{name} 必须是 true（自动私有路径）或绝对路径", 2)
        path = Path(value)
        try:
            info = os.lstat(path.parent)
        except OSError as exc:
            raise BrowserUseError(f"{name} 的目录不存在或不可读：{exc}", 2) from exc
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise BrowserUseError(f"{name} 的父目录必须是本用户拥有的真实 700 私有目录", 6)
        if os.path.lexists(path):
            raise BrowserUseError(f"{name} 目标已存在；不覆盖", 6)
        return str(path)

    def _dispatch(self, action, params, validated):
        raw = params.get("raw", False) is True
        if action == "requests":
            return self._requests_view(params, validated, raw)
        if action in ("request", "request_body"):
            key = params.get("id", params.get("requestId"))
            record = self._records.get(key)
            if record is None:
                raise BrowserUseError("找不到请求，或请求已超出保留限额", 3, data=self._stats())
            if params.get("body"):
                self._body(record)
            if params.get("postData") or action == "request_body":
                self._post_data(record)
            result = {"request": self._view(record, raw, bool(params.get("body"))), **self._stats()}
            if "save_body" in validated or "save_post_data" in validated:
                result["artifacts"] = self._save_bodies(record, validated)
            return result
        if action in ("console", "errors"):
            return self._messages_view(action, params, validated)
        if action == "console_message":
            return self._message_detail(validated)
        if action == "clear":
            if self._har:
                raise BrowserUseError("请先停止 HAR 录制，再清空记录", 6)
            self._records.clear()
            self._chains.clear()
            self._console.clear()
            self._errors.clear()
            self._evicted = {"console": self._message_seq, "errors": self._message_seq, "requests": self._request_seq}
            self._body_bytes = 0
            self._ws_connections.clear()
            self._ws_frames.clear()
            return {"cleared": True, **self._stats()}
        if action == "har_start":
            if self._har:
                raise BrowserUseError("HAR 录制已在进行", 6)
            content = validated["content"]
            self._har = {"started": time.time(), "captureBody": content != "none", "content": content,
                         "raw": raw, "existing": set(self._records)}
            return {"recording": True, "captureBody": content != "none", "content": content, **self._stats()}
        if action == "har_stop":
            if not self._har:
                raise BrowserUseError("HAR 录制尚未开始", 2)
            capture, self._har = self._har, None
            records = [r for key, r in self._records.items() if key not in capture["existing"]]
            return {"har": {"log": {"version": "1.2", "creator": {"name": "browser-use", "version": "1"},
                                    "entries": [self._har_entry(r, capture["raw"], capture["content"]) for r in records],
                                    "_browser_use": dict(self._stats(), content=capture["content"])}},
                    "recording": False, **self._stats()}
        if action in ("route", "override"):
            if action == "override":
                if "file" not in params:
                    raise BrowserUseError("override 必须指定 file", 2)
                params = dict(params, action="fulfill")
            return self._route(params)
        if action in ("cache", "service_worker", "controls"):
            return self._control(action, params)
        if action in ("ws_frames", "ws_connections"):
            return self._websocket_view(action, params)
        if action in ("headers_set", "headers_get", "headers_clear", "auth_set", "auth_clear"):
            return getattr(self, "_" + action)(params, validated)
        if action in ("unroute", "unoverride"):
            key = params.get("routeId", params.get("id"))
            if key is None:
                if self._origin_headers or self._auth:
                    self._routes.clear()
                    self._refresh_fetch("unroute")
                else:
                    self._disable_routes("unroute")
                return {"removed": True, "routes": 0, **self._stats()}
            if key not in self._routes:
                raise BrowserUseError("找不到拦截规则", 3)
            del self._routes[key]
            self._refresh_fetch("unroute")
            return {"removed": True, "routes": len(self._routes), **self._stats()}
        raise BrowserUseError(f"未知网络操作：{action}", 2)

    @staticmethod
    def _page(items, validated, prefix, default_limit):
        """按 limit（最近 N 条）、page 或 after 游标切片；返回切片与分页字段。"""
        total = len(items)
        if "after" in validated or "page_size" in validated or "page" in validated:
            size = validated.get("page_size", 100)
            if "after" in validated:
                remaining = [item for item in items if item["_seq"] > validated["after"]]
                selected = remaining[:size]
                more = len(remaining) > size
                info = {"after": f"{prefix}-{validated['after']}"}
            else:
                page = validated.get("page", 1)
                selected = items[(page - 1) * size: page * size]
                more = page * size < total
                info = {"page": page, "pages": max(1, -(-total // size))}
            info.update(pageSize=size, truncated=more,
                        nextCursor=f"{prefix}-{selected[-1]['_seq']}" if more and selected else None)
            return selected, info
        limit = validated.get("limit", default_limit)
        selected = items[-limit:]
        return selected, {"truncated": total > limit,
                          "nextCursor": None}

    def _requests_view(self, params, validated, raw):
        records = [dict(r, _seq=r["seq"]) for r in self._records.values()]
        if "filter" in params:
            if not isinstance(params["filter"], str):
                raise BrowserUseError("请求过滤条件 filter 必须是字符串", 2)
            records = [r for r in records if params["filter"] in r["url"]]
        if "url" in params:
            if not isinstance(params["url"], str):
                raise BrowserUseError("请求过滤条件 url 必须是通配字符串", 2)
            records = [r for r in records if fnmatch.fnmatchcase(r["url"], params["url"])]
        if params.get("method"):
            records = [r for r in records if r["method"] == params["method"].upper()]
        if "status" in validated:
            low, high = validated["status"]
            records = [r for r in records if r.get("responseReceived") and isinstance(r.get("status"), int)
                       and low <= r["status"] <= high]
        if "types" in validated:
            records = [r for r in records if (r.get("type") or "Other").lower() in validated["types"]]
        if params.get("include_previous_navigations", True) is False:
            records = [r for r in records if r["navigation"] == self._navigation]
        selected, paging = self._page(records, validated, "req", self.max_requests)
        evicted = self._evicted.get("requests", 0)
        return {"requests": [dict(self._view(r, raw), cursor=f"req-{r['seq']}") for r in selected],
                "total": len(records), **paging,
                "cursorGap": "after" in validated and validated["after"] < evicted,
                "latestCursor": f"req-{self._request_seq}", "navigation": self._navigation,
                "navigations": list(self._navigations.values()), **self._stats()}

    def _message_view(self, record):
        result = {k: copy.deepcopy(v) for k, v in record.items() if not k.startswith("_")}
        result["expandable"] = any(record["_objects"])
        return result

    def _messages_view(self, action, params, validated):
        values = list(self._console if action == "console" else self._errors)
        if "types" in validated:
            values = [v for v in values if str(v.get("type", "")).lower() in validated["types"]]
        if params.get("include_previous_navigations", True) is False:
            values = [v for v in values if v.get("navigation") == self._navigation]
        selected, paging = self._page(values, validated, "msg", self.max_console)
        evicted = self._evicted.get(action, 0)
        return {action: [self._message_view(v) for v in selected], "total": len(values), **paging,
                "cursorGap": "after" in validated and validated["after"] < evicted,
                "latestCursor": f"msg-{self._message_seq}", "navigation": self._navigation, **self._stats()}

    def _message_detail(self, validated):
        seq = validated["seq"]
        record = next((v for v in list(self._console) + list(self._errors) if v["_seq"] == seq), None)
        if record is None:
            reason = "evicted_or_cleared" if 0 < seq <= self._message_seq else "unknown_id"
            raise BrowserUseError("找不到控制台消息，或已超出保留限额", 3, data={"reason": reason, "latestCursor": f"msg-{self._message_seq}"})
        result = self._message_view(record)
        expansions = []
        values = list(result.get("args") or [])
        if record.get("source") == "javascript":
            values = [result.get("exception") or {}]
        for index, object_id in enumerate(record["_objects"]):
            base = values[index] if index < len(values) else {}
            expansions.append(dict(self._expand(base, object_id, record["sessionId"], validated["property_limit"]), index=index))
        if record.get("source") == "javascript":
            result["exceptionDetail"] = expansions[0] if expansions else None
        else:
            result["argsDetail"] = expansions
        result["stackTrace"] = copy.deepcopy(record.get("stackTrace"))
        result["objectScope"] = "绑定页面会话内的控制台对象；导航、清空控制台或会话断开后不可展开"
        return {"message": result, **self._stats()}

    def _expand(self, base, object_id, session_id, limit):
        detail = copy.deepcopy(base)
        if not object_id:
            return dict(detail, expanded=False, reason="primitive_or_no_object")
        if base.get("type") not in ("object", "function"):
            return dict(detail, expanded=False, reason="not_object")
        if session_id not in self._known_sessions():
            return dict(detail, expanded=False, reason="frame_session_detached")
        try:
            result = self._call("Runtime.getProperties", {"objectId": object_id, "ownProperties": True,
                                                         "generatePreview": False}, session_id=session_id, timeout=5)
        except Exception as exc:
            return dict(detail, expanded=False, reason="object_unavailable", error=str(exc))
        own = [p for p in result.get("result", []) if p.get("isOwn", True)]
        properties = []
        for prop in own[:limit]:
            item = {"name": prop.get("name"), "enumerable": prop.get("enumerable")}
            if "value" in prop:
                item["value"] = _remote(prop["value"])
            else:
                item["accessor"] = True
                item["hasGetter"] = "get" in prop and prop["get"].get("type") != "undefined"
            properties.append(item)
        internal = [{"name": p.get("name"), "value": _remote(p.get("value"))} for p in result.get("internalProperties", [])[:limit]]
        return dict(detail, expanded=True, properties=properties, propertyCount=len(own),
                    propertiesTruncated=len(own) > limit, internalProperties=internal,
                    depth=1, getterInvoked=False)

    def _header_rules(self, headers, remove=(), *, request=True):
        if not isinstance(headers, dict) or not isinstance(remove, (list, tuple)):
            raise BrowserUseError("headers 必须是对象，removeHeaders 必须是字符串列表", 2)
        result = {}
        for name, value in headers.items():
            self._header_name(name, request=request)
            if not isinstance(value, str) or any(c in value for c in ("\r", "\n", "\x00")):
                raise BrowserUseError("请求头值必须是字符串且不含换行或空字符", 2)
            result[name.lower()] = (name, value)
        for name in remove:
            self._header_name(name, request=request)
        return {name: value for name, value in result.values()}, [name.lower() for name in remove]

    def _header_name(self, name, *, request):
        if not isinstance(name, str) or not _HEADER_NAME.fullmatch(name):
            raise BrowserUseError("请求头名称必须是合法的 HTTP 字符串", 2)

    def _strict(self, value, allowed, name):
        if not isinstance(value, dict) or set(value) - set(allowed):
            raise BrowserUseError(f"{name} 必须是对象且仅含 {', '.join(sorted(allowed))}", 2)

    def _status(self, value):
        if isinstance(value, bool) or not isinstance(value, int) or not 100 <= value <= 599:
            raise BrowserUseError("响应状态码必须在 100 到 599 之间", 2)
        return value

    def _post_data(self, record):
        if record["postDataAvailable"] or record.get("_postDataAttempted"):
            return
        record["_postDataAttempted"] = True
        if not record["hasPostData"]:
            record["postDataReason"] = "request_has_no_body"
            return
        if record.get("redirected"):
            record["postDataReason"] = "redirect_body_unavailable"
            return
        if record["sessionId"] not in self._known_sessions():
            record["postDataReason"] = "frame_session_detached"
            return
        try:
            result = self._call("Network.getRequestPostData", {"requestId": record["requestId"]}, session_id=record["sessionId"])
            data = result["postData"]
            size = len(data.encode("utf-8"))
            if size > self.max_body_bytes or self._body_bytes + size > self.max_total_body_bytes:
                record["postDataReason"] = "body_limit"
                self._loss("postData")
                return
            record.update(postData=data, postDataAvailable=True, postDataReason=None,
                          postDataCoverage="CDP 文本正文；multipart 文件内容可能省略", _bodySize=record.get("_bodySize", 0) + size)
            self._body_bytes += size
        except Exception as exc:
            record.update(postDataReason="cdp_post_data_unavailable", postDataError=str(exc))

    def _apply_control(self, name, value, session_id):
        method, field = {"cache": ("Network.setCacheDisabled", "cacheDisabled"),
                         "service_worker": ("Network.setBypassServiceWorker", "bypass")}[name]
        self._call(method, {field: value}, session_id=session_id)

    def _control(self, action, params):
        if action != "controls":
            field = "disabled" if action == "cache" else "bypass"
            if field not in params:
                raise BrowserUseError(f"{action} 必须提供 {field} 布尔值", 2)
            self._controls[action] = params[field]
            applied, failed = [], {}
            for sid in self._enabled_sessions:
                try:
                    self._apply_control(action, params[field], sid)
                    applied.append(sid)
                except Exception as exc:
                    failed[sid] = str(exc)
            if failed:
                raise BrowserUseError("页面网络控制部分失败；未扩大到浏览器全局", 5,
                              outcome="unknown", data={"appliedSessionIds": applied, "failedSessions": failed})
        return {"controls": dict(self._controls), "priorStateKnown": False, "releaseResetsTo": False,
                "reason": "CDP 无读取此前 cache/SW 覆盖状态接口；release 仅恢复本调试会话默认 false",
                "headers": {"page": sorted(self._extra_headers), "origins": sorted(self._origin_headers),
                            "authOrigins": sorted(self._auth), "release": dict(_RELEASE)}, **self._stats()}

    def _websocket(self, event, params, session_id):
        request_id = params["requestId"]
        key = request_id if session_id == self.session_id else f"{session_id}/{request_id}"
        if event == "Network.webSocketCreated":
            self._ws_connections[key] = {"connectionId": key, "requestId": request_id, "sessionId": session_id,
                                         "url": params.get("url", ""), "closed": False}
            while len(self._ws_connections) > self.max_requests:
                self._ws_connections.popitem(last=False)
                self._loss("webSocketConnections")
            return
        connection = self._ws_connections.get(key)
        if event == "Network.webSocketClosed":
            if connection:
                connection.update(closed=True, closedTimestamp=params.get("timestamp"))
            else:
                self._loss("webSocketUnmatched")
            return
        if event == "Network.webSocketFrameError":
            self._error({"source": "websocket", "connectionId": key, "text": params.get("errorMessage", ""),
                         "timestamp": params.get("timestamp"), "sessionId": session_id})
            return
        frame = params.get("response", {})
        payload = frame.get("payloadData", "")
        data = payload.encode("utf-8")
        payload_size = frame.get("_payloadBytes", len(data))
        wire_size = len(base64.b64decode(payload, validate=True)) if frame.get("opcode") != 1 and "_payloadBytes" not in frame else (payload_size if frame.get("opcode") == 1 else None)
        truncated = payload_size > len(data) or len(data) > self.max_event_bytes
        if truncated:
            payload = data[:self.max_event_bytes].decode("utf-8", errors="ignore")
            if not frame.get("_payloadBytes"):
                self._loss("webSocketPayloads")
        if len(self._ws_frames) == self._ws_frames.maxlen:
            self._loss("webSocketFrames")
        self._ws_sequence += 1
        self._ws_frames.append({"sequence": self._ws_sequence, "connectionId": key, "sessionId": session_id,
                               "direction": "sent" if event.endswith("Sent") else "received",
                               "timestamp": params.get("timestamp"), "opcode": frame.get("opcode"),
                               "mask": frame.get("mask"), "payloadData": payload,
                               "payloadEncoding": "utf-8" if frame.get("opcode") == 1 else "base64",
                               "payloadBytes": wire_size, "encodedPayloadBytes": payload_size, "payloadTruncated": truncated,
                               "connectionKnown": connection is not None})

    def _websocket_view(self, action, params):
        limit = integer(params.get("limit", self.max_requests), "limit", 1)
        connections = list(self._ws_connections.values())
        if action == "ws_connections":
            return {"connections": copy.deepcopy(connections[-limit:]), "total": len(connections),
                    "truncated": len(connections) > limit, **self._stats()}
        after = integer(params.get("after", 0), "after", 0)
        key = params.get("connectionId")
        if key is not None:
            string(key, "connectionId")
        frames = [f for f in self._ws_frames if f["sequence"] > after and (key is None or f["connectionId"] == key)]
        selected = frames[:limit]
        oldest = self._ws_frames[0]["sequence"] if self._ws_frames else self._ws_sequence + 1
        return {"frames": copy.deepcopy(selected), "cursor": selected[-1]["sequence"] if selected else after,
                "latestCursor": self._ws_sequence, "oldestCursor": oldest,
                "cursorGap": after < oldest - 1, "total": len(frames), "truncated": len(frames) > limit,
                "connections": copy.deepcopy(connections), **self._stats()}

    def _route(self, params):
        pattern = params.get("url", params.get("pattern"))
        if not isinstance(pattern, str) or not pattern:
            raise BrowserUseError("拦截规则必须提供 URL 通配模式", 2)
        if "url" in params and "pattern" in params:
            raise BrowserUseError("url 和 pattern 只能提供一个匹配字段", 2)
        action = params.get("action", "fulfill" if any(k in params for k in ("body", "file", "status")) else "continue")
        if action not in ("fulfill", "abort", "continue", "response_transform"):
            raise BrowserUseError("拦截操作必须是 fulfill、abort、continue 或 response_transform", 2)
        allowed = {"continue": {"headers", "rewrite"}, "abort": {"errorReason"},
                   "fulfill": {"headers", "body", "file", "status"},
                   "response_transform": {"transform"}}[action] | {"url", "pattern", "action", "method"}
        self._header_rules(params.get("headers", {}))
        if set(params) - allowed:
            raise BrowserUseError(f"{action} 不支持字段：{', '.join(sorted(set(params) - allowed))}", 2)
        status = self._status(params.get("status", 200))
        headers, _ = self._header_rules(params.get("headers", {}))
        rewrite = copy.deepcopy(params.get("rewrite", {}))
        self._strict(rewrite, {"url", "method", "postData", "headers", "removeHeaders"}, "rewrite")
        if "headers" in params and "headers" in rewrite:
            raise BrowserUseError("headers 与 rewrite.headers 不能同时提供", 2)
        rewrite["headers"], rewrite["removeHeaders"] = self._header_rules(
            rewrite.get("headers", headers), rewrite.get("removeHeaders", []))
        if "url" in rewrite:
            url = rewrite["url"]
            if not isinstance(url, str) or urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).netloc:
                raise BrowserUseError("rewrite.url 必须是绝对 HTTP(S) URL", 2)
        if "method" in rewrite:
            if not isinstance(rewrite["method"], str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", rewrite["method"]):
                raise BrowserUseError("rewrite.method 必须是 HTTP 方法字符串", 2)
            rewrite["method"] = rewrite["method"].upper()
        if "postData" in rewrite and not isinstance(rewrite["postData"], str):
            raise BrowserUseError("rewrite.postData 必须是字符串", 2)
        transform = copy.deepcopy(params.get("transform", {}))
        self._strict(transform, {"json", "text", "status", "headers", "removeHeaders"}, "transform")
        if action == "response_transform" and not transform:
            raise BrowserUseError("response_transform 必须指定 transform", 2)
        if "json" in transform and "text" in transform:
            raise BrowserUseError("transform.json 与 text 互斥", 2)
        if "status" in transform:
            self._status(transform["status"])
        transform["headers"], transform["removeHeaders"] = self._header_rules(
            transform.get("headers", {}), transform.get("removeHeaders", []), request=False)
        if "json" in transform:
            patch = transform["json"]
            self._strict(patch, {"set", "remove"}, "transform.json")
            if not isinstance(patch.get("set", {}), dict) or not isinstance(patch.get("remove", []), list):
                raise BrowserUseError("json.set 必须是对象，json.remove 必须是列表", 2)
            for pointer in list(patch.get("set", {})) + patch.get("remove", []):
                self._pointer(pointer)
        if "text" in transform:
            patch = transform["text"]
            self._strict(patch, {"replace"}, "transform.text")
            if not isinstance(patch.get("replace"), list):
                raise BrowserUseError("text.replace 必须是列表", 2)
            for replacement in patch["replace"]:
                self._strict(replacement, {"from", "to"}, "replace")
                if not isinstance(replacement.get("from"), str) or not replacement["from"] or not isinstance(replacement.get("to"), str):
                    raise BrowserUseError("replace 需要非空 from 字符串和 to 字符串", 2)
        reasons = {"Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed", "ConnectionReset",
                   "ConnectionRefused", "ConnectionAborted", "ConnectionFailed", "NameNotResolved",
                   "InternetDisconnected", "AddressUnreachable", "BlockedByClient", "BlockedByResponse"}
        if "errorReason" in params and (not isinstance(params["errorReason"], str) or params["errorReason"] not in reasons):
            raise BrowserUseError("errorReason 不是 CDP 支持的网络失败原因", 2)
        body = params.get("body", "")
        file_path = None
        if "file" in params:
            if "body" in params or not isinstance(params["file"], str) or not Path(params["file"]).is_absolute():
                raise BrowserUseError("file 必须为绝对路径且不能与 body 同时使用", 2)
            try:
                file_path = Path(params["file"]).resolve(strict=True)
                if not file_path.is_file():
                    raise BrowserUseError("file 必须是普通文件", 2)
                with file_path.open("rb") as source:
                    body = source.read(self.max_body_bytes + 1)
            except OSError as exc:
                raise BrowserUseError(f"无法读取覆盖文件：{exc}", 2) from exc
        if not isinstance(body, (str, bytes)):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False)
        body_bytes = body if isinstance(body, bytes) else body.encode("utf-8")
        config_bytes = len(json.dumps({"rewrite": rewrite, "transform": transform}, ensure_ascii=False, allow_nan=False).encode())
        if len(body_bytes) > self.max_body_bytes or (("rewrite" in params or "transform" in params) and config_bytes > self.max_body_bytes):
            raise BrowserUseError("规则正文或改写配置超过正文限额", 2)
        retained = len(body_bytes) + (config_bytes if "rewrite" in params or "transform" in params else 0)
        if sum(r["_retainedBytes"] for r in self._routes.values()) + retained > self.max_total_body_bytes:
            raise BrowserUseError("规则正文总量超过记录器的总正文限额", 2)
        if len(self._routes) >= self.max_requests:
            raise BrowserUseError("拦截规则已达到数量上限", 6)
        self._route_number += 1
        key = f"route-{self._route_number}"
        route = dict(params, url=pattern, action=action, status=status, headers=headers,
                     rewrite=rewrite, transform=transform, _retainedBytes=retained,
                     body=base64.b64encode(body_bytes).decode("ascii"))
        self._routes[key] = route
        try:
            self._update_fetch()
        except BaseException:
            self._disable_routes("route_enable_failed")
            raise
        self._routing_disabled_reason = None
        return {"routeId": key, "url": pattern, "action": action,
                "stage": "Response" if action == "response_transform" else "Request",
                "file": str(file_path) if file_path else None, "fileBytes": len(body_bytes) if file_path else None,
                "fileSnapshot": bool(file_path), "routes": len(self._routes), **self._stats()}

    def _fetch_needed(self):
        return bool(self._routes or self._origin_headers or self._auth)

    def _fetch_params(self):
        patterns = []
        for route in self._routes.values():
            pattern = {"urlPattern": route["url"],
                       "requestStage": "Response" if route["action"] == "response_transform" else "Request"}
            if pattern not in patterns:
                patterns.append(pattern)
        for origin in sorted(set(self._origin_headers) | set(self._auth)):
            pattern = {"urlPattern": origin + "/*", "requestStage": "Request"}
            if pattern not in patterns:
                patterns.append(pattern)
        params = {"patterns": patterns}
        if self._auth:
            params["handleAuthRequests"] = True
        return params

    def _enable_fetch_session(self, session_id):
        self._fetch_sessions.add(session_id)
        self._fetch_enabled = True
        self._call("Fetch.enable", self._fetch_params(), session_id=session_id)

    def _update_fetch(self):
        for session_id in self._enabled_sessions:
            self._enable_fetch_session(session_id)

    def _refresh_fetch(self, reason):
        if not self._fetch_needed():
            self._disable_routes(reason)
            return
        try:
            self._update_fetch()
        except BaseException:
            self._disable_routes(reason + "_failed")
            raise

    def _page_headers(self):
        """页面会话上实际要附加的头：headers-set 的和泳道的，两边头名不重叠。"""
        return {**self._extra_headers, **self._lane}

    def _apply_extra(self, session_id):
        headers = self._page_headers()
        try:
            self._call("Network.setExtraHTTPHeaders", {"headers": headers}, session_id=session_id)
        except Exception as exc:
            self._extra_failed[session_id] = str(exc)
            raise
        self._extra_failed.pop(session_id, None)
        if headers:
            self._extra_sessions.add(session_id)
        else:
            self._extra_sessions.discard(session_id)

    def _apply_extra_all(self):
        applied, failed, code = [], {}, 5
        targets = self._extra_sessions | set(self._extra_failed)
        if self._page_headers():
            targets |= self._enabled_sessions
        for sid in sorted(targets):
            if sid not in self._known_sessions():
                continue
            try:
                self._apply_extra(sid)
                applied.append(sid)
            except Exception as exc:
                failed[sid] = str(exc)
                if getattr(exc, "code", None) == 4:
                    code = 4
        if failed:
            raise BrowserUseError("页面额外请求头部分会话写入失败；结果未知，未重发", code, outcome="unknown",
                          data={"appliedSessionIds": applied, "failedSessions": failed,
                                "pageHeaders": sorted(self._extra_headers)})
        return applied

    @staticmethod
    def _header_merge(current, changes):
        result = {name.lower(): (name, value) for name, value in current.items()}
        for name, value in changes.items():
            result[name.lower()] = (name, value)
        return {name: value for name, value in result.values()}

    def _headers_state(self, raw=False):
        return {"pageHeaders": _headers(self._extra_headers, raw),
                "laneHeaders": sorted(self._lane),
                "originHeaders": {origin: _headers(values, raw) for origin, values in self._origin_headers.items()},
                "auth": [{"origin": origin, "username": value["username"], "passwordSet": True,
                          "provided": self._auth_counts[(origin, "provided")],
                          "rejected": self._auth_counts[(origin, "rejected")]}
                         for origin, value in self._auth.items()],
                "appliedSessionIds": sorted(self._extra_sessions),
                "failedSessions": dict(self._extra_failed),
                "fetchSessionIds": sorted(self._fetch_sessions),
                "scope": {"pageHeaders": "Network.setExtraHTTPHeaders，作用于绑定页面会话及已接入 frame 会话",
                          "originHeaders": "Fetch 请求阶段拦截，仅该 origin 的请求在 continueRequest 上加头",
                          "auth": "Fetch.authRequired，仅匹配 origin 的服务器 Basic 质询提供凭据，其他回 Default"},
                "coverage": "worker、service worker 自身请求和新 frame 接入前的请求不保证覆盖",
                "release": dict(_RELEASE)}

    def _headers_set(self, params, validated):
        headers, origin = validated["headers"], validated["origin"]
        taken = sorted({name.lower() for name in headers} & set(self._lane))
        if taken:
            raise BrowserUseError(f"请求头 {'、'.join(taken)} 已由泳道设置；同一个头只能有一个来源，改值用 lane set，或先 lane clear", 6,
                          data={"laneHeaders": sorted(self._lane)})
        if origin is None:
            previous = dict(self._extra_headers)
            # 部分会话失败时结果未知：保留新值，close 会向所有触及的会话发清空。
            self._extra_headers = dict(headers) if params.get("replace") else self._header_merge(self._extra_headers, headers)
            self._apply_extra_all()
            return {"set": True, "scope": "page", "previous": sorted(previous), **self._headers_state(), **self._stats()}
        current = {} if params.get("replace") else self._origin_headers.get(origin, {})
        previous = copy.deepcopy(self._origin_headers)
        self._origin_headers[origin] = self._header_merge(current, headers)
        try:
            self._update_fetch()
        except BaseException:
            self._origin_headers = previous
            self._disable_routes("headers_enable_failed")
            raise
        self._routing_disabled_reason = None
        return {"set": True, "scope": "origin", "origin": origin, **self._headers_state(), **self._stats()}

    def _headers_get(self, params, validated):
        return {**self._headers_state(params.get("raw", False) is True), **self._stats()}

    def _headers_clear(self, params, validated):
        origin, names = validated["origin"], validated.get("names")
        if origin is not None:
            if origin in self._origin_headers:
                remaining = {k: v for k, v in self._origin_headers[origin].items() if names is not None and k.lower() not in names}
                if remaining:
                    self._origin_headers[origin] = remaining
                else:
                    del self._origin_headers[origin]
                self._refresh_fetch("headers_clear")
            return {"cleared": True, "scope": "origin", "origin": origin, **self._headers_state(), **self._stats()}
        self._extra_headers = {k: v for k, v in self._extra_headers.items() if names is not None and k.lower() not in names}
        self._apply_extra_all()
        return {"cleared": True, "scope": "page", **self._headers_state(), **self._stats()}

    def lane(self, action, params):
        """页面泳道的设置、查询和撤销；头名先在调用线程查完，失败时不发任何 CDP 命令。"""
        if action == "set":
            headers = lane_headers(params)
            return self._invoke(lambda: self._lane_set(headers))
        if action in ("get", "status"):
            if params:
                raise BrowserUseError(f"lane {action} 不收参数", 2)
            return self._invoke(self._lane_state)
        if action == "clear":
            if params:
                raise BrowserUseError("lane clear 不收参数", 2)
            return self._invoke(self._lane_clear)
        raise BrowserUseError(f"未知泳道操作：{action}", 2)

    def _lane_state(self):
        return {"headers": dict(self._lane), "check": self.lane_check.stats(),
                "appliedSessionIds": sorted(self._extra_sessions), "failedSessions": dict(self._extra_failed)}

    def _lane_set(self, headers):
        taken = sorted(set(headers) & ({name.lower() for name in self._extra_headers}
                                       | {name.lower() for values in self._origin_headers.values() for name in values}))
        if taken:
            raise BrowserUseError(f"请求头 {'、'.join(taken)} 已由 network headers-set 设置；同一个头只能有一个来源，"
                          "先用 network headers-clear 撤掉再设泳道", 6, data={"headers": taken})
        self._lane = {**self._lane, **headers}
        # 期望值变了，旧的核对结果已不能说明新值，重新统计。
        self.lane_check.reset(self._lane)
        self._apply_extra_all()
        return self._lane_state()

    def _lane_clear(self):
        cleared = sorted(self._lane)
        self._lane = {}
        self.lane_check.reset({})
        self._apply_extra_all()
        return {"cleared": cleared, **self._lane_state()}

    def lane_warning(self):
        """出现新的或数量变了的泳道不一致时返回警告，否则 None；不进记录线程，页面动作结束时随手取。"""
        if not self._lane:
            return None
        return self.lane_check.take_warning()

    def _auth_set(self, params, validated):
        origin = validated["origin"]
        previous = dict(self._auth)
        self._auth[origin] = {"username": params["username"], "password": params["password"]}
        self._auth_origins_used.add(origin)
        try:
            self._update_fetch()
        except BaseException:
            self._auth = previous
            self._disable_routes("auth_enable_failed")
            raise
        self._routing_disabled_reason = None
        return {"set": True, "origin": origin, "username": params["username"], "passwordSet": True,
                "browserCache": "认证成功后浏览器可能为同一资料缓存凭据，CDP 无法清除",
                **self._headers_state(), **self._stats()}

    def _auth_clear(self, params, validated):
        origin = validated["origin"]
        removed = [o for o in list(self._auth) if origin is None or o == origin]
        for item in removed:
            del self._auth[item]
        self._refresh_fetch("auth_clear")
        return {"cleared": removed, "browserCache": "浏览器已缓存的认证不会因此清除", **self._headers_state(), **self._stats()}

    def _auth_required(self, params, session_id):
        request_id = params["requestId"]
        key = self._pause_key("Fetch.authRequired", params, session_id)
        with self._state_lock:
            if key not in self._pending_pauses:
                return
        request = params.get("request", {})
        challenge = params.get("authChallenge", {})
        origin = url_origin(request.get("url", ""))
        credential = self._auth.get(origin)
        challenger = challenge.get("origin")
        answer = {"response": "Default"}
        attempt = (session_id, request_id)
        if (credential and challenge.get("source", "Server") == "Server"
                and str(challenge.get("scheme", "")).lower() == "basic"
                and (not challenger or url_origin(challenger) == origin)):
            if attempt in self._auth_attempts:
                # 同一请求再次被质询说明凭据被拒，不再重复提交，交给页面收到 401。
                answer = {"response": "CancelAuth"}
                self._auth_counts[(origin, "rejected")] += 1
                self._error({"source": "auth", "type": "auth", "origin": origin, "sessionId": session_id,
                             "text": "服务器拒绝了 auth_set 提供的凭据；已取消本次认证，未重试"})
            else:
                answer = {"response": "ProvideCredentials", "username": credential["username"],
                          "password": credential["password"]}
                self._auth_attempts[attempt] = origin
                while len(self._auth_attempts) > self.max_requests:
                    self._auth_attempts.popitem(last=False)
                self._auth_counts[(origin, "provided")] += 1
        try:
            self._call("Fetch.continueWithAuth", {"requestId": request_id, "authChallengeResponse": answer},
                       session_id=session_id)
        except Exception as exc:
            self._error({"source": "auth", "type": "auth", "sessionId": session_id, "origin": origin,
                         "text": str(exc).replace(credential["password"], "[REDACTED]") if credential and credential["password"] else str(exc),
                         "outcome": getattr(exc, "outcome", None) or "failed"})
        finally:
            with self._state_lock:
                self._pending_pauses.pop(key, None)

    def _artifact_file(self, target, kind, suffix):
        if target is True:
            if self._artifact_root is None:
                self._artifact_root = Path(tempfile.mkdtemp(prefix="page-", dir=scratch.subdir("network")))
                os.chmod(self._artifact_root, 0o700)
            path = self._artifact_root / (kind + "-" + uuid.uuid4().hex + suffix)
        else:
            path = Path(target)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(path, flags, 0o600)
        except FileExistsError as exc:
            raise BrowserUseError("产物路径已存在；不覆盖", 6) from exc
        os.fchmod(fd, 0o600)
        return path, fd

    def _raw_body(self, record):
        if not record["finished"]:
            raise BrowserUseError("请求尚未完成，没有可保存的响应正文", 4, data={"reason": "request_not_finished"})
        if record["failed"] or record.get("redirected"):
            raise BrowserUseError("失败或重定向的请求没有可保存的响应正文", 3,
                          data={"reason": "loading_failed" if record["failed"] else "redirect_body_unavailable"})
        if record["bodyAvailable"]:
            text, encoded = record["body"], record.get("base64Encoded", False)
        else:
            if record["sessionId"] not in self._known_sessions():
                raise BrowserUseError("请求所在 frame 会话已断开，无法读取正文", 3, data={"reason": "frame_session_detached"})
            try:
                result = self._call("Network.getResponseBody", {"requestId": record["requestId"]},
                                    session_id=record["sessionId"])
            except BrowserUseError as exc:
                raise BrowserUseError("浏览器已不保留该响应正文；未重发请求", 3,
                              data={"reason": "cdp_body_unavailable", "error": str(exc)}) from exc
            text, encoded = result.get("body", ""), result.get("base64Encoded", False)
        return (base64.b64decode(text, validate=True) if encoded else text.encode("utf-8")), encoded

    def _raw_post_data(self, record):
        if record["postDataAvailable"]:
            return record["postData"].encode("utf-8"), False
        if not record["hasPostData"]:
            raise BrowserUseError("请求没有正文", 3, data={"reason": "request_has_no_body"})
        if record.get("redirected"):
            raise BrowserUseError("重定向前请求的正文不可用", 3, data={"reason": "redirect_body_unavailable"})
        if record["sessionId"] not in self._known_sessions():
            raise BrowserUseError("请求所在 frame 会话已断开，无法读取请求正文", 3, data={"reason": "frame_session_detached"})
        try:
            result = self._call("Network.getRequestPostData", {"requestId": record["requestId"]},
                                session_id=record["sessionId"])
        except BrowserUseError as exc:
            raise BrowserUseError("浏览器已不保留该请求正文；未重发请求", 3,
                          data={"reason": "cdp_post_data_unavailable", "error": str(exc)}) from exc
        encoded = result.get("base64Encoded", False)
        data = result.get("postData", "")
        return (base64.b64decode(data, validate=True) if encoded else data.encode("utf-8")), encoded

    def _save_bodies(self, record, validated):
        # 先取齐两份字节再建文件，任一不可用都不留下半套产物。
        payloads = []
        if "save_body" in validated:
            data, encoded = self._raw_body(record)
            payloads.append(("response_body", validated["save_body"], data, encoded, record.get("mimeType", "")))
        if "save_post_data" in validated:
            data, encoded = self._raw_post_data(record)
            mime = next((v for k, v in record["requestHeaders"].items() if k.lower() == "content-type"), "")
            payloads.append(("request_post_data", validated["save_post_data"], data, encoded, mime))
        artifacts = []
        for kind, target, data, encoded, mime in payloads:
            try:
                path, fd = self._artifact_file(target, kind, ".bin")
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
            except (OSError, BrowserUseError) as exc:
                raise BrowserUseError(f"正文写入失败：{exc}", getattr(exc, "code", 5), data={"artifacts": artifacts}) from exc
            artifacts.append({"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                              "kind": kind, "mimeType": mime, "base64Encoded": encoded,
                              "requestId": record["id"], "complete": True})
        return artifacts

    def _merged_headers(self, original, changes, remove):
        pairs = original.items() if isinstance(original, dict) else ((h["name"], h["value"]) for h in original)
        # Response headers can repeat (notably Set-Cookie); preserve duplicates untouched.
        replaced = {k.lower() for k in changes} | set(remove)
        return ([{"name": k, "value": v} for k, v in pairs if k.lower() not in replaced] +
                [{"name": k, "value": v} for k, v in changes.items()])

    def _terminate_pause(self, request_id, session_id, reason, *, timeout=3, kind=None):
        if kind == "auth":
            method, params = "Fetch.continueWithAuth", {"requestId": request_id,
                                                         "authChallengeResponse": {"response": "CancelAuth"}}
        else:
            method, params = "Fetch.failRequest", {"requestId": request_id, "errorReason": "Failed"}
        try:
            self._call(method, params, session_id=session_id, timeout=timeout)
            outcome = "terminated"
        except Exception as exc:
            outcome = "unknown"
            self._error({"source": "route", "requestId": request_id, "sessionId": session_id,
                         "text": str(exc), "outcome": outcome, "terminalAttempt": method})
        self._error({"source": "route", "requestId": request_id, "sessionId": session_id,
                     "text": reason, "outcome": outcome, "terminalAttempt": method})
        return outcome

    def _paused(self, params, session_id):
        request_id = params["requestId"]
        key = self._pause_key("Fetch.requestPaused", params, session_id)
        with self._state_lock:
            if key not in self._pending_pauses:
                return
        request = params.get("request", {})
        response = "responseStatusCode" in params or "responseErrorReason" in params
        route = next((r for r in reversed(list(self._routes.values()))
                      if (r["action"] == "response_transform") == response
                      and fnmatch.fnmatchcase(request.get("url", ""), r["url"])
                      and (not r.get("method") or request.get("method") == r["method"].upper())), None)
        try:
            if route is None or route["action"] == "continue":
                continuation = {"requestId": request_id}
                changes = {} if response else dict(self._origin_headers.get(url_origin(request.get("url", "")), {}))
                remove = []
                if route:
                    rewrite = route["rewrite"]
                    for name in ("url", "method"):
                        if name in rewrite:
                            continuation[name] = rewrite[name]
                    if "postData" in rewrite:
                        continuation["postData"] = base64.b64encode(rewrite["postData"].encode()).decode("ascii")
                    changes = self._header_merge(changes, rewrite["headers"])
                    remove = rewrite["removeHeaders"]
                    changes = {k: v for k, v in changes.items() if k.lower() not in remove or k in rewrite["headers"]}
                if changes or remove:
                    continuation["headers"] = self._merged_headers(request.get("headers", {}), changes, remove)
                self._call("Fetch.continueResponse" if response else "Fetch.continueRequest", continuation, session_id=session_id)
            elif route["action"] == "abort":
                self._call("Fetch.failRequest", {"requestId": request_id,
                                                "errorReason": route.get("errorReason", "BlockedByClient")}, session_id=session_id)
            elif route["action"] == "response_transform":
                self._transform_response(params, route, session_id)
            else:
                self._call("Fetch.fulfillRequest", {"requestId": request_id, "responseCode": route["status"],
                           "responseHeaders": self._merged_headers({}, route["headers"], []),
                           "body": route["body"]}, session_id=session_id)
        except Exception as exc:
            self._error({"source": "route", "sessionId": session_id, "requestId": request_id,
                         "text": str(exc), "outcome": getattr(exc, "outcome", "failed")})
            with self._state_lock:
                self._pending_pauses.pop(key, None)
            self._terminate_pause(request_id, session_id, str(exc))
            self._disable_routes("route_command_failed")
        finally:
            with self._state_lock:
                self._pending_pauses.pop(key, None)

    def _pointer(self, pointer):
        if not isinstance(pointer, str) or not pointer.startswith("/") or re.search(r"~(?![01])", pointer):
            raise BrowserUseError("JSON pointer 必须以 / 开头且仅使用 ~0、~1 转义；不支持替换根节点", 2)
        return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]

    def _json_patch(self, value, patch):
        for remove, operations in ((False, patch.get("set", {}).items()),
                                   (True, ((p, None) for p in patch.get("remove", [])))):
            for pointer, replacement in operations:
                parts = self._pointer(pointer)
                parent = value
                for part in parts[:-1]:
                    parent = parent[self._json_key(parent, part)]
                key = self._json_key(parent, parts[-1])
                if remove:
                    if isinstance(parent, list):
                        parent.pop(key)
                    else:
                        del parent[key]
                else:
                    parent[key] = replacement
        return value

    def _json_key(self, parent, part):
        if isinstance(parent, dict):
            return part
        if isinstance(parent, list) and re.fullmatch(r"0|[1-9][0-9]*", part) and int(part) < len(parent):
            return int(part)
        raise BrowserUseError("JSON pointer 指向不存在的数组位置或非容器值", 2)

    def _transform_response(self, params, route, session_id):
        status = params.get("responseStatusCode")
        if params.get("responseErrorReason") or status is None or status in (204, 205, 304) or 300 <= status < 400 or params.get("request", {}).get("method") == "HEAD":
            raise BrowserUseError("此响应没有可改写正文或为重定向/失败响应", 5)
        original_headers = params.get("responseHeaders", [])
        headers = {h["name"].lower(): h["value"] for h in original_headers}
        content_type = headers.get("content-type", "")
        if not re.search(r"(?:^text/|json|javascript|xml)", content_type, re.I):
            raise BrowserUseError("响应正文不是支持的文本类型；不自动猜测二进制编码", 5)
        charset = re.search(r"charset\s*=\s*[\"']?([^;\s\"']+)", content_type, re.I)
        if charset and charset.group(1).lower() not in ("utf-8", "utf8", "us-ascii"):
            raise BrowserUseError("响应转换仅支持 UTF-8/ASCII 文本", 5)
        if "content-length" in headers:
            if int(headers["content-length"]) > self.max_body_bytes:
                raise BrowserUseError("原响应超过正文限额", 6)
        result = self._call("Fetch.getResponseBody", {"requestId": params["requestId"]}, session_id=session_id)
        original = base64.b64decode(result["body"], validate=True) if result.get("base64Encoded") else result["body"].encode("utf-8")
        if len(original) > self.max_body_bytes:
            raise BrowserUseError("解码后原响应超过正文限额", 6)
        text = original.decode("utf-8", errors="strict")
        transform = route["transform"]
        if "json" in transform:
            if "json" not in content_type.lower():
                raise BrowserUseError("JSON 转换要求 JSON Content-Type", 5)
            def invalid_constant(value):
                raise ValueError("JSON 包含非法常量 " + value)
            def unique_object(pairs):
                value = {}
                for key, item in pairs:
                    if key in value:
                        raise ValueError("JSON 存在重复键，拒绝丢失原始字段：" + key)
                    value[key] = item
                return value
            value = json.loads(text, parse_constant=invalid_constant, object_pairs_hook=unique_object)
            text = json.dumps(self._json_patch(value, transform["json"]), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        elif "text" in transform:
            for replacement in transform["text"]["replace"]:
                text = text.replace(replacement["from"], replacement["to"])
        output = text.encode("utf-8")
        if len(output) > self.max_body_bytes:
            raise BrowserUseError("转换后的响应超过正文限额", 6)
        response_status = transform.get("status", status)
        if response_status in (204, 205, 304) or response_status < 200:
            raise BrowserUseError("带正文的转换响应不支持该状态码", 2)
        # CDP returns decoded body. Never claim the fulfilled bytes remain gzip/chunked.
        merged = self._merged_headers(original_headers, transform["headers"], transform["removeHeaders"] +
                                     ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"])
        merged = [h for h in merged if h["name"].lower() not in {"content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"}]
        merged.append({"name": "Content-Length", "value": str(len(output))})
        fulfillment = {"requestId": params["requestId"], "responseCode": response_status,
                       "responseHeaders": merged, "body": base64.b64encode(output).decode("ascii")}
        if response_status == status and params.get("responseStatusText"):
            fulfillment["responsePhrase"] = params["responseStatusText"]
        self._call("Fetch.fulfillRequest", fulfillment, session_id=session_id)

    def _har_entry(self, record, raw, mode="text"):
        def headers(side):
            return [{"name": k, "value": v} for k, v in self._record_headers(record, side, raw).items()]
        end = record.get("endTimestamp") or record["timestamp"]
        duration = max(0, (end - record["timestamp"]) * 1000)
        response_time = record.get("responseTimestamp") or end
        wait = min(duration, max(0, (response_time - record["timestamp"]) * 1000))
        content = {"size": record.get("_responseBodySize", -1), "mimeType": record.get("mimeType", ""),
                   "_bodyAvailable": record["bodyAvailable"], "_bodyReason": record["bodyReason"]}
        textual = bool(_TEXT_MIME.search(record.get("mimeType") or ""))
        if record["bodyAvailable"] and mode == "all":
            content["text"] = record["body"]
            if record.get("base64Encoded"):
                content["encoding"] = "base64"
        elif record["bodyAvailable"] and mode == "text" and textual:
            if record.get("base64Encoded"):
                try:
                    content["text"] = base64.b64decode(record["body"]).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    content["_bodyReason"] = "text_not_utf8"
            else:
                content["text"] = record["body"]
        elif record["bodyAvailable"]:
            content["_bodyReason"] = "har_content_" + mode
        elif mode == "none":
            content["_bodyReason"] = "har_content_none" if record["bodyReason"] == "not_requested" else record["bodyReason"]
        elif mode == "text" and not textual and record["bodyReason"] == "not_requested":
            content["_bodyReason"] = "har_content_text_only"
        if "text" not in content:
            content["_bodyAvailable"] = False
        request = {"method": record["method"], "url": record["url"], "httpVersion": record.get("protocol", ""),
                   "cookies": [], "headers": headers("request"),
                   "queryString": [{"name": k, "value": v} for k, v in parse_qsl(urlsplit(record["url"]).query)],
                   "headersSize": -1, "bodySize": len((record.get("postData") or "").encode("utf-8"))}
        if record.get("postData") is not None:
            request["postData"] = {"mimeType": next((v for k, v in record["requestHeaders"].items()
                                                    if k.lower() == "content-type"), ""), "text": record["postData"]}
        return {"startedDateTime": datetime.fromtimestamp(record["wallTime"], timezone.utc).isoformat(),
                "time": duration, "request": request,
                "response": {"status": record.get("status", 0), "statusText": record.get("statusText", ""),
                             "httpVersion": record.get("protocol", ""), "cookies": [],
                             "headers": headers("response"), "content": content,
                             "redirectURL": next((v for k, v in record["responseHeaders"].items()
                                                   if k.lower() == "location"), ""),
                             "headersSize": -1, "bodySize": record.get("encodedDataLength", -1)},
                "cache": {}, "timings": {"send": 0, "wait": wait, "receive": duration - wait},
                "_requestId": record["id"], "_navigation": record.get("navigation"), "_finalHeadersKnown": (record["requestHeadersFinal"] and record["responseHeadersFinal"]
                                       and not self._correlation_lost),
                "_timingsApproximate": True,
                "_finished": record["finished"], "_failed": record["failed"]}
