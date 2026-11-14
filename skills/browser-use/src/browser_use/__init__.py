"""browser-use：普通 Python 与技能内核共用的异步浏览器接口。"""
from __future__ import annotations

import asyncio
import functools
from pathlib import Path
import sys
import warnings

_PACKAGE_SHARED = Path(__file__).resolve().parent / "_shared"
_SHARED = str(_PACKAGE_SHARED if _PACKAGE_SHARED.is_dir() else Path(__file__).resolve().parents[3] / "_shared")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

from agentkit import deps

from . import actions
from .browsers import NAMES as BROWSER_NAMES
from .errors import BrowserUseError
from .client import DEFAULT_SESSION, get_client, validate_context, resolve_host, routing
from .contexts import session_control
from .lane import lane_params

__version__ = "2.1.0"


class LaneWarning(UserWarning):
    """泳道请求头没有按 browser-use 设的值发出去。"""


def _row(e):
    parts = [f"{e.get('idx', '?'):>3}", e.get("role", ""), str(e.get("label") or "·")]
    if e.get("id"):
        parts.append("#" + str(e["id"]))
    if e.get("value") is not None and e.get("value") != "":
        parts.append(f"= {e['value']!r}")
    if e.get("state"):
        parts.append(f"[{e['state']}]")
    if not e.get("enabled", True):
        parts.append("(禁用)")
    return " ".join(parts)


def _role(role):
    return role.removeprefix("AX").lower()


class Snap:
    def __init__(self, data):
        self.data = data
        self.elements = data.get("elements", [])
        self.snapshot = data.get("snapshot")
        self.shot = data.get("shot")
        self.screenshot = data.get("screenshot", {})
        self.truncated = data.get("truncated", False)
        self.truncation = data.get("truncation")
        self.timed_out = data.get("timedOut", False)
        self.warnings = data.get("warnings", [])
        self.page = data.get("page", {})
        self.window = data.get("window", {})
        self.remote_path = data.get("remotePath")
        self.host_context = data.get("hostContext", {})
        self.lane_warning = data.get("laneWarning")

    def find(self, label=None, *, role=None, id=None, contains=None, action=None):
        hits = []
        for e in self.elements:
            if label is not None and e.get("label") != label:
                continue
            if role is not None and _role(e.get("role", "")) != _role(role):
                continue
            if id is not None and e.get("id") != id:
                continue
            if contains is not None and contains not in str(e.get("label") or "") and contains not in str(e.get("value") or ""):
                continue
            if action is not None and action.removeprefix("AX") not in e.get("actions", []):
                continue
            hits.append(e)
        return hits

    def one(self, label=None, **conditions):
        hits = self.find(label, **conditions)
        if self.truncated or self.timed_out:
            hint = (self.truncation or {}).get("hint") or "加大 max/depth 重新 snap，或用 within 只看一个区域"
            raise LookupError(f"取态不完整（{'已截断' if self.truncated else '遍历超时'}），条件 {dict(label=label, **conditions)} 无法确认唯一；{hint}；或改用 selector 在整页 DOM 里定位")
        if len(hits) != 1:
            raise LookupError(f"条件 {dict(label=label, **conditions)} 匹配到 {len(hits)} 个元素，不能唯一定位")
        return hits[0]

    def table(self, limit=60):
        rows = [_row(e) for e in self.elements[:limit]]
        if limit is not None and len(self.elements) > limit:
            rows.append(f"… 还有 {len(self.elements) - limit} 个，table(limit=None) 看全部")
        return "\n".join(rows)

    def tree(self, limit=200, *, keep_empty=False):
        by_idx = {e["idx"]: e for e in self.elements}
        def empty(e):
            return e.get("role") in ("group", "generic", "none", "presentation") and not any(e.get(k) for k in ("label", "value", "id", "actions"))
        shown = [e for e in self.elements if keep_empty or not empty(e)]
        levels, rows = {}, []
        for e in shown[:limit]:
            parent, seen = e.get("parent"), {e["idx"]}
            while parent is not None and parent not in levels:
                if parent in seen:
                    parent = None
                    break
                seen.add(parent)
                parent = by_idx.get(parent, {}).get("parent")
            levels[e["idx"]] = levels.get(parent, -1) + 1
            rows.append("  " * levels[e["idx"]] + _row(e))
        if limit is not None and len(shown) > limit:
            rows.append(f"… 还有 {len(shown)-limit} 个，tree(limit=None) 看全部")
        return "\n".join(rows)

    def children(self, idx):
        return [e for e in self.elements if e.get("parent") == idx]

    def __len__(self):
        return len(self.elements)

    def __iter__(self):
        return iter(self.elements)

    def __repr__(self):
        flags = [name for name, on in (("已截断", self.truncated), ("遍历超时", self.timed_out)) if on]
        text = f"<snap {len(self.elements)} 个元素" + ("，" + "、".join(flags) if flags else "")
        if self.truncation and self.truncation.get("hint"):
            text += "：" + self.truncation["hint"]
        return text + ">"


