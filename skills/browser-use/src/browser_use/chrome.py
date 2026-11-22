"""Cra-shaped page controls backed by Chrome DevTools MCP v1.13.0."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from uuid import uuid4

from .input_actions import INPUT_TOOLS, perform, redacted_url
from .protocol import BrowserError


CHROME_TOOLS = (frozenset(INPUT_TOOLS) - {"page_scroll"}) | {
    "tabs_list", "tab_open", "tab_close", "tab_show", "page_read", "page_snapshot",
    "page_wait", "page_navigate", "page_history", "page_dialog", "page_screenshot",
    "page_network", "page_console", "page_evaluate",
}
_INTERACTIVE = {
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch",
    "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
    "option", "listbox", "treeitem", "heading", "Iframe",
}
_STATES = ("checked", "selected", "expanded", "disabled", "focused", "required", "level")
_EDITABLE = {"textbox", "searchbox", "combobox", "spinbutton"}
_TRANSIENT_FRAME_ERRORS = (
    "Execution context was destroyed", "Cannot find context", "Cannot find frame",
    "Cannot find default execution context", "Main document unavailable",
)
_HISTORY_ENTRY = "() => [location.href, performance.timeOrigin, window.navigation?.currentEntry?.key ?? null]"
_VIEWPORT = """() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    url: location.href, document: performance.timeOrigin, scrollX, scrollY,
    scale: visualViewport?.scale ?? 1, left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0})"""

# Each read slices in the browser's UTF-16 coordinate system.
_READ = r"""(offset) => {
    const text = document.body?.innerText ?? '';
    function boundary(s, i) {
        return i > 0 && i < s.length && s.charCodeAt(i - 1) >= 0xd800 &&
            s.charCodeAt(i - 1) <= 0xdbff && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff;
    }
    function cut(s, length) { return s.slice(0, boundary(s, length) ? length - 1 : length); }
    let start = Math.min(offset, text.length);
    if (boundary(text, start)) start++;
    let end = Math.min(start + 20000, text.length);
    if (boundary(text, end)) end--;
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
        if (a instanceof HTMLAnchorElement) links.push({text: cut(a.innerText, 150), url: cut(a.href, 1000)});
        if (links.length === 50) break;
    }
    return {title: cut(document.title, 500), url: location.href, text: text.slice(start, end),
        nextOffset: end < text.length ? end : null, links, contentTrust: 'untrusted'};
}"""
_WAIT = """(a) => {
    let target;
    if (a.selector) {
        try { target = document.querySelector(a.selector); }
        catch { return {invalidSelector: true}; }
    }
    if (document.readyState !== 'complete' || ('url' in a && location.href !== a.url) ||
        (a.text && !document.body?.innerText.includes(a.text))) return false;
    if (!a.selector) return true;
    if (a.state === 'attached') return !!target;
    if (a.state === 'detached') return !target;
    let visible = !!target?.getClientRects().length;
    for (let parent = target; parent && visible; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        visible = style.visibility === 'visible' && Number(style.opacity) !== 0;
    }
    return a.state === 'hidden' ? !visible : visible;
}"""


def _js_call(function, arg):
    return f"() => ({function})({json.dumps(arg, ensure_ascii=True, allow_nan=False)})"


def _unsupported(message):
    return BrowserError("unsupported", message)


def _bad_reply(tool, message):
    return BrowserError("protocol_error", f"{tool}: {message}", outcome="unknown")


def _structured(tool, reply):
    data = reply.get("structuredContent")
    if not isinstance(data, dict):
        if tool in {"new_page", "select_page", "close_page"}:
            raise _bad_reply(tool, "The action was sent but its structured page list is unavailable.")
        raise _unsupported(f"{tool} requires Chrome DevTools MCP --experimental-structured-content.")
    return data


def _text(reply):
    message = (reply.get("structuredContent") or {}).get("message")
    if isinstance(message, str):
        return message
    return "\n".join(block["text"] for block in reply["content"] if block.get("type") == "text")


def _evaluation_value(reply):
    # evaluate_script puts JSON.stringify's output inside a fenced block in message/text.
    marker = "Script ran on page and returned:\n```json\n"
    _, found, rest = _text(reply).partition(marker)
    payload, fence, _ = rest.partition("\n```")
    if not found or not fence:
        raise _bad_reply("evaluate_script", "Missing fenced JavaScript result.")
    if payload == "undefined":
        raise BrowserError("unsupported_result", "The JavaScript result has no JSON representation.", outcome="unknown")
    try:
        return json.loads(payload)
    except ValueError as exc:
        raise _bad_reply("evaluate_script", "Invalid JSON in the JavaScript result.") from exc


def _http_url(value):
    try:
        url = urlsplit(value)
        return url.scheme in {"http", "https"} and bool(url.hostname)
    except ValueError:
        return False


def _jpeg_size(encoded):
    try:
        data = base64.b64decode(encoded, validate=True)
    except (TypeError, ValueError, binascii.Error) as exc:
        raise _bad_reply("take_screenshot", "Invalid image encoding.") from exc
    if data[:2] == b"\xff\xd8":
        offset = 2
        while offset + 4 <= len(data) and data[offset] == 255:
            offset += 1
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset + 3 > len(data):
                break
            marker = data[offset]
            length = int.from_bytes(data[offset + 1:offset + 3], "big")
            if length < 2 or offset + 1 + length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 8:
                height = int.from_bytes(data[offset + 4:offset + 6], "big")
                width = int.from_bytes(data[offset + 6:offset + 8], "big")
                if width and height:
                    return width, height
            if marker in {0xDA, 0xD9}:
                break
            offset += length + 1
    raise _bad_reply("take_screenshot", "JPEG dimensions unavailable.")


@dataclass
class _Tab:
    id: str = field(default_factory=lambda: str(uuid4()))
    owned: bool = False
    url: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    refs: dict[str, str] = field(default_factory=dict)
    screenshot: tuple | None = None
    network_cursor: int | None = None
    console_cursor: dict[int, int] = field(default_factory=dict)


class ChromeControl:
    def __init__(self, google, *, local_files=False):
        self.google = google
        self.local_files = local_files
        self._pages: dict[int, _Tab] = {}
        self._handles: dict[str, int] = {}
        self._catalog_lock = asyncio.Lock()

    def _tab(self, page_id, *, web=False):
        if type(page_id) is not int or page_id not in self._pages:
            raise BrowserError("stale_tab", "The page is not bound to this session. List tabs again.")
        tab = self._pages[page_id]
        if web and not _http_url(tab.url):
            raise _unsupported("Page operations require an HTTP(S) tab.")
        return tab

    def _bound_id(self, tab_id):
        if not isinstance(tab_id, str) or tab_id not in self._handles:
            raise BrowserError("stale_tab", "Unknown or closed tabId in this session. List tabs again.")
        return self._handles[tab_id]

    def _sync_pages(self, tool, reply):
        data = _structured(tool, reply)
        rows = data.get("pages", [])
        if not isinstance(rows, list):
            raise _bad_reply(tool, "Invalid pages list.")
        ids = set()
        for row in rows:
            if (not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0
                    or row["id"] in ids or not isinstance(row.get("url"), str)
                    or type(row.get("selected")) is not bool):
                raise _bad_reply(tool, "Invalid page identity in the pages list.")
            ids.add(row["id"])
        if data.get("reconnected"):
            self._pages.clear()
            self._handles.clear()
        for old in self._pages.keys() - ids:
            del self._handles[self._pages.pop(old).id]
        for row in rows:
            page_id = row["id"]
            if page_id not in self._pages:
                tab = self._pages[page_id] = _Tab()
                self._handles[tab.id] = page_id
            self._pages[page_id].url = row["url"]
        return rows

    async def _refresh(self):
        return self._sync_pages("list_pages", await self.google("list_pages", {}))

    async def _resolve(self, tab_id, *, web):
        async with self._catalog_lock:
            self._bound_id(tab_id)
            await self._refresh()
            page_id = self._bound_id(tab_id)
            self._tab(page_id, web=web)
            return page_id

    async def page_id(self, tab_id: str) -> int:
        return await self._resolve(tab_id, web=True)

    async def _tabs_list(self):
        async with self._catalog_lock:
            rows = await self._refresh()
            result = []
            for row in rows:
                tab = self._tab(row["id"])
                item = {"id": tab.id, "url": row["url"], "title": row.get("title", ""), "owned": tab.owned}
                if not _http_url(row["url"]):
                    item["webPage"] = False
                # Google's 'selected' denotes its input context, not Chrome's visible tab.
                result.append(item)
            return result

    async def _open(self, args):
        url = args["url"]
        if not _http_url(url):
            raise BrowserError("invalid_arguments", "Only HTTP(S) URLs can be opened.")
        if "space" in args or args.get("windowless"):
            raise _unsupported("Chrome DevTools MCP cannot open Cra spaces or windowless tabs.")
        selected = args.get("select", False)
        if selected != args.get("activate", False):
            raise _unsupported("Chrome can open a background or foreground tab. It cannot separate select and activate.")
        async with self._catalog_lock:
            before = {row["id"] for row in await self._refresh()}
            reply = await self.google("new_page", {"url": url, "background": not selected})
            rows = self._sync_pages("new_page", reply)
            new = [row["id"] for row in rows if row["selected"] and row["id"] not in before]
            # A self-closing page may cause Google to report a different selected page.
            # v1.13 emits its selection-fallback notice only in text, before the page list.
            preamble = "\n".join(b["text"] for b in reply["content"] if b.get("type") == "text").split("## Pages", 1)[0]
            fallback = any(line.startswith("Note: the previously selected page ") for line in preamble.splitlines())
            if len(new) != 1 or fallback or reply["structuredContent"].get("reconnected"):
                raise _bad_reply("new_page", "The created page could not be identified. Inspect tabs before opening another.")
            tab = self._tab(new[0])
            tab.owned = True
            return {"tabId": tab.id, "status": "opened", "selected": selected}

    async def _close(self, page_id):
        if not self._tab(page_id).owned:
            raise _unsupported("Only a tab opened by this Chrome session can be closed.")
        async with self._catalog_lock:
            reply = await self.google("close_page", {"pageId": page_id})
            data = _structured("close_page", reply)
            if str(data.get("message", "")).startswith("The last open page cannot be closed."):
                raise BrowserError("close_refused", data["message"], outcome="unknown")
            rows = self._sync_pages("close_page", reply) if "pages" in data else await self._refresh()
            if any(row["id"] == page_id for row in rows):
                raise BrowserError("close_refused", _text(reply) or "Chrome kept the tab open.", outcome="unknown")
            return {"status": "closed"}

    async def _show(self, page_id, activate):
        if not activate:
            raise _unsupported("Chrome cannot show a tab in its window without bringing it forward. Set activate=true.")
        async with self._catalog_lock:
            reply = await self.google("select_page", {"pageId": page_id, "bringToFront": True})
            rows = self._sync_pages("select_page", reply)
            if not any(row["id"] == page_id and row["selected"] for row in rows):
                raise _bad_reply("select_page", "The selected page was not confirmed.")
            return {"status": "shown"}

    async def evaluate(self, page_id: int, function: str, uid: str | list[str] | None = None):
        self._tab(page_id, web=True)
        # An empty dialogAction interrupts evaluation and leaves a newly opened dialog pending.
        params = {"pageId": page_id, "function": function, "waitForStableDom": False, "dialogAction": ""}
        if uid is not None:
            params["args"] = [uid] if isinstance(uid, str) else list(uid)
        return _evaluation_value(await self.google("evaluate_script", params))

    async def uid_for(self, page_id: int, ref: str) -> str:
        uid = self._tab(page_id, web=True).refs.get(ref)
        if uid is None:
            raise BrowserError("stale_ref", "This ref is not current on this page. Take a fresh snapshot.")
        return uid

    async def snapshot(self, page_id: int, **options):
        tab = self._tab(page_id, web=True)
        extra = options.keys() - {"interactive", "query"}
        if extra:
            raise _unsupported("Unsupported snapshot option: " + ", ".join(sorted(extra)))
        reply = await self.google("take_snapshot", {"pageId": page_id})
        root = _structured("take_snapshot", reply).get("snapshot")
        if not isinstance(root, dict) or not root.get("role"):
            raise _bad_reply("take_snapshot", "Missing accessibility tree.")
        elements, current_refs = [], {}
        truncated = False
        size = frames = 0
        query = options.get("query", "").strip().casefold()
        stack = [(root, 0)]
        while stack:
            node, frame = stack.pop()
            role, name, uid = node.get("role", ""), node.get("name", ""), node.get("id")
            if not isinstance(name, str) or not isinstance(role, str):
                raise _bad_reply("take_snapshot", "Invalid accessibility node.")
            children = node.get("children", [])
            if not isinstance(children, list) or any(not isinstance(child, dict) for child in children):
                raise _bad_reply("take_snapshot", "Invalid accessibility children.")
            if role == "Iframe" and children:
                frames += 1
            if role not in _EDITABLE and not node.get("editable"):
                stack.extend((n, frame + (role == "Iframe")) for n in reversed(children))
            if role in {"generic", "none", "InlineTextBox"} or (frame and role == "RootWebArea"):
                continue
            row = {"role": role, "name": name[:500]}
            ref = None
            if isinstance(uid, str) and uid and role not in {"StaticText", "LineBreak"}:
                ref = f"e-{tab.id}-{uid}"
                if ref in tab.refs:
                    current_refs[ref] = uid
                row["ref"] = ref
            if truncated or (options.get("interactive") and role not in _INTERACTIVE):
                continue
            if query and query not in name.casefold() and query != role.casefold():
                continue
            if frame:
                row["frame"] = frame
            row.update((key, node[key]) for key in _STATES if key in node)
            size += len(json.dumps(row, ensure_ascii=False).encode("utf-8", errors="surrogatepass"))
            if len(elements) >= 600 or size > 120_000:
                truncated = True
                continue
            elements.append(row)
            if ref:
                current_refs[ref] = uid
        tab.refs = current_refs
        result = {"url": root.get("url", ""), "title": root.get("name", ""), "elements": elements, "truncated": truncated,
                  "frames": frames, "contentTrust": "untrusted"}
        if root.get("id"):
            result["document"] = f"e-{tab.id}-{root['id']}"
        if truncated:
            result["hint"] = "Narrow the snapshot with interactive or query."
        return result

    async def _wait(self, page_id, args):
        if ("state" in args and not args.get("selector")) or ("selector" in args and not args["selector"].strip()):
            raise BrowserError("invalid_arguments", "A selector state requires a nonempty CSS selector.")
        conditions = {k: args[k] for k in ("url", "text", "selector", "state") if k in args}
        probe = _js_call(_WAIT, conditions)
        loop = asyncio.get_running_loop()
        timeout = args.get("timeoutMs", 10_000) / 1000
        deadline = loop.time() + timeout
        try:
            # A zero timeout means one observation. A positive timeout also bounds a slow RPC.
            async with asyncio.timeout_at(deadline if timeout else None):
                while True:
                    try:
                        value = await self.evaluate(page_id, probe)
                    except BrowserError as exc:
                        if exc.code != "tool_error" or not any(part in str(exc) for part in _TRANSIENT_FRAME_ERRORS):
                            raise
                    else:
                        if value is True:
                            return {"status": "matched"}
                        if value == {"invalidSelector": True}:
                            raise BrowserError("invalid_arguments", "Invalid CSS selector.")
                        if value is not False:
                            raise _bad_reply("evaluate_script", "Invalid wait observation.")
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        break
                    await asyncio.sleep(min(0.1, max(0.01, remaining / 2)))
        except TimeoutError:
            pass
        raise BrowserError("timeout", "The requested page conditions did not match before the deadline.")

    async def _navigate(self, page_id, args):
        mode = args.get("action", "url")
        params = {"pageId": page_id, "type": mode, "handleBeforeUnload": "dismiss"}
        if mode == "url":
            if not _http_url(args["url"]):
                raise BrowserError("invalid_arguments", "Only HTTP(S) URLs can be opened.")
            params["url"] = args["url"]
        before = await self.evaluate(page_id, _HISTORY_ENTRY) if mode in {"back", "forward"} else None
        tab = self._tab(page_id)
        tab.screenshot = None
        tab.refs.clear()
        reply = await self.google("navigate_page", params)
        message = _text(reply)
        # navigate_page also returns ordinary successful MCP envelopes for navigation failures.
        if not message.startswith(("Successfully navigated ", "Successfully reloaded the page.")):
            raise BrowserError("navigation_failed", message or "Chrome did not confirm navigation.", outcome="unknown")
        if "Dismissed a beforeunload dialog." in message.splitlines():
            raise BrowserError("navigation_blocked", "Chrome dismissed a leave-site prompt and kept the page open.", outcome="unknown")
        if before is not None:
            try:
                after = await self.evaluate(page_id, _HISTORY_ENTRY)
            except BrowserError as exc:
                raise BrowserError("navigation_unconfirmed", "Could not verify the history entry after navigation.", outcome="unknown") from exc
            if before == after:
                raise BrowserError("no_history_entry", "Chrome did not move to another history entry.", outcome="unknown")
        return {"status": "navigation_requested"}

    async def _take_screenshot(self, page_id):
        tab = self._tab(page_id)
        tab.screenshot = None
        before = await self.evaluate(page_id, _VIEWPORT)
        reply = await self.google("take_screenshot", {"pageId": page_id, "format": "jpeg", "quality": 75})
        images = [b for b in reply["content"] if b.get("type") == "image" and b.get("mimeType") == "image/jpeg"]
        if len(images) != 1:
            # The server saves large screenshots to its own filesystem rather than attaching an image.
            raise BrowserError("image_unavailable", "Chrome did not attach an inline JPEG.", data={"message": _text(reply)})
        width, height = _jpeg_size(images[0].get("data"))
        after = await self.evaluate(page_id, _VIEWPORT)
        info = {"width": width, "height": height}
        if (isinstance(before, dict) and before == after and before.get("width", 0) > 0
                and before.get("height", 0) > 0 and before.get("scale") == 1
                and before.get("left") == 0 and before.get("top") == 0):
            tab.screenshot = (width, height, before)
            info["coordinates"] = "Use pixels of this image for x/y."
        else:
            info["coordinates"] = "Unavailable: the viewport changed or is zoomed."
        return {**reply, "content": [*reply["content"], {"type": "text", "text": json.dumps(info)}]}

    async def screenshot_point(self, page_id, x, y):
        screenshot = self._tab(page_id).screenshot
        if screenshot is None:
            raise BrowserError("stale_screenshot", "Take a screenshot of this page before targeting image pixels.")
        width, height, view = screenshot
        if not (math.isfinite(x) and math.isfinite(y) and 0 <= x < width and 0 <= y < height):
            raise BrowserError("invalid_arguments", "The point is outside the screenshot.")
        if await self.evaluate(page_id, _VIEWPORT) != view:
            raise BrowserError("stale_screenshot", "The page or viewport changed. Take a fresh screenshot.")
        return x * view["width"] / width, y * view["height"] / height

    async def _log_rows(self, tool, key, params, empty_message):
        reply = await self.google(tool, params)
        data = _structured(tool, reply)
        pagination = data.get("pagination", {})
        if pagination.get("hasNextPage") or pagination.get("hasPreviousPage") or pagination.get("invalidPage"):
            raise _bad_reply(tool, "Expected the complete retained log.")
        rows = data.get(key)
        if rows is None and empty_message in _text(reply).splitlines():
            return []
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise _bad_reply(tool, "Missing log records.")
        return rows

    async def _network(self, page_id, args):
        tab = self._tab(page_id)
        rows = await self._log_rows("list_network_requests", "networkRequests",
                                    {"pageId": page_id, "includePreservedRequests": True}, "No requests found.")
        if any(type(row.get("requestId")) is not int or not all(isinstance(row.get(key), str)
               for key in ("url", "method", "status")) for row in rows):
            raise _bad_reply("list_network_requests", "Invalid request identity or summary.")
        latest = max((row["requestId"] for row in rows), default=-1)
        start = tab.network_cursor
        requests = []
        if start is not None:
            for row in rows:
                if row["requestId"] <= start or (args.get("writesOnly") and row["method"] not in {"POST", "PUT", "PATCH", "DELETE"}):
                    continue
                requests.append({"method": row["method"], "url": redacted_url(row["url"]), "status": row["status"]})
        result = {"requests": requests[-100:], "count": len(requests), "contentTrust": "untrusted",
                  "captureScope": "Retained Chrome DevTools requests since the first call. The summary omits resource type."}
        if start is None:
            result["note"] = "Capture started with this call."
        if len(requests) > 100:
            result["truncated"] = "Showing the last 100."
        if args.get("clear"):
            result["clearScope"] = "This session's page_network view. Chrome DevTools retains its own history."
        if start is None or args.get("clear"):
            tab.network_cursor = max(start if start is not None else -1, latest)
        return result

    async def _console(self, page_id, args):
        tab = self._tab(page_id)
        rows = await self._log_rows("list_console_messages", "consoleMessages",
                                    {"pageId": page_id, "includePreservedMessages": True}, "<no console messages found>")
        level = args.get("level", "all")
        wanted = {"error", "assert"} if level == "error" else {"error", "assert", "warning"}
        entries, observed = [], {}
        count = 0
        for row in rows:
            msgid, occurrences = row.get("id"), row.get("count", 1)
            if type(msgid) is not int or type(occurrences) is not int or occurrences < 1:
                raise _bad_reply("list_console_messages", "Invalid grouped message identity or count.")
            observed[msgid] = occurrences
            additional = occurrences - tab.console_cursor.get(msgid, 0)
            kind = row.get("type")
            kind = "warning" if kind == "warn" else kind
            if additional <= 0 or (level != "all" and kind not in wanted):
                continue
            item = {"level": kind, "text": (row.get("text") or row.get("title") or "")[:2000]}
            if additional > 1:
                item["count"] = additional
            entries.append(item)
            count += additional
        if args.get("clear"):
            tab.console_cursor = observed
        result = {"entries": entries[-100:], "count": count, "contentTrust": "untrusted",
                  "captureScope": "Retained Chrome DevTools messages, with consecutive duplicates grouped."}
        if len(entries) > 100:
            result["truncated"] = "Showing the last 100 groups."
        if args.get("clear"):
            result["clearScope"] = "This session's page_console view. Chrome DevTools retains its own history."
        return result

    async def call(self, name, arguments):
        if name not in CHROME_TOOLS:
            raise _unsupported(f"Chrome DevTools MCP v1.13.0 does not provide {name} with Cra semantics.")
        if name == "tabs_list":
            return await self._tabs_list()
        if name == "tab_open":
            return await self._open(arguments)
        tab_id = arguments["tabId"]
        tab = self._tab(self._bound_id(tab_id))
        # Hold the same lock over the entire input sequence, including before/after observations.
        async with tab.lock:
            if name in INPUT_TOOLS:
                return await perform(self, name, arguments)
            page_id = await self._resolve(tab_id, web=name not in {"tab_close", "tab_show"})
            if name == "tab_close":
                return await self._close(page_id)
            if name == "tab_show":
                return await self._show(page_id, arguments.get("activate", False))
            if name == "page_snapshot":
                return await self.snapshot(page_id, **{k: v for k, v in arguments.items() if k != "tabId"})
            if name == "page_read":
                return await self.evaluate(page_id, _js_call(_READ, arguments.get("offset", 0)))
            if name == "page_wait":
                return await self._wait(page_id, arguments)
            if name in {"page_navigate", "page_history"}:
                return await self._navigate(page_id, arguments)
            if name == "page_screenshot":
                return await self._take_screenshot(page_id)
            if name == "page_network":
                return await self._network(page_id, arguments)
            if name == "page_console":
                return await self._console(page_id, arguments)
            if name == "page_dialog":
                params = {k: v for k, v in arguments.items() if k != "tabId"}
                if params["action"] == "dismiss" and "promptText" in params:
                    raise _unsupported("A dismissed prompt cannot accept prompt text.")
                reply = await self.google("handle_dialog", {"pageId": page_id, **params})
                status = "accepted" if params["action"] == "accept" else "dismissed"
                if _text(reply).splitlines()[:1] != [f"Successfully {status} the dialog"]:
                    raise _bad_reply("handle_dialog", "The dialog action was not acknowledged.")
                return {"status": status}
            if name == "page_evaluate":
                reply = await self.google("evaluate_script", {"pageId": page_id, "function": arguments["expression"],
                                                              "format": "script", "waitForStableDom": False, "dialogAction": ""})
                value = _evaluation_value(reply)
                js_type = {str: "string", bool: "boolean", int: "number", float: "number"}.get(type(value), "object")
                return {"result": {"type": js_type, "value": value}, "contentTrust": "untrusted"}
        raise _unsupported(f"Unsupported Chrome control: {name}")
