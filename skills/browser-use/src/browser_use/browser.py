"""One browser session, with Cra-style control and Google DevTools diagnostics."""
from __future__ import annotations

import asyncio
import os
from contextlib import AsyncExitStack
from copy import deepcopy
from functools import partial

from ._chrome import CHROME_TOOLS, ChromeControl
from .debugging import DEBUG_SCHEMAS, Debugger
from .mcp_client import StdioMcp, cra_command as make_cra_command, google_command as make_google_command
from .protocol import BrowserError, CONTROL_SCHEMAS, TOOL_DESCRIPTIONS, checked_reply, mcp_result, native_value, validate


# Cra's native MCP already implements the control API directly.
_BROWSER_ADAPTERS = {"cra": None, "chrome": ChromeControl}

FILE_TOOLS = {
    "compare_screenshots": {
        "type": "object", "additionalProperties": False, "required": ["baseline", "current"],
        "properties": {name: {"type": "string", "minLength": 1, "description": description}
                       for name, description in {
                           "baseline": "本机基准 PNG 路径。", "current": "本机待比较 PNG 路径。",
                           "output": "可选的新 PNG 路径，仅在同尺寸画面有差异时写入。",
                       }.items()},
    },
}
SCHEMAS = {**CONTROL_SCHEMAS, **DEBUG_SCHEMAS, **FILE_TOOLS}