class Diff:
    def __init__(self, data):
        self.data = data
        self.snapshot = data.get("snapshot")
        self.changed = data.get("changed", False)
        self.added = data.get("added", [])
        self.removed = data.get("removed", [])
        self.updated = data.get("updated", [])

    def __bool__(self):
        return self.changed

    def __repr__(self):
        return f"<diff 新增 {len(self.added)} / 消失 {len(self.removed)} / 更新 {len(self.updated)}>" if self.changed else "<diff 无变化>"


async def _rpc(action, params=None, *, target=None, session=None, browser="Chrome", host=None, timeout=60):
    return await get_client().acall(action, params, target=target, session=session, browser=browser, host=host, timeout=timeout)


async def status(*, browser="Chrome", host=None, session=None, mode=None, profile=None):
    params = {k: v for k, v in {"mode": mode, "profile": profile}.items() if v is not None}
    return await _rpc("status", params, browser=browser, host=host, session=session)


def _mode_params(mode, profile, restart, fallback):
    """只带调用方明确给的运行方式参数；省略的由服务按浏览器取默认（Chrome：isolated、连不上 clone；Arc：attach、连不上报错）。"""
    return {k: v for k, v in {"mode": mode, "profile": profile, "restart": restart, "fallback": fallback}.items() if v is not None}


async def up(*, browser="Chrome", host=None, session=None, mode=None, profile=None, restart=None, fallback=None):
    return await _rpc("up", _mode_params(mode, profile, restart, fallback), browser=browser, host=host, session=session)


async def tabs(*, browser="Chrome", host=None, session=None, mode=None, profile=None):
    params = {k: v for k, v in {"mode": mode, "profile": profile}.items() if v is not None}
    data = await _rpc("tab_list", params, browser=browser, host=host, session=session)
    return data.get("tabs", []) if isinstance(data, dict) else data


async def find_tab(query, *, browser="Chrome", host=None, session=None, mode=None, profile=None, restart=None, fallback=None):
    """按网址或标题里的文字找到唯一的已加载标签并借用。"""
    session, browser, host = validate_context(session, browser, host)
    params = {"query": query, **_mode_params(mode, profile, restart, fallback)}
    data = await _rpc("tab_find", params, browser=browser, host=host, session=session)
    result = Page(data["targetId"], browser=browser, host=host, session=session)
    result._bound = True
    result.owned = bool(data.get("owned", False))
    result.found = data
    result.mode = data.get("mode", mode)
    return result


_LOGIN_FIELD = ("input[type=email]", "input[autocomplete=username]", "input[autocomplete=email]", "input[name*=email i]",
                "input[name*=user i]", "input[name*=account i]", "input[id*=email i]", "input[id*=user i]", "input[type=text]")


