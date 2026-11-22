"""Page-scoped diagnostics through one page-ID-routed Chrome DevTools MCP session.

Console and network data cover what Google collected for the page. Trace recording
uses one browser-wide recorder and can include events and screenshots from other
pages. Recording files and heap snapshots are written on the Google server's host.
"""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import sys
from urllib.parse import urlsplit

from .protocol import BrowserError, validate


_PAGE = {"type": "string", "minLength": 1, "description": "The tabId returned by the control backend."}
_PATH = {"type": "string", "minLength": 1}
_BOOL = {"type": "boolean"}
_PAGING = {
    "pageSize": {"type": "integer", "minimum": 1},
    "pageIdx": {"type": "integer", "minimum": 0, "description": "Zero-based index. Requires pageSize."},
}
_CONSOLE_TYPES = (
    "log debug info error warn dir dirxml table trace clear startGroup startGroupCollapsed "
    "endGroup assert profile profileEnd count timeEnd verbose issue"
).split()
_RESOURCE_TYPES = (
    "document stylesheet image media font script texttrack xhr fetch prefetch eventsource "
    "manifest signedexchange ping cspviolationreport preflight fedcm other"
).split()


def _schema(description, properties, *required):
    return {
        "type": "object", "description": description,
        "properties": {"tabId": _PAGE, **properties},
        "required": ["tabId", *required], "additionalProperties": False,
    }


DEBUG_SCHEMAS = {
    "debug_console": _schema("List console messages collected for this tab.", {
        **_PAGING, "types": {"type": "array", "items": {"type": "string", "enum": _CONSOLE_TYPES}},
        "includePreservedMessages": _BOOL, "includeStackTraces": _BOOL,
    }),
    "debug_network": _schema("List network requests collected for this tab.", {
        **_PAGING, "resourceTypes": {"type": "array", "items": {"type": "string", "enum": _RESOURCE_TYPES}},
        "includePreservedRequests": _BOOL,
    }),
    "debug_request": _schema("Inspect a request listed for this tab.", {
        "reqid": {"type": "integer", "minimum": 1, "description": "requestId from debug_network for the same tab."},
        "requestFilePath": _PATH, "responseFilePath": _PATH,
    }, "reqid"),
    "debug_trace_start": _schema("Start the browser-wide performance recorder from this tab. Only one recording can run.", {
        "reload": {"type": "boolean", "default": False},
        "autoStop": {"type": "boolean", "default": False, "description": "Stop after about five seconds and return the trace summary."},
        "ignoreCache": {"type": "boolean", "description": "Requires reload=true. Active network mocks already bypass the cache."},
        "filePath": {**_PATH, "description": "Save the recording on the Google MCP host. Requires autoStop=true here."},
    }),
    "debug_trace_stop": _schema("Stop the active recording started on this tab and return its summary.", {"filePath": _PATH}),
    "debug_heap_snapshot": _schema("Save a heap snapshot for this tab on the Google MCP host.", {"filePath": _PATH}, "filePath"),
}
DEBUG_TOOLS = frozenset(DEBUG_SCHEMAS)
_GOOGLE = {
    "debug_console": "list_console_messages", "debug_network": "list_network_requests",
    "debug_request": "get_network_request", "debug_trace_start": "performance_start_trace",
    "debug_trace_stop": "performance_stop_trace", "debug_heap_snapshot": "take_heapsnapshot",
}


def _text(reply):
    return "\n".join(block["text"] for block in reply["content"] if block.get("type") == "text")


def _message(reply):
    structured = reply.get("structuredContent")
    if isinstance(structured, dict) and isinstance(structured.get("message"), str):
        return structured["message"]
    return _text(reply)


def _check_connection(reply, *, outcome="unknown"):
    structured = reply.get("structuredContent")
    notice = "Note: the browser was restarted or reconnected since the last call. Page ids have changed."
    if (isinstance(structured, dict) and structured.get("reconnected") is True) or _text(reply).startswith(notice):
        raise BrowserError("connection_changed", "Google reported a browser reconnection during the call.", outcome=outcome)


def _valid_id(value):
    return type(value) is int and value > 0


