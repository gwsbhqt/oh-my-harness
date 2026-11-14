"""页面泳道：参数解析、与 headers-set 的头名归属、实际发出头的核对和警告；只用内存里的假调试连接。"""
import unittest
from unittest.mock import patch

from browser_use.errors import BrowserUseError
from browser_use.lane import LaneCheck, lane_params, requested, warning_text
from browser_use.network import NetworkRecorder, lane_headers
from test_network import FixtureDriver

BROWSER_USE_HEADERS = {"x-tt-env": "ppe_a", "force-workbench": "1"}


class ParamsTests(unittest.TestCase):
    def test_lane_params_shapes(self):
        self.assertEqual(lane_params("ppe_x"), {"env": "ppe_x"})
        self.assertEqual(lane_params('{"force-workbench": "1"}'), {"headers": {"force-workbench": "1"}})
        self.assertEqual(lane_params('{"headers": {"x-tt-branch": "feat/a"}}'), {"headers": {"x-tt-branch": "feat/a"}})
        self.assertEqual(lane_params({"env": "ppe_x"}), {"env": "ppe_x"})
        self.assertEqual(lane_params({"x-tt-branch": "feat/a"}), {"headers": {"x-tt-branch": "feat/a"}})
        with self.assertRaises(BrowserUseError):
            lane_params("{not json")

    def test_env_only_sets_x_tt_env(self):
        self.assertEqual(requested({"env": "ppe_a"}), {"x-tt-env": "ppe_a"})
        self.assertEqual(requested({"header": "X-Use-PPE", "value": "1"}), {"x-use-ppe": "1"})

    def test_any_legal_header_but_not_network_stack_headers(self):
        self.assertEqual(lane_headers({"headers": {"Force-Workbench": "1", "x-tt-env": "ppe_a"}}), BROWSER_USE_HEADERS)
        for name in ("Host", "content-length", "Connection"):
            with self.assertRaises(BrowserUseError) as caught:
                lane_headers({"headers": {name: "x"}})
            self.assertIn("网络栈", str(caught.exception))
        with self.assertRaises(BrowserUseError):
            lane_headers({"headers": {"bad name": "x"}})

    def test_bad_shapes_rejected(self):
        for params in ({}, {"env": "a", "headers": {"b": "c"}}, {"env": ""}, {"headers": {}},
                       {"headers": {"a": "x\ny"}}, {"headers": {"A": "1", "a": "2"}}, {"env": "a", "value": "b"},
                       {"env": '{"x-tt-env":"ppe_a"}'}, {"nope": 1}):
            with self.assertRaises(BrowserUseError, msg=params) as caught:
                requested(params)
            self.assertEqual(caught.exception.code, 2)


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.check = LaneCheck()
        self.check.reset(BROWSER_USE_HEADERS)

    def test_matching_counts_and_no_warning(self):
        self.check.observe("http://a/p", BROWSER_USE_HEADERS, BROWSER_USE_HEADERS)
        self.assertEqual((self.check.requests, self.check.matched, self.check.mismatched), (1, 1, 0))
        self.assertIsNone(self.check.take_warning())

    def test_requests_that_never_carried_browser_use_values_are_not_counted(self):
        self.check.observe("http://b/preflight", {}, {"x-tt-env": "ppe_b"})
        self.check.observe("http://a/worker", {"accept": "*/*"}, {})
        self.check.observe("http://a/script-own", {"x-tt-env": "mine"}, {"x-tt-env": "mine"})
        self.assertEqual(self.check.stats()["requests"], 0)
        self.assertIsNone(self.check.take_warning())

    def test_changed_and_missing_headers_warn_once_then_on_count_change(self):
        long_url = "http://a/" + "x" * 300
        self.check.observe(long_url, BROWSER_USE_HEADERS, {"x-tt-env": "ppe_b"})
        first = self.check.take_warning()
        rows = {row["header"]: row for row in first["mismatches"]}
        self.assertEqual((rows["x-tt-env"]["expected"], rows["x-tt-env"]["actual"]), ("ppe_a", "ppe_b"))
        self.assertIsNone(rows["force-workbench"]["actual"])
        self.assertTrue(rows["x-tt-env"]["sampleUrl"].endswith("…"))
        self.assertLess(len(rows["x-tt-env"]["sampleUrl"]), 130)
        for phrase in ("设的是 ppe_a，实际是 ppe_b", "force-workbench 设的是 1，实际没有带上", "关掉修改这个请求头的插件",
                       "x-tt-env=ppe_a"):
            self.assertIn(phrase, first["text"])
        self.assertIsNone(self.check.take_warning(), "同一种不一致不能每次都提醒")
        self.check.observe("http://a/2", BROWSER_USE_HEADERS, {"x-tt-env": "ppe_b"})
        again = self.check.take_warning()
        self.assertEqual({row["requests"] for row in again["mismatches"]}, {2})
        stats = self.check.stats()
        self.assertEqual((stats["requests"], stats["mismatched"], len(stats["mismatches"])), (2, 2, 2))

    def test_warning_text_alone(self):
        text = warning_text([{"header": "x-tt-env", "expected": "ppe_a", "actual": "ppe_b", "requests": 3,
                              "sampleUrl": "http://a/"}], {"x-tt-env": "ppe_a"})
        self.assertIn("3 个请求", text)