async def login(page, *, account=None, field=None, timeout=20, native_window=None):
    """用 1Password 登录当前停在登录页的标签：browser-use 点账号框，computer-use 点 1Password 浮层里的账号，等页面离开登录页。

    page 是已绑定的 Page（一般来自 find_tab）。浮层只有一个账号就直接用；有多个时要给 account。
    field 是账号框的 CSS，省略时按常见写法找第一个可见的。只点按钮，不读、不填密码。返回登录后的网址和标题。
    """
    if not isinstance(page, Page):
        raise BrowserUseError("login 需要已绑定的 Page", 2)
    if page.host not in (None, "local"):
        raise BrowserUseError("login 要在本机操作 1Password 浮层；远端机器尚未支持", 5)
    if not isinstance(native_window, dict) or not {"id", "pid", "startedAt", "bundleId"}.issubset(native_window):
        raise BrowserUseError("login 需要本任务的 native_window 稳定窗口引用；先用 computer-use windows 确认窗口，不使用真人当前窗", 2)
    computer_use = deps.computer_use()
    try:
        windows = await computer_use.windows(page.browser, host="local")
    except computer_use.ComputerUseError as exc:
        raise BrowserUseError(f"无法确认登录窗口：{exc}", exc.code, outcome=exc.outcome, data=exc.data) from None
    matches = [row for row in windows["windows"] if all(row.get(key) == native_window[key] for key in ("id", "pid", "startedAt", "bundleId"))]
    if len(matches) != 1 or not matches[0].get("isFrontmost") or not matches[0].get("isFocused"):
        raise BrowserUseError("登录窗口不在确切前台或已消失；先将本任务窗口置前，未点击账号框", 4, outcome="not_sent")
    before = await page.page_info()
    selectors = [field] if field else list(_LOGIN_FIELD)
    clicked = None
    for css in selectors:
        try:
            await page.click(selector={"css": css})
            clicked = css
            break
        except BrowserUseError as exc:
            if exc.code not in (3, 4) or field:
                raise
    if clicked is None:
        raise BrowserUseError("页面上没有找到可见的账号输入框；用 field 指定它的 CSS", 3, data={"url": before.get("url")})
    try:
        chosen = await computer_use.autofill(page.browser, account=account, host="local", window=native_window)
    except computer_use.ComputerUseError as exc:
        raise BrowserUseError(f"1Password 填充失败：{exc}", exc.code if exc.code in (2, 3, 4, 5, 6) else 1, outcome=exc.outcome, data=exc.data) from None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    last = None
    while loop.time() < deadline:
        await asyncio.sleep(0.5)
        try:
            last = await page.page_info()
        except BrowserUseError as exc:
            if exc.code == 6:
                raise
            continue
        if last.get("url") != before.get("url") and not _looks_like_login(last.get("url", "")):
            return {"loggedIn": True, "account": chosen["clicked"], "url": last["url"], "title": last.get("title")}
    raise BrowserUseError("已点 1Password 账号，但页面没有离开登录页；可能需要验证码或二次确认，请看一眼", 4, outcome="unknown",
                  data={"account": chosen["clicked"], "url": (last or before).get("url")})


def _looks_like_login(url):
    return any(word in url.lower() for word in ("/login", "/signin", "/sign-in", "/auth/", "#/login"))


async def open_page(url=None, *, browser="Chrome", host=None, session=None, mode=None, profile=None, restart=None, fallback=None, lane=None, init_script=None, capture=True, executable=None, headed=False, launch=None, new_window=False, source_target=None):
    """新建页面。mode=attach 接管日常浏览器；isolated 启动独立实例；clone 复制日常 Chrome 资料后启动。

    browser="Arc" 只能 attach，省略 mode 即是；Chrome 省略 mode 是 isolated。"""
    session, browser, host = validate_context(session, browser, host)
    if type(new_window) is not bool:
        raise BrowserUseError("new_window 必须是 bool", 2)
    if source_target is not None and (not isinstance(source_target, str) or not source_target or not new_window):
        raise BrowserUseError("source_target 需要确切页面 ID，且只用于新窗口", 2)
    params = dict(url=url or "about:blank", capture=capture, headed=headed, **_mode_params(mode, profile, restart, fallback))
    if new_window:
        params["new_window"] = True
    if source_target is not None:
        params["source_target"] = source_target
    if executable is not None:
        params["executable"] = str(executable)
    if launch is not None:
        params["launch"] = dict(launch)
    if lane is not None:
        params["lane"] = lane_params(lane)
    if init_script is not None:
        params["init_script"] = init_script
    data = await _rpc("tab_new", params, browser=browser, host=host, session=session)
    result = Page(data["targetId"], browser=browser, host=host, session=session)
    result._bound = True
    result.owned = True
    result.mode = data.get("mode", mode)
    return result


async def _release_browsers(callback, *, browser=None):
    names = BROWSER_NAMES if browser is None else (browser,)
    results, errors = {}, []
    for name in names:
        try:
            result = await callback(name)
            results[name] = {"ok": True, "result": result}
        except Exception as exc:
            error = exc if isinstance(exc, BrowserUseError) else BrowserUseError(str(exc), 1)
            results[name] = error.as_dict()
            errors.append(error)
    data = {"browsers": results}
    if errors:
        message = "；".join(f"{name}：{result['error']}" for name, result in results.items() if not result["ok"])
        raise BrowserUseError("部分浏览器释放失败，已尝试其余浏览器：" + message, errors[0].code,
                      outcome="unknown" if any(e.outcome == "unknown" for e in errors) else None, data=data)
    return data


async def release(*, session=None, browser=None, host=None):
    """释放本会话用到的浏览器（省略 browser 时 Chrome、Arc 都释放）；只关自建页面。"""
    session, _, host = validate_context(session, browser or "Chrome", host)
    async def release(name):
        return await _rpc("release", browser=name, host=host, session=session)
    return await _release_browsers(release, browser=browser)