def _page_ids(reply):
    _check_connection(reply, outcome="not_sent")
    structured = reply.get("structuredContent")
    if not isinstance(structured, dict):
        raise BrowserError("unsupported", "Cra tab binding requires Google MCP --experimental-structured-content.")
    pages = structured.get("pages", [])
    if not isinstance(pages, list):
        raise BrowserError("protocol_error", "Invalid Google page list.")
    ids = []
    for page in pages:
        if not isinstance(page, dict) or not _valid_id(page.get("id")) or not isinstance(page.get("url"), str):
            raise BrowserError("protocol_error", "Invalid page entry in the Google page list.")
        try:
            url = urlsplit(page["url"])
            if url.scheme in {"http", "https"} and url.hostname:
                ids.append(page["id"])
        except ValueError as exc:
            raise BrowserError("protocol_error", "Invalid URL in the Google page list.") from exc
    if len(set(ids)) != len(ids):
        raise BrowserError("protocol_error", "Duplicate page ID in the Google page list.")
    return ids


def _probe_result(reply):
    _check_connection(reply, outcome="not_sent")
    # v1.13.0 puts script results in a JSON fence, also inside structuredContent.message.
    blocks = re.findall(r"^Script ran on page and returned:\n```json\n([^\n]+)\n```$", _message(reply), re.MULTILINE)
    if len(blocks) == 1:
        try:
            value = json.loads(blocks[0])
        except ValueError:
            pass
        else:
            if value is None or isinstance(value, str):
                return value
    raise BrowserError("protocol_error", "Google returned an unrecognized document probe result.")


def _cra_value(reply):
    # Cra 0.1.53 page_evaluate returns the decoded object with result.value.
    result = reply.get("result") if isinstance(reply, dict) else None
    if not isinstance(result, dict) or "value" not in result:
        raise BrowserError("protocol_error", "Cra returned an unrecognized page_evaluate result.")
    return result["value"]


def _install_marker(key, owner):
    # Both official evaluators use the top document's main world. A non-enumerable
    # own property leaves the HTML, CSS and DOM mutation observers undisturbed.
    return f"""(() => {{
      const key = {json.dumps(key)}, owner = {json.dumps(owner)};
      if (Object.hasOwn(document, key)) return false;
      let answer = null, timer;
      const release = () => {{
        if (Object.getOwnPropertyDescriptor(document, key)?.value === marker) delete document[key];
        clearTimeout(timer);
        window.removeEventListener('pagehide', release);
      }};
      const marker = Object.freeze({{
        owner,
        probe(challenge) {{ answer = challenge; return owner; }},
        finish() {{ release(); return answer; }}
      }});
      Object.defineProperty(document, key, {{value: marker, configurable: true}});
      window.addEventListener('pagehide', release, {{once: true}});
      timer = setTimeout(release, 60000);
      return true;
    }})()"""


def _probe_marker(key, challenge):
    # Each page gets a distinct challenge. Only the Cra document knows the owner.
    return f"""() => {{
      const marker = Object.getOwnPropertyDescriptor(document, {json.dumps(key)})?.value;
      return typeof marker?.probe === 'function' ? marker.probe({json.dumps(challenge)}) : null;
    }}"""


def _finish_marker(key, owner):
    return f"""(() => {{
      const marker = Object.getOwnPropertyDescriptor(document, {json.dumps(key)})?.value;
      return marker?.owner === {json.dumps(owner)} ? marker.finish() : null;
    }})()"""


def _check_trace(reply, recording):
    lines = _message(reply).splitlines()
    # These three refusals are ordinary text results, without MCP isError, in 1.13.0.
    refusals = ("Error: a performance trace is already running.", "Error: no active performance trace recording to stop.",
                "Error: the active performance trace is running")
    for line in lines:
        if line.startswith(refusals):
            raise BrowserError("trace_state", line)
    expected = ("The performance trace is being recorded. Use performance_stop_trace to stop it." if recording
                else "The performance trace has been stopped.")
    if expected not in lines:
        raise BrowserError("protocol_error", "Google did not confirm the requested trace state.", outcome="unknown")