class RecorderLaneTests(unittest.TestCase):
    def setUp(self):
        self.driver = FixtureDriver()
        self.recorder = NetworkRecorder(self.driver)
        self.addCleanup(self.recorder.close)

    def extra_calls(self):
        return [c[1]["headers"] for c in self.driver.calls if c[0] == "Network.setExtraHTTPHeaders"]

    def emit(self, event, params):
        self.driver.cdp.emit(event, params, "fixture")

    def sent(self, key, url, intended, wire):
        self.emit("Network.requestWillBeSent", {"requestId": key, "timestamp": 1, "type": "Fetch",
                                                "request": {"url": url, "method": "GET", "headers": intended}})
        if wire is not None:
            self.emit("Network.requestWillBeSentExtraInfo", {"requestId": key, "headers": wire})

    def test_set_merges_with_headers_set_and_clear_removes_only_lane(self):
        self.recorder.dispatch("headers_set", {"headers": {"X-Debug": "1"}})
        state = self.recorder.lane("set", {"headers": BROWSER_USE_HEADERS})
        self.assertEqual(state["headers"], BROWSER_USE_HEADERS)
        self.assertEqual(self.extra_calls()[-1], {"X-Debug": "1", **BROWSER_USE_HEADERS})
        self.assertEqual(self.recorder.dispatch("headers_get")["laneHeaders"], sorted(BROWSER_USE_HEADERS))
        self.recorder.lane("clear", {})
        self.assertEqual(self.extra_calls()[-1], {"X-Debug": "1"})

    def test_one_owner_per_header(self):
        self.recorder.lane("set", {"env": "ppe_a"})
        with self.assertRaises(BrowserUseError) as caught:
            self.recorder.dispatch("headers_set", {"headers": {"X-TT-Env": "other"}})
        self.assertEqual(caught.exception.code, 6)
        self.assertIn("lane", str(caught.exception))
        self.recorder.lane("clear", {})
        self.recorder.dispatch("headers_set", {"headers": {"force-workbench": "1"}})
        with self.assertRaises(BrowserUseError) as caught:
            self.recorder.lane("set", {"headers": BROWSER_USE_HEADERS})
        self.assertEqual(caught.exception.code, 6)
        self.assertIn("headers-clear", str(caught.exception))
        self.recorder.dispatch("headers_set", {"headers": {"x-tt-env": "ok"}, "origin": "https://a.example"})
        with self.assertRaises(BrowserUseError):
            self.recorder.lane("set", {"env": "ppe_a"})

    def test_bad_header_sends_nothing(self):
        before = len(self.driver.calls)
        with self.assertRaises(BrowserUseError):
            self.recorder.lane("set", {"headers": {"Host": "x"}})
        self.assertEqual(len(self.driver.calls), before)

    def test_wire_check_counts_and_skips_requests_without_wire(self):
        self.recorder.lane("set", {"headers": BROWSER_USE_HEADERS})
        self.sent("ok", "http://a/ok", BROWSER_USE_HEADERS, BROWSER_USE_HEADERS)
        self.sent("cache", "http://a/cache", BROWSER_USE_HEADERS, None)
        self.sent("data", "data:text/plain,hi", BROWSER_USE_HEADERS, None)
        self.sent("pre", "http://b/api", {}, {"x-tt-env": "ppe_b"})
        self.sent("bad", "http://a/api", BROWSER_USE_HEADERS, {"x-tt-env": "ppe_b"})
        state = self.recorder.lane("get", {})
        check = state["check"]
        self.assertEqual((check["requests"], check["matched"], check["mismatched"]), (2, 1, 1))
        warning = self.recorder.lane_warning()
        self.assertIn("http://a/api", warning["text"])
        self.assertIsNone(self.recorder.lane_warning())

    def test_wire_before_request_event_also_checked(self):
        self.recorder.lane("set", {"env": "ppe_a"})
        self.emit("Network.requestWillBeSentExtraInfo", {"requestId": "r", "headers": {"x-tt-env": "ppe_b"}})
        self.emit("Network.requestWillBeSent", {"requestId": "r", "timestamp": 1, "type": "Document",
                                                "request": {"url": "http://a/", "method": "GET", "headers": {"x-tt-env": "ppe_a"}}})
        self.assertEqual(self.recorder.lane("get", {})["check"]["mismatched"], 1)

    def test_close_releases_lane_on_every_session(self):
        self.recorder.lane("set", {"env": "ppe_a"})
        self.recorder.close()
        self.assertEqual(self.extra_calls()[-1], {})
        self.assertIsNone(self.recorder.lane_warning())


