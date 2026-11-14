"""有界同步 CDP 连接；接收响应和投递事件分离，不重放请求。"""
from __future__ import annotations
import itertools
import json
import queue
import threading
import urllib.request
from concurrent.futures import Future, TimeoutError
from .errors import BrowserUseError


def discover(endpoint):
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/json/version", timeout=3) as response:
            data = json.load(response)
        url = data.get("webSocketDebuggerUrl")
        if not url:
            raise ValueError("没有 browser WebSocket 地址")
        return url
    except Exception as exc:
        raise BrowserUseError(f"浏览器调试端口未就绪：{endpoint}（{exc}）", 5) from exc


class CDP:
    def __init__(self, url, *, open_timeout=60):
        try:
            from websockets.sync.client import connect
        except ImportError as exc:
            raise BrowserUseError("缺少 websockets；普通命令先运行 browser-use install，DSH 内核用 await repl.install('websockets>=15,<17')", 5) from exc
        try:
            self.ws = connect(url, open_timeout=open_timeout, close_timeout=2, max_size=64 * 1024 * 1024)
        except Exception as exc:
            raise BrowserUseError(f"连不上浏览器：{exc}", 5) from exc
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._counter = itertools.count(1)
        self._pending = {}
        self._listeners = {}
        self._closed = False
        self._events = queue.Queue(maxsize=20000)
        self.event_loss = 0
        self.callback_errors = []
        self._reader = threading.Thread(target=self._receive, name="browser-use-cdp-reader", daemon=True)
        self._dispatcher = threading.Thread(target=self._dispatch, name="browser-use-cdp-events", daemon=True)
        self._reader.start()
        self._dispatcher.start()

    @property
    def closed(self):
        with self._lock:
            return self._closed

    def on(self, event, callback):
        with self._lock:
            self._listeners.setdefault(event, []).append(callback)
        def unsubscribe():
            with self._lock:
                callbacks = self._listeners.get(event, [])
                if callback in callbacks:
                    callbacks.remove(callback)
        return unsubscribe

    def call(self, method, params=None, *, session_id=None, timeout=20):
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise BrowserUseError("CDP timeout 需要正数", 2)
        with self._lock:
            if self._closed:
                raise BrowserUseError("浏览器连接已断开；未重发操作", 5, outcome="not_sent")
            number = next(self._counter)
            future = Future()
            self._pending[number] = future
        payload = {"id": number, "method": method, "params": params or {}}
        if session_id is not None:
            payload["sessionId"] = session_id
        try:
            with self._send_lock:
                self.ws.send(json.dumps(payload, ensure_ascii=False))
            result = future.result(timeout)
        except TimeoutError as exc:
            raise BrowserUseError(f"{method} 等待超时；执行结果未知，未自动重试", 4, outcome="unknown") from exc
        except BrowserUseError:
            raise
        except Exception as exc:
            self._fail(f"浏览器连接中断：{exc}")
            raise BrowserUseError(f"{method} 连接中断：{exc}；执行结果未知", 5, outcome="unknown") from exc
        finally:
            with self._lock:
                self._pending.pop(number, None)
        if "error" in result:
            error = result["error"]
            raise BrowserUseError(f"{method}：{error.get('message', error)}", 1, data={"cdp": error})
        return result.get("result", {})

    def _receive(self):
        try:
            for raw in self.ws:
                message = json.loads(raw)
                if "id" in message:
                    with self._lock:
                        pending = self._pending.get(message["id"])
                        if pending is not None and not pending.done():
                            pending.set_result(message)
                elif "method" in message:
                    try:
                        self._events.put_nowait(message)
                    except queue.Full:
                        self.event_loss += 1
        except Exception as exc:
            self._fail(f"浏览器连接中断：{exc}")
        finally:
            self._fail("浏览器连接已关闭")

    def _fail(self, message):
        with self._lock:
            self._closed = True
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(BrowserUseError(message, 5, outcome="unknown"))

    def flush_events(self, timeout=20):
        """等待先前排入的所有事件回调完成，不伪造流式记录完整性。"""
        if threading.current_thread() is self._dispatcher:
            raise BrowserUseError("不能从事件分发回调等待事件栅栏", 6)
        if self._closed:
            raise BrowserUseError("连接已关闭，无法确认事件完整性", 5, outcome="unknown")
        barrier = threading.Event()
        try:
            self._events.put({"_barrier": barrier}, timeout=timeout)
        except queue.Full as exc:
            raise BrowserUseError("事件队列已满，未能确认所有事件完成", 4, outcome="unknown") from exc
        if not barrier.wait(timeout):
            raise BrowserUseError("事件处理栅栏超时，完整性未知", 4, outcome="unknown")

    def _dispatch(self):
        while True:
            try:
                event = self._events.get(timeout=0.2)
            except queue.Empty:
                if self._closed:
                    return
                continue
            if "_barrier" in event:
                event["_barrier"].set()
                continue
            with self._lock:
                callbacks = tuple(self._listeners.get(event["method"], ())) + tuple(self._listeners.get("*", ()))
            for callback in callbacks:
                try:
                    callback(event.get("params", {}), event.get("sessionId"))
                except Exception as exc:
                    with self._lock:
                        self.callback_errors.append({"event": event["method"], "error": str(exc)})
                        del self.callback_errors[:-50]

    def close(self):
        self._fail("browser-use 已断开浏览器连接")
        self.ws.close()
        if threading.current_thread() is not self._reader:
            self._reader.join(timeout=3)
        if threading.current_thread() is not self._dispatcher:
            self._dispatcher.join(timeout=3)
