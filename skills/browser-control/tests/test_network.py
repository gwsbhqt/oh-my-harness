"""Dedicated in-memory CDP fixtures; never connect to users' browser traffic."""
import base64
import json
import re
import threading
import unittest
from collections import defaultdict

from browser_control.errors import BrowserControlError
from browser_control.network import NetworkRecorder


class FixtureCDP:
    def __init__(self):
        self.listeners = defaultdict(list)
        self.event_loss = 0
        self.callback_thread = None

    def on(self, event, callback):
        self.listeners[event].append(callback)
        def unsubscribe():
            if callback in self.listeners[event]:
                self.listeners[event].remove(callback)
        return unsubscribe

    def emit(self, event, params, session="fixture"):
        self.callback_thread = threading.current_thread()
        try:
            for callback in tuple(self.listeners[event]):
                callback(params, session)
        finally:
            self.callback_thread = None


class FixtureDriver:
    session_id = "fixture"

    def __init__(self):
        self.cdp = FixtureCDP()
        self.calls = []
        self.bodies = {}
        self.failures = {}
        self.properties = {}

    def call(self, method, params=None, timeout=20, session_id=None):
        if threading.current_thread() is self.cdp.callback_thread:
            raise AssertionError("CDP callback synchronously called CDP")
        self.calls.append((method, params or {}, threading.current_thread().name, session_id or self.session_id))
        if method in self.failures:
            raise self.failures[method]
        if method == "Fetch.getResponseBody":
            result = self.bodies.get(params["requestId"])
            if isinstance(result, Exception):
                raise result
            return result or {"body": '{"keep":{"real":true},"change":"old","remove":1}', "base64Encoded": False}
        if method == "Network.getRequestPostData":
            return {"postData": "real-fixture-post"}
        if method == "Network.getResponseBody":
            result = self.bodies.get(params["requestId"])
            if isinstance(result, Exception):
                raise result
            return result or {"body": "fixture-body", "base64Encoded": False}
        if method == "Runtime.getProperties":
            result = self.properties.get(params["objectId"])
            if isinstance(result, Exception):
                raise result
            if result is None:
                raise BrowserControlError("Runtime.getProperties：Could not find object with given id", 1)
            return result
        return {}


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.driver = FixtureDriver()
        self.recorder = NetworkRecorder(self.driver)
        self.addCleanup(self.recorder.close)

    def emit(self, event, params, session="fixture"):
        self.driver.cdp.emit(event, params, session)

    def request(self, key="r1", **params):
        payload = {"requestId": key, "timestamp": 10, "wallTime": 1700000000,
                   "type": "Fetch", "request": {"url": "https://fixture.invalid/data?x=1", "method": "GET",
                                                "headers": {"Accept": "application/json", "Cookie": "private"}}}
        payload.update(params)
        self.emit("Network.requestWillBeSent", payload)

    def response(self, key="r1", extra=False):
        self.emit("Network.responseReceived", {"requestId": key, "timestamp": 11, "hasExtraInfo": extra,
                                               "response": {"status": 200, "headers": {"Content-Type": "text/plain"},
                                                            "mimeType": "text/plain", "protocol": "h2"}})

    def finish(self, key="r1", length=12):
        self.emit("Network.loadingFinished", {"requestId": key, "timestamp": 12, "encodedDataLength": length})

    def detail(self, key="r1", **params):
        return self.recorder.dispatch("request", {"id": key, **params})["request"]

    def drain(self):
        return self.recorder.dispatch("requests")

    def test_enable_and_never_call_from_callbacks(self):
        self.request()
        self.response()
        self.finish()
        self.drain()
        self.assertEqual([c[0] for c in self.driver.calls[:3]], ["Network.enable", "Runtime.enable", "Log.enable"])
        self.assertTrue(all(c[2] == "browser-control-network-worker" for c in self.driver.calls))

    def test_session_isolation(self):
        self.emit("Network.requestWillBeSent", {"requestId": "foreign"}, session="private-other-tab")
        self.assertEqual(self.drain()["requests"], [])

    def test_extra_info_before_and_after_event_and_redaction(self):
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {"Authorization": "secret", "X-Final": "yes"}})
        self.emit("Network.responseReceivedExtraInfo", {"requestId": "r1", "headers": {"Set-Cookie": "secret2"}, "statusCode": 201})
        self.request()
        self.response(extra=True)
        self.finish()
        record = self.detail()
        self.assertTrue(record["finalHeadersKnown"])
        self.assertEqual(record["status"], 201)
        self.assertEqual(record["requestHeaders"]["Authorization"], "[REDACTED]")
        self.assertEqual(record["requestHeaders"]["Cookie"], "[REDACTED]")
        self.assertEqual(record["responseHeaders"]["Set-Cookie"], "[REDACTED]")
        self.assertEqual(self.detail(raw=True)["responseHeaders"]["Set-Cookie"], "secret2")

    def test_final_unknown_without_request_extra(self):
        self.request()
        self.response()
        self.assertFalse(self.detail()["finalHeadersKnown"])
        self.assertTrue(self.detail()["responseHeadersFinal"])

    def test_redirect_hops_and_extra_correlation(self):
        self.request()
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {"Hop": "old"}})
        self.request(redirectResponse={"status": 302, "headers": {"Location": "https://fixture.invalid/new"}},
                     redirectHasExtraInfo=True)
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {"Hop": "new"}})
        self.emit("Network.responseReceivedExtraInfo", {"requestId": "r1", "headers": {"Old-Response": "yes"}, "statusCode": 302})
        self.response(extra=True)
        self.emit("Network.responseReceivedExtraInfo", {"requestId": "r1", "headers": {"New-Response": "yes"}, "statusCode": 200})
        self.finish()
        old, new = self.detail("r1", body=True), self.detail("r1:1", body=True)
        self.assertTrue(old["redirected"])
        self.assertEqual(old["bodyReason"], "redirect_body_unavailable")
        self.assertEqual(old["requestHeaders"]["Hop"], "old")
        self.assertEqual(new["requestHeaders"]["Hop"], "new")
        self.assertIn("Old-Response", old["responseHeaders"])
        self.assertIn("New-Response", new["responseHeaders"])
        self.assertEqual(len([c for c in self.driver.calls if c[0] == "Network.getResponseBody"]), 1)

    def test_lazy_body_and_no_replay_when_missing(self):
        self.request()
        self.response()
        self.finish()
        self.assertFalse(self.detail()["bodyAvailable"])
        self.assertFalse(any(c[0] == "Network.getResponseBody" for c in self.driver.calls))
        self.driver.bodies["r1"] = BrowserControlError("body was evicted")
        self.assertEqual(self.detail(body=True)["bodyReason"], "cdp_body_unavailable")
        self.detail(body=True)
        self.assertEqual(sum(c[0] == "Network.getResponseBody" for c in self.driver.calls), 1)
        self.assertFalse(any(c[0] in ("Page.reload", "Page.navigate", "Network.replayXHR") for c in self.driver.calls))

    def test_body_retry_only_after_request_finishes(self):
        self.request()
        self.assertEqual(self.detail(body=True)["bodyReason"], "request_not_finished")
        self.response()
        self.finish()
        self.assertEqual(self.detail(body=True)["body"], "fixture-body")
        self.assertNotIn("body", self.detail())

    def test_base64_binary_body(self):
        self.driver.bodies["r1"] = {"body": base64.b64encode(b"\x00\xff").decode(), "base64Encoded": True}
        self.request()
        self.response()
        self.finish()
        result = self.detail(body=True)
        self.assertTrue(result["bodyAvailable"])
        self.assertTrue(result["base64Encoded"])
        self.assertEqual(base64.b64decode(result["body"]), b"\x00\xff")

    def test_body_limits(self):
        self.recorder.max_body_bytes = 4
        self.request()
        self.finish(length=2)
        result = self.recorder.dispatch("request", {"id": "r1", "body": True})
        self.assertEqual(result["request"]["bodyReason"], "body_limit")
        self.assertEqual(result["retainedBodyBytes"], 0)
        self.assertEqual(result["dropped"]["bodies"], 1)

    def test_total_body_limit(self):
        self.recorder.max_total_body_bytes = 12
        for key in ("r1", "r2"):
            self.request(key)
            self.finish(key)
            self.detail(key, body=True)
        self.assertTrue(self.detail("r1")["bodyAvailable"])
        self.assertEqual(self.detail("r2")["bodyReason"], "body_limit")

    def test_request_eviction_and_body_accounting(self):
        self.recorder.max_requests = 1
        self.request()
        self.finish()
        self.detail(body=True)
        self.request("r2")
        result = self.drain()
        self.assertEqual(result["retainedBodyBytes"], 0)
        self.assertEqual(result["dropped"]["requests"], 1)
        with self.assertRaises(BrowserControlError) as error:
            self.detail("r1")
        self.assertEqual(error.exception.code, 3)

    def test_console_exception_and_failed_request(self):
        self.emit("Runtime.consoleAPICalled", {"type": "log", "args": [{"type": "string", "value": "fixture console"},
                                                                     {"type": "object", "description": "Object", "objectId": "must-not-retain"}]})
        self.emit("Runtime.exceptionThrown", {"exceptionDetails": {"text": "Uncaught", "exception": {"description": "fixture error"}}})
        self.emit("Log.entryAdded", {"entry": {"level": "error", "text": "fixture log"}})
        self.request()
        self.emit("Network.loadingFailed", {"requestId": "r1", "errorText": "net::ERR_FAILED"})
        self.assertTrue(self.detail()["failed"])
        console = self.recorder.dispatch("console")["console"]
        self.assertNotIn("objectId", console[0]["args"][1])
        self.assertEqual(len(self.recorder.dispatch("errors")["errors"]), 3)

    def test_console_limits_and_clear_retains_loss(self):
        self.recorder._console = __import__("collections").deque(maxlen=1)
        self.recorder.max_console = 1
        for text in ("a", "b"):
            self.emit("Runtime.consoleAPICalled", {"args": [{"value": text}]})
        result = self.recorder.dispatch("console")
        self.assertEqual(result["console"][0]["args"][0]["value"], "b")
        self.assertEqual(result["dropped"]["console"], 1)
        self.assertEqual(self.recorder.dispatch("clear")["dropped"]["console"], 1)
        self.assertEqual(self.recorder.dispatch("console")["console"], [])

    def test_har_capture_has_actual_body_and_redacted_headers(self):
        self.request("before")
        self.drain()
        self.recorder.dispatch("har_start", {"body": True})
        self.request()
        self.response()
        self.finish()
        result = self.recorder.dispatch("har_stop")
        har = result["har"]["log"]
        self.assertEqual(har["version"], "1.2")
        self.assertEqual(len(har["entries"]), 1)
        entry = har["entries"][0]
        self.assertEqual(entry["time"], 2000)
        self.assertEqual(entry["response"]["content"]["text"], "fixture-body")
        self.assertIn({"name": "Cookie", "value": "[REDACTED]"}, entry["request"]["headers"])
        self.assertEqual(entry["request"]["queryString"], [{"name": "x", "value": "1"}])
        json.dumps(result)

    def test_har_no_body_by_default_and_clear_refused_while_active(self):
        self.recorder.dispatch("har_start")
        with self.assertRaises(BrowserControlError):
            self.recorder.dispatch("clear")
        self.request()
        self.finish()
        content = self.recorder.dispatch("har_stop")["har"]["log"]["entries"][0]["response"]["content"]
        self.assertFalse(content["_bodyAvailable"])
        self.assertNotIn("text", content)
        with self.assertRaises(BrowserControlError):
            self.recorder.dispatch("har_stop")

    def test_route_fulfill_abort_continue_and_precedence(self):
        route = self.recorder.dispatch("route", {"url": "https://fixture.invalid/*", "body": {"mock": True}, "status": 202,
                                                 "headers": {"Content-Type": "application/json"}})
        self.emit("Fetch.requestPaused", {"requestId": "fetch1", "request": {"url": "https://fixture.invalid/data", "method": "GET"}})
        self.drain()
        call = next(c for c in self.driver.calls if c[0] == "Fetch.fulfillRequest")
        self.assertEqual(call[1]["responseCode"], 202)
        self.assertEqual(json.loads(base64.b64decode(call[1]["body"])), {"mock": True})
        self.recorder.dispatch("route", {"url": "*", "action": "abort", "method": "POST"})
        self.emit("Fetch.requestPaused", {"requestId": "fetch2", "request": {"url": "https://fixture.invalid/data", "method": "POST"}})
        self.emit("Fetch.requestPaused", {"requestId": "fetch3", "request": {"url": "https://other.invalid/", "method": "GET"}})
        self.drain()
        self.assertTrue(any(c[0] == "Fetch.failRequest" for c in self.driver.calls))
        self.assertTrue(any(c[0] == "Fetch.continueRequest" for c in self.driver.calls))
        self.recorder.dispatch("unroute", {"routeId": route["routeId"]})
        self.recorder.dispatch("unroute")
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))

    def test_continue_headers_merge_original_and_override_case_insensitively(self):
        self.recorder.dispatch("route", {"url": "*", "action": "continue",
                                         "headers": {"x-browser-control-review": "expected", "X-New": "added"}})
        self.emit("Fetch.requestPaused", {"requestId": "fetch-header", "request": {
            "url": "https://fixture.invalid/", "method": "GET",
            "headers": {"Accept": "application/json", "Cookie": "fixture-cookie",
                        "X-Browser-Control-Review": "old", "X-Tt-Env": "original-lane"}}})
        self.drain()
        continuation = next(c[1] for c in self.driver.calls if c[0] == "Fetch.continueRequest")
        self.assertEqual(continuation["requestId"], "fetch-header")
        self.assertEqual({h["name"]: h["value"] for h in continuation["headers"]}, {
            "Accept": "application/json", "Cookie": "fixture-cookie", "x-browser-control-review": "expected",
            "X-New": "added", "X-Tt-Env": "original-lane"})
        self.assertEqual(sum(h["name"].lower() == "x-browser-control-review" for h in continuation["headers"]), 1)

    def test_continue_without_headers_does_not_replace_browser_headers(self):
        self.recorder.dispatch("route", {"url": "*", "action": "continue"})
        self.emit("Fetch.requestPaused", {"requestId": "fetch-no-header", "request": {
            "url": "https://fixture.invalid/", "headers": {"Cookie": "fixture-cookie"}}})
        self.drain()
        continuation = next(c[1] for c in self.driver.calls if c[0] == "Fetch.continueRequest")
        self.assertEqual(continuation, {"requestId": "fetch-no-header"})

    def test_routes_may_set_lane_style_headers(self):
        self.recorder.dispatch("route", {"url": "*", "action": "continue", "headers": {"X-TT-Env": "fixture-lane"}})
        self.assertTrue(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def test_invalid_header_names_and_values_are_rejected_before_fetch(self):
        for headers in ({"X Bad": "value"}, {"X\r\nInjected": "value"}, {"": "value"},
                        {"X-Fixture": "value\r\nInjected: true"}, {"X-Fixture": 1}):
            with self.subTest(headers=headers):
                with self.assertRaises(BrowserControlError) as error:
                    self.recorder.dispatch("route", {"url": "*", "headers": headers})
                self.assertEqual(error.exception.code, 2)
        self.assertFalse(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def test_continue_header_overrides_are_isolated_to_child_session(self):
        self.driver.session_ids = {"fixture", "child-fixture"}
        self.recorder.dispatch("route", {"url": "*", "action": "continue", "headers": {"X-Browser-Control-Review": "expected"}})
        self.emit("Fetch.requestPaused", {"requestId": "fetch-child", "request": {
            "url": "https://child.fixture.invalid/", "headers": {"Accept": "text/plain"}}}, session="child-fixture")
        self.drain()
        call = next(c for c in self.driver.calls if c[0] == "Fetch.continueRequest")
        self.assertEqual(call[3], "child-fixture")
        self.assertIn({"name": "X-Browser-Control-Review", "value": "expected"}, call[1]["headers"])

    def test_status_filter_exact_integer_returns_only_matching_response(self):
        for key, status in (("ok", 200), ("missing", 404), ("error", 599)):
            self.request(key)
            self.emit("Network.responseReceived", {"requestId": key, "response": {"status": status}})
        self.request("pending")
        result = self.recorder.dispatch("requests", {"status": 599})
        self.assertEqual(result["total"], 1)
        self.assertEqual([record["id"] for record in result["requests"]], ["error"])
        self.assertEqual(self.recorder.dispatch("requests", {"status": 201})["total"], 0)
        self.assertEqual(self.recorder.dispatch("requests", {"status": 599, "filter": "/not-present"})["total"], 0)
        for invalid in (True, "599", [599], 99, 600, None):
            with self.subTest(status=invalid):
                with self.assertRaises(BrowserControlError) as error:
                    self.recorder.dispatch("requests", {"status": invalid})
                self.assertEqual(error.exception.code, 2)

    def test_unknown_fields_rejected_for_every_network_action_before_side_effects(self):
        for action in ("requests", "request", "clear", "har_start", "har_stop", "route", "unroute", "console", "errors"):
            with self.subTest(action=action):
                with self.assertRaises(BrowserControlError) as error:
                    self.recorder.dispatch(action, {"unknownField": "must-not-ignore"})
                self.assertEqual(error.exception.code, 2)
                self.assertIn("unknownField", str(error.exception))
        for key in ("status_min", "status_max"):
            with self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("requests", {key: 200})
            self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.recorder._har)
        self.assertFalse(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def test_dispatch_rejects_invalid_parameter_shape_and_flags(self):
        for action, params in (("requests", []), ("request", {"body": "false"}), ("har_start", {"raw": 1}),
                               ("requests", {"method": 42}), ("request", {"id": []})):
            with self.subTest(action=action, params=params):
                with self.assertRaises(BrowserControlError) as error:
                    self.recorder.dispatch(action, params)
                self.assertEqual(error.exception.code, 2)

    def test_clear_never_removes_routes(self):
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.recorder.dispatch("clear")
        self.emit("Fetch.requestPaused", {"requestId": "fetch1", "request": {"url": "https://fixture.invalid/"}})
        self.drain()
        self.assertTrue(any(c[0] == "Fetch.fulfillRequest" for c in self.driver.calls))

    def test_route_failure_disables_not_replays(self):
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.driver.failures["Fetch.fulfillRequest"] = BrowserControlError("timeout", 4, outcome="unknown")
        self.emit("Fetch.requestPaused", {"requestId": "fetch1", "request": {"url": "https://fixture.invalid/"}})
        result = self.drain()
        self.assertEqual(result["routingDisabledReason"], "route_command_failed")
        self.assertEqual(sum(c[0] == "Fetch.fulfillRequest" for c in self.driver.calls), 1)
        errors = self.recorder.dispatch("errors")["errors"]
        self.assertTrue(any(e["outcome"] == "unknown" for e in errors))
        self.assertEqual(errors[-1]["outcome"], "terminated")
        self.assertEqual(sum(c[0] == "Fetch.failRequest" for c in self.driver.calls), 1)

    def test_queue_overflow_disables_and_releases_routes(self):
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        entered, release = threading.Event(), threading.Event()
        future = __import__("concurrent.futures", fromlist=["Future"]).Future()
        def block():
            entered.set()
            self.assertTrue(release.wait(2))
        self.recorder._queue.put_nowait((future, block))
        self.assertTrue(entered.wait(2))
        old_queue = self.recorder._queue
        self.recorder._queue = __import__("queue").Queue(1)
        self.emit("Runtime.consoleAPICalled", {"args": []})
        self.emit("Fetch.requestPaused", {"requestId": "overflow", "request": {"url": "https://fixture.invalid/"}})
        release.set()
        future.result(2)
        # The barrier drains after the worker has processed the overload signal.
        future2 = __import__("concurrent.futures", fromlist=["Future"]).Future()
        self.recorder._queue.put((future2, lambda: self.recorder._stats()), timeout=2)
        result = future2.result(2)
        self.assertEqual(result["dropped"]["routeEvents"], 1)
        self.assertEqual(result["routingDisabledReason"], "queue_overflow")
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.assertTrue(old_queue.empty())

    def test_oversized_event_and_cdp_loss_reporting(self):
        self.recorder.max_event_bytes = 20
        self.emit("Runtime.consoleAPICalled", {"args": [{"value": "large fixture"}]})
        self.driver.cdp.event_loss = 3
        result = self.drain()
        self.assertEqual(result["dropped"]["oversizedEvents"], 1)
        self.assertEqual(result["cdpEventLoss"], 3)

    def test_filter_substring_only_returns_matching_api_requests(self):
        for key, url in (("main", "https://fixture.invalid/"), ("api", "https://fixture.invalid/api/data"),
                         ("frame", "https://fixture.invalid/frame"), ("favicon", "https://fixture.invalid/favicon.ico")):
            self.request(key, request={"url": url, "method": "GET", "headers": {}})
        result = self.recorder.dispatch("requests", {"filter": "/api/"})
        self.assertEqual(result["total"], 1)
        self.assertEqual([record["id"] for record in result["requests"]], ["api"])
        with self.assertRaises(BrowserControlError):
            self.recorder.dispatch("requests", {"filter": 42})

    def test_validation_and_filtering(self):
        self.request()
        self.request("r2", request={"url": "https://fixture.invalid/other", "method": "POST", "headers": {}})
        self.assertEqual(self.recorder.dispatch("requests", {"method": "post", "url": "*/other"})["total"], 1)
        self.assertTrue(self.recorder.dispatch("requests", {"limit": 1})["truncated"])
        for action, params in (("requests", {"limit": 0}), ("route", {}), ("route", {"url": "*", "status": 999}),
                               ("route", {"url": "*", "action": "invalid"}), ("nonsense", {})):
            with self.assertRaises(BrowserControlError):
                self.recorder.dispatch(action, params)

    def test_final_headers_replace_case_insensitively(self):
        self.request(request={"url": "https://fixture.invalid/", "method": "GET",
                              "headers": {"X-Header": "provisional", "AUTHORIZATION": "old"}})
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {"x-header": "final", "Authorization": "new"}})
        record = self.detail(raw=True)
        self.assertNotIn("X-Header", record["requestHeaders"])
        self.assertNotIn("AUTHORIZATION", record["requestHeaders"])
        self.assertEqual(record["requestHeaders"]["x-header"], "final")

    def test_cdp_loss_releases_routes_and_invalidates_final_headers(self):
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.request()
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {}})
        self.response()
        self.assertTrue(self.detail()["finalHeadersKnown"])
        self.driver.cdp.event_loss += 1
        result = self.drain()
        self.assertEqual(result["routingDisabledReason"], "cdp_event_loss")
        self.assertTrue(result["headerCorrelationLost"])
        self.assertFalse(self.detail()["finalHeadersKnown"])
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))

    def test_failed_fetch_enable_cleans_up_uncertain_interception(self):
        self.driver.failures["Fetch.enable"] = BrowserControlError("timeout", 4, outcome="unknown")
        with self.assertRaises(BrowserControlError):
            self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.assertEqual(self.drain()["routingDisabledReason"], "route_enable_failed")

    def test_close_from_worker_does_not_join_itself(self):
        self.recorder._invoke(self.recorder.close)
        self.assertTrue(self.recorder._closed.wait(2))
        self.assertTrue(all(not listeners for listeners in self.driver.cdp.listeners.values()))

    def test_oopif_session_id_isolates_equal_request_ids_and_body_calls(self):
        self.driver.session_ids = {"fixture", "child-fixture"}
        self.drain()
        self.request()
        self.emit("Network.requestWillBeSent", {"requestId": "r1", "timestamp": 20,
                                                "request": {"url": "https://child.fixture.invalid/", "method": "GET", "headers": {}}},
                  session="child-fixture")
        self.emit("Network.responseReceived", {"requestId": "r1", "response": {"status": 200}}, session="child-fixture")
        self.emit("Network.loadingFinished", {"requestId": "r1", "timestamp": 21}, session="child-fixture")
        result = self.recorder.dispatch("request", {"id": "child-fixture/r1", "body": True})
        self.assertEqual(result["request"]["sessionId"], "child-fixture")
        self.assertEqual(result["request"]["requestId"], "r1")
        self.assertEqual(self.detail()["url"], "https://fixture.invalid/data?x=1")
        self.assertEqual(result["coverage"]["enabledSessionIds"], ["child-fixture", "fixture"])
        self.assertFalse(result["coverage"]["complete"])
        body_call = next(c for c in self.driver.calls if c[0] == "Network.getResponseBody")
        self.assertEqual(body_call[3], "child-fixture")
        self.assertEqual(body_call[1]["requestId"], "r1")

    def test_dynamic_oopif_copies_and_releases_current_mock_rules(self):
        self.driver.session_ids = {"fixture"}
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.driver.session_ids.add("child-fixture")
        self.drain()
        self.assertTrue(any(c[0] == "Fetch.enable" and c[3] == "child-fixture" for c in self.driver.calls))
        self.emit("Fetch.requestPaused", {"requestId": "fetch-child", "request": {"url": "https://child.fixture.invalid/"}},
                  session="child-fixture")
        self.drain()
        self.assertTrue(any(c[0] == "Fetch.fulfillRequest" and c[3] == "child-fixture" for c in self.driver.calls))
        self.recorder.close()
        self.assertEqual({c[3] for c in self.driver.calls if c[0] == "Fetch.disable"}, {"fixture", "child-fixture"})

    def test_detached_oopif_body_is_not_sent_to_other_session(self):
        self.driver.session_ids = {"fixture", "child-fixture"}
        self.drain()
        self.emit("Network.requestWillBeSent", {"requestId": "r1", "request": {"url": "https://child.fixture.invalid/"}},
                  session="child-fixture")
        self.emit("Network.loadingFinished", {"requestId": "r1"}, session="child-fixture")
        self.drain()
        self.driver.session_ids.remove("child-fixture")
        result = self.detail("child-fixture/r1", body=True)
        self.assertEqual(result["bodyReason"], "frame_session_detached")
        self.assertFalse(any(c[0] == "Network.getResponseBody" for c in self.driver.calls))

    def test_correlation_pending_slots_have_global_bound(self):
        self.recorder.max_requests = 2
        for key in ("r1", "r2"):
            for value in range(7):
                self.emit("Network.requestWillBeSentExtraInfo", {"requestId": key, "headers": {"X-Fixture": str(value)}})
        result = self.drain()
        pending = sum(len(chain[name]) for chain in self.recorder._chains.values()
                      for name in ("requestSlots", "responseSlots", "requestExtra", "responseExtra"))
        self.assertLessEqual(pending, self.recorder.max_requests * 4)
        self.assertTrue(result["headerCorrelationLost"])
        self.assertGreater(result["dropped"]["correlations"], 0)

    def test_console_error_is_also_in_errors(self):
        self.emit("Runtime.consoleAPICalled", {"type": "error", "args": [{"value": "fixture error"}]})
        self.assertEqual(self.recorder.dispatch("errors")["errors"][0]["source"], "console")

    def test_late_request_extra_without_response_extra_still_merges(self):
        self.request()
        self.response(extra=False)
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r1", "headers": {"Final": "late"}})
        self.assertTrue(self.detail()["finalHeadersKnown"])
        self.assertEqual(self.detail()["requestHeaders"]["Final"], "late")

    def test_session_discovery_race_reported_without_worker_crash(self):
        class RacingDriver(FixtureDriver):
            @property
            def session_ids(self):
                if self.racing:
                    raise RuntimeError("dictionary changed size during iteration")
                return {"fixture"}
        driver = RacingDriver()
        driver.racing = False
        recorder = NetworkRecorder(driver)
        self.addCleanup(recorder.close)
        driver.racing = True
        result = recorder.dispatch("requests")
        self.assertGreater(result["coverage"]["sessionDiscoveryErrors"], 0)
        self.assertTrue(recorder._worker.is_alive())

    def test_failed_child_session_is_explicit_in_coverage(self):
        self.driver.session_ids = {"fixture", "child-fixture"}
        self.driver.failures["Log.enable"] = BrowserControlError("fixture unsupported")
        result = self.drain()
        self.assertEqual(result["coverage"]["enabledSessionIds"], ["fixture"])
        self.assertIn("child-fixture", result["coverage"]["failedSessions"])
        self.assertFalse(result["coverage"]["complete"])

    def test_har_eviction_reports_loss_instead_of_complete_capture(self):
        self.recorder.max_requests = 1
        self.recorder.dispatch("har_start")
        self.request("r1")
        self.request("r2")
        result = self.recorder.dispatch("har_stop")
        self.assertEqual(result["har"]["log"]["_browser_control"]["dropped"]["requests"], 1)
        self.assertEqual(len(result["har"]["log"]["entries"]), 1)

    def test_mock_total_body_limit(self):
        self.recorder.max_total_body_bytes = 12
        self.recorder.dispatch("route", {"url": "*/first", "body": "12345678"})
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("route", {"url": "*/second", "body": "12345678"})
        self.assertEqual(error.exception.code, 2)

    def test_queue_timeout_cancels_unstarted_command(self):
        entered, release = threading.Event(), threading.Event()
        future = __import__("concurrent.futures", fromlist=["Future"]).Future()
        def block():
            entered.set()
            self.assertTrue(release.wait(2))
        self.recorder._queue.put_nowait((future, block))
        self.assertTrue(entered.wait(2))
        self.recorder._command_timeout = 0.02
        try:
            with self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("route", {"url": "*", "body": "must-not-send"})
            self.assertEqual(error.exception.outcome, "not_sent")
        finally:
            release.set()
        future.result(2)
        self.recorder._command_timeout = 25
        self.drain()
        self.assertFalse(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def test_close_unsubscribes_and_stops_worker(self):
        self.recorder.dispatch("route", {"url": "*", "body": "mock"})
        self.recorder.close()
        self.recorder.close()
        self.assertFalse(self.recorder._worker.is_alive())
        self.assertTrue(all(not listeners for listeners in self.driver.cdp.listeners.values()))
        self.emit("Network.requestWillBeSent", {"requestId": "after-close"})
        with self.assertRaises(BrowserControlError):
            self.recorder.dispatch("requests")
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))


    def test_initial_post_data_obeys_total_limit_and_har_response_size(self):
        self.recorder.max_total_body_bytes = 20
        self.request(request={"url": "https://fixture.invalid/post", "method": "POST", "postData": "post-body", "headers": {}})
        self.response()
        self.finish()
        self.driver.bodies["r1"] = {"body": "reply", "base64Encoded": False}
        detail = self.detail(body=True)
        self.assertEqual(detail["postData"], "post-body")
        self.assertEqual(self.recorder.dispatch("requests")["retainedBodyBytes"], 14)
        entry = self.recorder._invoke(lambda: self.recorder._har_entry(self.recorder._records["r1"], True))
        self.assertEqual(entry["response"]["content"]["size"], 5)
        self.request("r2", request={"url": "https://fixture.invalid/post", "method": "POST", "postData": "oversized-post-body", "headers": {}})
        detail = self.detail("r2", postData=True)
        self.assertFalse(detail["postDataAvailable"])
        self.assertEqual(detail["postDataReason"], "body_limit")
        self.assertFalse(any(c[0] == "Network.getRequestPostData" for c in self.driver.calls))

    def test_json_duplicate_fields_are_not_silently_discarded(self):
        self.driver.bodies["response"] = {"body": '{"keep":1,"keep":2}'}
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"json": {"set": {"/new": 1}}}})
        self.paused_response()
        self.assertFalse(any(c[0] == "Fetch.fulfillRequest" for c in self.driver.calls))
        self.assertTrue(any("重复键" in e["text"] for e in self.recorder.dispatch("errors")["errors"]))

    def test_new_network_actions_reject_unknown_flags(self):
        for action in ("request_body", "ws_frames", "ws_connections", "cache", "service_worker", "controls", "override", "unoverride"):
            with self.subTest(action=action), self.assertRaises(BrowserControlError):
                self.recorder.dispatch(action, {"unknownField": True})
        for action, params in (("cache", {"disabled": 1}), ("service_worker", {"bypass": "false"}),
                               ("request", {"postData": "true"}), ("ws_frames", {"after": True})):
            with self.subTest(action=action), self.assertRaises(BrowserControlError):
                self.recorder.dispatch(action, params)

    def test_get_response_body_failure_still_terminates(self):
        self.driver.bodies["response"] = BrowserControlError("response body evicted", 5)
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"status": 202}})
        self.paused_response()
        self.assertTrue(any(c[0] == "Fetch.failRequest" for c in self.driver.calls))
        self.assertEqual(self.recorder.dispatch("requests")["pendingPauses"], 0)

    def test_termination_failure_reports_unknown_and_disables(self):
        self.driver.bodies["response"] = {"body": "invalid"}
        self.driver.failures["Fetch.failRequest"] = BrowserControlError("connection lost", 5, outcome="unknown")
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"json": {"set": {"/x": 1}}}})
        self.paused_response()
        errors = self.recorder.dispatch("errors")["errors"]
        self.assertEqual(errors[-1]["outcome"], "unknown")
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.assertFalse(any(c[0] == "Fetch.continueRequest" for c in self.driver.calls))

    def test_missing_remove_pointer_fails_instead_of_success(self):
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"json": {"remove": ["/missing"]}}})
        self.paused_response()
        self.assertTrue(any(c[0] == "Fetch.failRequest" for c in self.driver.calls))
        self.assertFalse(any(c[0] == "Fetch.fulfillRequest" for c in self.driver.calls))

    def test_missing_file_reports_buerror_without_fetch(self):
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("override", {"url": "*", "file": "/nonexistent-browser-control-network-fixture/file"})
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def paused_response(self, key="response", kind="application/json", status=200):
        self.emit("Fetch.requestPaused", {"requestId": key, "request": {"url": "https://fixture.invalid/data", "method": "GET"},
                  "responseStatusCode": status, "responseStatusText": "OK", "responseHeaders": [
                      {"name": "Content-Type", "value": kind}, {"name": "X-Keep", "value": "real"},
                      {"name": "Set-Cookie", "value": "a=1"}, {"name": "Set-Cookie", "value": "b=2"},
                      {"name": "Content-Encoding", "value": "gzip"}, {"name": "Content-Length", "value": "50"}]})
        return self.drain()

    def test_rewrite_distinguishes_matching_and_encodes_post_data(self):
        self.recorder.dispatch("route", {"url": "*/data", "method": "GET", "action": "continue", "rewrite": {
            "url": "https://fixture.invalid/echo", "method": "POST", "postData": "中文正文",
            "headers": {"X-New": "yes"}, "removeHeaders": ["x-remove"]}})
        self.emit("Fetch.requestPaused", {"requestId": "f", "request": {"url": "https://fixture.invalid/data", "method": "GET",
                  "headers": {"X-Remove": "no", "Accept": "application/json"}}})
        self.drain()
        value = next(c[1] for c in self.driver.calls if c[0] == "Fetch.continueRequest")
        self.assertEqual(value["url"], "https://fixture.invalid/echo")
        self.assertEqual(value["method"], "POST")
        self.assertEqual(base64.b64decode(value["postData"]).decode(), "中文正文")
        self.assertEqual({h["name"]: h["value"] for h in value["headers"]}, {"Accept": "application/json", "X-New": "yes"})

    def test_response_transform_preserves_original_fields_and_duplicate_headers(self):
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {
            "json": {"set": {"/change": "new", "/added": [1, 2]}, "remove": ["/remove"]},
            "status": 201, "headers": {"X-Added": "yes"}}})
        self.paused_response()
        value = next(c[1] for c in self.driver.calls if c[0] == "Fetch.fulfillRequest")
        self.assertEqual(json.loads(base64.b64decode(value["body"])), {"keep": {"real": True}, "change": "new", "added": [1, 2]})
        self.assertEqual(value["responseCode"], 201)
        self.assertEqual([h["value"] for h in value["responseHeaders"] if h["name"] == "Set-Cookie"], ["a=1", "b=2"])
        self.assertNotIn("content-encoding", {h["name"].lower() for h in value["responseHeaders"]})
        self.assertTrue(any(c[0] == "Fetch.enable" and c[1]["patterns"][0]["requestStage"] == "Response" for c in self.driver.calls))
        self.assertFalse(any(c[0] == "Fetch.continueRequest" for c in self.driver.calls))

    def test_response_text_replace_and_base64_utf8(self):
        self.driver.bodies["response"] = {"body": base64.b64encode("keep 中文 old".encode()).decode(), "base64Encoded": True}
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {
            "text": {"replace": [{"from": "old", "to": "new"}]}, "removeHeaders": ["X-Keep"]}})
        self.paused_response(kind="text/plain; charset=utf-8")
        value = next(c[1] for c in self.driver.calls if c[0] == "Fetch.fulfillRequest")
        self.assertEqual(base64.b64decode(value["body"]).decode(), "keep 中文 new")
        self.assertFalse(any(h["name"] == "X-Keep" for h in value["responseHeaders"]))

    def test_response_unmatched_method_continues_response_not_request(self):
        self.recorder.dispatch("route", {"url": "*", "method": "POST", "action": "response_transform", "transform": {"status": 201}})
        self.paused_response()
        self.assertTrue(any(c[0] == "Fetch.continueResponse" for c in self.driver.calls))
        self.assertFalse(any(c[0] == "Fetch.getResponseBody" for c in self.driver.calls))

    def test_transform_failure_fails_request_without_fallback(self):
        for body, kind in (("not-json", "application/json"), ("hello", "application/octet-stream"),
                           ("hello", "text/plain; charset=latin1")):
            with self.subTest(kind=kind, body=body):
                self.driver.bodies["response"] = {"body": body}
                self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"json": {"set": {"/x": 1}}}})
                before = len(self.driver.calls)
                result = self.paused_response(kind=kind)
                calls = self.driver.calls[before:]
                self.assertTrue(any(c[0] == "Fetch.failRequest" for c in calls))
                self.assertFalse(any(c[0] in ("Fetch.continueResponse", "Fetch.fulfillRequest", "Fetch.continueRequest") for c in calls))
                self.assertEqual(result["pendingPauses"], 0)

    def test_transformed_body_limit_terminates(self):
        self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"status": 201}})
        self.recorder.max_body_bytes = 10
        self.paused_response()
        self.assertTrue(any(c[0] == "Fetch.failRequest" for c in self.driver.calls))
        self.assertFalse(any(c[0] == "Fetch.fulfillRequest" for c in self.driver.calls))

    def test_json_pointer_nested_array_and_escaping(self):
        value = {"a/b": {"~x": ["zero", "one"]}, "keep": 1}
        self.assertEqual(self.recorder._json_patch(value, {"set": {"/a~1b/~0x/1": "changed"}, "remove": ["/a~1b/~0x/0"]}),
                         {"a/b": {"~x": ["changed"]}, "keep": 1})
        for pointer in ("", "no-slash", "/bad~2"):
            with self.assertRaises(BrowserControlError):
                self.recorder.dispatch("route", {"url": "*", "action": "response_transform", "transform": {"json": {"remove": [pointer]}}})

    def test_rewrite_rejects_unknown_nested_fields_and_lane_removal(self):
        for rewrite in ({"typo": True}, {"method": "POST\r\n"}, {"url": "file:///tmp/test"}, {"postData": 2}, {"removeHeaders": ["bad name"]}):
            with self.subTest(rewrite=rewrite), self.assertRaises(BrowserControlError):
                self.recorder.dispatch("route", {"url": "*", "rewrite": rewrite})
        self.assertFalse(any(c[0] == "Fetch.enable" for c in self.driver.calls))

    def test_file_override_snapshot_and_size(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source.txt"
            source.write_bytes(b"original")
            route = self.recorder.dispatch("override", {"url": "*", "file": str(source)})
            source.write_bytes(b"changed")
            self.emit("Fetch.requestPaused", {"requestId": "file", "request": {"url": "https://fixture.invalid/file"}})
            self.drain()
            call = next(c for c in self.driver.calls if c[0] == "Fetch.fulfillRequest")
            self.assertEqual(base64.b64decode(call[1]["body"]), b"original")
            self.assertTrue(route["fileSnapshot"])
            self.recorder.dispatch("unoverride", {"routeId": route["routeId"]})
            self.recorder.max_body_bytes = 2
            with self.assertRaises(BrowserControlError):
                self.recorder.dispatch("override", {"url": "*", "file": str(source)})

    def test_post_data_missing_is_fetched_once_and_no_network_replay(self):
        self.request(request={"url": "https://fixture.invalid/post", "method": "POST", "hasPostData": True, "headers": {}})
        record = self.detail(postData=True)
        self.assertEqual(record["postData"], "real-fixture-post")
        self.assertTrue(record["postDataAvailable"])
        self.recorder.dispatch("request_body", {"id": "r1"})
        self.assertEqual(sum(c[0] == "Network.getRequestPostData" for c in self.driver.calls), 1)
        self.assertFalse(any(c[0].startswith("Fetch.") for c in self.driver.calls))

    def test_controls_scope_dynamic_frames_and_close_resets(self):
        self.recorder.dispatch("cache", {"disabled": True})
        self.driver.session_ids = {"fixture", "child-fixture"}
        self.recorder.dispatch("service_worker", {"bypass": True})
        self.assertFalse(self.recorder.dispatch("controls")["priorStateKnown"])
        self.recorder.close()
        for method, field in (("Network.setCacheDisabled", "cacheDisabled"), ("Network.setBypassServiceWorker", "bypass")):
            for sid in ("fixture", "child-fixture"):
                calls = [c for c in self.driver.calls if c[0] == method and c[3] == sid]
                self.assertTrue(calls[0][1][field])
                self.assertFalse(calls[-1][1][field])
        self.assertFalse(any(c[0].startswith("Browser.") for c in self.driver.calls))

    def test_websocket_direction_bounded_cursor_and_connection_scope(self):
        from collections import deque
        self.recorder._ws_frames = deque(maxlen=2)
        self.emit("Network.webSocketCreated", {"requestId": "ws", "url": "ws://127.0.0.1:1234/"})
        for index in range(3):
            self.emit("Network.webSocketFrameSent" if index % 2 == 0 else "Network.webSocketFrameReceived",
                      {"requestId": "ws", "timestamp": index, "response": {"opcode": 1, "payloadData": str(index)}})
        self.emit("Network.webSocketClosed", {"requestId": "ws", "timestamp": 4})
        result = self.recorder.dispatch("ws_frames", {"after": 0, "limit": 1})
        self.assertTrue(result["cursorGap"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["frames"][0]["direction"], "received")
        self.assertEqual(result["dropped"]["webSocketFrames"], 1)
        second = self.recorder.dispatch("ws_frames", {"after": result["cursor"]})
        self.assertEqual(second["frames"][0]["payloadData"], "2")
        self.assertTrue(self.recorder.dispatch("ws_connections")["connections"][0]["closed"])

    def test_oversized_websocket_payload_retains_explicit_truncation(self):
        self.recorder.max_event_bytes = 128
        self.emit("Network.webSocketFrameReceived", {"requestId": "ws", "response": {"opcode": 1, "payloadData": "x" * 1000}})
        frame = self.recorder.dispatch("ws_frames")["frames"][0]
        self.assertTrue(frame["payloadTruncated"])
        self.assertEqual(frame["payloadBytes"], 1000)
        self.assertLess(len(frame["payloadData"]), 128)

    def test_oversized_pause_still_has_explicit_terminal_attempt(self):
        self.recorder.dispatch("route", {"url": "*", "body": "original"})
        self.recorder.max_event_bytes = 20
        self.emit("Fetch.requestPaused", {"requestId": "large", "request": {"url": "https://fixture.invalid/large"}})
        self.drain()
        self.assertTrue(any(c[0] == "Fetch.failRequest" and c[1]["requestId"] == "large" for c in self.driver.calls))
        self.assertEqual(self.recorder.dispatch("requests")["pendingPauses"], 0)


class NetworkPhase3Tests(unittest.TestCase):
    """控制台编号、请求筛选分页、正文落盘、HAR 模式、请求头与认证。"""

    def setUp(self):
        self.driver = FixtureDriver()
        self.driver.browser_owned = True
        self.recorder = NetworkRecorder(self.driver)
        self.addCleanup(self.recorder.close)

    def emit(self, event, params, session="fixture"):
        self.driver.cdp.emit(event, params, session)

    def log(self, kind="log", *args, stack=None):
        self.emit("Runtime.consoleAPICalled", {"type": kind, "args": list(args) or [{"type": "string", "value": kind}],
                                               "timestamp": 1, "stackTrace": stack})

    def navigate(self, loader, url="https://fixture.invalid/"):
        self.emit("Page.frameNavigated", {"frame": {"id": "fixture-frame", "loaderId": loader, "url": url}})

    def request(self, key, url="https://fixture.invalid/a", kind="Fetch", status=None, mime="application/json", **extra):
        self.emit("Network.requestWillBeSent", {"requestId": key, "type": kind, "timestamp": 1, "wallTime": 1700000000,
                                                "request": {"url": url, "method": "GET", "headers": {}, **extra}})
        if status is not None:
            self.emit("Network.responseReceived", {"requestId": key, "type": kind, "response": {
                "status": status, "headers": {"Content-Type": mime}, "mimeType": mime}})
            self.emit("Network.loadingFinished", {"requestId": key, "timestamp": 2, "encodedDataLength": 3})

    def cdp_calls(self, prefix=""):
        return [c for c in self.driver.calls if c[0].startswith(prefix) and c[0] not in (
            "Network.enable", "Runtime.enable", "Log.enable", "Audits.enable")]

    def private_dir(self):
        import tempfile, os
        from pathlib import Path
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        os.chmod(directory.name, 0o700)
        return Path(directory.name)

    # 控制台
    def test_console_ids_preview_location_types_and_cursor(self):
        stack = {"callFrames": [{"url": "https://fixture.invalid/app.js", "lineNumber": 4, "columnNumber": 9, "functionName": "f"}]}
        self.log("log", {"type": "string", "value": "hello"},
                 {"type": "object", "objectId": "obj-1", "description": "Object",
                  "preview": {"type": "object", "overflow": False, "properties": [{"name": "a", "type": "number", "value": "1"}]}},
                 stack=stack)
        self.log("warning")
        self.log("error")
        self.emit("Log.entryAdded", {"entry": {"level": "info", "source": "network", "text": "log info"}})
        self.emit("Audits.issueAdded", {"issue": {"code": "MixedContentIssue", "details": {"x": 1}}})
        result = self.recorder.dispatch("console")
        ids = [m["id"] for m in result["console"]]
        self.assertEqual(ids, sorted(ids, key=lambda v: int(v[4:])))
        self.assertTrue(all(re.fullmatch(r"msg-[0-9]+", i) for i in ids))
        first = result["console"][0]
        self.assertEqual(first["text"], "hello Object")
        self.assertEqual(first["args"][1]["preview"]["properties"][0]["name"], "a")
        self.assertNotIn("objectId", json.dumps(result))
        self.assertEqual((first["url"], first["lineNumber"], first["columnNumber"]), ("https://fixture.invalid/app.js", 4, 9))
        self.assertTrue(first["expandable"])
        self.assertEqual({m["source"] for m in result["console"]}, {"console", "log", "issue"})
        warn = self.recorder.dispatch("console", {"types": ["WARN", "issue"]})["console"]
        self.assertEqual([m["type"] for m in warn], ["warning", "issue"])
        page = self.recorder.dispatch("console", {"page_size": 2})
        self.assertEqual(len(page["console"]), 2)
        self.assertTrue(page["truncated"])
        rest = self.recorder.dispatch("console", {"after": page["nextCursor"], "page_size": 10})
        self.assertEqual([m["id"] for m in page["console"] + rest["console"]], ids)
        self.assertIsNone(rest["nextCursor"])
        error = self.recorder.dispatch("errors", {"types": ["error"]})["errors"][0]
        self.assertTrue(error["id"].startswith("msg-"))
        self.assertNotIn(error["id"], ids[:1])

    def test_console_message_expands_one_level_and_dead_object_is_explained(self):
        self.driver.properties["obj-1"] = {"result": [
            {"name": "a", "value": {"type": "number", "value": 1}, "isOwn": True, "enumerable": True},
            {"name": "nested", "value": {"type": "object", "objectId": "deep", "description": "Object"}, "isOwn": True},
            {"name": "getter", "get": {"type": "function"}, "isOwn": True}] +
            [{"name": f"p{i}", "value": {"type": "number", "value": i}, "isOwn": True} for i in range(5)],
            "internalProperties": [{"name": "[[Prototype]]", "value": {"type": "object", "description": "Object"}}]}
        self.log("log", {"type": "object", "objectId": "obj-1", "description": "Object"},
                 {"type": "object", "objectId": "gone", "description": "Object"}, {"type": "number", "value": 3},
                 stack={"callFrames": [{"url": "u", "lineNumber": 1, "columnNumber": 2}]})
        mid = self.recorder.dispatch("console")["console"][0]["id"]
        detail = self.recorder.dispatch("console_message", {"id": mid, "property_limit": 4})["message"]
        first, second, third = detail["argsDetail"]
        self.assertTrue(first["expanded"])
        self.assertEqual([p["name"] for p in first["properties"]], ["a", "nested", "getter", "p0"])
        self.assertTrue(first["propertiesTruncated"])
        self.assertEqual(first["propertyCount"], 8)
        self.assertNotIn("objectId", json.dumps(detail))
        self.assertTrue(first["properties"][2]["accessor"])
        self.assertFalse(first["getterInvoked"])
        self.assertEqual((second["expanded"], second["reason"]), (False, "object_unavailable"))
        self.assertEqual(third["reason"], "primitive_or_no_object")
        self.assertEqual(detail["stackTrace"]["callFrames"][0]["lineNumber"], 1)
        calls = [c for c in self.driver.calls if c[0] == "Runtime.getProperties"]
        self.assertEqual([c[1]["objectId"] for c in calls], ["obj-1", "gone"])
        self.assertTrue(all(c[1]["ownProperties"] for c in calls))

    def test_console_message_strict_params_and_missing(self):
        for params in ({}, {"id": 1}, {"id": "msg-x"}, {"id": "msg-1", "property_limit": 0},
                       {"id": "msg-1", "property_limit": 201}, {"id": "msg-1", "extra": 1}):
            with self.subTest(params=params), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("console_message", params)
            self.assertEqual(error.exception.code, 2)
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("console_message", {"id": "msg-99"})
        self.assertEqual(error.exception.code, 3)
        self.assertEqual(self.cdp_calls("Runtime.getProperties"), [])

    def test_console_and_errors_param_validation(self):
        for action in ("console", "errors"):
            for params in ({"types": "log"}, {"types": []}, {"types": ["nope"]}, {"after": 3}, {"after": "req-1"},
                           {"page_size": 0}, {"limit": 2, "after": "msg-1"}, {"include_previous_navigations": 1},
                           {"page": 1}):
                with self.subTest(action=action, params=params), self.assertRaises(BrowserControlError) as error:
                    self.recorder.dispatch(action, params)
                self.assertEqual(error.exception.code, 2)

    def test_navigation_segments_and_eviction_cursor_gap(self):
        self.navigate("L1")
        self.log("log", {"type": "string", "value": "first"})
        self.request("L2", url="https://fixture.invalid/next", kind="Document")
        self.navigate("L2", "https://fixture.invalid/next")
        self.log("log", {"type": "string", "value": "second"})
        self.emit("Page.frameNavigated", {"frame": {"id": "child", "parentId": "fixture-frame", "loaderId": "C"}})
        result = self.recorder.dispatch("console")
        self.assertEqual([m["navigation"] for m in result["console"]], [1, 2])
        self.assertEqual(result["navigation"], 2)
        current = self.recorder.dispatch("console", {"include_previous_navigations": False})["console"]
        self.assertEqual([m["text"] for m in current], ["second"])
        requests = self.recorder.dispatch("requests", {"include_previous_navigations": False})
        self.assertEqual([r["id"] for r in requests["requests"]], ["L2"])
        self.assertEqual(requests["requests"][0]["navigation"], 2)
        self.assertEqual([n["navigation"] for n in requests["navigations"]], [1, 2])
        from collections import deque
        self.recorder._console = deque(list(self.recorder._console), maxlen=2)
        self.log("log", {"type": "string", "value": "third"})
        gap = self.recorder.dispatch("console", {"after": "msg-0"})
        self.assertTrue(gap["cursorGap"])
        self.assertEqual(gap["dropped"]["console"], 1)

    # 网络记录
    def test_requests_resource_types_status_ranges_and_pages(self):
        for index, (kind, status) in enumerate((("Document", 200), ("XHR", 204), ("Fetch", 404), ("Image", 500),
                                                ("Script", 302), ("WebSocket", 101), ("Fetch", None))):
            self.request(f"r{index}", kind=kind, status=status)
        total = self.recorder.dispatch("requests")["total"]
        self.assertEqual(total, 7)
        ids = lambda params: [r["id"] for r in self.recorder.dispatch("requests", params)["requests"]]
        self.assertEqual(ids({"resource_types": ["fetch", "XHR"]}), ["r1", "r2", "r6"])
        self.assertEqual(ids({"status": "2xx"}), ["r0", "r1"])
        self.assertEqual(ids({"status": "400-599"}), ["r2", "r3"])
        self.assertEqual(ids({"status": 302}), ["r4"])
        self.assertEqual(ids({"status": "1XX"}), ["r5"])
        page2 = self.recorder.dispatch("requests", {"page": 2, "page_size": 3})
        self.assertEqual([r["id"] for r in page2["requests"]], ["r3", "r4", "r5"])
        self.assertEqual((page2["pages"], page2["truncated"]), (3, True))
        first = self.recorder.dispatch("requests", {"page_size": 4})
        after = self.recorder.dispatch("requests", {"after": first["nextCursor"], "page_size": 4})
        self.assertEqual([r["id"] for r in first["requests"] + after["requests"]], [f"r{i}" for i in range(7)])
        self.assertIsNone(after["nextCursor"])
        for params in ({"status": "6xx"}, {"status": "500-400"}, {"status": "2xx,3xx"}, {"resource_types": ["Bogus"]},
                       {"resource_types": "Fetch"}, {"page": 0}, {"page_size": 1001}, {"page": 1, "after": "req-1"},
                       {"after": "msg-1"}, {"limit": 1, "page": 1}, {"include_previous_navigations": "no"}):
            with self.subTest(params=params), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("requests", params)
            self.assertEqual(error.exception.code, 2)

    def test_save_body_and_post_data_private_files_without_overwrite(self):
        import os, stat as stat_module
        self.driver.bodies["r1"] = {"body": base64.b64encode(b"\x00\xffraw").decode(), "base64Encoded": True}
        self.request("r1", status=200, mime="image/png", method="POST", hasPostData=True)
        directory = self.private_dir()
        target = directory / "body.bin"
        result = self.recorder.dispatch("request", {"id": "r1", "save_body": str(target), "save_post_data": True})
        body, post = result["artifacts"]
        self.assertEqual(target.read_bytes(), b"\x00\xffraw")
        self.assertEqual((body["bytes"], body["mimeType"], body["base64Encoded"]), (5, "image/png", True))
        self.assertEqual(stat_module.S_IMODE(os.stat(target).st_mode), 0o600)
        with open(post["path"], "rb") as saved:
            self.assertEqual(saved.read(), b"real-fixture-post")
        self.assertEqual(stat_module.S_IMODE(os.stat(os.path.dirname(post["path"])).st_mode), 0o700)
        self.assertEqual(stat_module.S_IMODE(os.stat(post["path"]).st_mode), 0o600)
        os.remove(post["path"])
        self.assertNotIn("body", result["request"])
        calls_before = len(self.driver.calls)
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("request", {"id": "r1", "save_body": str(target)})
        self.assertEqual(error.exception.code, 6)
        self.assertEqual(len(self.driver.calls), calls_before)
        self.assertEqual(target.read_bytes(), b"\x00\xffraw")
        os.chmod(directory, 0o755)
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("request", {"id": "r1", "save_body": str(directory / "other.bin")})
        self.assertEqual(error.exception.code, 6)
        os.chmod(directory, 0o700)
        for value in ("relative.bin", 1, False, "", str(directory / "missing" / "x.bin")):
            with self.subTest(value=value), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("request", {"id": "r1", "save_body": value})
            self.assertEqual(error.exception.code, 2)

    def test_save_body_unavailable_does_not_replay_or_leave_file(self):
        self.request("r1", status=200)
        self.driver.bodies["r1"] = BrowserControlError("No resource with given identifier found")
        directory = self.private_dir()
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("request", {"id": "r1", "save_body": str(directory / "x.bin")})
        self.assertEqual(error.exception.code, 3)
        self.assertEqual(error.exception.data["reason"], "cdp_body_unavailable")
        self.assertEqual(list(directory.iterdir()), [])
        self.assertFalse(any(c[0] in ("Page.reload", "Network.replayXHR") for c in self.driver.calls))
        self.request("r2")
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("request", {"id": "r2", "save_post_data": True})
        self.assertEqual(error.exception.data["reason"], "request_has_no_body")

    def test_har_content_modes_and_legacy_body(self):
        self.driver.bodies["text"] = {"body": "plain", "base64Encoded": False}
        self.driver.bodies["bin"] = {"body": base64.b64encode(b"\x01\x02").decode(), "base64Encoded": True}
        def capture(params):
            self.recorder.dispatch("clear")
            self.recorder.dispatch("har_start", params)
            self.request("text", status=200, mime="text/plain")
            self.request("bin", status=200, mime="image/png")
            entries = self.recorder.dispatch("har_stop")["har"]["log"]["entries"]
            return {e["_requestId"]: e["response"]["content"] for e in entries}
        none = capture({"content": "none"})
        self.assertTrue(all("text" not in c for c in none.values()))
        self.assertFalse(any(c[0] == "Network.getResponseBody" for c in self.driver.calls))
        text = capture({"content": "text"})
        self.assertEqual(text["text"]["text"], "plain")
        self.assertNotIn("text", text["bin"])
        self.assertEqual(text["bin"]["_bodyReason"], "har_content_text_only")
        self.assertEqual(sum(c[0] == "Network.getResponseBody" for c in self.driver.calls), 1)
        all_ = capture({"content": "all"})
        self.assertEqual((all_["bin"]["text"], all_["bin"]["encoding"]), (base64.b64encode(b"\x01\x02").decode(), "base64"))
        legacy = capture({"body": True})
        self.assertEqual(legacy["text"]["text"], "plain")
        self.assertNotIn("text", legacy["bin"])
        for params in ({"content": "binary"}, {"content": True}, {"content": "text", "body": True}):
            with self.subTest(params=params), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("har_start", params)
            self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.recorder._har)

    # 请求头
    def test_page_headers_apply_to_frames_redact_and_clear_on_close(self):
        self.driver.session_ids = {"fixture", "child"}
        result = self.recorder.dispatch("headers_set", {"headers": {"X-Debug": "1", "Authorization": "Bearer secret"}})
        self.assertEqual(result["pageHeaders"]["Authorization"], "[REDACTED]")
        sets = [c for c in self.driver.calls if c[0] == "Network.setExtraHTTPHeaders"]
        self.assertEqual({c[3] for c in sets}, {"fixture", "child"})
        self.assertEqual(sets[-1][1]["headers"], {"X-Debug": "1", "Authorization": "Bearer secret"})
        self.assertNotIn("secret", json.dumps(self.recorder.dispatch("headers_get")))
        self.assertEqual(self.recorder.dispatch("headers_get", {"raw": True})["pageHeaders"]["Authorization"], "Bearer secret")
        self.recorder.dispatch("headers_set", {"headers": {"x-debug": "2"}})
        self.assertEqual(self.recorder.dispatch("headers_get")["pageHeaders"], {"x-debug": "2", "Authorization": "[REDACTED]"})
        self.driver.session_ids.add("late")
        self.recorder.dispatch("requests")
        self.assertTrue(any(c[0] == "Network.setExtraHTTPHeaders" and c[3] == "late" for c in self.driver.calls))
        self.recorder.close()
        for sid in ("fixture", "child", "late"):
            last = [c for c in self.driver.calls if c[0] == "Network.setExtraHTTPHeaders" and c[3] == sid][-1]
            self.assertEqual(last[1]["headers"], {})
        self.assertEqual(self.recorder.close_errors, [])
        self.assertFalse(any(c[0].startswith(("Browser.", "Target.")) for c in self.driver.calls))

    def test_headers_clear_names_and_replace(self):
        self.recorder.dispatch("headers_set", {"headers": {"X-A": "1", "X-B": "2"}})
        self.recorder.dispatch("headers_clear", {"names": ["x-a"]})
        self.assertEqual(self.recorder.dispatch("headers_get")["pageHeaders"], {"X-B": "2"})
        self.recorder.dispatch("headers_set", {"headers": {"X-C": "3"}, "replace": True})
        self.assertEqual(self.recorder.dispatch("headers_get")["pageHeaders"], {"X-C": "3"})
        self.recorder.dispatch("headers_clear")
        last = [c for c in self.driver.calls if c[0] == "Network.setExtraHTTPHeaders"][-1]
        self.assertEqual(last[1]["headers"], {})

    def test_headers_reject_invalid_and_unknown_before_cdp(self):
        for params in ({}, {"headers": {}}, {"headers": {"X Bad": "1"}}, {"headers": {"X-A": 1}}, {"headers": {"X-A": "a\r\nb"}},
                       {"headers": {"Host": "evil"}}, {"headers": {"Content-Length": "1"}}, {"headers": {"X-A": "1"}, "origin": "*"},
                       {"headers": {"X-A": "1"}, "origin": "https://a.invalid/path"}, {"headers": {"X-A": "1"}, "origin": "ftp://a.invalid"},
                       {"headers": {"X-A": "1"}, "replace": "yes"}, {"headers": {"X-A": "1"}, "extra": True},
                       {"headers": {"X-A": "1"}, "origin": "https://user:pw@a.invalid"}):
            with self.subTest(params=params), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("headers_set", params)
            self.assertEqual(error.exception.code, 2)
        for action, params in (("headers_get", {"raw": 1}), ("headers_clear", {"names": "x"}), ("headers_clear", {"origin": 1})):
            with self.subTest(action=action), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch(action, params)
            self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.cdp_calls("Network.setExtraHTTPHeaders") + self.cdp_calls("Fetch."), [])

    def test_origin_headers_only_on_matching_origin_and_merge_with_routes(self):
        result = self.recorder.dispatch("headers_set", {"headers": {"X-Origin": "yes"}, "origin": "HTTPS://API.fixture.invalid:443"})
        self.assertEqual(result["origin"], "https://api.fixture.invalid")
        enable = [c for c in self.driver.calls if c[0] == "Fetch.enable"][-1][1]
        self.assertEqual(enable["patterns"], [{"urlPattern": "https://api.fixture.invalid/*", "requestStage": "Request"}])
        self.assertNotIn("handleAuthRequests", enable)
        self.recorder.dispatch("route", {"url": "*", "action": "continue", "headers": {"X-Route": "r"}})
        enable = [c for c in self.driver.calls if c[0] == "Fetch.enable"][-1][1]
        self.assertEqual(len(enable["patterns"]), 2)
        self.emit("Fetch.requestPaused", {"requestId": "f1", "request": {"url": "https://api.fixture.invalid/x", "headers": {"A": "1"}}})
        self.emit("Fetch.requestPaused", {"requestId": "f2", "request": {"url": "https://other.invalid/x", "headers": {"A": "1"}}})
        self.recorder.dispatch("requests")
        calls = {c[1]["requestId"]: {h["name"]: h["value"] for h in c[1]["headers"]}
                 for c in self.driver.calls if c[0] == "Fetch.continueRequest"}
        self.assertEqual(calls["f1"], {"A": "1", "X-Origin": "yes", "X-Route": "r"})
        self.assertEqual(calls["f2"], {"A": "1", "X-Route": "r"})
        self.recorder.dispatch("unroute")
        self.assertEqual(self.recorder.dispatch("headers_get")["originHeaders"], {"https://api.fixture.invalid": {"X-Origin": "yes"}})
        self.assertFalse(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.recorder.dispatch("headers_clear", {"origin": "https://api.fixture.invalid"})
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))

    def test_page_header_timeout_is_unknown_not_replayed(self):
        self.driver.failures["Network.setExtraHTTPHeaders"] = BrowserControlError("timeout", 4, outcome="unknown")
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("headers_set", {"headers": {"X-A": "1"}})
        self.assertEqual((error.exception.code, error.exception.outcome), (4, "unknown"))
        self.assertEqual(sum(c[0] == "Network.setExtraHTTPHeaders" for c in self.driver.calls), 1)
        del self.driver.failures["Network.setExtraHTTPHeaders"]
        self.recorder.close()
        last = [c for c in self.driver.calls if c[0] == "Network.setExtraHTTPHeaders"][-1]
        self.assertEqual(last[1]["headers"], {})

    def test_close_reports_header_reset_failure(self):
        self.recorder.dispatch("headers_set", {"headers": {"X-A": "1"}})
        self.driver.failures["Network.setExtraHTTPHeaders"] = BrowserControlError("connection lost", 5, outcome="unknown")
        self.recorder.close()
        self.assertEqual(self.recorder.close_errors[0]["action"], "extra_headers_reset")
        self.assertEqual(self.recorder.close_errors[0]["outcome"], "unknown")

    # 认证
    def auth(self, request_id, url="https://auth.fixture.invalid/p", scheme="basic", source="Server", session="fixture"):
        self.emit("Fetch.authRequired", {"requestId": request_id, "request": {"url": url, "method": "GET"},
                                         "authChallenge": {"source": source, "origin": url.split("/p")[0], "scheme": scheme, "realm": "r"}},
                  session=session)
        self.recorder.dispatch("requests")
        return [c for c in self.driver.calls if c[0] == "Fetch.continueWithAuth"][-1][1]["authChallengeResponse"]

    def test_auth_provides_only_for_origin_once_and_never_echoes_password(self):
        result = self.recorder.dispatch("auth_set", {"username": "fixture-user", "password": "pw-secret-123",
                                                     "origin": "https://auth.fixture.invalid"})
        self.assertNotIn("pw-secret-123", json.dumps(result))
        enable = [c for c in self.driver.calls if c[0] == "Fetch.enable"][-1][1]
        self.assertTrue(enable["handleAuthRequests"])
        self.assertEqual(enable["patterns"], [{"urlPattern": "https://auth.fixture.invalid/*", "requestStage": "Request"}])
        self.assertEqual(self.auth("a1"), {"response": "ProvideCredentials", "username": "fixture-user", "password": "pw-secret-123"})
        self.assertEqual(self.auth("a1")["response"], "CancelAuth")
        self.assertEqual(self.auth("a2", url="https://other.invalid/p"), {"response": "Default"})
        self.assertEqual(self.auth("a3", source="Proxy"), {"response": "Default"})
        self.assertEqual(self.auth("a4", scheme="digest"), {"response": "Default"})
        for action, params in (("headers_get", {"raw": True}), ("controls", {}), ("errors", {}), ("requests", {"raw": True})):
            self.assertNotIn("pw-secret-123", json.dumps(self.recorder.dispatch(action, params)))
        state = self.recorder.dispatch("headers_get")["auth"][0]
        self.assertEqual((state["provided"], state["rejected"]), (1, 1))
        self.recorder.dispatch("auth_clear")
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.assertEqual(self.recorder._auth, {})

    def test_auth_coexists_with_route_request_paused(self):
        self.recorder.dispatch("route", {"url": "*/mock", "body": "mocked"})
        self.recorder.dispatch("auth_set", {"username": "u", "password": "p", "origin": "https://auth.fixture.invalid"})
        enable = [c for c in self.driver.calls if c[0] == "Fetch.enable"][-1][1]
        self.assertTrue(enable["handleAuthRequests"])
        self.assertIn({"urlPattern": "*/mock", "requestStage": "Request"}, enable["patterns"])
        self.emit("Fetch.requestPaused", {"requestId": "same", "request": {"url": "https://auth.fixture.invalid/mock"}})
        self.assertEqual(self.auth("same")["response"], "ProvideCredentials")
        self.assertTrue(any(c[0] == "Fetch.fulfillRequest" and c[1]["requestId"] == "same" for c in self.driver.calls))
        self.recorder.dispatch("auth_clear", {"origin": "https://auth.fixture.invalid"})
        enable = [c for c in self.driver.calls if c[0] == "Fetch.enable"][-1][1]
        self.assertNotIn("handleAuthRequests", enable)
        self.assertEqual(enable["patterns"], [{"urlPattern": "*/mock", "requestStage": "Request"}])

    def test_auth_strict_params_and_shared_browser_authorization(self):
        for params in ({"username": "u", "password": "p"}, {"username": "", "password": "p", "origin": "https://a.invalid"},
                       {"username": "a:b", "password": "p", "origin": "https://a.invalid"},
                       {"username": "u", "password": 1, "origin": "https://a.invalid"},
                       {"username": "u", "password": "p", "origin": "https://a.invalid/x"},
                       {"username": "u", "password": "p", "origin": "https://a.invalid", "realm": "r"},
                       {"username": "u", "password": "p", "origin": "https://a.invalid", "authorized": "yes"}):
            with self.subTest(params=params), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch("auth_set", params)
            self.assertEqual(error.exception.code, 2)
            self.assertNotIn("p", getattr(error.exception, "data", {}) or {})
        self.driver.browser_owned = False
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("auth_set", {"username": "u", "password": "p", "origin": "https://a.invalid"})
        self.assertEqual(error.exception.code, 6)
        self.assertEqual(self.cdp_calls("Fetch."), [])
        self.recorder.dispatch("auth_set", {"username": "u", "password": "p", "origin": "https://a.invalid", "authorized": True})
        self.assertTrue(self.cdp_calls("Fetch.enable"))

    def test_auth_enable_timeout_rolls_back_and_does_not_retry(self):
        self.driver.failures["Fetch.enable"] = BrowserControlError("timeout", 4, outcome="unknown")
        with self.assertRaises(BrowserControlError) as error:
            self.recorder.dispatch("auth_set", {"username": "u", "password": "secret-pw", "origin": "https://a.invalid"})
        self.assertEqual(error.exception.outcome, "unknown")
        self.assertEqual(sum(c[0] == "Fetch.enable" for c in self.driver.calls), 1)
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        self.assertEqual(self.recorder._auth, {})
        self.assertEqual(self.recorder.dispatch("headers_get")["auth"], [])

    def test_raw_view_redacts_authorization_for_auth_origin(self):
        self.recorder.dispatch("auth_set", {"username": "u", "password": "pw", "origin": "https://auth.fixture.invalid"})
        self.request("r1", url="https://auth.fixture.invalid/p", status=200, headers={"Authorization": "Basic dTpwdw=="})
        self.request("r2", url="https://other.invalid/p", status=200, headers={"Authorization": "Bearer visible"})
        rows = {r["id"]: r for r in self.recorder.dispatch("requests", {"raw": True})["requests"]}
        self.assertEqual(rows["r1"]["requestHeaders"]["Authorization"], "[REDACTED:auth_set]")
        self.assertEqual(rows["r2"]["requestHeaders"]["Authorization"], "Bearer visible")

    def test_close_clears_auth_and_disables_fetch_and_pending_auth_is_cancelled(self):
        self.recorder.dispatch("auth_set", {"username": "u", "password": "pw", "origin": "https://a.invalid"})
        entered, release = threading.Event(), threading.Event()
        future = __import__("concurrent.futures", fromlist=["Future"]).Future()
        def block():
            entered.set()
            release.wait(2)
        self.recorder._queue.put_nowait((future, block))
        self.assertTrue(entered.wait(2))
        self.emit("Fetch.authRequired", {"requestId": "pending", "request": {"url": "https://a.invalid/x"},
                                         "authChallenge": {"source": "Server", "scheme": "basic", "origin": "https://a.invalid"}})
        closing = threading.Thread(target=self.recorder.close)
        closing.start()
        release.set()
        closing.join(5)
        self.assertEqual(self.recorder._auth, {})
        self.assertTrue(any(c[0] == "Fetch.disable" for c in self.driver.calls))
        cancel = [c for c in self.driver.calls if c[0] == "Fetch.continueWithAuth"]
        self.assertEqual([c[1]["authChallengeResponse"]["response"] for c in cancel], ["CancelAuth"])

    def test_controls_and_stats_report_headers_and_auth(self):
        self.recorder.dispatch("headers_set", {"headers": {"X-A": "1"}})
        self.recorder.dispatch("auth_set", {"username": "u", "password": "pw", "origin": "https://a.invalid"})
        controls = self.recorder.dispatch("controls")
        self.assertEqual(controls["headers"]["page"], ["X-A"])
        self.assertEqual(controls["headers"]["authOrigins"], ["https://a.invalid"])
        self.assertTrue(controls["interception"]["handleAuthRequests"])

    def test_new_actions_reject_unknown_fields(self):
        for action in ("console_message", "headers_set", "headers_get", "headers_clear", "auth_set", "auth_clear"):
            with self.subTest(action=action), self.assertRaises(BrowserControlError) as error:
                self.recorder.dispatch(action, {"unknownField": 1})
            self.assertEqual(error.exception.code, 2)
        for params in ({"save_body": True, "save_post_data": True, "x": 1},):
            with self.assertRaises(BrowserControlError):
                self.recorder.dispatch("request", dict(params, id="r1"))


if __name__ == "__main__":
    unittest.main()
