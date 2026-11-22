"""One fixed JSON response on an exclusively owned loopback development tab.

Google 1.13.0 scopes rules to its own MCP session and page. Only the caller
can establish that it opened this dedicated tab and verified its top document.
Google persists rules across navigations and intercepts GET/HEAD upstreams;
service workers can bypass interception. Counts describe requests, not the UI.
"""
from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import re
import secrets
import socket
import threading
from urllib.parse import urlsplit

from .protocol import BrowserError, checked_reply


_EMPTY = "No network mocks match these filters."
_MAX_BODY = 1024 * 1024
_LITERAL = re.compile(r"(?:[A-Za-z0-9/._~!$&,;=@-]|%[0-9a-fA-F]{2})*")
_COUNTS = re.compile(r"  Since configured: ([0-9]+) hits, ([0-9]+) errors\.")


def local_origin(url):
    """Return (scheme, canonical loopback IP or "localhost", effective port)."""
    if not isinstance(url, str) or re.search(r"[\s\x00-\x1f\x7f\\]", url):
        return None
    try:
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"}:
            return None
        authority = re.fullmatch(r"(localhost|\[[0-9a-f:]+\]|[0-9.]+)(?::[0-9]+)?", parts.netloc.lower())
        if not authority:
            return None
        host = authority[1]
        if host != "localhost":
            address = ipaddress.ip_address(host.strip("[]"))
            if not address.is_loopback or (address.version == 6) != host.startswith("["):
                return None
            host = str(address)
        port = parts.port
        if port == 0:
            return None
        return parts.scheme, host, port or (80 if parts.scheme == "http" else 443)
    except ValueError:
        return None


def _route(document_url, url):
    origin = local_origin(url)
    if origin is None or origin != local_origin(document_url):
        raise BrowserError("invalid_arguments", "The document and API must share one literal loopback HTTP(S) origin.")
    parts = urlsplit(url)
    path = parts.path or "/"
    if ("#" in url or not _LITERAL.fullmatch(path) or not _LITERAL.fullmatch(parts.query)
            or any(re.sub(r"%2e", ".", segment, flags=re.I) in {".", ".."} for segment in path.split("/"))):
        raise BrowserError("invalid_arguments", "Use one literal API path and query without URL patterns, fragments or dot segments.")
    scheme, address, port = origin
    host = "[" + address.replace(":", r"\:") + "]" if ":" in address else address
    # URLPattern treats omitted username, password, search and hash as wildcards.
    return f"{scheme}://:@{host}:{port}{path}?{parts.query}#"


def _body(value):
    try:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(body) > _MAX_BODY:
            raise BrowserError("invalid_arguments", "The UTF-8 JSON response must fit in 1 MiB.")
        # json.dumps also accepts tuples and coerces certain object keys to strings.
        if json.loads(body) != value:
            raise ValueError
        return body
    except (TypeError, ValueError, RecursionError) as exc:
        raise BrowserError("invalid_arguments", "The body must be ordinary JSON with string keys and finite numbers.") from exc


