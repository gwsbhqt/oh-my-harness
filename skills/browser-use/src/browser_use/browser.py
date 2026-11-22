"""One browser session, with Cra-style control and Google DevTools diagnostics."""
from __future__ import annotations

import asyncio
import os
from copy import deepcopy
from functools import partial

from .chrome import CHROME_TOOLS, ChromeControl
from .debugging import DEBUG_SCHEMAS, Debugger
from .mcp_client import StdioMcp, cra_command as make_cra_command, google_command as make_google_command
from .protocol import BrowserError, CONTROL_SCHEMAS, TOOL_DESCRIPTIONS, checked_reply, mcp_result, native_value, validate


SCHEMAS = {**CONTROL_SCHEMAS, **DEBUG_SCHEMAS}


class Browser:
    """Bind a task to one browser. Hold the object while using its tab IDs and refs."""

    def __init__(self, browser="cra", *, endpoint=None, local_files=False,
                 cra_executable=None, cra_socket=None, google_executable=None,
                 cra_command=None, google_command=None):
        if browser not in ("cra", "chrome"):
            raise BrowserError("invalid_arguments", "browser must be cra or chrome")
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
        self._closed = False
        self._locks = {}
        self._chrome = ChromeControl(self._google, local_files=local_files) if browser == "chrome" else None
        self._debug = Debugger(self._google, cra=self._cra if browser == "cra" else None,
                               chrome_page_id=self._chrome.page_id if self._chrome else None)

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
                "debug": sorted(DEBUG_SCHEMAS), "debugConfigured": bool(self.endpoint or self._google_argv)}

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

    async def _google(self, name, arguments):
        if self._google_client is None:
            if not self.endpoint and not self._google_argv:
                raise BrowserError("connection_failed", f"Set an explicit debugging endpoint for {self.browser}")
            argv = self._google_argv or make_google_command(self.endpoint, executable=self._google_executable)
            self._google_client = StdioMcp(argv)
        return checked_reply(name, await self._google_client.call(name, arguments))

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
        if name in DEBUG_SCHEMAS:
            return await self._debug.call(name, arguments)
        if self._chrome is None:
            return await self._cra(name, arguments)
        if name == "page_batch":
            return await self._chrome_batch(arguments["tabId"], arguments["steps"])
        return await self._chrome.call(name, arguments)

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
        """Disconnect the clients opened by this object. Close task tabs explicitly with tab_close."""
        if not self._closed:
            self._closed = True
            await asyncio.gather(*(c.aclose() for c in (self._google_client, self._cra_client) if c is not None))

    async def __aenter__(self):
        if self._closed:
            raise BrowserError("session_closed", "This browser session is closed")
        return self

    async def __aexit__(self, *_):
        await self.aclose()
