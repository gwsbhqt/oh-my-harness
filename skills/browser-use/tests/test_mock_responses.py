"""Google 1.13 mock tool envelopes and real, short-lived loopback JSON responses."""
import asyncio
from contextlib import redirect_stderr
from http.client import HTTPConnection
from io import StringIO
import json
import socket
import unittest
from urllib.parse import urlsplit

from browser_use.mock_responses import MockResponses, local_origin
from browser_use.protocol import BrowserError


_SITE = "http://127.0.0.1:8123"
_URL = _SITE + "/api/items"
_EMPTY = "No network mocks match these filters."


def receipt(text):
    return {"content": [{"type": "text", "text": text}], "structuredContent": {"message": text}}


class Google:
    """Store by exact page/route/type, like the official manager's inspection/removal."""

    def __init__(self):
        self.rules = {}
        self.calls = []

    async def __call__(self, name, args):
        self.calls.append((name, dict(args)))
        await asyncio.sleep(0)
        key = (args["pageId"], args.get("route"), args.get("resourceType"))
        if name == "remove_network_mock":
            return receipt("Removed 1 network mock." if self.rules.pop(key, None) else "Removed 0 network mocks.")
        assert name == "mock_network"
        if "upstream" in args:
            self.rules[key] = {"source": args["upstream"], "hits": 0, "errors": 0}
        lines = []
        for (page_id, route, kind), row in self.rules.items():
            if (page_id == key[0] and (key[1] is None or route == key[1]) and (key[2] is None or kind == key[2])):
                lines += [f"{route} [{kind}] -> {row['source']}", f"  Since configured: {row['hits']} hits, {row['errors']} errors."]
        return receipt("\n".join(lines) or _EMPTY)


def request(source, method="GET", suffix=""):
    url = urlsplit(source)
    client = HTTPConnection(url.hostname, url.port, timeout=2)
    try:
        client.request(method, url.path + suffix, headers={"X-Fixture-Note": "drawing"})
        reply = client.getresponse()
        return reply.status, dict(reply.getheaders()), reply.read()
    finally:
        client.close()


class OriginTests(unittest.TestCase):
    def test_literal_and_default_ports(self):
        for url, expected in (
            (_URL, ("http", "127.0.0.1", 8123)), ("https://[::1]/?q=1#page", ("https", "::1", 443)),
            ("HTTP://LOCALHOST:80/", ("http", "localhost", 80)), ("http://127.1.2.3", ("http", "127.1.2.3", 80)),
        ):
            with self.subTest(url=url):
                self.assertEqual(local_origin(url), expected)
        self.assertNotEqual(local_origin("http://localhost"), local_origin("http://127.0.0.1"))
        self.assertNotEqual(local_origin("http://localhost"), local_origin("http://[::1]"))

    def test_ambiguous_hosts_and_invalid_inputs(self):
        for url in ("http://localhost.", "http://test.localhost/", "http://localhost.example.invalid/",
                    "http://[::1]ignored/api", "http://0/", "http://127.1/", "http://0x7f000001/",
                    "http://127.00.0.1/", "http://[::1%25zone]/", "http://127.0.0.1:/", "http://127.0.0.1:0/",
                    "http://127.0.0.1:65536/", "http://example.invalid/", "http://foo@127.0.0.1/",
                    "http://localhost\\@example.invalid", "http://local\nhost/", "file:///tmp/example", [], None):
            with self.subTest(url=url):
                self.assertIsNone(local_origin(url))


class MockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.google = Google()
        self.mocks = MockResponses(self.google)
        self.addAsyncCleanup(self.mocks.close)

    async def install(self, page_id=7, **options):
        args = dict(document_url=_SITE + "/drawings", url=_URL, resource_type="fetch", status=200,
                    json_body={"items": []}, dedicated=True)
        return await self.mocks.install(page_id, **(args | options))

    def changes(self, name):
        return [args for tool, args in self.google.calls if tool == name and (name != "mock_network" or "upstream" in args)]

    def assert_offline(self, upstream):
        with self.assertRaises(OSError):
            request(upstream)

    async def test_validation_precedes_google_and_the_responder(self):
        for option in (
            {"dedicated": False}, {"dedicated": 1}, {"url": "https://127.0.0.1:8123/api"},
            {"url": "http://localhost:8123/api"}, {"url": "http://127.0.0.1:8124/api"},
            {"document_url": "https://example.invalid/"}, {"url": "file:///tmp/test.json"},
            *({"url": _URL + end} for end in ("/*", "/:name", "/{test}", "/(a|b)", "?q=*", "#part", "/%2E./next", "?q=1?q=2", "/%xz")),
            *({"resource_type": kind} for kind in ("document", "script", "image", "Fetch", [], None)),
            *({"status": code} for code in (True, 201, 204, 301, 407, 700, "500")),
            *({"json_body": value} for value in (float("nan"), {"nested": float("inf")}, {1: "a"}, (1, 2), b"{}", "\ud800")),
        ):
            with self.subTest(option=option), self.assertRaises(BrowserError):
                await self.install(**option)
        for page_id in (True, "7", 0, -1):
            with self.subTest(page_id=page_id), self.assertRaises(BrowserError):
                await self.install(page_id)
        for option in ("upstream", "headers", "proxy", "file", "method"):
            with self.subTest(option=option), self.assertRaises(TypeError):
                await self.install(**{option: "unused"})
        self.assertEqual(self.google.calls, [])

    async def test_body_limit_counts_utf8_bytes(self):
        fits = "é" * ((1024 * 1024 - 2) // 2)
        with self.assertRaisesRegex(BrowserError, "1 MiB"):
            await self.install(json_body=fits + "a")
        self.assertEqual(self.google.calls, [])
        await self.install(json_body=fits, status=404)
        source = self.changes("mock_network")[0]["upstream"]
        status, headers, _ = request(source, "HEAD")
        self.assertEqual((status, int(headers["Content-Length"])), (404, 1024 * 1024))

    async def test_real_status_head_and_fixed_path_without_header_logging(self):
        first = await self.install(status=500, json_body={"message": "示例"})
        self.assertEqual((first["state"], first["hits"], first["errors"], first["served"]), ("configured", 0, 0, 0))
        change, = self.changes("mock_network")
        self.assertEqual(change["pageId"], 7)
        self.assertEqual(change["resourceType"], "fetch")
        self.assertEqual(change["route"], "http://:@127.0.0.1:8123/api/items?#")
        source = change["upstream"]
        self.assertEqual(urlsplit(source).hostname, "127.0.0.1")
        self.assertGreaterEqual(len(urlsplit(source).path), 33)
        self.assertNotIn(urlsplit(source).path, str(first))
        logs = StringIO()
        with redirect_stderr(logs):
            status, headers, body = request(source)
            self.assertEqual((status, json.loads(body)), (500, {"message": "示例"}))
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
            self.assertNotIn("X-Fixture-Note", headers)
            status, headers, body_head = request(source, "HEAD")
            self.assertEqual((status, int(headers["Content-Length"]), body_head), (500, len(body), b""))
            for method, suffix, expected in (("GET", "?neighbor=1", 404), ("GET", "/extra", 404), ("POST", "", 405)):
                status, _, content = request(source, method, suffix)
                self.assertEqual((status, content), (expected, b""))
        self.assertEqual(logs.getvalue(), "")
        # Official hits include a matching POST that aborts before visiting the responder.
        row, = self.google.rules.values()
        row.update(hits=3, errors=1)
        observed = await self.mocks.inspect(7)
        self.assertEqual((observed["hits"], observed["errors"], observed["served"]), (3, 1, 2))
        idle = socket.create_connection(("127.0.0.1", urlsplit(source).port), timeout=2)
        with idle:
            cleared = await self.mocks.clear(7)
            self.assertEqual(idle.recv(1), b"")
        self.assertEqual(cleared, observed | {"state": "cleared"})
        self.assert_offline(source)
        self.assertFalse(self.mocks.has(7))
        self.assertEqual((await self.mocks.clear(7))["state"], "absent")
        self.assertEqual(self.changes("remove_network_mock"), [{k: v for k, v in change.items() if k != "upstream"}])

    async def test_explicit_query_and_xhr_on_ipv6(self):
        url = "http://[::1]/api/items?tag=a%20b&page=1"
        await self.install(document_url="http://[::1]/drawings", url=url, resource_type="xhr")
        args, = self.changes("mock_network")
        self.assertEqual((args["route"], args["resourceType"]), (r"http://:@[\:\:1]:80/api/items?tag=a%20b&page=1#", "xhr"))

    async def test_parallel_retries_and_separate_pages(self):
        results = await asyncio.gather(self.install(), self.install(), self.install(8, json_body=None))
        self.assertEqual(results[0], results[1])
        installed = self.changes("mock_network")
        self.assertEqual(len(installed), 2)
        self.assertNotEqual(installed[0]["upstream"], installed[1]["upstream"])
        with self.assertRaisesRegex(BrowserError, "Clear"):
            await self.install(status=500)
        cleared = await asyncio.gather(self.mocks.clear(7), self.mocks.clear(7))
        self.assertEqual([row["state"] for row in cleared], ["cleared", "absent"])
        self.assertEqual((await self.mocks.inspect(8))["state"], "configured")
        await self.mocks.close()
        self.assertEqual(self.google.rules, {})
        for args in installed:
            self.assert_offline(args["upstream"])
        with self.assertRaisesRegex(BrowserError, "closed"):
            await self.install()

    async def test_foreign_rule_is_never_overwritten_or_removed(self):
        foreign = {"source": "http://127.0.0.1:8123/fixture", "hits": 0, "errors": 0}
        self.google.rules[(7, "*://*:*/*", "fetch")] = foreign
        with self.assertRaisesRegex(BrowserError, "already has a rule"):
            await self.install()
        self.assertFalse(self.changes("mock_network"))
        await self.install(8)
        own = next(k for k in self.google.rules if k[0] == 8)
        source = self.google.rules[own]["source"]
        self.google.rules[own] = foreign
        with self.assertRaisesRegex(BrowserError, "different source"):
            await self.mocks.clear(8)
        self.assertFalse(self.mocks.has(8))
        self.assertEqual(len(self.google.rules), 2)
        self.assertEqual(self.changes("remove_network_mock"), [])
        self.assert_offline(source)

    async def test_configuration_with_lost_reply_or_cancellation_is_reconciled(self):
        for failure in (BrowserError("timeout", "reply lost", outcome="unknown"), asyncio.CancelledError()):
            async def lost(name, args):
                reply = await self.google(name, args)
                if "upstream" in args:
                    raise failure
                return reply

            with self.subTest(failure=type(failure).__name__):
                self.mocks._google = lost
                with self.assertRaises(type(failure)):
                    await self.install()
                self.assertEqual(self.google.rules, {})
                self.assertFalse(self.mocks.has(7))
                self.assert_offline(self.changes("mock_network")[-1]["upstream"])

    async def test_reconcile_ambiguous_removal_without_replaying_it(self):
        await self.install()

        async def lost(name, args):
            reply = await self.google(name, args)
            if name == "remove_network_mock":
                return receipt("Unrecognized confirmation")
            return reply

        self.mocks._google = lost
        self.assertEqual((await self.mocks.clear(7))["state"], "cleared")
        self.assertEqual(len(self.changes("remove_network_mock")), 1)
        self.assertFalse(self.mocks.has(7))

    async def test_cancelled_close_finishes_all_pages(self):
        await self.install()
        await self.install(8)
        entered, resume = asyncio.Event(), asyncio.Event()

        async def delayed(name, args):
            if name == "remove_network_mock" and args["pageId"] == 7:
                entered.set()
                await resume.wait()
            return await self.google(name, args)

        self.mocks._google = delayed
        closing = asyncio.create_task(self.mocks.close())
        await entered.wait()
        closing.cancel()
        resume.set()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertEqual(self.google.rules, {})
        for args in self.changes("mock_network"):
            self.assert_offline(args["upstream"])

    async def test_refused_removal_keeps_the_rule_for_retry(self):
        await self.install()

        async def tracing(name, args):
            if name == "remove_network_mock":
                return receipt("Cannot change network mocks while a performance trace is running.") | {"isError": True}
            return await self.google(name, args)

        self.mocks._google = tracing
        with self.assertRaises(BrowserError) as ctx:
            await self.mocks.clear(7)
        self.assertEqual(ctx.exception.outcome, "unknown")
        self.assertEqual((await self.mocks.inspect(7))["state"], "cleanup_pending")
        self.assert_offline(self.changes("mock_network")[0]["upstream"])
        self.mocks._google = self.google
        self.assertEqual((await self.mocks.clear(7))["state"], "cleared")

    async def test_loss_stops_all_responders_and_remembers_uncertain_page(self):
        await self.install()
        await self.install(8)
        originals = list(self.google.rules.items())

        async def disconnected(name, args):
            if args["pageId"] == 7:
                raise BrowserError("connection_lost", "connection closed", outcome="unknown")
            return await self.google(name, args)

        self.mocks._google = disconnected
        with self.assertRaises(BrowserError) as ctx:
            await self.mocks.inspect(7)
        self.assertEqual(ctx.exception.outcome, "unknown")
        for _, row in originals:
            self.assert_offline(row["source"])
        self.assertEqual((await self.mocks.inspect(8))["state"], "cleanup_pending")
        with self.assertRaises(BrowserError) as ctx:
            await self.mocks.close()
        self.assertEqual([error["pageId"] for error in ctx.exception.data["pages"]], [7])
        self.assertTrue(self.mocks.has(7))
        self.assertFalse(self.mocks.has(8))
        self.google.rules.clear()
        self.mocks._google = self.google
        with self.assertRaises(BrowserError) as ctx:
            await self.mocks.clear(7)
        self.assertEqual(ctx.exception.outcome, "unknown")
        self.assertTrue(self.mocks.has(7))
        key, original = originals[0]
        self.google.rules[key] = original
        self.assertEqual((await self.mocks.clear(7))["state"], "cleared")