async def open_window(url=None, *, browser="Chrome", host=None, session=None, source_target=None,
                      lane=None, init_script=None, capture=True):
    """在日常浏览器的同份资料里开任务窗口；不复制资料、不重启、不改用独立实例。

    多份资料同时打开时，source_target 必须指向要共享登录的确切页面。
    返回固定 Page；关闭这个页面只关闭自建内容，不退出浏览器。
    """
    return await open_page(url, browser=browser, host=host, session=session, mode="attach",
                           restart="never", fallback="never", new_window=True,
                           source_target=source_target, lane=lane, init_script=init_script, capture=capture)


async def _page_call(target, action, params, *, browser=None, host=None, session=None, rpc_timeout=60):
    params = {k: v for k, v in params.items() if v is not None}
    if isinstance(target, Page):
        if host is not None and host != target.host or session is not None and session != target.session or browser is not None and browser != target.browser:
            raise BrowserUseError("Page 已固定浏览器、主机与会话，不能临时换目标", 2)
        return await target._call(action, params, rpc_timeout=rpc_timeout)
    if not isinstance(target, str) or not target:
        raise BrowserUseError("需要明确 target_id 或 Page，不能使用活动标签页", 2)
    return await _rpc("page_" + action, params, target=target, browser=browser or "Chrome", host=host, session=session, timeout=rpc_timeout)


class _Namespace:
    def __init__(self, page, prefix, operations):
        self.page, self.prefix, self.operations = page, prefix, operations

    def __getattr__(self, name):
        if name not in self.operations:
            raise AttributeError(name)
        async def call(*args, **params):
            positional = self.operations[name]
            if args:
                if len(args) != 1 or positional is None or positional in params:
                    raise BrowserUseError("该操作不接受这些位置参数，请用具名参数", 2)
                params[positional] = args[0]
            async with self.page._lock:
                await self.page._bind_unlocked()
                return await self.page._rpc(self.prefix + "_" + name, params, target=self.page.target_id,
                                  browser=self.page.browser, host=self.page.host, session=self.page.session)
        return call


class _ServiceNamespace:
    """页面服务的具名动作；动作名与参数由服务端严格校验，未知字段报 code 2。"""
    def __init__(self, page, prefix):
        self.page, self.prefix = page, prefix

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        async def call(**params):
            async with self.page._lock:
                await self.page._bind_unlocked()
                timeout = params.get("timeout")
                rpc_timeout = max(60, timeout + 5) if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) else 60
                return await self.page._rpc(self.prefix + "_" + name, params, target=self.page.target_id, browser=self.page.browser,
                                            host=self.page.host, session=self.page.session, timeout=rpc_timeout)
        return call


class Page:
    """固定标签页绑定；同对象串行，保存快照凭证，不跟随活动标签页。"""
    def __init__(self, target_id, *, browser="Chrome", host=None, session=None):
        if not isinstance(target_id, str) or not target_id:
            raise BrowserUseError("target_id 不能为空", 2)
        self.target_id = target_id
        self.session, self.browser, self.host = validate_context(session, browser, host)
        self.snapshot = None
        self.owned = False
        self._bound = False
        self._closed = False
        self._lock = asyncio.Lock()
        self._rpc = _rpc
        self.network = _Namespace(self, "network", actions.NETWORK_PYTHON)
        self.lane = _Namespace(self, "lane", actions.LANE)
        self.debug = DebugNamespace(self)
        for prefix in actions.SERVICES:
            setattr(self, prefix, _ServiceNamespace(self, prefix))

    async def _bind_unlocked(self):
        if self._closed:
            raise BrowserUseError("Page 已关闭，不能重新绑定", 4)
        if not self._bound:
            data = await self._rpc("tab_bind", target=self.target_id, browser=self.browser, host=self.host, session=self.session)
            self.owned = bool(data.get("owned", False))
            self._bound = True

    async def _call(self, action, params, *, rpc_timeout=60):
        async with self._lock:
            await self._bind_unlocked()
            params = dict(params)
            if params.get("idx") is not None:
                params["snapshot"] = params.get("snapshot") or self.snapshot
                if not params["snapshot"]:
                    raise BrowserUseError("编号操作前必须先 snap，或显式提供 snapshot", 4)
            result = await self._rpc("page_" + action, params, target=self.target_id, browser=self.browser,
                                host=self.host, session=self.session, timeout=rpc_timeout)
            if action == "snap":
                self.snapshot = result.get("snapshot")
            elif action in {"goto", "reload", "back", "forward"}:
                self.snapshot = None
            return result

    async def window(self):
        """读取固定页面所在浏览器窗口；browserWindowId 不是 macOS 原生窗口 ID。"""
        async with self._lock:
            await self._bind_unlocked()
            return await self._rpc("tab_window", target=self.target_id, browser=self.browser,
                                   host=self.host, session=self.session)

    async def recover(self):
        """只恢复原页面的调试绑定；不新建页面、不重发此前动作。"""
        async with self._lock:
            if self._closed:
                raise BrowserUseError("Page 已关闭，不能恢复", 4)
            self.snapshot = None
            result = await self._rpc("tab_recover", target=self.target_id, browser=self.browser,
                                     host=self.host, session=self.session)
            self.owned = bool(result.get("owned", False))
            self._bound = True
            return result

    async def close(self, *, authorized=False):
        async with self._lock:
            await self._bind_unlocked()
            result = await self._rpc("tab_close", {"authorized": authorized}, target=self.target_id, browser=self.browser, host=self.host, session=self.session)
            self._closed = True
            return result

    def __repr__(self):
        return f"<page {self.browser} {self.target_id!r} {'自建' if self.owned else '借用'}>"


