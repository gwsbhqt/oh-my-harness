"""computer-use：在 Python 内核里直接调 computer-use，`await skills.computer_use.snap("计算器")`。

每个子命令对应一个异步函数，参数是普通的 Python 参数，返回的是字典、列表或字符串，
失败抛 ComputerUseError（带退出码）。本机复用常驻进程；远程经过共享启动器，遵守各机器的默认目标和 pin。
"""
from __future__ import annotations

import asyncio
import functools
import contextvars
import inspect
import math
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

_PACKAGE_SHARED = Path(__file__).resolve().parent / "_shared"
_SHARED = str(_PACKAGE_SHARED if _PACKAGE_SHARED.is_dir() else Path(__file__).resolve().parents[3] / "_shared")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

from .build import BuildError, ensure_binary

__all__ = [
    "ComputerUseError", "BuildError", "Snap", "Diff", "App", "app",
    "version", "capabilities", "perms", "wake", "apps", "screens", "open_app", "snap", "shot",
    "click", "type_text", "key", "paste", "set_value", "act", "scroll", "drag",
    "selecttext", "read", "wait", "menu", "clip", "winmove", "winsize", "webmode", "cli",
    "disconnect", "release", "ownership", "capabilities", "Element", "element", "autofill", "windows",
]

DEFAULT_TIMEOUT = 60.0
_target_host = contextvars.ContextVar("computer_use_target_host", default=None)
_task_scope = contextvars.ContextVar("computer_use_task_scope", default=None)
_task_lease = contextvars.ContextVar("computer_use_task_lease", default=None)
_window_ref = contextvars.ContextVar("computer_use_window_ref", default=None)
_observed_ownership = contextvars.ContextVar("computer_use_observed_ownership", default=None)
_PROCESS_SCOPE = "python-" + uuid.uuid4().hex
_APP_COMMANDS = {"snap", "shot", "click", "type", "key", "paste", "set", "act", "scroll", "drag",
                 "selecttext", "read", "wait", "menu", "winmove", "winsize", "webmode", "open", "owner", "quit",
                 "element", "autofill", "approve_chrome_debugging", "windows", "window-close"}


def _normalize_window(window):
    if not isinstance(window, dict):
        raise TypeError("window 需要包含 id/pid/startedAt 的字典")
    ref = {"id": _integer(window.get("id"), "window.id"), "pid": _integer(window.get("pid"), "window.pid"),
           "startedAt": _number(window.get("startedAt"), "window.startedAt", positive=True)}
    if window.get("bundleId"):
        ref["bundleId"] = _text(window["bundleId"])
    return ref


def _scope(value=None):
    value = value if value is not None else (_task_scope.get() or os.environ.get("COMPUTER_USE_CONTEXT_ID") or os.environ.get("DSH_SESSION_ID") or _PROCESS_SCOPE)
    if not isinstance(value, str) or not value or len(value.encode()) > 256 or any(c in value for c in "\n\r\0"):
        raise ValueError("scope 需要非空任务名，最多256字节且不含换行")
    return value
_LAUNCHER = Path(__file__).resolve().parents[2] / "scripts" / "computer-use"
if not _LAUNCHER.is_file():
    _LAUNCHER = Path(__file__).with_name("_launcher.py")


def _transport():
    from agentkit.remote import target
    return target


def _host(value: str | None) -> str | None:
    if value is not None and (not isinstance(value, str) or not value.strip() or value.startswith("-")):
        raise ValueError("host 需要非空机器名，不能是命令选项")
    return value


def _with_host(function):
    @functools.wraps(function)
    async def routed(*args, host=None, scope=None, window=None, **kwargs):
        token = _target_host.set(_host(host)) if host is not None else None
        scope_token = _task_scope.set(_scope(scope))
        window_token = _window_ref.set(_normalize_window(window)) if isinstance(window, dict) else None
        if window is not None and not isinstance(window, dict):
            if "window" not in inspect.signature(function).parameters:
                raise TypeError("window 需要稳定窗口字典")
            kwargs["window"] = window
        try:
            return await function(*args, **kwargs)
        finally:
            if token is not None:
                _target_host.reset(token)
            if scope_token is not None:
                _task_scope.reset(scope_token)
            if window_token is not None:
                _window_ref.reset(window_token)
    signature = inspect.signature(function)
    parameters = list(signature.parameters.values())
    index = next((i for i, p in enumerate(parameters) if p.kind == p.VAR_KEYWORD), len(parameters))
    parameters.insert(index, inspect.Parameter("host", inspect.Parameter.KEYWORD_ONLY, default=None,
                                               annotation="str | None"))
    parameters.insert(index + 1, inspect.Parameter("scope", inspect.Parameter.KEYWORD_ONLY, default=None, annotation="str | None"))
    if "window" not in signature.parameters:
        parameters.insert(index + 2, inspect.Parameter("window", inspect.Parameter.KEYWORD_ONLY, default=None))
    routed.__signature__ = signature.replace(parameters=parameters)
    return routed

#: 退出码的含义，和命令行一致。
NOT_FOUND, STALE, NO_PERMISSION, SENSITIVE = 3, 4, 5, 6

class ComputerUseError(RuntimeError):
    """computer-use 报的错。code：1 动作失败 / 2 用法错 / 3 找不到应用或元素 / 4 界面已变 / 5 缺权限 / 6 敏感应用拒绝操作。"""

    def __init__(self, message: str, code: int | None, command: str, *, data: dict | None = None, host: str | None = None, outcome: str | None = None):
        super().__init__(message)
        self.code = code
        self.command = command
        self.data = data or {}
        self.host = host
        self.outcome = outcome


