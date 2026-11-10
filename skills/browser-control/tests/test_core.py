"""核心协议与资源隔离回归，不连接用户浏览器。"""
import json
import threading
import unittest
from unittest.mock import Mock, patch
from websockets.sync.server import serve
from browser_control.cdp import CDP
from browser_control.errors import BrowserControlError
from browser_control.engine import Engine


class CDPTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.gate = threading.Event()
        def handler(ws):
            for raw in ws:
                request = json.loads(raw)
                self.seen.append(request)
                if request["method"] == "disconnect":
                    ws.close()
                    return
                if request["method"] == "hang":
                    continue
                if request["method"] == "event":
                    ws.send(json.dumps({"method": "Test.event", "sessionId": "child", "params": {"value": 1}}))
                if request["method"] == "error":
                    ws.send(json.dumps({"id": request["id"], "error": {"message": "rejected"}}))
                else:
                    ws.send(json.dumps({"id": request["id"], "result": {"value": request["method"]}}))
        self.server = serve(handler, "127.0.0.1", 0)
        port = self.server.socket.getsockname()[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cdp = CDP(f"ws://127.0.0.1:{port}")
    def tearDown(self):
        self.cdp.close()
        self.server.shutdown()
        self.thread.join(3)
    def test_session_and_response(self):
        self.assertEqual(self.cdp.call("hello", session_id="child"), {"value": "hello"})
        self.assertEqual(self.seen[0]["sessionId"], "child")
    def test_error(self):
        with self.assertRaises(BrowserControlError) as raised:
            self.cdp.call("error")
        self.assertIn("rejected", str(raised.exception))
    def test_timeout_not_replayed(self):
        with self.assertRaises(BrowserControlError) as raised:
            self.cdp.call("hang", timeout=.1)
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertEqual(sum(x["method"] == "hang" for x in self.seen), 1)
        self.assertEqual(self.cdp.call("later"), {"value": "later"})
    def test_event_callback_can_read_without_receiver_deadlock(self):
        results = []
        def callback(params, session):
            results.append((params, session, self.cdp.call("nested")))
            self.gate.set()
        self.cdp.on("Test.event", callback)
        self.cdp.call("event")
        self.assertTrue(self.gate.wait(2))
        self.assertEqual(results[0][1], "child")
    def test_event_flush_observes_all_prior_callbacks(self):
        values = []
        self.cdp.on("Test.event", lambda p, s: values.append(p["value"]))
        self.cdp.call("event")
        self.cdp.flush_events(timeout=2)
        self.assertEqual(values, [1])

    def test_external_disconnect_pending_is_unknown_and_not_replayed(self):
        with self.assertRaises(BrowserControlError) as raised:
            self.cdp.call("disconnect")
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertTrue(self.cdp.closed)
        with self.assertRaises(BrowserControlError) as later:
            self.cdp.call("later")
        self.assertEqual(later.exception.outcome, "not_sent")
        self.assertEqual([r["method"] for r in self.seen], ["disconnect"])

    def test_disconnect_never_resends(self):
        self.cdp.close()
        with self.assertRaises(BrowserControlError) as raised:
            self.cdp.call("hello")
        self.assertEqual(raised.exception.outcome, "not_sent")
        self.assertEqual(self.seen, [])


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.browser = {"cdp": Mock(), "endpoint": "fake", "process": None, "profile": None}
        self.engine._browser = Mock(return_value=self.browser)
    def request(self, action, **kwargs):
        return self.engine.dispatch(dict(session="test", browser="Chrome", action=action, **kwargs))
    def test_remote_refuses_before_browser(self):
        response = self.request("tab_new", host="beta")
        self.assertFalse(response["ok"])
        self.engine._browser.assert_not_called()
    def test_session_name_validation(self):
        response = self.engine.dispatch({"session": "../other", "action": "tab_new"})
        self.assertEqual(response["code"], 2)
    def test_action_cannot_adopt_active_tab(self):
        response = self.request("page_click", target="missing", params={"label": "Delete"})
        self.assertEqual(response["code"], 6)
        self.browser["cdp"].call.assert_not_called()
    def test_borrowed_tab_not_closed(self):
        driver = Mock(cdp=self.browser["cdp"])
        self.engine.bindings[("Chrome", "user")] = {"owner": "test", "owned": False, "driver": driver, "network": Mock(), "lock": threading.RLock(), "targetId": "user", "browser": "Chrome"}
        response = self.request("tab_close", target="user")
        self.assertEqual(response["code"], 6)
        self.browser["cdp"].call.assert_not_called()
    def test_other_session_refused(self):
        self.engine.bindings[("Chrome", "other")] = {"owner": "someone"}
        response = self.request("page_click", target="other")
        self.assertEqual(response["code"], 6)
    def test_only_set_get_clear_lane_actions_on_page(self):
        from browser_control.network import NetworkRecorder
        from test_network import FixtureDriver
        network = NetworkRecorder(FixtureDriver())
        self.addCleanup(network.close)
        self.engine.bindings[("Chrome", "mine")] = {"owner": "test", "owned": True, "driver": Mock(cdp=self.browser["cdp"]), "network": network,
                                                 "lock": threading.RLock(), "targetId": "mine", "browser": "Chrome"}
        for action in ("lane_tabs", "lane_capabilities"):
            response = self.request(action, target="mine", params={})
            self.assertEqual(response["code"], 2, (action, response))
        response = self.request("lane_set", target="mine", params={"env": "ppe_test"})
        self.assertEqual(response["result"]["headers"], {"x-tt-env": "ppe_test"})
        self.assertIn("刷新页面", response["result"]["note"])


class RecoveryOwnershipTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        from browser_control.resources import ResourceLedger
        from test_page import FakeCDP
        self.temp = tempfile.TemporaryDirectory(prefix="browser-control-recovery-unit-")
        self.addCleanup(self.temp.cleanup)
        self.engine = Engine(ResourceLedger(Path(self.temp.name).resolve() / "resources.json"))
        self.addCleanup(self.engine.close)
        self.scope = "11111111-1111-1111-1111-111111111111"
        self.url = "ws://127.0.0.1:12345/devtools/browser/" + self.scope
        class TargetCDP(FakeCDP):
            def __init__(inner):
                super().__init__()
                inner.closed = False
                inner.targets = {"first", "second"}
                inner.attachments = 0
            def call(inner, method, params=None, **kw):
                if inner.closed:
                    raise BrowserControlError("浏览器连接已关闭", 5, outcome="not_sent")
                if method == "Target.getTargets":
                    return {"targetInfos": [{"targetId": t, "type": "page"} for t in sorted(inner.targets)]}
                if method == "Target.attachToTarget":
                    inner.attachments += 1
                    return {"sessionId": "session-" + str(inner.attachments)}
                if method == "Target.closeTarget":
                    inner.targets.discard(params["targetId"])
                    return {"success": True}
                return super().call(method, params, **kw)
            def close(inner):
                inner.closed = True
        self.factory = TargetCDP
        self.old = TargetCDP()
        self.record = {"cdp": self.old, "scope": self.scope, "endpoint": "http://127.0.0.1:12345",
                       "process": None, "profile": None, "context_id": None}
        self.engine.browsers[("Chrome", "a")] = self.record
        self.engine._bind("Chrome", "a", "first", self.record, owned=True)
        self.discovery = patch("browser_control.engine.discover", return_value=self.url)
        self.discovery.start()
        self.addCleanup(self.discovery.stop)
        self.connections = patch("browser_control.engine.CDP", side_effect=lambda url: TargetCDP())
        self.connections.start()
        self.addCleanup(self.connections.stop)

    def call(self, action, owner="a", target=None):
        return self.engine.dispatch({"action": action, "session": owner, "browser": "Chrome", "target": target})

    def test_recovery_restores_only_the_same_task_binding(self):
        before = self.engine.ledger.list(self.scope)
        self.old.closed = True
        tabs = self.call("tab_list")
        self.assertEqual(tabs["data"]["recoveryTargets"], ["first"])
        self.assertTrue(self.call("tab_recover", target="first")["ok"])
        self.assertEqual(self.engine.ledger.list(self.scope), before)

    def test_status_reports_closed_cached_chrome_connection(self):
        self.old.closed = True
        status = self.call("status")["result"]
        self.assertFalse(status["ready"])
        self.assertFalse(status["connected"])
        self.old.closed = False

    def test_scope_change_and_missing_target_refuse_without_rebinding(self):
        self.old.closed = True
        with patch("browser_control.engine.discover", return_value=self.url.replace(self.scope, "22222222-2222-2222-2222-222222222222")):
            self.assertEqual(self.call("tab_recover", target="first")["code"], 6)
        original_factory = self.factory
        def without_target(url):
            connection = original_factory()
            connection.targets.discard("first")
            return connection
        with patch("browser_control.engine.CDP", side_effect=without_target):
            self.assertEqual(self.call("tab_recover", target="first")["code"], 4)
        self.assertIs(self.record["cdp"], self.old)
        self.old.closed = False

    def test_custom_state_attempts_refuse_before_connection_or_actions(self):
        binding = self.engine.bindings[("Chrome", "first")]
        for action in ("network_route", "network_headers_set", "lane_set", "page_init_add", "page_viewport", "debug_enable", "state_cookies", "output_pdf"):
            with self.subTest(action=action):
                self.engine._remember_configuration(binding, action, {})
                result = self.call("tab_recover", target="first")
                self.assertEqual(result["code"], 6)
                self.assertIn(action, result["data"]["settings"])
                binding["recovery_blockers"].clear()
        self.assertEqual(self.old.attachments, 1)


if __name__ == "__main__":
    unittest.main()
