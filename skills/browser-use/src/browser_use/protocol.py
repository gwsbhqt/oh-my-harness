"""Contracts shared by the Cra and Chrome backends."""
from __future__ import annotations

import json
import math
from importlib.resources import files


CONTROL_SCHEMAS = json.loads(files(__package__).joinpath("control_tools.json").read_text(encoding="utf-8"))


TOOL_DESCRIPTIONS = {
    'tabs_list': '列出浏览器中的标签及其编号。',
    'tab_open': '打开一个网页，返回本次任务可使用的 tabId。默认后台打开。',
    'tab_show': '在浏览器窗口中显示标签。',
    'tab_close': '关闭指定的标签。',
    'tab_move': '在侧栏中移动标签。',
    'tab_update': '更新标签的标题、静音或休眠状态。',
    'folder_create': '在浏览器空间中建立文件夹。',
    'history_search': '按文字搜索浏览历史。',
    'site_notes': '读取或更新站点笔记。',
    'page_snapshot': '读取页面控件及其引用 ref，可按名称查询。',
    'page_read': '分段读取可见正文与链接。',
    'page_click': '在指定标签内点击一个控件或截图位置。',
    'page_fill': '替换输入框中的内容。',
    'page_type': '向指定控件或当前焦点输入文字。',
    'page_press': '向页面发送按键或组合键。',
    'page_hover': '把指针移到指定控件或截图位置。',
    'page_scroll': '以像素为单位向页面发送滚轮输入。',
    'page_select': '按值或可见名称选择选项。',
    'page_drag': '把源控件拖到指定的目标控件。',
    'page_wait': '等待网页就绪，并满足指定的网址、文字与元素条件。',
    'page_navigate': '在指定标签内打开网址。',
    'page_history': '后退、前进或刷新指定标签。',
    'page_dialog': '答复当前网页对话框。',
    'page_screenshot': '获取当前视口的截图。',
    'page_pdf': '把页面导出为 PDF。',
    'page_network': '查看该标签发出的网络请求摘要。',
    'page_console': '读取该标签的控制台记录。',
    'page_evaluate': '在此页面计算 JavaScript 表达式。',
    'page_upload': '将选择的本机文件附加到网页文件控件。',
    'page_download': '在无窗口标签内下载指定网址。',
    'download_status': '查看此前启动的下载进度。',
    'download_cancel': '取消指定的下载任务。',
    'page_batch': '在同一标签顺序执行一组网页操作。',
    'debug_console': '查看这张页面的控制台记录。',
    'debug_css_styles': '查看主文档中唯一匹配、可由 Google 快照定位的元素的 CSS 规则、优先级和来源。',
    'debug_element_screenshot': '按唯一 CSS 选择器截取主文档元素的 PNG 图片。目标须能在 Google 快照中定位。',
    'debug_network': '列出这张页面捕获的网络请求。',
    'debug_request': '查看指定请求的详细信息。',
    'debug_trace_start': '从这张页面开始记录性能。',
    'debug_trace_stop': '停止性能记录并返回结果。',
    'debug_heap_snapshot': '采集这张页面的内存快照到文件。',
}


class BrowserError(Exception):
    """A rejected call or an operation whose result could not be confirmed."""

    def __init__(self, code: str, message: str, *, outcome: str = "not_sent", data=None):
        super().__init__(message)
        self.code = code
        self.outcome = outcome
        self.data = data

    def as_dict(self):
        result = {"code": self.code, "message": str(self), "outcome": self.outcome}
        if self.data is not None:
            result["data"] = self.data
        return result


def validate(value, schema, path):
    """Validate the input schema features used by the two published tool sets."""
    kind = schema.get("type")
    valid = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "boolean": type(value) is bool,
        "integer": type(value) is int,
        "number": type(value) is int or (type(value) is float and math.isfinite(value)),
    }
    if kind and not valid[kind]:
        raise BrowserError("invalid_arguments", f"{path} expects {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise BrowserError("invalid_arguments", f"{path} must be one of {schema['enum']}")
    if kind == "object":
        missing = set(schema.get("required", ())) - value.keys()
        if missing:
            raise BrowserError("invalid_arguments", f"{path} requires {', '.join(sorted(missing))}")
        props = schema.get("properties", {})
        for key, item in value.items():
            if key in props:
                validate(item, props[key], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                raise BrowserError("invalid_arguments", f"Unknown option {path}.{key}")
    elif kind == "array":
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", math.inf):
            raise BrowserError("invalid_arguments", f"Invalid number of items in {path}")
        for idx, item in enumerate(value):
            validate(item, schema.get("items", {}), f"{path}[{idx}]")
    elif kind == "string" and not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf):
        raise BrowserError("invalid_arguments", f"Invalid length for {path}")
    elif kind in ("integer", "number") and not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
        raise BrowserError("invalid_arguments", f"{path} is outside the permitted range")


def mcp_result(value):
    if isinstance(value, dict) and isinstance(value.get("content"), list):
        return value
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, allow_nan=False)}]}


def checked_reply(name, reply):
    if not isinstance(reply, dict) or not isinstance(reply.get("content"), list):
        raise BrowserError("protocol_error", f"{name} returned an invalid MCP result", outcome="unknown")
    if reply.get("isError"):
        message = "\n".join(block.get("text", "") for block in reply["content"] if block.get("type") == "text")
        raise BrowserError("tool_error", message or f"{name} failed", outcome="unknown", data=reply)
    return reply


def native_value(name, reply):
    blocks = checked_reply(name, reply)["content"]
    if len(blocks) == 1 and blocks[0].get("type") == "text":
        text = blocks[0].get("text", "")
        try:
            return json.loads(text)
        except (ValueError, TypeError):
            return text
    return reply