def _bind(function):
    @functools.wraps(function)
    async def bound(self, *args, **kwargs):
        if any(k in kwargs for k in ("host", "browser", "session")):
            raise BrowserUseError("Page 已固定上下文，不能临时换机器、浏览器或会话", 2)
        return await function(self, *args, **kwargs)
    return bound


def _page_function(action):
    """按参数表生成一个页面函数，签名、名字和文档都取自表里那一条。"""
    collect = action.collector()

    @functools.wraps(collect)
    async def call(*args, **kwargs):
        values = collect(*args, **kwargs)
        target = values.pop("target")
        context = values.pop("context", {})
        for key in ("browser", "host", "session"):
            if key in values:
                context[key] = values.pop(key)
        if action.locate:
            chosen = [k for k in ("idx", "id", "label", "selector", "at") if values.get(k) is not None]
            if len(chosen) > 1 or action.locate == "required" and not chosen:
                fields = "idx/id/label/selector" + ("/at" if action.name == "click" else "")
                raise BrowserUseError(f"{action.name} 需要 {fields} 恰好一个", 2)
        timeout = {"rpc_timeout": action.timeout(values)} if action.timeout else {}
        data = await _page_call(target, action.name, action.params(values), **context, **timeout)
        if not action.result:
            return data
        if isinstance(data, dict) and isinstance(data.get("laneWarning"), dict):
            # 这些函数只返回结果里的一部分，警告字段会随之丢掉，所以另外发一条 Python 警告。
            warnings.warn(LaneWarning(data["laneWarning"]["text"]), stacklevel=2)
        return action.result(data)

    call.__doc__ = action.doc
    return call


for _action in actions.ACTIONS:
    if _action.python:
        globals()[_action.function_name] = _page_function(_action)
        setattr(Page, _action.function_name, _bind(globals()[_action.function_name]))
Page.login = login


def page(target_id, *, browser="Chrome", host=None, session=None):
    return Page(target_id, browser=browser, host=host, session=session)


def diff_text(before, after, **options):
    """比较两段文本（例如两次快照），返回 changed/added/removed/diff；纯本地计算。"""
    from .output import diff_text as _diff_text
    return _diff_text(before, after, **options)


async def lane_status(*, browser="Chrome", host=None, session=None):
    """本任务在这个浏览器里设了泳道的页面：各自的请求头和实际发出去的核对统计。"""
    return await _rpc("lane_status", browser=browser, host=host, session=session)


async def cli(*args, **options):
    from .commands import execute
    return await execute([str(a) for a in args], **options)


async def version(*, host=None):
    """读取所选机器的版本，不启动浏览器。"""
    selected = resolve_host(host)
    if selected != "local":
        from .transport import RemoteTransport
        probe = await asyncio.to_thread(RemoteTransport().probe, selected, timeout=60)
        return {k: probe[k] for k in ("tool", "version", "protocol")}
    return {"tool": "browser-use", "version": __version__, "protocol": 1}


