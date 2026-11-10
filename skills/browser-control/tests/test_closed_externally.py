"""页面在 browser-control 之外被关掉后，release、tab close、disconnect 的收尾；不连接真实浏览器。"""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from browser_control.diagnostics import Diagnostics
from browser_control.elements import ElementService
from browser_control.engine import Engine
from browser_control.errors import BrowserControlError
from browser_control.resources import ResourceLedger
from test_diagnostics import FakeCDP as DiagnosticsCDP
from test_page import FakeCDP as PageCDP
from browser_control.driver import PageDriver

SCOPE = "11111111-2222-3333-4444-555555555555"
TARGET = "fixture-target"
GONE = BrowserControlError("Debugger.disable：Session with given id not found.", 1)


class FakeBrowser:
    """假浏览器连接：页面是否还在由 alive 决定，调试连接解除按真实浏览器的报错返回。"""

    def __init__(self):
        self.alive = {TARGET}
        self.calls = []

    def call(self, method, params=None, **kwargs):
        self.calls.append(method)
        if method == "Target.getTargets":
            return {"targetInfos": [{"targetId": t, "type": "page"} for t in sorted(self.alive)]}
        if method == "Target.detachFromTarget":
            if not self.alive:
                raise BrowserControlError("Target.detachFromTarget：No session with given id", 1)
            return {}
        if method == "Target.closeTarget":
            self.alive.discard(params["targetId"])
            return {"success": True}
        raise AssertionError(method)


class Component:
    """页面上挂的某个服务；页面已不在时按真实服务的行为不报错，否则按 errors 报收尾失败。"""

    def __init__(self, errors=()):
        self.session_id = "page-session"
        self.close_errors = list(errors)
        self.closed = False

    def close(self):
        self.closed = True


class EngineClosedExternallyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="browser-control-closed-externally-")
        self.addCleanup(self.temp.cleanup)
        self.ledger = ResourceLedger(Path(self.temp.name).resolve() / "state" / "resources.json")
        self.engine = Engine(self.ledger)
        self.engine._release_uploads = Mock(return_value={"cleaned": []})
        self.engine._stop_browser = Mock()
        self.cdp = FakeBrowser()
        self.browser = {"cdp": self.cdp, "scope": SCOPE}
        self.engine.browsers[("Chrome", "task")] = self.browser
        self.engine._browser = lambda name, session, params=None: self.browser

    def bind(self, **components):
        self.ledger.record(SCOPE, "task", TARGET, True, "Chrome")
        binding = {"targetId": TARGET, "owner": "task", "browser": "Chrome", "owned": True,
                   "lock": threading.RLock(), "driver": Component(), "network": Component(), **components}
        binding["driver"].cdp = self.cdp
        self.engine.bindings[("Chrome", TARGET)] = binding
        return binding

    def request(self, action, target=None):
        return self.engine.dispatch({"action": action, "session": "task", "browser": "Chrome", "target": target})

    def test_release_after_external_close_succeeds_and_clears_ledger(self):
        self.bind(diagnostics=Component())
        self.cdp.alive.clear()
        reply = self.request("release")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["released"], [])
        self.assertEqual(reply["result"]["closedExternally"], [TARGET])
        self.assertEqual(self.ledger.list(SCOPE), [])
        self.assertFalse(self.engine.bindings)
        self.assertNotIn("Target.closeTarget", self.cdp.calls)
        again = self.request("release")
        self.assertTrue(again["ok"], again)
        self.assertNotIn("closedExternally", again["result"])

    def test_release_of_ledger_record_without_binding_reports_external_close(self):
        self.ledger.record(SCOPE, "task", TARGET, True, "Chrome")
        self.cdp.alive.clear()
        reply = self.request("release")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["closedExternally"], [TARGET])
        self.assertEqual(self.ledger.list(SCOPE), [])

    def test_release_of_live_page_is_not_reported_as_external_close(self):
        self.bind()
        reply = self.request("release")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"], {"released": [TARGET]})
        self.assertIn("Target.closeTarget", self.cdp.calls)

    def test_real_undo_failure_on_live_page_still_fails(self):
        self.bind(diagnostics=Component([{"action": "remove", "error": "Debugger.removeBreakpoint：fixture refused"}]))
        reply = self.request("release")
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], 1)
        self.assertEqual(reply["error"], "部分资源未能清理，保留记录供再次核对")
        self.assertNotIn("closedExternally", reply["data"])

    def test_tab_close_after_external_close_succeeds(self):
        self.bind(diagnostics=Component())
        self.cdp.alive.clear()
        reply = self.request("tab_close", TARGET)
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["closed"], TARGET)
        self.assertTrue(reply["result"]["closedExternally"])
        self.assertEqual(self.ledger.list(SCOPE), [])
        self.assertTrue(self.request("release")["ok"])

    def test_disconnect_after_external_close_drops_record(self):
        self.bind(diagnostics=Component())
        self.cdp.alive.clear()
        reply = self.request("disconnect")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["disconnected"], [])
        self.assertEqual(reply["result"]["closedExternally"], [TARGET])
        self.assertEqual(self.ledger.list(SCOPE), [])
        self.assertTrue(self.request("release")["ok"])

    def test_disconnect_of_live_page_keeps_record_for_release(self):
        self.bind()
        reply = self.request("disconnect")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"], {"disconnected": [TARGET], "targetsPreserved": True})
        self.assertEqual([r["targetId"] for r in self.ledger.list(SCOPE)], [TARGET])