class Browser:
    """Bind a task to one browser. Hold the object while using its tab IDs and refs."""

    def __init__(self, browser="cra", *, endpoint=None, local_files=False,
                 cra_executable=None, cra_socket=None, google_executable=None,
                 cra_command=None, google_command=None):
        if not isinstance(browser, str) or browser not in _BROWSER_ADAPTERS:
            raise BrowserError("invalid_arguments", f"browser must be {' or '.join(_BROWSER_ADAPTERS)}")
        if type(local_files) is not bool:
            raise BrowserError("invalid_arguments", "local_files must be a boolean")
        self.browser = browser
        self.endpoint = endpoint or os.environ.get(f"BROWSER_USE_{browser.upper()}_ENDPOINT")
        self._cra_argv = cra_command
        self._google_argv = google_command
        self._google_executable = google_executable
        self._cra_executable = cra_executable
        self._cra_socket = cra_socket
        self._cra_client = None
        self._google_client = None
        self._capture_client = None
        self._closed = False
        self._locks = {}
        self._opened_tabs = {}
        self._viewport_tabs = set()
        adapter = _BROWSER_ADAPTERS[browser]
        self._chrome = adapter(self._google, local_files=local_files) if adapter is not None else None
        self._debug = Debugger(self._google, cra=self._cra if self._chrome is None else None,
                               chrome_page_id=self._chrome.page_id if self._chrome else None, opened_tabs=self._opened_tabs)
        self._capture = Debugger(self._google_capture, cra=self._chrome.call if self._chrome else self._cra,
                                 opened_tabs=self._opened_tabs)

    def __getattr__(self, name):
        if name in SCHEMAS:
            return partial(self.call, name)
        raise AttributeError(name)

    def __dir__(self):
        return sorted(set(super().__dir__()) | set(SCHEMAS))

    @staticmethod
    def tools():
        """Return the same input schemas for either target, without connecting."""
        return [{"name": name, "description": TOOL_DESCRIPTIONS[name], "inputSchema": deepcopy(schema)}
                for name, schema in SCHEMAS.items()]

    def capabilities(self):
        """Report implemented tools. The selected browser and its permissions are checked on use."""
        supported = set(CHROME_TOOLS) | {"page_batch"} if self._chrome else set(CONTROL_SCHEMAS)
        return {"browser": self.browser, "control": sorted(supported),
                "unsupported": sorted(set(CONTROL_SCHEMAS) - supported),
                "debug": sorted(DEBUG_SCHEMAS), "files": sorted(FILE_TOOLS),
                "debugConfigured": bool(self.endpoint or self._google_argv)}

    async def _cra(self, name, arguments):
        if self._cra_client is None and self._cra_argv is None and not (self._cra_socket or self._cra_executable):
            try:
                from dsh_kernel import tools
            except ModuleNotFoundError as error:
                if error.name != "dsh_kernel":
                    raise
            else:
                tool = f"mcp__cra__{name}"
                if tool not in tools:
                    raise BrowserError("connection_failed", f"This DSH session has no Cra tool {name}")
                try:
                    reply = await tools[tool](arguments)
                except Exception as error:
                    raise BrowserError("tool_error", str(error), outcome="unknown") from error
                return native_value(name, reply)
        if self._cra_client is None:
            argv = self._cra_argv or make_cra_command(socket=self._cra_socket, executable=self._cra_executable)
            self._cra_client = StdioMcp(argv)
        reply = await self._cra_client.call(name, arguments)
        return native_value(name, reply)

    def _google_command(self):
        if not self.endpoint and not self._google_argv:
            raise BrowserError("connection_failed", f"Set an explicit debugging endpoint for {self.browser}")
        return self._google_argv or make_google_command(self.endpoint, executable=self._google_executable)

    async def _google(self, name, arguments):
        if self._google_client is None:
            self._google_client = StdioMcp(self._google_command())
        return checked_reply(name, await self._google_client.call(name, arguments))

    async def _google_capture(self, name, arguments):
        if self._capture_client is None:
            # Google's preview bounds apply even to files and are fixed at process startup.
            preview_flags = {"--screenshot-max-width=1280", "--screenshot-max-height=1280"}
            self._capture_client = StdioMcp([arg for arg in self._google_command() if arg not in preview_flags])
        return checked_reply(name, await self._capture_client.call(name, arguments))

    async def call(self, name, /, **arguments):
        """Run one tool against this browser. Submitted operations are never replayed."""
        if self._closed:
            raise BrowserError("session_closed", "This browser session is closed")
        if name not in SCHEMAS:
            raise BrowserError("unknown_tool", f"Unknown browser tool {name}")
        validate(arguments, SCHEMAS[name], name)
        tab = arguments.get("tabId")
        if tab is None:
            return await self._dispatch(name, arguments)
        lock = self._locks.setdefault(tab, asyncio.Lock())
        async with lock:
            if self._closed:
                raise BrowserError("session_closed", "This browser session is closed")
            return await self._dispatch(name, arguments)

    async def _dispatch(self, name, arguments):
        if name == "compare_screenshots":
            from .visual import compare_screenshots
            return await asyncio.to_thread(compare_screenshots, **arguments)
        if name == "debug_viewport":
            result = await self._capture.call(name, arguments)
            if "viewport" in arguments:
                self._viewport_tabs.add(arguments["tabId"])
            else:
                self._viewport_tabs.discard(arguments["tabId"])
            return result
        # Only the inspector which applied the viewport captures its device pixel ratio.
        if name == "debug_full_page_screenshot" or (
                name == "debug_element_screenshot" and arguments["tabId"] in self._viewport_tabs):
            return await self._capture.call(name, arguments)
        if name in DEBUG_SCHEMAS:
            return await self._debug.call(name, arguments)
        await self._debug.before_control(name, arguments)
        if self._chrome is None:
            result = await self._cra(name, arguments)
        elif name == "page_batch":
            result = await self._chrome_batch(arguments["tabId"], arguments["steps"])
        else:
            result = await self._chrome.call(name, arguments)
        if name == "tab_open" and isinstance(result, dict) and isinstance(result.get("tabId"), str):
            from .mock_responses import local_origin
            self._opened_tabs[result["tabId"]] = local_origin(arguments["url"])
        elif name == "tab_close":
            self._opened_tabs.pop(arguments["tabId"], None)
            self._viewport_tabs.discard(arguments["tabId"])
        return result

    async def _chrome_batch(self, tab, steps):
        output = []
        failed = False
        for index, step in enumerate(steps, 1):
            name = step["tool"]
            label = f"{index}. {name}"
            if failed:
                output.append({"type": "text", "text": f"{label}: not run"})
                continue
            try:
                if name not in CONTROL_SCHEMAS or not name.startswith("page_") or name == "page_batch":
                    raise BrowserError("invalid_arguments", f"Cannot run {name} in a page batch")
                args = {**step.get("arguments", {}), "tabId": tab}
                validate(args, CONTROL_SCHEMAS[name], name)
                result = mcp_result(await self._chrome.call(name, args))
                for block in result["content"]:
                    if block.get("type") == "text":
                        block = {**block, "text": f"{label}: {block['text']}"}
                    output.append(block)
            except BrowserError as error:
                failed = True
                output.append({"type": "text", "text": f"{label} failed: {error}"})
        return checked_reply("page_batch", {"content": output, "isError": failed})

    async def aclose(self):
        """Remove owned test responses and disconnect clients. Close task tabs explicitly with tab_close."""
        if not self._closed:
            self._closed = True
            async with AsyncExitStack() as pending:
                for lock in tuple(self._locks.values()):
                    await pending.enter_async_context(lock)
                try:
                    await self._debug.aclose()
                finally:
                    clients = (self._capture_client, self._google_client, self._cra_client)
                    await asyncio.gather(*(c.aclose() for c in clients if c is not None))

    async def __aenter__(self):
        if self._closed:
            raise BrowserError("session_closed", "This browser session is closed")
        return self

    async def __aexit__(self, *_):
        await self.aclose()