async def capabilities(*, host=None):
    """查询所选机器支持范围，不把本机能力冒充远端。"""
    selected = resolve_host(host)
    if selected != "local":
        from .transport import RemoteTransport
        return await asyncio.to_thread(RemoteTransport().probe, selected, timeout=60)
    common = ("snap", "click", "type_text", "key", "set_value", "read", "wait", "scroll", "shot", "element", "disconnect", "release")
    features = {name: {"supported": True, "mode": "local"} for name in common}
    features["remote"] = {"supported": True, "mode": "ssh_rpc", "reason": "目标机必须具有匹配的 browser-use 入口与浏览器权限；失败不会转本机"}
    for name in ("debug", "network", "dom", "computed_style", "element_screenshot", "websocket_frames", "response_transform"):
        features[name] = {"supported": True, "mode": "page"}
    features["page_lane"] = {"supported": True, "mode": "page_sessions",
                             "reason": "给本任务控制的页面及其 iframe 加任意合法请求头（浏览器网络栈自己维护的头除外），新开页从第一个请求起就带；"
                                       "核对实际发出去的头，被插件等改掉时在下一次页面动作里警告；release 撤掉，浏览器里不留东西；"
                                       "worker 和 service worker 自己发的请求不带"}
    features["batch"] = {"supported": True, "mode": "cli", "reason": "命令行从 stdin 或文件读多条命令，默认出错即停；Python 直接编排"}
    features["browser_modes"] = {"supported": True, "mode": "attach_isolated_clone", "reason": "attach 借用日常 Chrome 或 Arc；isolated 使用临时或持久资料；clone 复制日常 Chrome 资料到本任务私有目录；Arc 只能 attach"}
    features["shared_window"] = {"supported": True, "mode": "attach", "reason": "open_window 为任务新开窗口，与指定现有页面共享资料和登录，不复制、不重启、不回退独立实例；多个资料同时打开时须提供 source_target；原生菜单和键盘仍受桌面焦点限制"}
    features["chrome_launch_options"] = {"supported": True, "mode": "owned_chrome", "reason": "代理、证书、语言、UA、窗口尺寸用于 isolated/clone；attach 不改日常 Chrome 配置"}
    features["state"] = {"supported": True, "mode": "page_session", "reason": "Cookie 值默认打码；网页存储只限页面里出现的来源；登录状态文件只载入自启 Chrome；共享浏览器写入需授权，释放时恢复"}
    features["output"] = {"supported": True, "mode": "page", "reason": "截图变化检测、差异图、编号标注"}
    features["diff_text"] = {"supported": True, "mode": "local", "reason": "两段文本或快照文件的统一 diff"}
    features["semantic_locators"] = {"supported": True, "mode": "page", "reason": "text/placeholder/alt/title 默认精确，可选包含与忽略大小写；nth 选第几个；不给 nth 时要求唯一"}
    features["form_fill"] = {"supported": True, "mode": "page", "reason": "清空后可信插入并回读核对；批量填表出错即停；ARIA 勾选点击后核对 aria-checked，不重试"}
    features["keyboard"] = {"supported": True, "mode": "cdp", "reason": "完整键名与任意修饰组合、按下松开分开、逐键输入；复制剪切粘贴只在无界面 Chrome，不碰系统剪贴板"}
    features["mouse"] = {"supported": True, "mode": "cdp", "reason": "移动、按下、松开、滚轮；元素拖放走浏览器拖放事件并核对 drop，跨进程 iframe 不支持"}
    features["wait_conditions"] = {"supported": True, "mode": "page", "reason": "文字、元素四种状态、网址通配、加载阶段（networkidle 取 Chrome 生命周期事件）、多段文字任一"}
    features["file_chooser"] = {"supported": True, "mode": "page", "reason": "拦截点击弹出的文件选择框并填入明确的本机文件；远程时先上传到目标机私有暂存目录"}
    features["screenshot_formats"] = {"supported": True, "mode": "page", "reason": "png/jpeg/webp、质量、shrink=0 原图"}
    features["page_info"] = {"supported": True, "mode": "page", "reason": "网址、标题、加载状态、视口、正文、框架列表"}
    features["inspect"] = {"supported": True, "mode": "page_session", "reason": "CSS 规则来源与胜出覆盖（browser-use 自算层叠）"}
    features["console_detail"] = {"supported": True, "mode": "page", "reason": "消息编号、类型筛选、游标分页、单条参数展开一层；不做 source map 还原"}
    features["network_filters"] = {"supported": True, "mode": "page", "reason": "资源类型、状态范围、分页、按导航分段；正文另存私有文件；HAR 正文 none/text/all"}
    features["extra_headers"] = {"supported": True, "mode": "page_sessions_or_origin", "reason": "同一个头只能由泳道或 headers-set 之一设置；释放撤销"}
    features["http_basic_auth"] = {"supported": True, "mode": "fetch_auth", "reason": "只答 origin 服务器的 Basic 质询；浏览器会缓存成功的凭据且清不掉，共享浏览器需 authorized"}
    return {"tool": "browser-use", "version": __version__, "protocol": 1, "features": [*common, "local-routing", "remote-rpc"], "capabilities": features}