class _Handler(BaseHTTPRequestHandler):
    timeout = 5

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler otherwise echoes malformed requests as HTML.
        self.send_response_only(405 if code == 501 else code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def do_GET(self):
        fixture = self.server
        # parse_request normalizes a leading '//' in self.path.
        if self.requestline.split()[1] != fixture.path or fixture.stopped:
            self.send_error(404)
            return
        self.send_response_only(fixture.status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(fixture.body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command == "GET":
            self.wfile.write(fixture.body)
        with fixture.lock:
            fixture.served += 1

    do_HEAD = do_GET


class _Fixture(ThreadingHTTPServer):
    # Join all accepted sockets at teardown, including idle keep-alive clients.
    daemon_threads = False

    def __init__(self, status, body):
        self.status, self.body = status, body
        self.path = "/" + secrets.token_urlsafe(32)
        self.served = 0
        self.stopped = False
        self.clients = set()
        self.lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), _Handler)
        self.upstream = f"http://127.0.0.1:{self.server_port}{self.path}"
        self.thread = threading.Thread(target=self.serve_forever, args=(0.02,), daemon=True)
        try:
            self.thread.start()
        except RuntimeError:
            self.server_close()
            raise

    def process_request(self, request, client_address):
        with self.lock:
            self.clients.add(request)
        super().process_request(request, client_address)

    def close_request(self, request):
        with self.lock:
            self.clients.discard(request)
        super().close_request(request)

    def stop(self):
        if self.stopped:
            return
        self.stopped = True
        self.shutdown()
        self.thread.join()
        with self.lock:
            for client in self.clients:
                with suppress(OSError):
                    client.shutdown(socket.SHUT_RDWR)
        self.server_close()
        self.body = b""


@dataclass
class _Rule:
    page_id: int
    url: str
    route: str
    resource_type: str
    fixture: _Fixture
    hits: int | None = None
    errors: int | None = None
    connection_unknown: bool = False

    @property
    def filters(self):
        return {"pageId": self.page_id, "route": self.route, "resourceType": self.resource_type}

    def observe(self, message):
        if message == _EMPTY:
            if self.connection_unknown:
                raise BrowserError("mock_cleanup_unknown", "An empty rule list after connection loss cannot verify the original page.", outcome="unknown")
            return "absent"
        prefix = f"{self.route} [{self.resource_type}] -> "
        lines = message.splitlines()
        matches = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if len(matches) == 1:
            i = matches[0]
            if lines[i] != prefix + self.fixture.upstream:
                if self.connection_unknown:
                    raise BrowserError("mock_cleanup_unknown", "A different source after connection loss cannot verify the original page.", outcome="unknown")
                return "foreign"
            counts = _COUNTS.fullmatch(lines[i + 1]) if i + 1 < len(lines) else None
            if counts:
                self.hits, self.errors = map(int, counts.groups())
                self.connection_unknown = False
                return "owned"
        raise BrowserError("protocol_error", "Google returned unrecognized mock diagnostics.", outcome="unknown")

    def receipt(self, state):
        return {"state": state, "pageId": self.page_id, "url": self.url, "resourceType": self.resource_type,
                "status": self.fixture.status, "hits": self.hits, "errors": self.errors, "served": self.fixture.served}


def _page(page_id):
    if type(page_id) is not int or page_id < 1:
        raise BrowserError("tab_binding_failed", "Expected a verified Google page ID.")


def _absent(page_id):
    return {"state": "absent", "pageId": page_id, "hits": 0, "errors": 0, "served": 0}


class MockResponses:
    """Own local fixtures and exact route/type pairs on one Google MCP connection."""

    def __init__(self, google):
        self._google = google
        self._lock = asyncio.Lock()
        self._rules = {}
        self._closed = False

    def has(self, page_id):
        return type(page_id) is int and page_id in self._rules

    async def _message(self, name, args):
        # Debugger owns this class and the shared Google 1.13 response decoding.
        from .debugging import _check_connection, _message

        if self._google is None:
            raise BrowserError("unavailable", "This operation requires Google MCP for the selected browser.")
        try:
            try:
                reply = checked_reply(name, await self._google(name, args))
            except BrowserError as exc:
                if isinstance(exc.data, dict) and isinstance(exc.data.get("content"), list):
                    _check_connection(exc.data)
                raise
            _check_connection(reply)
            return _message(reply)
        except (BrowserError, asyncio.CancelledError) as exc:
            if getattr(exc, "code", "connection_lost") in {"connection_lost", "connection_failed", "connection_changed", "timeout"}:
                for managed in self._rules.values():
                    managed.connection_unknown = True
                    managed.fixture.stop()
            raise

    async def install(self, page_id, *, document_url, url, resource_type, status, json_body, dedicated):
        _page(page_id)
        if dedicated is not True:
            raise BrowserError("mock_ownership", "Open a dedicated development tab in this session first.")
        route = _route(document_url, url)
        if resource_type not in ("fetch", "xhr"):
            raise BrowserError("invalid_arguments", "Only fetch and xhr resources can use a JSON response.")
        if type(status) is not int or not (status == 200 or 400 <= status <= 599 and status != 407):
            raise BrowserError("invalid_arguments", "Use 200 or a 4xx/5xx HTTP status other than proxy authentication (407).")
        body = _body(json_body)
        async with self._lock:
            if self._closed:
                raise BrowserError("session_closed", "The mock response session is closed.")
            rule = self._rules.get(page_id)
            if rule:
                if (rule.fixture.stopped or (route, resource_type, status, body)
                        != (rule.route, rule.resource_type, rule.fixture.status, rule.fixture.body)):
                    raise BrowserError("mock_conflict", "Clear this page's current response before changing it.")
                return await self._status(rule)
            if await self._message("mock_network", {"pageId": page_id}) != _EMPTY:
                raise BrowserError("mock_conflict", "This dedicated page already has a rule or its empty state could not be confirmed.")
            try:
                fixture = _Fixture(status, body)
            except (OSError, RuntimeError) as exc:
                raise BrowserError("unavailable", "The loopback JSON responder could not start.") from exc
            if local_origin(fixture.upstream) == local_origin(url):
                fixture.stop()
                raise BrowserError("unavailable", "The responder needs a different origin from the development site. Retry installation.")
            rule = self._rules[page_id] = _Rule(page_id, url, route, resource_type, fixture)
            return await self._status(rule, installing=True)

    async def inspect(self, page_id):
        _page(page_id)
        async with self._lock:
            rule = self._rules.get(page_id)
            return await self._status(rule) if rule else _absent(page_id)

    async def _status(self, rule, *, installing=False):
        args = rule.filters
        if installing:
            args["upstream"] = rule.fixture.upstream
        try:
            message = await self._message("mock_network", args)
            ownership = rule.observe(message)
            if installing and ownership != "owned":
                raise BrowserError("protocol_error", "Google did not confirm this response's installation.", outcome="unknown")
        except (Exception, asyncio.CancelledError) as exc:
            if installing and isinstance(exc, BrowserError) and exc.outcome == "not_sent":
                self._forget(rule, "absent")
                raise
            # The request may have reached Google even if the caller lost its reply.
            try:
                await self._clear(rule)
            except BrowserError as cleanup:
                if isinstance(exc, asyncio.CancelledError):
                    exc.add_note(str(cleanup))
                    raise exc
                raise cleanup from exc
            raise
        if ownership == "owned":
            return rule.receipt("cleanup_pending" if rule.fixture.stopped else "configured")
        self._forget(rule, ownership)
        return rule.receipt("absent")

    def _forget(self, rule, ownership):
        rule.fixture.stop()
        del self._rules[rule.page_id]
        if ownership == "foreign":
            raise BrowserError("mock_conflict", "This page's route now belongs to a different source. Its rule was preserved.")

    async def clear(self, page_id):
        _page(page_id)
        async with self._lock:
            rule = self._rules.get(page_id)
            return await self._clear(rule) if rule else _absent(page_id)

    async def _clear(self, rule):
        try:
            ownership = rule.observe(await self._message("mock_network", rule.filters))
            if ownership == "owned":
                try:
                    result = await self._message("remove_network_mock", rule.filters)
                    if result not in {"Removed 1 network mock.", "Removed 0 network mocks."}:
                        raise BrowserError("protocol_error", "Google did not confirm removal.", outcome="unknown")
                except Exception:
                    # A failed reply may follow a successful removal. Inspect before any retry.
                    ownership = rule.observe(await self._message("mock_network", rule.filters))
                    if ownership == "owned":
                        raise
        except Exception as exc:
            raise BrowserError("mock_cleanup_unknown", f"Google could not confirm cleanup on page {rule.page_id}. "
                               "The local responder is stopped. Retry clear on the same page and connection.",
                               outcome="unknown", data=rule.receipt("cleanup_pending")) from exc
        finally:
            rule.fixture.stop()
        self._forget(rule, ownership)
        return rule.receipt("cleared")

    async def close(self):
        # A cancelled caller must not interrupt removal between the owned pages.
        cleanup = asyncio.create_task(self._close_all())
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError as cancelled:
            try:
                await cleanup
            except BrowserError as failure:
                raise cancelled from failure
            raise

    async def _close_all(self):
        async with self._lock:
            self._closed = True
            failures = []
            try:
                for rule in list(self._rules.values()):
                    try:
                        await self._clear(rule)
                    except BrowserError as exc:
                        failures.append({"pageId": rule.page_id, **exc.as_dict()})
            finally:
                for rule in self._rules.values():
                    rule.fixture.stop()
            if failures:
                raise BrowserError("mock_cleanup_failed", "Google could not confirm cleanup of every owned response.",
                                   outcome="unknown", data={"pages": failures})