class EngineLaneTests(unittest.TestCase):
    """新开页先设泳道再导航；页面动作结果里带警告；lane_status 不连浏览器。"""

    def test_tab_new_sets_lane_before_navigation(self):
        from browser_use import engine as engine_module
        order = []

        class Network:
            def lane(self, action, params):
                order.append(("lane", action, params))
                return {"headers": params["headers"]}

            def lane_warning(self):
                return None

        class Driver:
            def dispatch(self, action, params):
                order.append(("page", action, params.get("url")))
                return {}

        core = engine_module.Engine()
        browser = {"cdp": unittest.mock.Mock(), "context_id": None, "scope": None}
        browser["cdp"].call.return_value = {"targetId": "t1"}
        binding = {"targetId": "t1", "owned": True, "browser": "Chrome", "url": "about:blank", "owner": "s",
                   "driver": Driver(), "network": Network()}
        with patch.object(core, "_browser", return_value=browser), patch.object(core, "_bind", return_value=binding):
            reply = core.dispatch({"action": "tab_new", "session": "s", "browser": "Chrome",
                                   "params": {"url": "http://a/", "lane": {"headers": BROWSER_USE_HEADERS}}})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(order, [("lane", "set", {"headers": BROWSER_USE_HEADERS}), ("page", "goto", "http://a/")])
        created = browser["cdp"].call.call_args_list[0]
        self.assertEqual(created.args[1]["url"], "about:blank")
        self.assertEqual(reply["result"]["lane"], {"headers": BROWSER_USE_HEADERS})

    def test_bad_lane_on_tab_new_creates_nothing(self):
        from browser_use import engine as engine_module
        core = engine_module.Engine()
        browser = {"cdp": unittest.mock.Mock(), "context_id": None, "scope": None}
        with patch.object(core, "_browser", return_value=browser):
            reply = core.dispatch({"action": "tab_new", "session": "s", "browser": "Chrome",
                                   "params": {"lane": {"headers": {"Host": "x"}}}})
        self.assertFalse(reply["ok"])
        browser["cdp"].call.assert_not_called()

    def test_page_action_carries_warning(self):
        from browser_use import engine as engine_module
        import threading
        core = engine_module.Engine()

        class Network:
            def lane_warning(self):
                return {"text": "泳道请求头没有按 browser-use 设的值发出去", "mismatches": []}

        class Driver:
            cdp = None

            def dispatch(self, action, params):
                return {"done": action}

        core.browsers[("Chrome", "s")] = {"cdp": None}
        core.bindings[("Chrome", "t1")] = {"owner": "s", "driver": Driver(), "network": Network(), "lock": threading.RLock()}
        with patch.object(core, "_browser", return_value=core.browsers[("Chrome", "s")]):
            reply = core.dispatch({"action": "page_click", "session": "s", "browser": "Chrome", "target": "t1", "params": {}})
        self.assertEqual(reply["result"]["done"], "click")
        self.assertIn("laneWarning", reply["result"])

    def test_lane_status_does_not_start_browser(self):
        from browser_use import engine as engine_module
        core = engine_module.Engine()
        with patch.object(core, "_browser", side_effect=AssertionError("不该连浏览器")):
            reply = core.dispatch({"action": "lane_status", "session": "s", "browser": "Chrome"})
        self.assertEqual(reply["result"], {"pages": []})


if __name__ == "__main__":
    unittest.main()