class EventStream:
    """有界订阅；跨PTC调用保留服务端事件，游标与丢失明确返回。"""
    def __init__(self, page, identifier):
        self.page, self.identifier, self.cursor = page, identifier, 0
        self.stopped = False

    async def read(self, *, limit=100, wait_timeout=0):
        if self.stopped:
            raise BrowserUseError("事件订阅已停止", 4)
        result = await self.page.debug.events_read(id=self.identifier, after=self.cursor, limit=limit, wait_timeout=wait_timeout)
        self.cursor = result.get("cursor", self.cursor)
        return result

    async def stop(self):
        if self.stopped:
            return {"stopped": True}
        result = await self.page.debug.events_stop(id=self.identifier)
        self.stopped = True
        return result


class DebugNamespace:
    """调试命令固定至本页面，不另建裸连接。"""
    def __init__(self, page):
        self.page = page

    async def _call(self, action, params):
        if self.page._closed:
            raise BrowserUseError("Page 已关闭", 4)
        if not self.page._bound:
            async with self.page._lock:
                await self.page._bind_unlocked()
        return await self.page._rpc("debug_" + action, params, target=self.page.target_id,
            browser=self.page.browser, host=self.page.host, session=self.page.session,
            timeout=max(60, params.get("timeout", 20) + 5))

    async def call(self, method, params=None, *, timeout=20, session_id=None, authorized=False, scope=None):
        values = {"method": method, "params": params or {}, "timeout": timeout, "authorized": authorized}
        if scope is not None:
            values["scope"] = scope
        if session_id is not None:
            values["session_id"] = session_id
        return await self._call("call", values)

    async def subscribe(self, methods, *, limit=1000):
        result = await self._call("events_start", {"methods": methods, "limit": limit})
        return EventStream(self.page, result["subscriptionId"])

    def __getattr__(self, name):
        allowed = {"events_start", "events_read", "events_stop", "enable", "sources", "source", "breakpoint", "remove", "pause", "resume", "step", "stack", "evaluate_frame"}
        if name not in allowed:
            raise AttributeError(name)
        async def call(**params):
            return await self._call(name, params)
        return call


class Element:
    """元素身份固定在解析时的文档，导航后拒绝重新解释为另一元素。"""
    def __init__(self, page, selector, *, frame=None, within=None, shadow=None, handle=None):
        if not isinstance(selector, dict):
            raise BrowserUseError("selector 需要明确定位条件对象", 2)
        self.page, self.selector = page, dict(selector)
        self.frame, self.within, self.shadow = frame, within, shadow
        self.handle = handle
        self.metadata = None

    async def _call(self, action, params=None):
        async with self.page._lock:
            await self.page._bind_unlocked()
            context = dict(target=self.page.target_id, browser=self.page.browser, host=self.page.host, session=self.page.session)
            if self.handle is None:
                selector = dict(self.selector)
                if "idx" in selector:
                    selector["snapshot"] = selector.get("snapshot") or self.page.snapshot
                values = {"selector": selector}
                for key in ("frame", "within", "shadow"):
                    value = getattr(self, key)
                    if value is not None:
                        values[key] = value
                result = await self.page._rpc("element_resolve", values, **context)
                self.handle, self.metadata = result["handle"], result.get("metadata")
                if action == "resolve":
                    return result
            return await self.page._rpc("element_" + action, {"handle": self.handle, **(params or {})}, **context)

    async def click(self, *, count=1, button="left"):
        return await self._call("click", {"count": count, "button": button})

    async def type_text(self, text, *, allow_newline=False):
        return await self._call("type", {"text": text, "allow_newline": allow_newline})

    async def key(self, keys):
        return await self._call("key", {"keys": keys})

    async def set_value(self, value):
        return await self._call("set", {"value": value})

    async def scroll(self, direction="down", *, pages=1):
        return await self._call("scroll", {"direction": direction, "pages": pages})

    async def attribute(self, name):
        return await self._call("attribute", {"name": name})

    async def select(self, value=None, *, values=None, label=None, labels=None):
        """按选项值（value/values）或可见文字（label/labels）选择，四选一。"""
        chosen = {k: v for k, v in dict(value=value, values=values, label=label, labels=labels).items() if v is not None}
        if len(chosen) != 1:
            raise BrowserUseError("select 需要 value/values/label/labels 恰好一个", 2)
        return await self._call("select", chosen)

    async def fill(self, value, *, allow_newline=False):
        """清空后可信插入文字并回读核对；适用于文本框、多行文本框和可编辑区域。"""
        return await self._call("fill", {"value": value, "allow_newline": allow_newline})

    async def uncheck(self):
        return await self._call("uncheck")

    async def evaluate(self, function, *, args=None, timeout=None):
        """在元素上执行函数，函数里的 this 是该元素；args 是 JSON 列表。"""
        params = {"function": function}
        if args is not None:
            params["args"] = list(args)
        if timeout is not None:
            params["timeout"] = timeout
        return await self._call("evaluate", params)

    async def drag_to(self, target=None, *, selector=None, mode="auto", steps=10):
        """拖到另一个元素（Element 或其 handle）或 selector 指定的位置；可拖元素走浏览器拖放并核对 drop。"""
        if (target is None) == (selector is None):
            raise BrowserUseError("drag_to 需要 target 或 selector 恰好一个", 2)
        params = {"mode": mode, "steps": steps}
        if selector is not None:
            params["target_selector"] = selector
        else:
            if isinstance(target, Element):
                if target.page is not self.page:
                    raise BrowserUseError("拖放目标必须在同一页面", 2)
                if target.handle is None:
                    await target.resolve()
                target = target.handle
            params["target"] = target
        return await self._call("drag_to", params)

    async def restore(self, patch_id):
        async with self.page._lock:
            await self.page._bind_unlocked()
            return await self.page._rpc("element_restore", {"patchId": patch_id}, target=self.page.target_id, browser=self.page.browser, host=self.page.host, session=self.page.session)

    async def resolve(self):
        if self.handle is not None:
            result = await self._call("describe")
            self.metadata = result.get("metadata")
            return result
        return await self._call("resolve")

    def __getattr__(self, name):
        if name not in {"describe", "read", "attribute", "html", "measure", "styles", "screenshot", "focus", "hover", "check", "patch"}:
            raise AttributeError(name)
        async def call(**params):
            return await self._call({"type_text": "type", "set_value": "set"}.get(name, name), params)
        return call


