"""Cra 官方 MCP 的原始调用和后台任务标签。"""
from __future__ import annotations

import asyncio
import json
import re

from .errors import BrowserUseError


async def cra(tool: str, /, **arguments):
    """调用当前 DSH Python 格已注册的 Cra 官方 MCP 工具，原样返回回执。"""
    if not isinstance(tool, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", tool):
        raise BrowserUseError("请传入 Cra 官方工具名，例如 tab_open", 2, outcome="not_sent")
    try:
        from dsh_kernel import tools
    except ModuleNotFoundError as exc:
        if exc.name != "dsh_kernel":
            raise
        raise BrowserUseError("Cra 入口需要 DSH Python 技能内核及当前会话中的 Cra MCP 工具", 5,
                              outcome="not_sent") from None
    name = f"mcp__cra__{tool}"
    if name not in tools:
        raise BrowserUseError(
            f"当前 DSH Python 格未提供 {name}；请检查 Cra MCP 的连接和授权。恢复后在新的 Python 格核对工具。",
            5, outcome="not_sent", command=tool,
        )
    return await tools[name](arguments)


def _json_reply(tool, reply):
    try:
        blocks = reply["content"]
        if reply.get("isError"):
            raise BrowserUseError(blocks[0]["text"], command=tool, data=reply)
        if len(blocks) != 1 or blocks[0]["type"] != "text":
            raise ValueError("expected one text block")
        data = json.loads(blocks[0]["text"])
        if not isinstance(data, dict):
            raise ValueError("expected a JSON object")
        return data
    except (AttributeError, IndexError, KeyError, TypeError, ValueError) as exc:
        raise BrowserUseError(f"Cra 的 {tool} 未返回预期的 JSON 回执", 4,
                              outcome="unknown", command=tool, data={"receipt": reply}) from exc


class CraSnapshot:
    """保留 Cra 快照及其原生元素引用。"""

    def __init__(self, data):
        self.data = data
        self.elements = data["elements"]
        self.url = data.get("url")
        self.truncated = data.get("truncated", False)

    def one(self, name=None, *, role=None):
        """按精确名称和角色查找唯一、可引用的元素。"""
        if self.truncated:
            raise LookupError("Cra 快照已截断，无法核对唯一元素；请用 query 缩小范围后重新取态")
        hits = [item for item in self.elements
                if (name is None or item.get("name") == name)
                and (role is None or item.get("role") == role)]
        if len(hits) != 1 or not hits[0].get("ref"):
            raise LookupError(f"Cra 控件 {name!r}（{role or '任意角色'}）有 {len(hits)} 项匹配，无法取得唯一引用")
        return hits[0]


class _CraTab:
    """仅由 open_cra_tab 创建，所有操作固定使用返回的标签 ID。"""

    def __init__(self, tab_id):
        self._tab_id = tab_id
        self._closed = False
        self._close_attempted = False
        self._lock = asyncio.Lock()

    @property
    def tab_id(self):
        return self._tab_id

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        if self._close_attempted:
            return
        try:
            await self.close()
        except Exception as cleanup_error:
            if exc is None:
                raise
            exc.add_note(f"Cra 任务标签 {self.tab_id} 关闭失败：{cleanup_error}")

    async def call(self, tool, /, **arguments):
        """调用当前标签的官方 page_* 工具，保留原始回执及媒体。"""
        if not isinstance(tool, str) or not tool.startswith("page_") or "tabId" in arguments:
            raise BrowserUseError("任务标签只接受 page_* 工具，tabId 由任务标签提供", 2, outcome="not_sent")
        async with self._lock:
            if self._closed:
                raise BrowserUseError("Cra 任务标签已经关闭", 4, outcome="not_sent", command=tool)
            return await cra(tool, tabId=self.tab_id, **arguments)

    async def snap(self, **arguments):
        result = _json_reply("page_snapshot", await self.call("page_snapshot", **arguments))
        if not isinstance(result.get("elements"), list):
            raise BrowserUseError("Cra 未返回页面快照", 4, command="page_snapshot", data=result)
        return CraSnapshot(result)

    async def click(self, **arguments):
        return _json_reply("page_click", await self.call("page_click", **arguments))

    async def fill(self, text, **arguments):
        return _json_reply("page_fill", await self.call("page_fill", text=text, **arguments))

    async def read(self, **arguments):
        return _json_reply("page_read", await self.call("page_read", **arguments))

    async def close(self):
        async with self._lock:
            if self._closed:
                return
            self._close_attempted = True
            result = _json_reply("tab_close", await cra("tab_close", tabId=self.tab_id))
            if result.get("status") != "closed":
                raise BrowserUseError("Cra 未确认任务标签已关闭", 4, outcome="unknown",
                                      command="tab_close", data=result)
            self._closed = True


async def open_cra_tab(url, *, space=None):
    """在本机 Cra 后台新开普通任务标签，沿用当前登录资料。"""
    arguments = {"url": url, "select": False, "activate": False}
    if space is not None:
        arguments["space"] = space
    result = _json_reply("tab_open", await cra("tab_open", **arguments))
    tab_id = result.get("tabId")
    if not isinstance(tab_id, str) or not tab_id:
        raise BrowserUseError("Cra 未返回新开的任务标签 ID", 4, outcome="unknown",
                              command="tab_open", data=result)
    return _CraTab(tab_id)