_binary: Path | None = None
_source_stamp: tuple[int, int] | None = None


async def _program() -> Path:
    """编好的程序路径。源码的修改时间或大小变了就重新找（必要时重编），内核不用重启就能用上新版本。"""
    global _binary, _source_stamp
    from .build import SOURCE
    stat = SOURCE.stat()
    stamp = (stat.st_mtime_ns, stat.st_size)
    if _binary is None or stamp != _source_stamp or not _binary.exists():
        _binary = await asyncio.to_thread(ensure_binary)
        _source_stamp = stamp
    return _binary


def _text(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"需要字符串，拿到的是 {type(value).__name__}")
    if "\x00" in value:
        raise ValueError("文本不能含 NUL 字符")
    return value


def _integer(value: Any, name: str, minimum: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} 需要整数")
    if value < minimum:
        raise ValueError(f"{name} 不能小于 {minimum}")
    return value


def _number(value: Any, name: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} 需要数字")
    if not math.isfinite(value) or (positive and value <= 0):
        raise ValueError(f"{name} 需要有限{'正' if positive else ''}数")
    return value


def _point(point: Iterable[float]) -> str:
    if isinstance(point, (str, bytes)):
        raise TypeError("坐标需要两个数字")
    x, y = point
    return f"{int(_number(x, 'x'))},{int(_number(y, 'y'))}"


class _Server:
    """一个常驻的 `computer-use serve` 进程。所有调用排队走它，省掉每条命令起进程和连系统服务的时间
    超时或崩溃会停止进程，不重放本次请求；下一次显式调用才重开。"""

    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.binary: Path | None = None
        self.lock = asyncio.Lock()
        self.next_id = 0
        self.loop: asyncio.AbstractEventLoop | None = None
        self.last_used = 0.0

    async def _start(self, binary: Path) -> None:
        env = os.environ.copy()
        env["COMPUTER_USE_SERVE_IDLE"] = str(_SERVE_IDLE)
        self.proc = await asyncio.create_subprocess_exec(
            str(binary), "serve", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env=env, limit=1 << 26)
        self.binary = binary
        self.loop = asyncio.get_running_loop()

    async def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 35)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()

    async def call(self, args: list[str], timeout: float | None) -> tuple[int | None, dict | None, list[str]]:
        binary = await _program()
        async with self.lock:
            # 换了新编译的程序、换了事件循环（内核重启）、进程已经没了，或者空闲到它可能正在自己退出，都重开。
            # 最后一条按比进程那边短 30 秒算，请求就不会发给一个正要退出的进程。
            idle = time.monotonic() - self.last_used
            if (self.proc is None or self.proc.returncode is not None or self.binary != binary
                    or self.loop is not asyncio.get_running_loop()
                    or (_SERVE_IDLE > 0 and idle > _SERVE_IDLE - 30)):
                await self.stop()
                await self._start(binary)
            self.next_id += 1
            request = {"id": self.next_id, "args": args}
            assert self.proc is not None and self.proc.stdin is not None and self.proc.stdout is not None
            try:
                self.proc.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode())
                await self.proc.stdin.drain()
                line = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
            except asyncio.TimeoutError:
                await self.stop()
                raise
            except asyncio.CancelledError:
                await self.stop()
                raise
            except (BrokenPipeError, ConnectionResetError):
                await self.stop()
                return None, None, []
            if not line:
                await self.stop()
                return None, None, []
            self.last_used = time.monotonic()
            reply = json.loads(line)
            return reply.get("code"), reply.get("result"), reply.get("warnings") or []


_server = _Server()
#: 设 COMPUTER_USE_NO_SERVE=1 就每条命令单独起一个进程（排查常驻模式本身的问题时用）。
_USE_SERVE = os.environ.get("COMPUTER_USE_NO_SERVE") != "1"
#: 常驻进程空闲多少秒后自己退出；下一次调用自动重开。0 表示不退出。
_SERVE_IDLE = max(0.0, float(os.environ.get("COMPUTER_USE_SERVE_IDLE") or 600))