class Debugger:
    """Callables belong to one fixed Google MCP process with page ID routing enabled.

    Supply either a Cra native-tool callable for its explicitly configured instance,
    or ChromeControl's async tabId resolver. The caller converts MCP and transport
    errors to BrowserError. Successful calls preserve Google's complete MCP result.
    Binding uses a temporary document property discoverable by the page through
    reflection. It assumes the page cooperates with JavaScript evaluation.
    """

    def __init__(self, google, *, cra=None, chrome_page_id=None):
        self._google = google
        self._cra = cra
        self._chrome_page_id = chrome_page_id
        self._binding_lock = asyncio.Lock()

    async def _cra_page_id(self, tab_id):
        # Check that Google is available before touching the Cra document. Page IDs
        # are never cached. Google keeps IDs unique across its in-process reconnects.
        _page_ids(await self._google("list_pages", {}))
        key = "__browser_use_" + secrets.token_hex(16)
        owner = secrets.token_hex(16)
        matches = []
        try:
            create = {"tabId": tab_id, "expression": _install_marker(key, owner)}
            if _cra_value(await self._cra("page_evaluate", create)) is not True:
                raise BrowserError("tab_binding_failed", "Cra could not install the document marker.")
            # The native call may have woken a sleeping tab after the connection check.
            for page_id in _page_ids(await self._google("list_pages", {})):
                challenge = secrets.token_hex(16)
                try:
                    probe = await self._google("evaluate_script", {
                        "pageId": page_id, "function": _probe_marker(key, challenge), "waitForStableDom": False,
                        # In 1.13.0 an empty action leaves any new JS dialog open.
                        "dialogAction": "",
                    })
                except BrowserError as exc:
                    # These specific refusals occur before the probe runs. A different
                    # candidate still needs to complete both sides of the handshake.
                    if exc.code != "tool_error":
                        raise
                    message = str(exc).removeprefix("Error: ")
                    if isinstance(exc.data, dict) and isinstance(exc.data.get("content"), list):
                        _check_connection(exc.data, outcome="not_sent")
                        details = exc.data.get("structuredContent")
                        if isinstance(details, dict) and isinstance(details.get("errorMessage"), str):
                            message = details["errorMessage"]
                    dialog = r"A dialog is open \((?:alert|confirm|prompt|beforeunload): .*\)\."
                    if message == "No page found" or re.fullmatch(dialog, message, re.DOTALL):
                        continue
                    raise
                if _probe_result(probe) == owner:
                    matches.append((page_id, challenge))
            if len(matches) != 1:
                raise BrowserError("tab_binding_failed", f"The Cra document matched {len(matches)} Google pages. Expected one.")
        finally:
            # The first reply may be lost after the property was created. Cleanup is
            # conditional on ownership even in that case. pagehide/timer also clean it.
            pending = sys.exception()
            try:
                finish = {"tabId": tab_id, "expression": _finish_marker(key, owner)}
                answer = _cra_value(await self._cra("page_evaluate", finish))
            except Exception as cleanup_error:
                message = f"Document marker cleanup could not be confirmed. {cleanup_error}"
                if pending is None:
                    raise BrowserError("tab_binding_failed", message) from cleanup_error
                if isinstance(pending, BrowserError):
                    raise BrowserError(pending.code, f"{pending}. {message}", outcome=pending.outcome, data=pending.data) from pending
                pending.add_note(message)
        page_id, challenge = matches[0]
        if answer != challenge:
            raise BrowserError("tab_binding_failed", "The Cra document changed or did not confirm the Google page's challenge.")
        return page_id

    async def call(self, name, arguments):
        if name not in DEBUG_TOOLS:
            raise BrowserError("unknown_tool", f"Unknown debug tool {name}")
        validate(arguments, DEBUG_SCHEMAS[name], name)
        options = dict(arguments)
        tab_id = options.pop("tabId")
        if "pageIdx" in options and "pageSize" not in options:
            raise BrowserError("invalid_arguments", "pageIdx requires pageSize.")
        if name == "debug_trace_start":
            options.setdefault("reload", False)
            options.setdefault("autoStop", False)
            if "ignoreCache" in options and not options["reload"]:
                raise BrowserError("invalid_arguments", "ignoreCache requires reload=true.")
            if "filePath" in options and not options["autoStop"]:
                raise BrowserError("invalid_arguments", "Use filePath at stop, or set autoStop=true at start.")
        if self._google is None:
            raise BrowserError("unavailable", "Debugging requires a Google MCP connection to the specified browser instance.")
        if self._cra is not None and self._chrome_page_id is None:
            async with self._binding_lock:
                page_id = await self._cra_page_id(tab_id)
        elif self._chrome_page_id is not None and self._cra is None:
            page_id = await self._chrome_page_id(tab_id)
        else:
            raise BrowserError("unavailable", "Configure one tab resolver for the requested browser instance.")
        if not _valid_id(page_id):
            raise BrowserError("tab_binding_failed", "The tab resolver returned an invalid Google page ID.")
        result = await self._google(_GOOGLE[name], {"pageId": page_id, **options})
        _check_connection(result)
        if name in {"debug_trace_start", "debug_trace_stop"}:
            _check_trace(result, recording=name == "debug_trace_start" and not options["autoStop"])
        return result