class ServiceCloseAfterPageGoneTests(unittest.TestCase):
    def test_debugger_cleanup_on_gone_page_is_not_an_error(self):
        cdp = DiagnosticsCDP()
        driver = Mock(cdp=cdp, session_id="page", session_ids={"page"}, sessions={"page": "target"}, target_id="target")
        diagnostics = Diagnostics(driver)
        diagnostics.dispatch("enable", {})
        cdp.responses["Debugger.setBreakpointByUrl"] = {"breakpointId": "bp-1", "locations": []}
        diagnostics.dispatch("breakpoint", {"url_regex": ".*", "line": 0})
        cdp.responses["Debugger.removeBreakpoint"] = BrowserControlError("Debugger.removeBreakpoint：Session with given id not found.", 1)
        cdp.responses["Debugger.disable"] = GONE
        diagnostics.close()
        self.assertEqual(diagnostics.close_errors, [])

    def test_debugger_cleanup_failure_on_live_page_is_reported(self):
        cdp = DiagnosticsCDP()
        driver = Mock(cdp=cdp, session_id="page", session_ids={"page"}, sessions={"page": "target"}, target_id="target")
        diagnostics = Diagnostics(driver)
        diagnostics.dispatch("enable", {})
        cdp.responses["Debugger.disable"] = BrowserControlError("Debugger.disable：fixture refused", 1)
        diagnostics.close()
        self.assertEqual([e["action"] for e in diagnostics.close_errors], ["debugger_cleanup"])

    def element_service_with_patch(self):
        cdp = PageCDP()
        driver = PageDriver(cdp, "root", "session")
        self.addCleanup(driver.close)
        service = ElementService(driver)
        service._patches["patch-1"] = {"handle": {}, "before": {}, "after": {}}
        return cdp, driver, service

    def test_unrestored_patch_on_gone_page_is_not_an_error(self):
        cdp, driver, service = self.element_service_with_patch()
        original = cdp.call
        def call(method, params=None, **kwargs):
            if method == "Runtime.releaseObjectGroup":
                raise BrowserControlError("Runtime.releaseObjectGroup：Session with given id not found.", 1)
            return original(method, params, **kwargs)
        cdp.call = call
        service.close()
        self.assertEqual(service.close_errors, [])

    def test_unrestored_patch_on_live_page_is_reported(self):
        cdp, driver, service = self.element_service_with_patch()
        service.close()
        self.assertEqual(service.close_errors[0]["patchIds"], ["patch-1"])


if __name__ == "__main__":
    unittest.main()