async def _one_shot(args: list[str], timeout: float | None, *, host: str | None = None) -> tuple[int | None, dict | None, list[str]]:
    args = list(args)
    args.insert(args.index("--") if "--" in args else len(args), "--json")
    argv = ([str(_LAUNCHER), "-H", host, *args] if host is not None
            else [str(await _program()), *args])
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=os.environ.copy())
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), 35 if host is None else 3)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        raise
    warnings = [line.removeprefix("computer-use: ") for line in err.decode(errors="replace").splitlines() if line.strip()]
    try:
        data = json.loads(out.decode(errors="replace").strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        data = {"ok": False, "error": "; ".join(warnings) or f"退出码 {proc.returncode}，没有输出"}
    return proc.returncode, data, warnings


async def cli(*args: Any, timeout: float | None = DEFAULT_TIMEOUT, host: str | None = None, scope: str | None = None, lease: str | None = None) -> dict:
    """直接跑一条 computer-use 子命令，返回解析后的字典。其他函数都走这里。默认复用常驻进程。"""
    if timeout is not None:
        _number(timeout, "timeout", positive=True)
    argv = [str(a) for a in args]
    for a in argv:
        if not a.startswith("-"):
            break
        if a in {"-H", "--host", "--local"} or a.startswith("--host=") or a.startswith("-H"):
            raise ValueError("Python 调用请用 host= 指定机器，不在命令前传主机选项")
    command = argv[0] if argv else ""
    if command in _APP_COMMANDS:
        boundary = argv.index("--") if "--" in argv else len(argv)
        if any(arg in {"--scope", "--lease"} for arg in argv[:boundary]):
            raise ValueError("Python scope/lease 请用命名参数，不混入原生命令参数")
        scope_value = _scope(scope)
        lease_value = lease if lease is not None else _task_lease.get()
        boundary = argv.index("--") if "--" in argv else len(argv)
        ref = _window_ref.get()
        argv[boundary:boundary] = ["--scope", scope_value] + (["--lease", lease_value] if lease_value is not None else []) + (["--window-ref", json.dumps(ref)] if ref is not None else [])
    try:
        code, data, warnings = (None, None, [])
        try:
            selected = _transport().resolve_target("computer-use", host=_host(host) if host is not None else _target_host.get())
        except ValueError as exc:
            raise ComputerUseError(str(exc), 2, command) from exc
        if selected == "local":
            if command in {"version", "capabilities", "--capabilities", "element", "target-close", "release", "disconnect"}:
                code, data, warnings = await _one_shot(argv, timeout, host="local")
            elif _USE_SERVE:
                code, data, warnings = await _server.call(argv, timeout)
            if data is None:
                if _USE_SERVE:
                    raise ComputerUseError("常驻进程中断，执行结果未知，未自动重试；先取态确认", None, command, host=selected, outcome="unknown")
                code, data, warnings = await _one_shot(argv, timeout)
        else:
            code, data, warnings = await _one_shot(argv, timeout, host=selected)
    except asyncio.TimeoutError:
        raise ComputerUseError(f"computer-use {command} 超过 {timeout} 秒没返回；已停止本机等待进程，但目标动作结果未知，远端进程可能继续。未自动重试，先 snap 核对",
                            None, command, host=selected, outcome="unknown") from None
    if not data or not data.get("ok"):
        message = (data or {}).get("error") or "; ".join(warnings) or "未知错误"
        raise ComputerUseError(message, (data or {}).get("code", code), command, data=data, host=selected, outcome=(data or {}).get("outcome"))
    data = dict(data)
    data.pop("ok", None)
    if data.get("ownership"):
        _observed_ownership.set(data["ownership"])
    if warnings:
        data["warnings"] = warnings
    return data


async def windows(app: str):
    """发现原生窗口；返回可传给 app(window=...) 的稳定引用，不激活窗口。"""
    return await cli("windows", _text(app))


async def ownership(app: str, action="status", *, lease=None, to=None, expected_owner=None, authorized=False):
    """查询、取得、释放或交接应用归属，不关闭用户窗口。"""
    if action not in {"status", "claim", "release", "handoff", "recover"}:
        raise ValueError("未知应用归属动作")
    return await cli("owner", _text(app), action, *(["--to", _scope(to)] if to is not None else []),
                     *(["--expected-owner", _scope(expected_owner)] if expected_owner is not None else []),
                     *(["--authorized"] if authorized is True else []), lease=lease)


async def disconnect() -> dict:
    """只断开本进程执行连接，不退出应用或关闭窗口。"""
    await _server.stop()
    return {"disconnected": True, "targets_closed": False}


async def release() -> dict:
    """不批量释放任务归属；持有者显式调用 App.release，不关闭用户目标。"""
    return {"released": [], "targets_closed": False, "reason": "应用归属须由持有者逐个 App.release；不批量释放"}



def _row(element: dict) -> str:
    parts = [f"{element['idx']:>3}", element.get("role", "").removeprefix("AX"), element.get("label") or "·"]
    if element.get("axid") and element.get("axid") != element.get("label"):
        parts.append("#" + element["axid"])
    if element.get("value"):
        parts.append(f"= {element['value']!r}")
    if element.get("state"):
        parts.append(f"[{element['state']}]")
    if not element.get("enabled", True):
        parts.append("(禁用)")
    return " ".join(parts)


def _role(value: str) -> str:
    return value.removeprefix("AX").lower()


class Snap:
    """一次取态。repr 只给摘要；元素在 .elements，用 find / one 按条件挑。"""

    def __init__(self, data: dict):
        self.data = data
        self.app: dict = data.get("app", {})
        self.window: dict = data.get("window", {})
        self.elements: list[dict] = data.get("elements", [])
        self.shot: str | None = data.get("shot")
        self.snapshot: str | None = data.get("snapshot")
        self.screenshot: dict = data.get("screenshot", {})
        self.remote_path: str | None = data.get("remotePath")
        self.host_context: dict = data.get("hostContext", {})
        self.truncated: bool = data.get("truncated", False)
        self.timed_out: bool = data.get("timedOut", False)
        self.warnings: list[str] = data.get("warnings", [])

    def find(self, label: str | None = None, *, role: str | None = None, id: str | None = None,
             contains: str | None = None, action: str | None = None) -> list[dict]:
        """按条件筛元素。label 精确匹配，contains 子串匹配，role 可写 "AXButton" 或 "button"。"""
        hits = []
        for element in self.elements:
            if label is not None and element.get("label") != label:
                continue
            if contains is not None and contains not in element.get("label", "") and contains not in element.get("value", ""):
                continue
            if role is not None and _role(element.get("role", "")) != _role(role):
                continue
            if id is not None and element.get("axid") != id:
                continue
            if action is not None and action.removeprefix("AX") not in element.get("actions", []):
                continue
            hits.append(element)
        return hits

    def one(self, label: str | None = None, **conditions: Any) -> dict:
        """恰好一个匹配时返回它；零个或多个都抛 LookupError，免得点错。"""
        if self.truncated or self.timed_out:
            raise LookupError("取态不完整，不能确认唯一匹配；增大 depth/max 或缩小读取范围")
        hits = self.find(label, **conditions)
        if len(hits) != 1:
            shown = ", ".join(f"#{h['idx']} {h.get('role')} {h.get('label')!r}" for h in hits[:5])
            raise LookupError(f"条件 {dict(label=label, **conditions)} 匹配到 {len(hits)} 个元素" + (f"：{shown}" if hits else ""))
        return hits[0]

    def table(self, limit: int | None = 60) -> str:
        """元素清单的紧凑文本：编号、角色、标签、#ID、当前值、状态。"""
        rows = []
        for element in self.elements[:limit]:
            rows.append(_row(element))
        if limit is not None and len(self.elements) > limit:
            rows.append(f"… 还有 {len(self.elements) - limit} 个，table(limit=None) 看全部")
        return "\n".join(rows)

    def tree(self, limit: int | None = 200, *, keep_empty: bool = False) -> str:
        """按层级缩进的元素树：看得出哪个按钮属于哪块区域（按父子关系排）。
        没有名字、没有值、不能操作的空分组默认折叠掉，它的子元素上提一层；keep_empty=True 保留。"""
        def empty(e: dict) -> bool:
            return (e.get("role") in ("AXGroup", "AXSplitGroup", "AXLayoutArea", "AXUnknown")
                    and not e.get("label") and not e.get("value") and not e.get("axid")
                    and not set(e.get("actions", [])) - {"ShowMenu", "ScrollToVisible"})
        shown = [e for e in self.elements if keep_empty or not empty(e)]
        level: dict[int, int] = {}
        by_idx = {e["idx"]: e for e in self.elements}
        rows = []
        for element in shown[:limit]:
            parent = element.get("parent")
            while parent is not None and parent not in level:
                parent = by_idx.get(parent, {}).get("parent")
            level[element["idx"]] = level[parent] + 1 if parent is not None else 0
            rows.append("  " * level[element["idx"]] + _row(element))
        if limit is not None and len(shown) > limit:
            rows.append(f"… 还有 {len(shown) - limit} 个，tree(limit=None) 看全部")
        return "\n".join(rows)


    def children(self, idx: int) -> list[dict]:
        """某个元素下面直接列出来的子元素。"""
        return [e for e in self.elements if e.get("parent") == idx]


    def __len__(self) -> int:
        return len(self.elements)

    def __iter__(self):
        return iter(self.elements)

    def __repr__(self) -> str:
        flags = [f for f, on in (("已截断", self.truncated), ("遍历超时", self.timed_out)) if on]
        tail = f"，截图 {self.shot}" if self.shot else ""
        return (f"<snap {self.app.get('name', '?')} 窗口 {self.window.get('title', '')!r}："
                f"{len(self.elements)} 个元素{('，' + '、'.join(flags)) if flags else ''}{tail}>")


class Diff:
    """与上次取态的差异。changed 为 False 表示界面没变。"""

    def __init__(self, data: dict):
        self.data = data
        self.snapshot: str | None = data.get("snapshot")
        self.changed: bool = data.get("changed", False)
        self.truncated: bool = data.get("truncated", False)
        self.timed_out: bool = data.get("timedOut", False)
        self.added: list[dict] = data.get("added", [])
        self.removed: list[dict] = data.get("removed", [])

    def __bool__(self) -> bool:
        return self.changed

    def __repr__(self) -> str:
        if self.truncated or self.timed_out:
            return f"<diff 取态不完整：新增 {len(self.added)} / 消失 {len(self.removed)}>"
        if not self.changed:
            return "<diff 无变化>"
        return f"<diff 新增 {len(self.added)} / 消失 {len(self.removed)}>"


def probe(version_value="0.2.0") -> dict:
    implemented = (
        "apps", "perms", "wake", "screens", "open_app", "snap", "shot", "click", "type_text", "key", "paste",
        "set_value", "act", "scroll", "drag", "selecttext", "read", "wait", "menu", "clip",
        "winmove", "winsize", "webmode", "autofill", "approve_chrome_debugging", "element", "disconnect", "release", "ownership", "windows",
    )
    supported = {k: {"supported": True, "mode": "direct", "reason": "原生 AX/定向事件"}
                 for k in implemented}
    supported["target.close"] = {"supported": True, "mode": "direct", "reason": "绑定窗口仅关闭该窗口；共享浏览器拒绝整应用退出；其他应用正常退出并核对进程结束"}
    supported.update({k: {"supported": False, "mode": "unsupported", "reason": "原生 AX 没有可靠后台实现"}
                      for k in ("css", "raw", "network", "lane")})
    return {"tool": "computer-use", "protocol": 1, "version": version_value,
            "features": ["local-routing", "snapshot-token", "snapshot-status", "safe-text-separator", "element-handle", "task-ownership", "system-wake", "stable-window-ref", "browser-window-lock", "short-desktop-input-lock"],
            "capabilities": supported}


async def version() -> dict:
    """结构化版本及能力；不再返回版本字符串。"""
    return probe((await cli("--version"))["version"])


async def capabilities() -> dict:
    return await version()


async def perms(*, request: bool = False) -> dict:
    """检查三项系统权限；request=True 申请授权，用户亲手确认。"""
    if not isinstance(request, bool):
        raise TypeError("request 需要布尔值")
    return await cli("perms", *(["--request"] if request else []))


async def wake(*, hold: float = 3.0, input: str = "none") -> dict:
    """正常唤醒显示器并核对桌面状态；仍锁在登录窗口时可选发一个非文本按键，不输密码。"""
    if isinstance(hold, bool) or not isinstance(hold, (int, float)) or not math.isfinite(hold):
        raise TypeError("hold 需要数字")
    if not 0.3 <= float(hold) <= 30:
        raise ValueError("hold 需要在 0.3 到 30 秒之间")
    if input not in {"none", "space", "return", "escape"}:
        raise ValueError("input 支持 none/space/return/escape")
    args: list[Any] = ["wake", "--hold", f"{float(hold):g}"]
    if input != "none":
        args += ["--input", input]
    return await cli(*args, timeout=40)


async def apps(all: bool = False) -> list[dict]:
    """运行中的应用；all=True 连 Dock、控制中心这类系统界面进程也列出来。"""
    return (await cli("apps", *(["--all"] if all else [])))["apps"]


async def screens() -> list[dict]:
    """显示器列表。多屏时坐标是全局的。"""
    return (await cli("screens"))["screens"]


async def open_app(name: str, *, front: bool = False, lease: str | None = None) -> dict:
    """启动应用（名称或 .app 路径，不是 bundle id），默认后台；lease 传当前持有凭证，满足释放后重新打开同一任务应用的归属要求。"""
    if lease is not None and (not isinstance(lease, str) or not lease):
        raise ValueError("lease 需要非空字符串")
    return await cli("open", _text(name), *(["--front"] if front else []), timeout=30, lease=lease)


async def snap(app: str, *, shot: bool = False, diff: bool = False, all: bool = False, max: int = 120,
               depth: int = 25, window: int | None = None, out: str | None = None, shrink: int = 1400,
               webmode: bool = True) -> Snap | Diff:
    """取态。默认只要元素清单不截图；diff=True 返回与上次取态的差异（Diff）。

    浏览器和 Electron 应用第一次读时会自动打开网页辅助功能（约 2 秒），webmode=False 关掉。
    应用没在运行时会在后台启动它。
    """
    args: list[Any] = ["snap", _text(app), "--max", _integer(max, "max"), "--depth", _integer(depth, "depth"),
                       "--shrink", _integer(shrink, "shrink", 0)]
    if not webmode:
        args.append("--no-webmode")
    if shot:
        args.append("--shot")
    if diff:
        args.append("--diff")
    if all:
        args.append("--all")
    if window is not None:
        args += ["--window", _integer(window, "window")]
    if out is not None:
        args += ["--out", _text(out)]
    data = await cli(*args)
    return Diff(data) if data.get("mode") == "diff" else Snap(data)


async def shot(app: str, *, out: str | None = None, shrink: int = 1400) -> str:
    """只截图，返回图片路径。"""
    args: list[Any] = ["shot", _text(app), "--shrink", _integer(shrink, "shrink", 0)]
    if out is not None:
        args += ["--out", _text(out)]
    return (await cli(*args))["path"]


async def click(app: str, idx: int | None = None, *, id: str | None = None, label: str | None = None,
                at: Iterable[float] | None = None, count: int = 1, button: str = "left", coord: bool = False, snapshot: str | None = None) -> dict:
    """点击。idx / id / label / at 四选一：id 最稳，label 次之，idx 只在刚 snap 完用，at 是屏幕坐标。

    全部后台执行，不动真鼠标、不抢前台：button="right" 弹出右键菜单，count=2 双击。
    coord=True 才会真的移动鼠标去点（拖放、悬停菜单这类必须真鼠标的场景）。
    """
    chosen = [name for name, value in (("idx", idx), ("id", id), ("label", label), ("at", at)) if value is not None]
    if len(chosen) != 1:
        raise TypeError("click 需要且只需要 idx / id / label / at 其中一个")
    _integer(count, "count")
    if button not in {"left", "right"}:
        raise ValueError("button 只能是 left / right")
    args: list[Any] = ["click", _text(app)]
    if idx is not None:
        args.append(_integer(idx, "idx"))
    elif id is not None:
        args += ["--id", _text(id)]
    elif label is not None:
        args += ["--label", _text(label)]
    else:
        args += ["--at", _point(at)]
    if count != 1:
        args += ["--count", count]
    if button != "left":
        args += ["--button", button]
    if coord:
        args.append("--coord")
    return await cli(*args, *_snapshot_args(snapshot))


async def type_text(app: str, text: str, *, allow_newline: bool = False) -> dict:
    """逐字键盘输入。文本含换行默认拒绝（聊天框里等于发送）；多行文本用 paste。"""
    return await cli("type", _text(app), *(["--allow-newline"] if allow_newline else []), "--", _text(text))


async def key(app: str, keys: str, *, system: bool = False) -> dict:
    """按键或组合键：Return / Tab / cmd+c / shift+Left。system=True 时向当前前台应用发真实系统热键。"""
    if not isinstance(system, bool):
        raise TypeError("system 需要布尔值")
    return await cli("key", _text(app), *(["--system"] if system else []), "--", _text(keys))


async def paste(app: str, text: str, *, settle: int = 400) -> dict:
    """走剪贴板粘贴，完成后还原原剪贴板。慢应用把 settle（毫秒）调大，粘完用 read 核对。"""
    return await cli("paste", _text(app), "--settle", _integer(settle, "settle", 0), "--", _text(text))


async def set_value(app: str, idx: int, value: str, *, snapshot: str | None = None) -> dict:
    """直接给可写元素赋值（后台、不走键盘）。"""
    return await cli("set", _text(app), _integer(idx, "idx"), *_snapshot_args(snapshot), "--", _text(value))


async def act(app: str, idx: int, action: str, *, snapshot: str | None = None) -> dict:
    """执行元素暴露的动作，如 Press / ShowMenu / Increment / ScrollToVisible。"""
    return await cli("act", _text(app), _integer(idx, "idx"), *_snapshot_args(snapshot), "--", _text(action))


async def scroll(app: str, idx: int, direction: str = "down", *, pages: float = 1, snapshot: str | None = None) -> dict:
    """在元素上滚动。direction：up / down / left / right。"""
    if direction not in {"up", "down", "left", "right"}:
        raise ValueError("direction 只能是 up / down / left / right")
    return await cli("scroll", _text(app), _integer(idx, "idx"), direction, "--pages", _number(pages, "pages", positive=True), *_snapshot_args(snapshot))


async def drag(app: str, start: Iterable[float], end: Iterable[float], *, coord: bool = False) -> dict:
    """默认后台拖拽，投递不可用时报错；coord=True 才使用经过命中校验的真实鼠标。"""
    return await cli("drag", _text(app), _point(start), _point(end), *(["--coord"] if coord else []))


async def selecttext(app: str, idx: int, text: str, *, snapshot: str | None = None) -> dict:
    """在文本元素里选中一段文字。"""
    return await cli("selecttext", _text(app), _integer(idx, "idx"), *_snapshot_args(snapshot), "--", _text(text))


async def read(app: str, idx: int, *, selected: bool = False, snapshot: str | None = None) -> str:
    """读元素全文（snap 里的标签最多 80 字）；selected=True 只读选中的部分。"""
    return (await cli("read", _text(app), _integer(idx, "idx"), *(["--selected"] if selected else []), *_snapshot_args(snapshot)))["text"]


async def wait(app: str, label: str, *, gone: bool = False, timeout: float = 10) -> dict:
    """等某段文字出现（gone=True 等它消失）。超时抛 ComputerUseError，code 为 4。"""
    return await cli("wait", _text(app), "--label", _text(label), "--timeout", _number(timeout, "timeout", positive=True),
                     *(["--gone"] if gone else []), timeout=timeout + 15)


async def menu(app: str, menu: str | None = None, item: str | None = None) -> list | dict:
    """菜单栏：不给 menu 列顶层菜单名；给 menu 列它的菜单项；再给 item 就点它。"""
    if item is not None and menu is None:
        raise TypeError("点菜单项要同时给 menu")
    args: list[Any] = ["menu", _text(app), "--"] + [_text(v) for v in (menu, item) if v is not None]
    data = await cli(*args)
    if data.get("level") == "bar":
        return data["menus"]
    if data.get("level") == "items":
        return data["items"]
    return data


async def clip(text: str | None = None) -> str | dict:
    """不给参数读剪贴板文字；给参数写入剪贴板。"""
    if text is None:
        return (await cli("clip"))["text"]
    return await cli("clip", "--", _text(text))


async def webmode(app: str, *, off: bool = False, timeout: float = 4) -> dict:
    """让 Chrome/Electron 把网页内容暴露给辅助功能（默认只暴露浏览器外壳）。webContent 为真表示已经读得到。"""
    return await cli("webmode", _text(app), "--timeout", _number(timeout, "timeout", positive=True), *(["--off"] if off else []), timeout=timeout + 15)


async def winmove(app: str, x: float, y: float, *, window: int | None = None) -> dict:
    """把窗口移到屏幕坐标 (x, y)，后台生效。"""
    return await cli("winmove", _text(app), _point((x, y)), *(["--window", _integer(window, "window")] if window is not None else []))


async def winsize(app: str, width: float, height: float, *, window: int | None = None) -> dict:
    """调整窗口大小，后台生效。"""
    return await cli("winsize", _text(app), _point((width, height)), *(["--window", _integer(window, "window")] if window is not None else []))


def _autofill_choices(elements: list[dict]) -> list[dict]:
    """取 1Password 浮层（名为 1Password 的网页区域）里形如「网站 — 账号」的填充按钮。"""
    choices: list[dict] = []
    for index, area in enumerate(elements):
        if _role(area.get("role", "")) != _role("AXWebArea") or area.get("label") != "1Password":
            continue
        for element in elements[index + 1:]:
            if element.get("depth", 0) <= area.get("depth", 0):
                break
            if _role(element.get("role", "")) == _role("AXButton") and " — " in element.get("label", ""):
                choices.append(element)
    return choices


async def autofill(app: str, *, account: str | None = None, timeout: float = 5) -> dict:
    """点 1Password 浮层里的填充按钮。先让网页的账号框获得焦点（browser-use click），浮层出现后调用。

    浮层里只有一个账号就点它；有多个时必须给 account（按钮文字里要包含它），否则报错 2 并列出候选。
    点了以后 1Password 通常会顺带提交登录。只点按钮，不读密码。
    """
    if _window_ref.get() is None:
        raise ComputerUseError("密码浮层需要明确任务窗口；请传 window=稳定引用", 4, "autofill", outcome="not_sent")
    deadline = asyncio.get_running_loop().time() + _number(timeout, "timeout", positive=True)
    while True:
        data = await cli("snap", _text(app), "--max", 800)
        if data.get("truncated") or data.get("timedOut") or not data.get("snapshot"):
            raise ComputerUseError("1Password 浮层取态不完整或缺凭证，不能确认唯一账号", 4, "autofill", outcome="not_sent")
        choices = _autofill_choices(data.get("elements", []))
        if choices or asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(0.3)
    if not choices:
        raise ComputerUseError("没有看到 1Password 的填充浮层；先用 browser-use 点一下账号输入框，并确认 1Password 已解锁", 3, "autofill")
    if account is not None:
        choices = [c for c in choices if _text(account) in c["label"]]
    labels = [c["label"] for c in choices]
    if len(choices) != 1:
        raise ComputerUseError(("1Password 里有多个账号，用 account 指定一个" if choices else "1Password 浮层里没有匹配的账号"), 2 if choices else 3,
                      "autofill", data={"accounts": labels})
    ref = _window_ref.get()
    if ref is None:
        try:
            ref = _normalize_window(data.get("window"))
        except (TypeError, ValueError) as exc:
            raise ComputerUseError("填充需要稳定任务窗口引用", 4, "autofill", outcome="not_sent") from exc
    token = _window_ref.set(ref)
    try:
        await cli("click", _text(app), choices[0]["idx"], "--snapshot", data["snapshot"], "--require-focus")
    finally:
        _window_ref.reset(token)
    return {"clicked": labels[0], "app": app}


_ALLOW_LABELS = {"允许", "Allow", "允许远程调试", "Allow remote debugging"}


def _allow_buttons(elements):
    return [element for element in elements
            if _role(element.get("role", "")) == _role("AXButton") and element.get("label", "") in _ALLOW_LABELS]


def _debugging_prompt(elements):
    """有远程调试字样且有「允许」按钮才算确认框：浏览器自己的 inspect 设置页也写着 Remote debugging，但没有这个按钮。"""
    return bool(_allow_buttons(elements)) and any(
        "远程调试" in element.get("label", "") or "remote debugging" in element.get("label", "").lower() for element in elements)


async def approve_chrome_debugging(app_name="Google Chrome", *, watch=30, on_ready=None):
    """只观察授权框，确认同一原生窗口且仍在前台后短保护点击；不激活或恢复桌面。

    弹框消失只表示原生确认完成，连接结果由 browser-use 独立核对。
    """
    deadline = asyncio.get_running_loop().time() + _number(watch, "watch")
    if on_ready is not None:
        on_ready()
    while True:
        data = await cli("snap", _text(app_name), "--max", 800, "--no-webmode")
        elements = data.get("elements", [])
        if _debugging_prompt(elements):
            if data.get("truncated") or data.get("timedOut") or not data.get("snapshot"):
                raise ComputerUseError("远程调试授权窗口取态不完整", 4, "approve_debugging", outcome="not_sent")
            ref = _normalize_window(data.get("window"))
            choices = _allow_buttons(elements)
            if len(choices) != 1:
                raise ComputerUseError("远程调试授权按钮不唯一", 4, "approve_debugging", outcome="not_sent")
            token = _window_ref.set(ref)
            try:
                checked = await cli("snap", _text(app_name), "--max", 800, "--no-webmode")
                buttons = _allow_buttons(checked.get("elements", []))
                if checked.get("truncated") or checked.get("timedOut") or not checked.get("snapshot") or not _debugging_prompt(checked.get("elements", [])) or len(buttons) != 1:
                    raise ComputerUseError("授权框已变化，未点击", 4, "approve_debugging", outcome="not_sent")
                await cli("click", _text(app_name), buttons[0]["idx"], "--snapshot", checked["snapshot"], "--require-focus", "--no-settle")
            finally:
                _window_ref.reset(token)
            verify_deadline = asyncio.get_running_loop().time() + 3
            while True:
                current = await windows(app_name)
                if not any(all(w.get(k) == ref[k] for k in ("id", "pid", "startedAt")) for w in current["windows"]):
                    return {"approved": True, "clicked": buttons[0]["label"], "count": 1, "app": app_name, "connectionVerified": False}
                if asyncio.get_running_loop().time() >= verify_deadline:
                    raise ComputerUseError("已点击允许但原窗口仍在；结果未知", 4, "approve_debugging", outcome="unknown")
                await asyncio.sleep(.1)
        if asyncio.get_running_loop().time() >= deadline:
            return {"approved": False, "reason": "no_prompt"}
        await asyncio.sleep(.2)


def _snapshot_args(token: str | None) -> list[str]:
    return ["--snapshot", _text(token)] if token is not None else []


from .elements import Element


def element(target, **selector):
    return Element(target if isinstance(target, App) else app(target), selector)


class App:
    """绑定一个应用，省得每次都写应用名：`calc = computer_use.app("计算器"); await calc.click(id="Seven")`。"""

    def __init__(self, name: str, *, host: str | None = None, scope: str | None = None, window: dict | None = None):
        self.name = _text(name)
        self._window = _normalize_window(window) if window is not None else None
        self.app_key: str | None = None
        self.snapshot: str | None = None
        self.scope = _scope(scope)
        self.lease: str | None = None
        self._released = False
        self._lock = asyncio.Lock()
        try:
            self.host = _transport().resolve_target("computer-use", host=_host(host))
        except ValueError as exc:
            raise ComputerUseError(str(exc), 2, "app") from exc

    @property
    def window(self):
        return dict(self._window) if self._window is not None else None

    def element(self, **selector):
        return Element(self, selector)

    async def disconnect(self):
        return {"disconnected": True, "targets_closed": False, "reason": "App 本身不持有独立连接"}

    def _remember_app(self, data):
        identity = data.get("app")
        key = data.get("appKey") or (identity.get("bundleId") if isinstance(identity, dict) else None)
        if key:
            self.app_key = key

    async def owner(self):
        result = await ownership(self.app_key or self.name, "status", host=self.host, scope=self.scope)
        self._remember_app(result)
        return result

    async def claim(self):
        async with self._lock:
            result = await ownership(self.name, "claim", host=self.host, scope=self.scope)
            self._remember_app(result)
            self.lease = result["ownership"]["lease"]
            self.snapshot = None
            self._released = False
            return result

    async def release(self):
        async with self._lock:
            if self.window is not None and self.lease is None:
                self._released = True
                self.snapshot = None
                return {"released": True, "targets_closed": False, "mode": "window", "window": dict(self.window)}
            if self.lease is None:
                raise ComputerUseError("App 尚未持有应用，不能释放", 4, "owner", outcome="not_sent")
            result = await ownership(self.app_key or self.name, "release", host=self.host, scope=self.scope, lease=self.lease)
            self._released = True
            self.snapshot = None
            return result

    async def handoff(self, to):
        async with self._lock:
            if self.lease is None:
                raise ComputerUseError("App 尚未持有应用，不能交接", 4, "owner", outcome="not_sent")
            result = await ownership(self.name, "handoff", host=self.host, scope=self.scope, lease=self.lease, to=to)
            self._released = True
            self.snapshot = None
            return result

    async def recover(self, *, expected_owner, lease, authorized=False):
        async with self._lock:
            result = await ownership(self.name, "recover", host=self.host, scope=self.scope, lease=lease,
                                     expected_owner=expected_owner, authorized=authorized)
            self.lease = result["ownership"]["lease"]
            self.snapshot = None
            self._released = False
            return result

    async def close(self, *, authorized=False, timeout=10):
        """绑定窗口只关该窗；共享浏览器拒绝整应用退出；不强杀。"""
        if authorized is not True:
            raise ComputerUseError("关闭目标需要明确授权", 6, "target.close", host=self.host)
        wait = _number(timeout, "timeout", positive=True)
        token = _window_ref.set(self.window)
        try:
            result = await cli("window-close" if self.window else "quit", self.name, "--authorized", "--timeout", wait,
                               host=self.host, scope=self.scope, lease=self.lease)
        finally:
            _window_ref.reset(token)
        self.snapshot = None
        self._remember_app(result)
        if result.get("ownership", {}).get("owner") == self.scope:
            self.lease = result["ownership"]["lease"]
        return result

    def __repr__(self) -> str:
        return f"<computer_use.App {self.name!r} host={self.host!r}>"


def _bind(function):
    @functools.wraps(function)
    async def method(self, *args, **kwargs):
        if "host" in kwargs and self.host is not None and kwargs["host"] != self.host:
            raise ValueError("已绑定机器的 App 不能临时换机器；请另建 App")
        if "scope" in kwargs and kwargs["scope"] != self.scope:
            raise ValueError("已绑定 App 不能临时换任务；请另建 App")
        if "window" in kwargs and self.window is not None:
            if not isinstance(kwargs["window"], dict) or _normalize_window(kwargs["window"]) != self.window:
                raise ValueError("已绑定 App 不能临时换窗口")
        if self.window is not None:
            kwargs["window"] = dict(self.window)
        kwargs.setdefault("host", self.host)
        kwargs.setdefault("scope", self.scope)
        async with self._lock:
            if self._released:
                raise ComputerUseError("App 已释放或交接；窗口模式须新建绑定，应用模式须显式 claim", 4, function.__name__, outcome="not_sent")
            numbered = function.__name__ in {"set_value", "act", "scroll", "selecttext", "read"} or (function.__name__ == "click" and (args or kwargs.get("idx") is not None))
            if numbered:
                kwargs.setdefault("snapshot", self.snapshot)
                if kwargs["snapshot"] is None:
                    raise ComputerUseError("App 编号动作需要先 snap 取得快照凭证", 4, function.__name__, host=self.host)
            lease_token = _task_lease.set(self.lease if self.lease is not None else _task_lease.get())
            observation_token = _observed_ownership.set(None)
            try:
                result = await function(self.name, *args, **kwargs)
            except ComputerUseError as exc:
                if exc.code == STALE or exc.outcome == "unknown":
                    self.snapshot = None
                raise
            finally:
                observed_ownership = _observed_ownership.get()
                _observed_ownership.reset(observation_token)
                _task_lease.reset(lease_token)
            if observed_ownership and observed_ownership.get("owner") == self.scope:
                self.lease = observed_ownership["lease"]
            data = result.data if isinstance(result, (Snap, Diff)) else result if isinstance(result, dict) else getattr(getattr(result, "view", None), "raw", None)
            data = getattr(data, "data", data) or {}
            self._remember_app(data)
            if data.get("ownership", {}).get("owner") == self.scope:
                self.lease = data["ownership"]["lease"]
            if isinstance(result, (Snap, Diff)):
                self.snapshot = None if result.truncated or result.timed_out else result.snapshot
                ref = data.get("window", {})
                if self.snapshot and self.window is None and all(ref.get(k) is not None for k in ("id", "pid", "startedAt")):
                    self._window = _normalize_window(ref)
            return result
    return method


def app(name: str, *, host: str | None = None, scope: str | None = None, window: dict | None = None) -> App:
    """绑定应用和创建时选定的机器；未给 host 时读取当时 computer-use 的默认目标。"""
    return App(name, host=host, scope=scope, window=window)


for _name in ("version", "capabilities", "perms", "wake", "apps", "screens", "open_app", "snap", "shot", "click",
              "type_text", "key", "paste", "set_value", "act", "scroll", "drag", "selecttext",
              "read", "wait", "menu", "clip", "winmove", "winsize", "webmode", "autofill", "approve_chrome_debugging", "ownership", "windows"):
    globals()[_name] = _with_host(globals()[_name])
for _name in ("snap", "shot", "click", "type_text", "key", "paste", "set_value", "act", "scroll",
              "drag", "selecttext", "read", "wait", "menu", "winmove", "winsize", "webmode", "autofill", "open_app", "windows"):
    setattr(App, _name, _bind(globals()[_name]))
del _name
