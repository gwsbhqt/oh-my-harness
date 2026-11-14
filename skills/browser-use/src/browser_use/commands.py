"""browser-use 命令行；argparse help、JSON 错误和 Python 共用 RPC。"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

from .actions import ACTIONS, COMMANDS, NETWORK, SERVICES, Group, json_object, point
from .browsers import NAMES as BROWSER_NAMES
from .errors import BrowserUseError
from .client import Client, default_socket, prepare_socket_directory, validate_context, routing
from .contexts import choose_session, session_control
from .lane import lane_params


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise BrowserUseError(message, 2)


def build_parser(*, explicit_tab=False):
    parser = Parser(prog="browser-use", description="后台控制明确绑定的 Chrome 或 Arc 网页，不使用活动标签页。文本以 -- 分隔原样传入。")
    common = argparse.ArgumentParser(add_help=False)
    for p in (parser, common):
        suppress = {} if p is parser else {"default": argparse.SUPPRESS}
        p.add_argument("--session", help="明确会话名称（字母数字、下划线、连字符）", **suppress)
        p.add_argument("--browser", choices=BROWSER_NAMES, help="浏览器：Chrome 或 Arc；默认 Chrome", **({"default": None} if p is parser else suppress))
        p.add_argument("--mode", choices=("attach", "isolated", "clone"), help="attach 接管日常浏览器；isolated 独立实例；clone 复制日常 Chrome 资料。默认 Chrome 为 isolated，Arc 只能 attach", **suppress)
        p.add_argument("--restart", choices=("never", "if_needed"), help="attach 连接失效时是否允许一次正常重启；Chrome 默认 if_needed，Arc 默认 never", **suppress)
        p.add_argument("--fallback", choices=("clone", "never"), help="attach 连接失败时是否自动改用 clone；Chrome 默认 clone，Arc 只能 never", **suppress)
        p.add_argument("--profile", help="isolated 的持久资料名，或 clone 的来源资料名", **suppress)
        p.add_argument("--host", "-H", help="本次机器；未指定则用 browser-use 自己的 pin，没有pin默认本机", **({"default": None} if p is parser else suppress))
        p.add_argument("--local", action="store_true", help="本次明确本机，不使用默认远端", **suppress)
        p.add_argument("--scope", help="任务上下文；缺省用BROWSER_USE_CONTEXT_ID或DSH_SESSION_ID", **suppress)
        p.add_argument("--json", action="store_true", help="stdout 只输出单行 JSON", **suppress)
        p.add_argument("--socket", help="专用私有目录中的 Unix socket 路径", **suppress)
        p.add_argument("--tab", help="明确标签页 targetId，可代替位置参数", **suppress)
        p.add_argument("--rpc-timeout", type=float, help="RPC 等待秒数；超时不重发", **({"default":60} if p is parser else suppress))
        p.add_argument("--snap", action="store_true", help="页面动作成功后再取一次态（不截图），结果放在 snap 字段", **suppress)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    def command(name, help, *, target=False, parents=True):
        p = sub.add_parser(name, help=help, description=help, parents=[common] if parents else [])
        if target and not explicit_tab:
            p.add_argument("target", nargs="?", help="明确标签页 targetId")
        return p
    command("status", "只检查服务与浏览器状态，不启动浏览器")
    command("service", "只读查看本机 browser-use 服务的代码版本、是否排空中、各任务持有的页面和浏览器；不启动服务、不发浏览器动作")
    command("up", "在后台启动或接上指定浏览器")
    command("release", "释放指定会话，仅关闭此会话自建页面")
    command("version", "显示 browser-use 版本")
    command("capabilities", "查询能力与限制，不启动浏览器")
    command("disconnect", "解除本任务调试连接，不关闭目标")
    for name in ("use", "pin", "hosts"):
        p = command(name, "共用选机；只改变 browser-use 自己的默认机器")
        if name != "hosts":
            p.add_argument("machine", nargs="?")
            p.add_argument("--clear", action="store_true")
    p = command("session", "只选择当前任务的资源归属，不选择机器或活动页")
    p.add_argument("operation", choices=("use", "current"))
    p.add_argument("name", nargs="?")
    p.add_argument("--clear", action="store_true", help="只清会话选择，不释放页面")
    command("install", "显式安装 websockets 到 browser-use 专用缓存环境，不在调用时自动安装")
    p = command("diff", "比较两段快照文本文件")
    p.add_argument("before")
    p.add_argument("after")
    p.add_argument("--context", type=int, default=3)
    p = command("batch", "从 stdin 或文件读 JSON 数组，每项是一条 browser-use 参数列表，按顺序执行；默认出错即停")
    p.add_argument("--file", help="JSON 文件路径；省略读 stdin")
    p.add_argument("--continue-on-error", action="store_true", help="单条失败后继续执行后续命令")
    p = command("serve", "运行常驻 RPC 服务；直接执行时持有服务锁")
    p = command("login", "用 1Password 登录停在登录页的标签：browser-use 点账号框，computer-use 点 1Password 浮层里的账号", target=True)
    p.add_argument("--account", help="1Password 有多个账号时，按钮文字里要包含的内容")
    p.add_argument("--field", help="账号输入框的 CSS；省略时按常见写法找")
    p.add_argument("--native-window", type=json_object, required=True, help="computer-use windows 返回的本任务稳定窗口引用 JSON；不猜当前窗")
    p.add_argument("--timeout", type=float, default=20)
    p = command("tab", "标签页管理：创建、枚举、绑定、关闭")
    ts = p.add_subparsers(dest="operation", required=True, parser_class=Parser)
    for name in ("new", "list", "bind", "find", "close", "recover", "window"):
        t = ts.add_parser(name, parents=[common], help={"new":"先空白页设置网络、脚本、泳道再导航", "list":"枚举标签页", "bind":"按精确 targetId 借用", "find":"按网址或标题里的文字找到唯一标签并借用", "close":"关闭页面；借用页面须显式授权", "recover":"显式恢复原页面调试绑定，不新建页面、不重发动作", "window":"读取固定页面所在窗口；浏览器窗口号与原生窗口号不同"}[name])
        if name == "new":
            t.add_argument("url", nargs="?", default="about:blank")
            t.add_argument("--lane", help="泳道：env 文本（设 x-tt-env），或请求头 JSON，如 '{\"x-tt-env\": \"ppe_a\", \"force-workbench\": \"1\"}'")
            t.add_argument("--init-script")
            t.add_argument("--no-capture", dest="capture", action="store_false", default=True)
            t.add_argument("--executable", help="Chrome 可执行文件路径")
            t.add_argument("--headed", action="store_true", help="使用可见 Chrome 窗口，不激活")
            t.add_argument("--new-window", action="store_true", help="为页面另开窗口；共享登录时显式用 --mode attach --fallback never --restart never")
            t.add_argument("--source-target", help="新窗口共享此确切页面的资料；多资料同时打开时必填")
            t.add_argument("--proxy", help="自启 Chrome 的代理地址")
            t.add_argument("--proxy-bypass", help="不走代理的主机列表")
            t.add_argument("--ignore-https-errors", action="store_true", help="自启 Chrome 忽略证书错误")
            t.add_argument("--lang", help="自启 Chrome 的界面与请求语言，如 zh-CN")
            t.add_argument("--user-agent", help="自启 Chrome 的默认 UA")
            t.add_argument("--window-size", type=point, help="自启 Chrome 窗口尺寸 W,H")
        elif name == "find":
            t.add_argument("query", help="网址或标题里的文字，空格分隔的词都要出现")
        elif name in ("bind", "close", "recover", "window"):
            if not explicit_tab:
                t.add_argument("target", nargs="?")
            if name == "close":
                t.add_argument("--authorized", action="store_true", help="用户明确允许关闭借用标签页")
    for action in ACTIONS:
        if action.cli:
            p = command(action.cli, action.help, target=True)
            for item in action.args:
                if isinstance(item, Group):
                    group = p.add_mutually_exclusive_group(required=item.required)
                    for arg in item.args:
                        group.add_argument(*arg.names, **arg.options)
                else:
                    p.add_argument(*item.names, **item.options)
    p = command("lane", "给本任务控制的页面加泳道请求头，并核对实际发出去的值")
    p.add_argument("tokens", nargs="+", metavar="[TAB] OP [ENV]", help="OP: set/get/clear 针对 TAB；status 不带 TAB，列出本任务设了泳道的页面")
    p.add_argument("--headers", type=json_object, help="请求头 JSON 对象，任意合法请求头")
    p.add_argument("--header", help="单个泳道请求头名称")
    p.add_argument("--value", help="单个泳道请求头值")
    p = command("network", "网络请求、响应正文、路由、控制台与 HAR", target=True)
    p.add_argument("operation", choices=tuple(name.replace("_", "-") for name in NETWORK))
    p.add_argument("--password-stdin", action="store_true", help="auth-set 从标准输入读密码，避免出现在进程列表和 shell 历史")
    p.add_argument("value", nargs="?", help="请求 ID、路由匹配或输出路径")
    p.add_argument("--raw", action="store_true", help="显式读取未脱敏敏感头")
    p.add_argument("--body", action="store_true")
    p.add_argument("--limit", type=int)
    p.add_argument("--url")
    p.add_argument("--method")
    p.add_argument("--status", type=_status_filter, help="状态码筛选：200、2xx 或 400-499")
    p.add_argument("--params", type=json_object, default={}, help="额外网络参数 JSON 对象")
    p.add_argument("--action", choices=("block","headers","fulfill","response-transform"))
    p.add_argument("--headers", type=json_object)
    p.add_argument("--status-code", type=int)
    p.add_argument("--response-body")
    p.add_argument("--out")
    for name, prefix, description in (("element", "element", "元素定位、操作、测量、样式与修改恢复"), ("debug", "debug", "固定页面的 CDP、断点和事件"),
                                      ("state", "state", "Cookie、网页存储与登录状态文件"),
                                      ("inspect", "inspect", "CSS 规则来源与胜出覆盖"), ("output", "output", "截图变化检测、差异图与编号标注")):
        p = command(name, description, target=True)
        p.add_argument("operation")
        p.add_argument("--params", type=json_object, default={}, help="操作参数JSON，按真实允许字段校验")
        p.add_argument("--selector", type=json_object, help="元素定位对象")
        p.add_argument("--handle", type=json_object, help="已解析元素身份凭证")
        p.add_argument("--authorized", action="store_true", help="明确授权影响全局状态的操作")
        if name == "element":
            p.add_argument("--file", help="element evaluate 的函数源码文件；- 表示从标准输入读")
    return parser


def _normalize_options(argv):
    """把通用选项移到命令前，保持 -- 之后每个文本字节原样。"""
    boundary = argv.index("--") if "--" in argv else len(argv)
    before, tail = list(argv[:boundary]), list(argv[boundary:])
    globals_, remaining = [], []
    valued = {"--session", "--browser", "--mode", "--profile", "--restart", "--fallback", "--host", "-H", "--socket", "--tab", "--rpc-timeout", "--scope"}
    i = 0
    while i < len(before):
        arg = before[i]
        if arg in {"--json", "--local"}:
            globals_.append(arg)
        elif arg in valued:
            if i+1 >= len(before):
                raise BrowserUseError(f"{arg} 需要参数", 2)
            globals_.extend(before[i:i+2])
            i += 1
        elif any(arg.startswith(option+"=") for option in valued):
            globals_.append(arg)
        else:
            remaining.append(arg)
        i += 1
    return globals_ + remaining + tail



def _status_filter(value):
    """CLI 的 --status：纯数字转整数，范围写法原样交给服务端校验。"""
    return int(value) if value.isdigit() else value


_TEXT_FIELDS = {action.cli: action.body for action in ACTIONS if action.body}


def _text_after_options(parser, argv):
    """type/key/eval/goto 的正文写在 -- 之后时，把它移到选项之前的位置参数里。

    这几条命令的目标页是可选位置参数，argparse 会把目标页当成正文，再把 -- 后的真正正文当成多余参数。
    """
    if "--" not in argv:
        return argv
    boundary = argv.index("--")
    head, tail = argv[:boundary], argv[boundary+1:]
    command = next((a for a in head if a in _TEXT_FIELDS), None)
    if command is None or len(tail) != 1:
        return argv
    try:
        ns, rest = parser.parse_known_args(head)
    except BrowserUseError:
        return argv
    if rest or ns.command != command:
        return argv
    field = _TEXT_FIELDS[command]
    positional = getattr(ns, field, None)
    if getattr(ns, "target", None) is None and getattr(ns, "tab", None) is None and positional is not None:
        # 唯一的位置参数其实是目标页；正文在 -- 之后。
        index = len(head) - 1 - head[::-1].index(positional)
        return head[:index] + head[index+1:] + ["--tab", positional, "--", tail[0]]
    return argv


def _target(namespace):
    positional = getattr(namespace, "target", None)
    if namespace.tab and positional and namespace.tab != positional:
        raise BrowserUseError("位置 target 与 --tab 不一致，未执行操作", 2)
    return namespace.tab or positional


def _context(namespace, target=None):
    session = choose_session(namespace.session, scope=namespace.scope)
    if namespace.local and namespace.host not in (None, "local"):
        raise BrowserUseError("--local不能与明确远端机器混用", 2, outcome="not_sent")
    return validate_context(session, namespace.browser or "Chrome", "local" if namespace.local else namespace.host)


_BATCH_FORBIDDEN = {"batch", "serve", "install"}


def _batch_items(text):
    if len(text.encode()) > 4 * 1024 * 1024:
        raise BrowserUseError("batch 输入超过 4MiB", 2)
    try:
        items = json.loads(text)
    except ValueError as exc:
        raise BrowserUseError(f"batch 需要 JSON 数组：{exc}", 2) from None
    if not isinstance(items, list) or not items or len(items) > 500:
        raise BrowserUseError("batch 需要 1~500 条命令的 JSON 数组", 2)
    for index, item in enumerate(items):
        if not isinstance(item, list) or not item or not all(isinstance(a, str) for a in item):
            raise BrowserUseError(f"第 {index} 条需要非空字符串数组，例如 [\"click\",\"TAB\",\"--id\",\"go\"]", 2)
        boundary = item.index("--") if "--" in item else len(item)
        if set(item[:boundary]) & _BATCH_FORBIDDEN:
            raise BrowserUseError(f"第 {index} 条不能嵌套 batch、serve 或 install", 2)
    return items


async def _batch(ns, argv, client):
    if ns.file:
        text = await asyncio.to_thread(Path(ns.file).expanduser().read_text, encoding="utf-8")
    else:
        text = await asyncio.to_thread(sys.stdin.read)
    items = _batch_items(text)
    # 外层的会话、机器、浏览器等选项作为每条的默认值；单条里显式写的选项排在后面，覆盖默认。
    prefix = []
    for option, value in (("--session", ns.session), ("--scope", ns.scope), ("--browser", ns.browser),
                          ("--host", ns.host), ("--socket", ns.socket), ("--rpc-timeout", ns.rpc_timeout),
                          ("--mode", ns.mode), ("--profile", ns.profile), ("--restart", ns.restart), ("--fallback", ns.fallback)):
        if value is not None:
            prefix += [option, str(value)]
    if ns.local:
        prefix.append("--local")
    shared = client or (Client(ns.socket) if ns.socket else None)
    results, failed = [], None
    for index, item in enumerate(items):
        # 选项必须放在文本分隔符 -- 之前，否则会被当成正文原样输入。
        boundary = item.index("--") if "--" in item else len(item)
        line = prefix + item[:boundary] + item[boundary:]
        try:
            value = await execute(line, client=shared)
            results.append({"index": index, "argv": item, "ok": True, "result": value})
        except BrowserUseError as exc:
            results.append({"index": index, "argv": item, "ok": False, **exc.as_dict()})
            failed = failed or exc
            if not ns.continue_on_error:
                break
    data = {"ok": failed is None, "total": len(items), "completed": len(results), "results": results}
    if failed is not None:
        first = next(r["index"] for r in results if not r["ok"])
        data.update(code=failed.code, error=f"第 {first} 条失败：{failed}", stoppedAt=None if ns.continue_on_error else first)
    return data


def install():
    cache = default_socket().parent
    prepare_socket_directory(default_socket())
    environment = cache / "venv"
    if environment.is_symlink():
        raise BrowserUseError("browser-use 环境路径不能是软链", 5)
    try:
        venv.EnvBuilder(with_pip=True).create(environment)
        proc = subprocess.run([str(environment / "bin" / "python"), "-m", "pip", "install", "websockets>=15,<17"],
                              capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BrowserUseError(f"创建依赖环境失败：{exc}；请检查 Python venv/pip", 5) from exc
    if proc.returncode:
        raise BrowserUseError(f"websockets 安装失败：{proc.stderr or proc.stdout}", 5)
    # 服务启动时才把这个环境加进搜索路径；装之前起的服务一直报缺依赖，代码指纹又没变，客户端不会让它换新，这里请它排空。
    try:
        service = "draining" if Client(autostart=False).service("drain")["supported"] else "old"
    except BrowserUseError:
        service = "not running"
    return dict(ok=True, environment=str(environment), dependency="websockets>=15,<17", service=service)


async def execute(argv, *, client=None):
    argv = list(argv)
    boundary = argv.index("--") if "--" in argv else len(argv)
    if "--capabilities" in argv[:boundary]:
        argv[argv.index("--capabilities")] = "capabilities"
    normalized = _normalize_options(argv)
    before = normalized[:normalized.index("--")] if "--" in normalized else normalized
    parser = build_parser(explicit_tab=any(arg == "--tab" or arg.startswith("--tab=") for arg in before))
    ns = parser.parse_args(_text_after_options(parser, normalized))
    if ns.local and ns.host not in (None, "local"):
        raise BrowserUseError("--local不能与明确远端机器混用", 2)
    if ns.command in {"use", "pin", "hosts"}:
        args = [ns.command]
        if getattr(ns, "machine", None):
            args.append(ns.machine)
        if getattr(ns, "clear", False):
            args.append("--clear")
        if ns.host is not None:
            args = ["-H", ns.host] + args
        if ns.local:
            args = ["--local"] + args
        return routing().control_target("browser-use", args)
    if ns.command == "session":
        return session_control(ns.operation, name=ns.name, scope=ns.scope, clear=ns.clear)
    if ns.command in {"version", "capabilities"}:
        from . import version, capabilities
        selected = validate_context("probe", ns.browser or "Chrome", "local" if ns.local else ns.host)[2]
        if selected != "local":
            from .transport import RemoteTransport
            return await asyncio.to_thread(RemoteTransport().probe, selected, timeout=ns.rpc_timeout)
        return {"ok": True, **await (version(host="local") if ns.command == "version" else capabilities(host="local"))}
    if ns.command == "diff":
        from .output import diff_text
        texts = []
        for name in (ns.before, ns.after):
            try:
                texts.append(await asyncio.to_thread(Path(name).expanduser().read_text, encoding="utf-8"))
            except FileNotFoundError:
                raise BrowserUseError(f"文件不存在：{name}", 3) from None
        return diff_text(*texts, context_lines=ns.context, from_label=ns.before, to_label=ns.after)
    if ns.command == "install":
        selected = validate_context("probe", ns.browser or "Chrome", "local" if ns.local else ns.host)[2]
        if selected != "local":
            raise BrowserUseError("远端依赖需在目标机显式运行 browser-use --local install；未改为安装本机", 5, host=selected, outcome="not_sent")
        return await asyncio.to_thread(install)
    if ns.command == "batch":
        return await _batch(ns, argv, client)
    if ns.command == "service":
        from .server import source_fingerprint
        caller = client or Client(ns.socket, autostart=False)
        try:
            info = await asyncio.to_thread(caller.service, "info")
        except BrowserUseError as exc:
            if exc.code == 5 and "未运行" in str(exc):
                return {"running": False, "localFingerprint": source_fingerprint()}
            raise
        return {"running": True, "localFingerprint": source_fingerprint(),
                "upToDate": info.get("supported") and info.get("fingerprint") == source_fingerprint(), **info}
    if ns.command == "serve":
        raise BrowserUseError("serve 只能通过独立 scripts/browser-use serve 启动，Python 接口不管理后台服务；普通操作会按需连接", 2)
    if ns.command == "lane":
        tokens = list(ns.tokens)
        operations = {"get", "set", "clear", "status"}
        ns.target = None
        if tokens[0] not in operations:
            ns.target = tokens.pop(0)
        if not tokens or tokens[0] not in operations or len(tokens) > 2:
            raise BrowserUseError("lane 用法：TAB set/get/clear [ENV]，或 lane status", 2)
        ns.operation = tokens[0]
        ns.env = tokens[1] if len(tokens) == 2 else None
        if ns.env is not None and ns.operation != "set":
            raise BrowserUseError(f"lane {ns.operation} 不收 ENV", 2)
    target = _target(ns)
    if getattr(ns, "snap", False) and (not target or ns.command in {"snap", "tab", "lane", "status", "up", "release", "disconnect"}):
        raise BrowserUseError("--snap 只用于针对确切页面的动作命令", 2, outcome="not_sent")
    if ns.command == "status" and not ns.session and not target:
        ns.session = "probe"
    session, browser, host = _context(ns, target)
    client = client or Client(ns.socket)
    context = dict(session=session, browser=browser, host=host, timeout=ns.rpc_timeout)
    async def call(action, params=None, *, target=target):
        return await client.acall(action, params, target=target, **context)
    if ns.command in ("release", "disconnect"):
        from . import _release_browsers
        async def each(name):
            return await client.acall(ns.command, target=None, **{**context, "browser": name})
        data = await _release_browsers(each, browser=ns.browser)
    elif ns.command in ("status", "up"):
        params = {k: v for k, v in {"mode": ns.mode, "profile": ns.profile, "restart": ns.restart, "fallback": ns.fallback}.items() if v is not None}
        data = await call(ns.command, params, target=None)
    elif ns.command in {"element", "debug", *SERVICES}:
        params = dict(ns.params)
        if ns.selector is not None:
            params["selector"] = ns.selector
        if ns.handle is not None:
            params["handle"] = ns.handle
        if ns.authorized:
            params["authorized"] = True
        if getattr(ns, "file", None) is not None:
            if ns.operation != "evaluate":
                raise BrowserUseError("--file 只用于 element evaluate", 2)
            if "function" in params:
                raise BrowserUseError("函数源码只能来自 --file 或 --params 之一", 2)
            source = await asyncio.to_thread(sys.stdin.read) if ns.file == "-" else Path(ns.file).expanduser().read_text(encoding="utf-8")
            params["function"] = source
        if not target:
            raise BrowserUseError("元素、调试与页面服务必须指定确切标签页", 2)
        await call("tab_bind")
        data = await call(ns.command + "_" + ns.operation.replace("-", "_"), params)
    elif ns.command == "tab":
        params = {k: v for k, v in {"mode": ns.mode, "profile": ns.profile, "restart": ns.restart, "fallback": ns.fallback}.items() if v is not None}
        if ns.operation == "new":
            params.update({k: getattr(ns, k) for k in ("url", "lane", "init_script", "capture", "executable", "headed", "new_window", "source_target") if getattr(ns, k) is not None})
            launch = {k: getattr(ns, k) for k in ("proxy", "proxy_bypass", "lang", "user_agent") if getattr(ns, k) is not None}
            if ns.ignore_https_errors:
                launch["ignore_https_errors"] = True
            if ns.window_size is not None:
                launch["window_size"] = [int(v) for v in ns.window_size]
            if launch:
                params["launch"] = launch
        if ns.operation == "new" and "lane" in params:
            params["lane"] = lane_params(params["lane"])
        if ns.operation == "find":
            params["query"] = ns.query
        if ns.operation in ("bind", "close", "recover") and not target:
            raise BrowserUseError("tab bind/close/recover 需要明确标签页 ID", 2)
        if ns.operation == "close":
            params["authorized"] = ns.authorized
        data = await call("tab_" + ns.operation, params, target=target if ns.operation in ("bind", "close", "recover") else None)
    elif ns.command == "lane":
        operation = ns.operation
        given = {k: getattr(ns, k) for k in ("env", "headers", "header", "value") if getattr(ns, k) is not None}
        if operation != "set" and given:
            raise BrowserUseError(f"lane {operation} 不收 ENV、--headers、--header、--value", 2)
        if operation == "status":
            data = await call("lane_status", target=target)
        else:
            if not target:
                raise BrowserUseError("lane set/get/clear 需要明确标签页 ID", 2)
            if operation == "set":
                if ns.env is None and ns.headers is None and (ns.header is None or ns.value is None):
                    raise BrowserUseError("lane set 需要 ENV、--headers 或 --header/--value", 2)
                if ns.env is not None and given.keys() == {"env"}:
                    given = lane_params(ns.env)
            await call("tab_bind")
            data = await call("lane_" + operation, given)
    else:
        if not target:
            raise BrowserUseError("网页动作必须明确标签页 ID，不能操作活动页面", 2)
        await call("tab_bind")
        if ns.command == "login":
            from . import Page, login
            p = Page(target, session=session, browser=browser, host=host)
            p._bound = True
            async def rpc(action, params=None, **kwargs):
                return await client.acall(action, params, **kwargs)
            p._rpc = rpc
            data = await login(p, account=ns.account, field=ns.field, timeout=ns.timeout, native_window=ns.native_window)
        elif ns.command == "network":
            params = dict(ns.params)
            params.update({k: getattr(ns, k) for k in ("limit","url","method","headers") if getattr(ns, k) is not None})
            if ns.raw:
                params["raw"] = True
            if ns.body:
                params["body"] = True
            if ns.action is not None:
                params["action"] = {"block": "abort", "headers": "continue", "fulfill": "fulfill", "response-transform": "response_transform"}[ns.action]
            if ns.status_code is not None:
                params["status"] = ns.status_code
            if ns.response_body is not None:
                params["body"] = ns.response_body
            if ns.status is not None:
                if ns.operation != "requests":
                    raise BrowserUseError("--status 仅用于 requests 筛选；模拟响应状态用 --status-code", 2)
                if ns.status_code is not None:
                    raise BrowserUseError("--status 不能和 --status-code 混用", 2)
                params["status"] = ns.status
            operation = ns.operation.replace("-", "_")
            if ns.password_stdin:
                if operation != "auth_set":
                    raise BrowserUseError("--password-stdin 只用于 network auth-set", 2)
                if "password" in params:
                    raise BrowserUseError("密码只从标准输入读，不要同时放进 --params", 2)
                params["password"] = (await asyncio.to_thread(sys.stdin.read)).rstrip("\r\n")
            elif operation == "auth_set" and "password" in params:
                raise BrowserUseError("密码不要写在命令行参数里（会进进程列表和 shell 历史）；用 --password-stdin", 6)
            if ns.value is not None and operation != "har_stop":
                if NETWORK[operation] is None:
                    raise BrowserUseError("该网络操作不接受位置 value 参数", 2)
                params[NETWORK[operation]] = ns.value
            out = ns.out or (ns.value if operation == "har_stop" else None)
            if out is not None and operation != "har_stop":
                raise BrowserUseError("--out 仅用于 network har-stop", 2)
            if out is None:
                data = await call("network_"+operation, params)
            else:
                # 停止录制会清掉服务端的记录，所以先确认能独占建出输出文件，再发停止。
                path = Path(out).expanduser()
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                stream = os.fdopen(fd, "w", encoding="utf-8")
                try:
                    with stream:
                        data = await call("network_"+operation, params)
                        if "har" not in data:
                            raise BrowserUseError("服务未返回 HAR，未写文件", 1)
                        json.dump(data["har"], stream, ensure_ascii=False, allow_nan=False)
                except BaseException:
                    path.unlink(missing_ok=True)
                    raise
                data["path"] = str(path.absolute())
        else:
            action = COMMANDS[ns.command]
            values = {arg.dest: getattr(ns, arg.dest) for arg in action.cli_args()}
            params = action.params(values)
            name = action.name
            if ns.command == "click":
                if sum(params.get(k) is not None for k in ("idx","id","label","at","selector")) != 1:
                    raise BrowserUseError("click 需要 idx/id/label/selector/at 五选一", 2)
            if params.get("idx") is not None and not params.get("snapshot"):
                raise BrowserUseError("编号操作必须传 --snapshot TOKEN；先 snap 取态", 4)
            if ns.command == "init":
                name = "init_"+ns.operation
                params = {"script" if ns.operation == "add" else "identifier": ns.value}
            limit = action.cli_timeout(values) if action.cli_timeout else None
            if limit is not None:
                context["timeout"] = max(context["timeout"], limit)
            data = await call("page_"+name, params)
    if getattr(ns, "snap", False):
        snapshot = await call("page_snap", {"shot": False, "max": 120})
        data = {"result": data} if not isinstance(data, dict) else dict(data)
        if isinstance(snapshot, dict) and "laneWarning" in snapshot:
            data.setdefault("laneWarning", snapshot.pop("laneWarning"))
        data["snap"] = snapshot
    if isinstance(data, dict):
        return {**data, "ok": True}
    return dict(ok=True, result=data)


def _wants_json(argv):
    before = argv[:argv.index("--")] if "--" in argv else argv
    return "--json" in before


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    json_mode = _wants_json(argv)
    try:
        result = asyncio.run(execute(argv))
        if not json_mode and isinstance(result.get("laneWarning"), dict):
            print("browser-use 警告：" + result["laneWarning"]["text"], file=sys.stderr)
        if json_mode:
            print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        elif "elements" in result:
            from . import Snap
            print(Snap(result).table())
            if result.get("shot"):
                print(result["shot"])
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok", True) else result.get("code", 1)
    except BrowserUseError as exc:
        if json_mode:
            print(json.dumps(exc.as_dict(), ensure_ascii=False))
        else:
            print(f"browser-use：{exc}", file=sys.stderr)
        return exc.code if isinstance(exc.code, int) else 1
    except (ValueError, TypeError) as exc:
        error = BrowserUseError(str(exc), 2)
        if json_mode:
            print(json.dumps(error.as_dict(), ensure_ascii=False))
        else:
            print(f"browser-use：{exc}", file=sys.stderr)
        return 2
    except ModuleNotFoundError as exc:
        message = f"缺少依赖 {exc.name}；请运行 browser-use install 安装 websockets>=15,<17 到专用环境"
        if json_mode:
            print(json.dumps(dict(ok=False, error=message, code=5), ensure_ascii=False))
        else:
            print(message, file=sys.stderr)
        return 5
    except OSError as exc:
        if json_mode:
            print(json.dumps(dict(ok=False, error=str(exc), code=5), ensure_ascii=False))
        else:
            print(f"browser-use：{exc}", file=sys.stderr)
        return 5
    except KeyboardInterrupt:
        print("browser-use：已停止等待；已发动作可能继续，请先取态核对，未自动重试", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
