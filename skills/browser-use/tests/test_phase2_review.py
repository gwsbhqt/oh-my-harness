"""第二阶段独立审查的确定清理与公开命名回归，不连接浏览器。"""
import importlib
import threading
import unittest
from unittest.mock import Mock

import browser_use
from browser_use.engine import Engine
from browser_use.errors import BrowserUseError


class Phase2ReviewTests(unittest.TestCase):
    def make_cleanup(self, *, detach_error=None, target_close_error=None):
        calls = []

        class Component:
            session_id = "fixture-session"

            def __init__(self, name):
                self.name = name

            def close(self):
                calls.append(self.name)
                raise BrowserUseError("fixture " + self.name + " failed", 6)

        class Connection:
            def call(self, method, params=None):
                calls.append(method)
                if method == "Target.detachFromTarget":
                    if detach_error is not None:
                        raise detach_error
                    return {}
                if method == "Target.getTargets":
                    return {"targetInfos": [{"targetId": "fixture-target"}]}
                raise AssertionError(method)

        ledger = Mock()
        engine = Engine(ledger)
        engine._release_uploads = Mock(return_value={"cleaned": []})
        binding = {"targetId": "fixture-target", "owner": "review", "browser": "Chrome",
                   "owned": True, "lock": threading.RLock(),
                   "driver": Component("page"), "network": Component("network"),
                   "diagnostics": Component("diagnostics"), "elements": Component("elements")}
        browser = {"cdp": Connection(), "scope": "fixture-scope"}
        binding["driver"].cdp = browser["cdp"]
        engine.bindings[("Chrome", "fixture-target")] = binding
        engine.browsers[("Chrome", "review")] = browser

        def close_target(record, target):
            calls.append("confirmed-close")
            if target_close_error is not None:
                raise target_close_error

        engine._close_target = close_target
        return engine, ledger, calls

    def close_request(self, engine):
        return engine.dispatch({"action": "tab_close", "session": "review",
                                "browser": "Chrome", "target": "fixture-target"})

    def assert_domains(self, reply, extra=()):
        self.assertEqual([row["domain"] for row in reply["data"]["errors"]],
                         ["diagnostics", "elements", "network", "page", *extra])
        self.assertEqual(reply["command"], "tab_close")
        self.assertEqual(reply["host"], "local")

    def test_cleanup_errors_still_detach_close_and_aggregate(self):
        engine, ledger, calls = self.make_cleanup()
        reply = self.close_request(engine)
        self.assertFalse(reply["ok"])
        self.assert_domains(reply)
        self.assertEqual(calls, ["diagnostics", "elements", "network", "page",
                                 "Target.detachFromTarget", "Target.getTargets", "confirmed-close"])
        self.assertFalse(engine.bindings)
        ledger.remove.assert_called_once_with("fixture-scope", "review", "fixture-target")

    def test_detach_unknown_keeps_prior_errors_and_recovery_ownership(self):
        error = BrowserUseError("fixture detach failed", 5, outcome="unknown")
        engine, ledger, calls = self.make_cleanup(detach_error=error)
        reply = self.close_request(engine)
        self.assert_domains(reply, ("detach",))
        self.assertEqual(reply["code"], 5)
        self.assertEqual(reply["outcome"], "unknown")
        self.assertEqual(reply["data"]["errors"][-1]["outcome"], "unknown")
        self.assertTrue(engine.bindings)
        ledger.remove.assert_not_called()
        self.assertNotIn("confirmed-close", calls)

    def test_target_close_unknown_keeps_prior_errors_and_recovery_ownership(self):
        error = BrowserUseError("fixture target close timeout", 4, outcome="unknown", data={"targetId": "fixture-target"})
        engine, ledger, calls = self.make_cleanup(target_close_error=error)
        reply = self.close_request(engine)
        self.assert_domains(reply, ("target_close",))
        self.assertEqual(reply["code"], 4)
        self.assertEqual(reply["outcome"], "unknown")
        self.assertTrue(engine.bindings)
        ledger.remove.assert_not_called()
        self.assertIn("confirmed-close", calls)

    def test_domain_module_imports_do_not_replace_public_functions(self):
        importlib.import_module("browser_use.elements")
        importlib.import_module("browser_use.lane")
        for name in ("element", "locate_all", "lane_status"):
            self.assertTrue(callable(getattr(browser_use, name)), name)
        page = browser_use.page("fixture-target", browser="Chrome", session="review")
        self.assertTrue(callable(page.element))
        self.assertTrue(callable(page.elements))
        self.assertTrue(callable(page.lane.set))


if __name__ == "__main__":
    unittest.main()
