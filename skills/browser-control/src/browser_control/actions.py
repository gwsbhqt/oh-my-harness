"""页面动作参数表：browser-control 的页面命令和 Python 页面函数都按这张表生成。

每条写一个页面动作：服务端动作名（发送时加 page_ 前缀）、命令行写法、Python 函数签名、
两边名字与服务端字段不同时的对照、发送前的取值转换、Python 返回值怎么取、RPC 等多久。
命令行和 Python 的默认值与超时本来就不完全一样（例如 page-text 命令行不写 --max-chars 就不发，
Python 默认发 20000），所以两边分开写；同名参数对应同一个服务端字段。
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from typing import Callable


def point(value):
    try:
        x, y = value.split(",")
        return [float(x), float(y)]
    except (ValueError, TypeError):
        raise argparse.ArgumentTypeError("坐标需要 X,Y") from None


def json_list(value):
    try:
        result = json.loads(value)
    except ValueError:
        raise argparse.ArgumentTypeError("需要有效 JSON 数组") from None
    if not isinstance(result, list):
        raise argparse.ArgumentTypeError("需要 JSON 数组")
    return result


def json_object(value):
    try:
        result = json.loads(value)
    except ValueError:
        raise argparse.ArgumentTypeError("需要有效 JSON 对象") from None
    if not isinstance(result, dict):
        raise argparse.ArgumentTypeError("需要 JSON 对象")
    return result


class Arg:
    """一个命令行参数；names 和其余关键字原样交给 argparse 的 add_argument。"""
    def __init__(self, *names, **options):
        self.names, self.options = names, options

    @property
    def dest(self):
        if "dest" in self.options:
            return self.options["dest"]
        name = next((n for n in self.names if n.startswith("--")), self.names[0])
        return name.lstrip("-").replace("-", "_")


class Group:
    """命令行互斥参数组。"""
    def __init__(self, *args, required=False):
        self.args, self.required = args, required


@dataclass
class Action:
    name: str                                       # 服务端动作名
    cli: str | None = None                          # 命令名；None 表示只有 Python 函数
    help: str = ""                                  # 命令说明
    args: tuple = ()                                # 命令行参数，顺序就是 --help 里的顺序
    python: str | None = None                       # Python 函数，写法和 def 那一行一样；None 表示只有命令
    doc: str | None = None                          # Python 函数文档
    fields: dict = field(default_factory=dict)      # 命令行 dest 或 Python 参数名 → 服务端字段名，只写不同的
    convert: dict = field(default_factory=dict)     # 参数名 → 发送前的取值转换
    locate: str | None = None                       # Python 的定位参数：optional 至多一个，required 恰好一个
    body: str | None = None                         # 可以写在 -- 之后原样传入的位置参数
    result: Callable | None = None                  # Python 返回值从服务端结果里怎么取
    timeout: Callable | None = None                 # Python 的 RPC 等待秒数，按参数取值算；None 用默认 60
    cli_timeout: Callable | None = None             # 命令行的 RPC 等待下限，算出 None 时保持 --rpc-timeout

    def cli_args(self):
        """命令行参数，互斥组展开。"""
        return [arg for item in self.args for arg in (item.args if isinstance(item, Group) else (item,))]

    def params(self, values):
        """参数名到取值的映射 → 服务端参数：先转换取值，再换成服务端字段名，去掉 None。"""
        sent = {self.fields.get(k, k): self.convert[k](v) if k in self.convert else v for k, v in values.items()}
        return {k: v for k, v in sent.items() if v is not None}

    @property
    def function_name(self):
        return self.python.partition("(")[0]

    def collector(self):
        """把表里的 Python 写法变成同签名的真函数，调用时返回收到的全部参数。

        用真函数而不是自己解析签名，是为了参数写错时 Python 报出的错误文字和手写函数一字不差。
        """
        namespace = {"__name__": __package__}
        exec(f"def {self.python}:\n    return locals()", namespace)
        return namespace[self.function_name]


def _locate(selector_help=None):
    """type、key、type-keys、edit 共用的命令行定位参数。"""
    return (Arg("--id"), Arg("--label"), Arg("--selector", type=json_object, help=selector_help),
            Arg("--idx", type=int), Arg("--snapshot"))


_LOCATE = "idx=None, id=None, label=None, selector=None, snapshot=None"
_POSITION = Arg("--position", choices=("cursor", "start", "end"),
                help="插到哪里：不给或 cursor 是当前光标处，start 元素开头，end 元素末尾")
_NAVIGATION = (Arg("--timeout", type=float), Arg("--before-unload", choices=("report", "accept", "dismiss")))
_BUTTONS = ("left", "middle", "right")


def _optional_path(value):
    return None if value is None else str(value)


def _files(files):
    return [str(f) for f in files]


def _plus(seconds):
    """服务端 timeout 再多等 seconds 秒。"""
    return lambda values: values["timeout"] + seconds


def _given_plus(seconds):
    """给了服务端 timeout 时再多等 seconds 秒，没给时不改。"""
    return lambda values: None if values["timeout"] is None else values["timeout"] + seconds


def _navigation_time(values):
    return (values["timeout"] or 30) + 30


def _typing_time(values):
    text, delay = values["text"], values["delay_ms"]
    return 60 + len(text) * delay / 1000 if isinstance(text, str) and isinstance(delay, (int, float)) else 60


def _snap_result(data):
    from . import Diff, Snap
    return Diff(data) if data.get("mode") == "diff" else Snap(data)


def _dict_result(read):
    return lambda data: read(data) if isinstance(data, dict) else data


ACTIONS = (
    Action("snap", "snap", "取态：元素与快照凭证，默认不截图",
           (Arg("--shot", action="store_true", help="同时截图"), Arg("--diff", action="store_true"),
            Arg("--all", action="store_true"), Arg("--max", type=int, default=300), Arg("--depth", type=int),
            Arg("--out"), Arg("--shrink", type=int, default=1400),
            Arg("--within", help="只看这个唯一 CSS 容器内的元素"),
            Arg("--interactive-only", action="store_true", default=None, help="只列可交互元素"),
            Arg("--include-urls", action="store_true", default=None, help="链接带绝对 url"),
            Arg("--ax-properties", action="store_true", default=None, help="附带无障碍属性与描述")),
           "snap(target, *, shot=False, diff=False, all=False, max=300, depth=None, out=None, shrink=1400, within=None, "
           "interactive_only=None, include_urls=None, ax_properties=None, browser=None, host=None, session=None)",
           convert={"out": _optional_path}, result=_snap_result),
    Action("click", "click", "按 DOM id、标签、编号、元素条件或页面坐标点击",
           (Arg("idx", nargs="?", type=int),
            Group(Arg("--id"), Arg("--label"),
                  Arg("--selector", type=json_object, help='元素条件 JSON，如 {"text":"提交"}、{"css":"#a"}、{"placeholder":"邮箱"}'),
                  Arg("--at", type=point)),
            Arg("--count", type=int, default=1), Arg("--button", choices=_BUTTONS, default="left"), Arg("--snapshot"),
            Arg("--position", choices=("center", "top-left"), help="点元素的哪里：不给或 center 点中心，top-left 点内容区左上角往里 4 像素")),
           "click(target, idx=None, *, id=None, label=None, selector=None, at=None, count=1, button='left', snapshot=None, "
           "position=None, **context)",
           locate="required"),
    Action("type", "type", "向当前页面输入原样文本",
           (Arg("text"), Arg("--allow-newline", action="store_true", help="显式允许换行，避免意外提交"), _POSITION,
            *_locate("元素条件 JSON")),
           f"type_text(target, text, *, allow_newline=False, position=None, {_LOCATE}, **context)", locate="optional", body="text"),
    Action("key", "key", "向页面发送按键", (Arg("keys"), *_locate("元素条件 JSON")),
           f"key(target, keys, *, {_LOCATE}, **context)", locate="optional", body="keys"),
    Action("goto", "goto", "导航到 URL", (Arg("url"), *_NAVIGATION),
           "goto(target, url, *, timeout=None, before_unload=None, **context)", body="url",
           timeout=_navigation_time, cli_timeout=_given_plus(30)),
    Action("eval", "eval", "执行 JavaScript 并返回 JSON 值", (Arg("expression"),),
           "evaluate(target, expression, **context)", body="expression",
           result=lambda data: data.get("value") if isinstance(data, dict) and "value" in data else data),
    Action("type_keys", "type-keys", "逐键输入，页面能收到每个按键事件",
           (Arg("text"), Arg("--delay-ms", type=int, default=0), Arg("--allow-newline", action="store_true"), _POSITION, *_locate()),
           f"type_keys(target, text, *, delay_ms=0, allow_newline=False, position=None, {_LOCATE}, **context)",
           "逐键发送，页面能收到 keydown/keypress/keyup；适合监听按键的输入框。",
           locate="optional", body="text", timeout=_typing_time, cli_timeout=_typing_time),
    Action("key_down", "key-down", "按住或松开单个键；按住的修饰键影响后续按键和鼠标", (Arg("key"),),
           "key_down(target, key, **context)"),
    Action("key_up", "key-up", "按住或松开单个键；按住的修饰键影响后续按键和鼠标", (Arg("key"),),
           "key_up(target, key, **context)"),
    # 命令行参数名不能叫 command（子命令已经占用），所以用 edit_command；命令行写 select-all，服务端要 select_all。
    Action("edit", "edit", "编辑命令：copy、cut、paste、select-all、undo、redo；复制粘贴只在无界面 Chrome",
           (Arg("edit_command", metavar="COMMAND", choices=("copy", "cut", "paste", "select-all", "undo", "redo")), *_locate()),
           f"edit(target, command, *, {_LOCATE}, **context)",
           "copy/cut/paste/select_all/undo/redo；复制剪切粘贴只在无界面 Chrome 可用，不碰系统剪贴板；"
           "undo/redo 是浏览器自己的撤销重做，返回撤销后的值。",
           fields={"edit_command": "command"}, convert={"edit_command": lambda value: value.replace("-", "_")},
           locate="optional"),
    Action("mouse_move", "mouse-move", "移动鼠标到页面坐标",
           (Arg("x", type=float), Arg("y", type=float), Arg("--steps", type=int)),
           "mouse_move(target, x, y, *, steps=1, **context)"),
    *(Action(name.replace("-", "_"), name, "按下或松开鼠标键；省略坐标用上次位置",
             (Arg("--x", type=float), Arg("--y", type=float), Arg("--button", choices=_BUTTONS), Arg("--click-count", type=int)),
             f"{name.replace('-', '_')}(target, x=None, y=None, *, button='left', click_count=1, **context)")
      for name in ("mouse-down", "mouse-up")),
    Action("wheel", "wheel", "滚轮滚动",
           (Arg("--dx", type=float), Arg("--dy", type=float), Arg("--x", type=float), Arg("--y", type=float)),
           "wheel(target, dx=None, dy=None, *, x=None, y=None, **context)"),
    Action("page_info", "page-info", "网址、标题、加载状态、视口与滚动位置", (),
           "page_info(target, **context)", "网址、标题、加载状态、视口尺寸与滚动位置、是否有未处理对话框。"),
    Action("page_text", "page-text", "页面可见正文", (Arg("--max-chars", type=int), Arg("--frame")),
           "page_text(target, *, max_chars=20000, frame=None, **context)", "页面可见正文；truncated 表示超过 max_chars。"),
    Action("frames", "frames", "列出页面里的框架", (), "frames(target, **context)"),
    Action("fill_form", "fill-form", "按顺序填多个字段，出错即停",
           (Arg("--items", type=json_list, required=True,
                help='JSON 数组，每项 {"selector":{...},"value":...,"kind":"text|select|check|uncheck"}'),),
           "fill_form(target, items, **context)", "按顺序填多个字段，出错即停；items 每项 {selector, value, kind?, by?}。",
           timeout=lambda values: 60 + 2 * len(values["items"]) if isinstance(values["items"], list) else 60),
    Action("upload_via_chooser", "upload-chooser", "点击会弹出文件选择框的控件，填入明确文件",
           (Arg("files", nargs="+"), Arg("--selector", type=json_object), Arg("--id"), Arg("--label"),
            Arg("--idx", type=int), Arg("--snapshot"), Arg("--timeout", type=float)),
           f"upload_via_chooser(target, files, *, {_LOCATE}, timeout=5, **context)",
           "点击会弹出文件选择框的控件，拦截选择框并填入文件；适合没有可见 file input 的上传按钮。",
           convert={"files": _files}, locate="required", timeout=_plus(30), cli_timeout=_given_plus(30)),
    Action("set", "set", "给输入框赋值", (Arg("idx", type=int), Arg("--snapshot"), Arg("value")),
           "set_value(target, idx, value, *, snapshot=None, **context)"),
    Action("act", "act", "执行元素动作", (Arg("idx", type=int), Arg("--snapshot"), Arg("action")),
           "act(target, idx, action, *, snapshot=None, **context)"),
    Action("selecttext", "selecttext", "选中文本", (Arg("idx", type=int), Arg("--snapshot"), Arg("text")),
           "selecttext(target, idx, text, *, snapshot=None, **context)"),
    Action("read", "read", "读取元素全文", (Arg("idx", type=int), Arg("--snapshot"), Arg("--selected", action="store_true")),
           "read(target, idx, *, selected=False, snapshot=None, **context)",
           result=_dict_result(lambda data: data.get("text", ""))),
    Action("upload", "upload", "向文件输入框上传明确文件", (Arg("idx", type=int), Arg("--snapshot"), Arg("files", nargs="+")),
           "upload(target, idx, files, *, snapshot=None, **context)", convert={"files": _files}),
    Action("scroll", "scroll", "滚动页面或编号所在的滚动区域",
           (Arg("idx", type=int, nargs="?"), Arg("--direction", choices=("up", "down", "left", "right"), default="down"),
            Arg("--pages", type=float, default=1), Arg("--snapshot")),
           "scroll(target, idx=None, direction='down', *, pages=1, snapshot=None, **context)"),
    Action("drag", "drag", "在页面内拖拽，坐标为 X,Y", (Arg("start", type=point), Arg("end", type=point)),
           "drag(target, start, end, **context)", convert={"start": list, "end": list}),
    Action("wait", "wait", "等待业务文字、元素状态、网址、加载阶段或 JavaScript 条件",
           (Group(Arg("--label"), Arg("--text"), Arg("--expression"),
                  Arg("--selector", type=json_object, help="元素条件 JSON，配 --state"),
                  Arg("--url", help="主框架网址通配，如 '*/done*'"),
                  Arg("--load", choices=("domcontentloaded", "load", "networkidle")),
                  Arg("--any-text", action="append", help="多段文字任一出现；可重复"), required=True),
            Arg("--state", choices=("visible", "hidden", "attached", "detached")),
            Arg("--gone", action="store_true", default=None), Arg("--timeout", type=float, default=10)),
           "wait(target, label=None, *, gone=None, timeout=10, expression=None, text=None, selector=None, state=None, "
           "url=None, load=None, any_text=None, **context)",
           "等一个条件成立：label/text/expression/selector(+state)/url/load/any_text 七选一。",
           timeout=_plus(5), cli_timeout=_plus(5)),
    Action("shot", "shot", "网页截图",
           (Arg("--out"), Arg("--shrink", type=int, default=1400), Arg("--full-page", action="store_true"),
            Arg("--overwrite", action="store_true", help="显式允许覆盖截图文件"),
            Arg("--format", choices=("png", "jpeg", "webp")), Arg("--quality", type=int, help="jpeg/webp 质量 0~100")),
           "shot(target, *, out=None, shrink=1400, full_page=False, overwrite=False, format=None, quality=None, **context)",
           convert={"out": _optional_path}, result=_dict_result(lambda data: data.get("path", data.get("shot")))),
    Action("reload", "reload", "重新加载网页",
           (Arg("--bypass-cache", dest="ignore_cache", action="store_true"), *_NAVIGATION),
           "reload(target, *, bypass_cache=False, timeout=None, before_unload=None, **context)",
           fields={"bypass_cache": "ignore_cache"}, timeout=_navigation_time, cli_timeout=_given_plus(30)),
    *(Action(name, name, "网页历史导航", _NAVIGATION, f"{name}(target, *, timeout=None, before_unload=None, **context)",
             timeout=_navigation_time, cli_timeout=_given_plus(30))
      for name in ("back", "forward")),
    # 命令行 init 用第一个位置参数选服务端的 init_add 或 init_remove；Python 是两个函数。
    Action("init", "init", "新增或删除下次文档执行的初始化脚本",
           (Arg("operation", choices=("add", "remove")), Arg("value", help="脚本文本或脚本 identifier；原样文本用 --"))),
    Action("init_add", python="init_add(target, script, **context)"),
    Action("init_remove", python="init_remove(target, identifier, **context)"),
    Action("dialog", "dialog", "接受或拒绝网页弹窗",
           (Arg("--dismiss", dest="accept", action="store_false", default=True), Arg("--text")),
           "dialog(target, *, accept=True, text=None, **context)"),
    Action("viewport", "viewport", "设置页面视口大小",
           (Arg("width", type=int), Arg("height", type=int),
            Arg("--scale", dest="device_scale_factor", type=float, default=1), Arg("--mobile", action="store_true")),
           "viewport(target, width, height, *, scale=1, mobile=False, **context)", fields={"scale": "device_scale_factor"}),
    Action("download", "download", "查看下载、等待下载完成或设置私有 Chrome 下载目录",
           (Arg("action", choices=("list", "wait", "directory"), default="list", nargs="?"), Arg("--guid"),
            Arg("--timeout", type=float, default=10), Arg("--path")),
           "download(target, *, action='list', guid=None, timeout=10, path=None, **context)",
           convert={"path": _optional_path}, timeout=_plus(5), cli_timeout=_plus(5)),
    Action("popups", "popups", "只列出新弹窗的明确 targetId，不自动切换页面", (), "popups(target, **context)"),
)

COMMANDS = {action.cli: action for action in ACTIONS if action.cli}

# 网络操作 → 位置参数对应的服务端字段；None 表示该操作不收位置参数。
# websockets 只是命令行里的可选值，服务端没有这个操作（会报未知网络操作），Python 不提供。
NETWORK = {
    "requests": None, "request": "id", "request_body": "id", "clear": None, "har_start": None, "har_stop": None,
    "route": "pattern", "unroute": "routeId", "console": None, "errors": None, "websockets": None,
    "ws_frames": None, "ws_connections": None, "cache": None, "service_worker": None, "controls": None,
    "override": "pattern", "unoverride": "routeId", "console_message": "id", "headers_set": None,
    "headers_get": None, "headers_clear": None, "auth_set": None, "auth_clear": None,
}
NETWORK_PYTHON = {name: field for name, field in NETWORK.items() if name != "websockets"}

# 页面泳道的 Python 操作 → 位置参数对应的服务端字段。
LANE = {"get": None, "set": "env", "clear": None}

# 只做参数透传、由服务端严格校验的页面服务。
SERVICES = ("state", "inspect", "output")