def element(target, *, selector=None, css=None, id=None, testid=None, label=None, role=None, idx=None, text=None, placeholder=None,
            alt=None, title=None, match=None, ignore_case=None, nth=None, frame=None, within=None, shadow=None):
    """创建惰性元素定位对象；首次操作解析并固定节点。text/placeholder/alt/title 默认精确，match="contains" 包含；nth 选第几个。"""
    if not isinstance(target, Page):
        raise BrowserUseError("元素定位需要已绑定的Page对象", 2)
    fields = {"css": css, "id": id, "testid": testid, "label": label, "role": role, "idx": idx, "text": text, "placeholder": placeholder,
              "alt": alt, "title": title, "match": match, "ignore_case": ignore_case, "nth": nth}
    direct = {key: value for key, value in fields.items() if value is not None}
    if selector is not None and direct:
        raise BrowserUseError("selector 与定位具名参数不能同时指定", 2)
    return Element(target, selector if selector is not None else direct, frame=frame, within=within, shadow=shadow)


Page.element = element


async def disconnect(*, session=None, browser=None, host=None):
    """断开本任务调试连接；保留目标页和归属，后续release仍可清理。"""
    session, _, host = validate_context(session, browser or "Chrome", host)
    async def detach(name):
        return await _rpc("disconnect", browser=name, host=host, session=session)
    return await _release_browsers(detach, browser=browser)


async def locate_all(target, *, selector=None, frame=None, within=None, shadow=None, limit=100):
    if not isinstance(target, Page):
        raise BrowserUseError("元素列表需要Page", 2)
    values = {"selector": selector or {"css": "*"}, "limit": limit}
    for key, value in {"frame": frame, "within": within, "shadow": shadow}.items():
        if value is not None:
            values[key] = value
    async with target._lock:
        await target._bind_unlocked()
        result = await target._rpc("element_list", values, target=target.target_id,
            browser=target.browser, host=target.host, session=target.session)
    return {**result, "elements": [Element(target, selector or {"css": "*"}, handle=e["handle"]) for e in result["elements"]]}


Page.elements = locate_all


async def use(host=None, *, clear=False):
    """选择 browser-use 自己的默认机器；省略读取，clear回默认本机。"""
    args = ["use"] + ([host] if host is not None else []) + (["--clear"] if clear else [])
    result = routing().control_target("browser-use", args)
    if not result.get("ok"):
        raise BrowserUseError(result.get("error", "选机失败"), result.get("code", 2), command="use", outcome="not_sent")
    return result


async def pin(host=None, *, clear=False):
    """固定或查看 browser-use 自己的默认机器。"""
    return await use(host, clear=clear)


async def hosts():
    return routing().control_target("browser-use", ["hosts"])


async def session_use(name=None, *, scope=None, clear=False):
    return session_control("use", name=name, scope=scope, clear=clear)


async def session_current(*, scope=None):
    return session_control("current", scope=scope)
