"""真实引擎调用链验收；显式启用，不连接用户浏览器。"""
import tempfile
import asyncio
from browser_use import Page
from pathlib import Path
import unittest
import os
import socket
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from browser_use.errors import BrowserUseError
from browser_use.engine import Engine
from browser_use.resources import ResourceLedger
from fixture_server import FixtureServer

@unittest.skipUnless(os.environ.get("BROWSER_USE_TEST_ENGINE"), "需显式 BROWSER_USE_TEST_ENGINE=1 启动专用Chrome")
class RealEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="browser-use-engine-test-")
        self.ledger=ResourceLedger(Path(self.tmp.name).resolve()/"resources.json")
        self.engine=Engine(ledger=self.ledger)
        self.fixture=FixtureServer().__enter__()
    def tearDown(self):
        try:self.engine.close()
        finally:self.fixture.__exit__(None,None,None);self.tmp.cleanup()
    def call(self,action,params=None,target=None,owner="a",ok=True):
        result=self.engine.dispatch({"session":owner,"browser":"Chrome","action":action,"target":target,"params":params or {}})
        if ok:self.assertTrue(result["ok"], result)
        return result
    def create(self,owner="a"):
        return self.call("tab_new",{"url":self.fixture.url,"init_script":"window.initBeforeLoad=true"},owner=owner)["result"]["targetId"]
    def test_dialog_call_chain_and_cleanup(self):
        page=self.create()
        self.assertTrue(self.call("page_eval",{"expression":"window.initBeforeLoad"},page)["result"]["value"])
        click=self.call("page_click",{"id":"dialog"},page)["result"]
        self.assertTrue(click.get("dialogPending"))
        self.call("page_dialog",{"accept":True},page)
        self.call("page_click",{"id":"name"},page)
        self.call("page_type",{"text":"弹窗恢复"},page)
        self.call("page_click",{"id":"query"},page)
        self.call("page_wait",{"label":"结果：弹窗恢复","timeout":3},page)
        result=self.call("network_requests",{"filter":"/api/"},page)["result"]
        self.assertEqual(result["total"],1)
        detail=self.call("network_request",{"id":result["requests"][0]["id"],"body":True},page)["result"]["request"]
        self.assertTrue(detail["bodyAvailable"])
        self.assertIn("name",detail["body"])
        scope=self.engine.browsers[("Chrome","a")]["scope"]
        self.assertEqual(len(self.ledger.list(scope,"a")),1)
        self.call("release")
        self.assertEqual(self.ledger.list(scope,"a"),[])
    def test_parallel_tasks_and_closed_target(self):
        first,second=self.create("a"),self.create("b")
        def query(target,owner,text):
            self.call("page_click",{"id":"name"},target,owner)
            self.call("page_type",{"text":text},target,owner)
            self.call("page_click",{"id":"query"},target,owner)
            self.call("page_wait",{"label":"结果："+text,"timeout":3},target,owner)
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(query,first,"a","甲"),pool.submit(query,second,"b","乙")]
            for future in futures:future.result(15)
        rejected=self.call("page_click",{"id":"query"},second,"a",ok=False)
        self.assertEqual(rejected["code"],6)
        browser=self.engine.browsers[("Chrome","a")]
        browser["cdp"].call("Target.closeTarget",{"targetId":first})
        rejected=self.call("page_click",{"id":"query"},first,ok=False)
        self.assertEqual(rejected["code"],4)
        self.call("release")
        self.assertEqual(self.call("page_eval",{"expression":"document.querySelector('#result').textContent"},second,"b")["result"]["value"],"结果：乙；点击次数：1")
    def test_restore_owned_metadata_without_action_binding(self):
        page=self.create()
        browser=self.engine.browsers[("Chrome","a")]
        scope=browser["scope"]
        recovered=Engine(ledger=ResourceLedger(self.ledger.path))
        recovered._browser=lambda name,owner,params=None:browser
        recovered._stop_browser=lambda name,owner:None
        recovered.browsers[("Chrome","a")]=browser
        self.assertEqual(recovered.bindings,{})
        result=recovered.dispatch({"session":"a","browser":"Chrome","action":"release"})
        self.assertTrue(result["ok"],result)
        self.assertIn(page,result["result"]["released"])
        self.assertEqual(self.ledger.list(scope,"a"),[])
        self.assertFalse(any(t["targetId"]==page for t in self.engine._targets(browser)))


@unittest.skipUnless(os.environ.get("BROWSER_USE_TEST_ENGINE"), "需显式启用专用 Chrome")
class ConnectionRecoveryLiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="browser-use-recovery-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.engine = Engine(ledger=ResourceLedger(self.root / "ledger" / "resources.json"))
        self.cleanup_may_fail = False
        self.addCleanup(self.cleanup_engine)
        # 默认 context 在断开后保留；普通临时私有 context 会 disposeOnDetach。
        self.profile = self.root / "profile"
        self.profile.mkdir()
        with patch.object(self.engine, "_profile_dir", return_value=self.profile):
            self.call("up", {"launch": {"profile": "recovery-fixture"}})
        self.browser = self.engine.browsers[("Chrome", "a")]
        self.target = self.call("tab_new", {"url": "data:text/html,<button id='count' onclick='window.clickTotal=(window.clickTotal||0)+1'>count</button>"})["targetId"]

    def call(self, action, params=None, target=None, owner="a"):
        return self.engine.execute({"action": action, "params": params or {}, "target": target,
                                    "session": owner, "browser": "Chrome"})

    def cleanup_engine(self):
        try:
            self.engine.close()
        except BrowserUseError:
            if not self.cleanup_may_fail:
                raise
        self.assertFalse(self.engine.browsers, "专用 Chrome 应已停止")

    def drop(self):
        cdp = self.browser["cdp"]
        # 从传输层中断，必须让真实 _receive 自己发现断线。
        cdp.ws.socket.shutdown(socket.SHUT_RDWR)
        cdp._reader.join(3)
        self.assertTrue(cdp.closed)

    def test_external_drop_status_and_same_target_recovery(self):
        scope = self.browser["scope"]
        ledger_before = self.engine.ledger.list(scope)
        before = {t["targetId"] for t in self.engine._targets(self.browser)}
        self.call("page_click", {"id": "count"}, self.target)
        old = self.engine.bindings[("Chrome", self.target)]["driver"]
        self.drop()
        self.assertFalse(self.call("status")["connected"])
        with self.assertRaises(BrowserUseError) as failed:
            self.call("tab_list")
        self.assertEqual(failed.exception.outcome, "not_sent")
        recovered = self.call("tab_recover", target=self.target)
        self.assertEqual(recovered["targetId"], self.target)
        self.assertTrue(recovered["recovered"])
        self.assertTrue(self.call("status")["connected"])
        self.assertIsNot(self.engine.bindings[("Chrome", self.target)]["driver"], old)
        self.assertEqual(self.call("page_eval", {"expression": "window.clickTotal"}, self.target)["value"], 1)
        self.assertEqual({t["targetId"] for t in self.engine._targets(self.browser)}, before)
        self.assertEqual(self.engine.ledger.list(scope), ledger_before)

    def test_pending_mutation_unknown_and_not_replayed_after_recovery(self):
        with ThreadPoolExecutor(1) as pool:
            pending = pool.submit(self.call, "page_eval", {"expression": "window.sent=(window.sent||0)+1; new Promise(()=>{})"}, self.target)
            # 独立调试连接只读确认原请求确实已经执行，再断开被测连接。
            from browser_use.cdp import CDP, discover
            observer = CDP(discover(self.browser["endpoint"]))
            try:
                sid = observer.call("Target.attachToTarget", {"targetId": self.target, "flatten": True})["sessionId"]
                import time
                deadline = time.monotonic() + 5
                while True:
                    sent = observer.call("Runtime.evaluate", {"expression": "window.sent", "returnByValue": True}, session_id=sid)
                    if sent["result"].get("value") == 1:
                        break
                    if time.monotonic() >= deadline:
                        self.fail("原请求没有执行，不能据此验收不重放")
                self.drop()
                with self.assertRaises(BrowserUseError) as failed:
                    pending.result(5)
                self.assertEqual(failed.exception.outcome, "unknown")
            finally:
                observer.close()
        self.call("tab_recover", target=self.target)
        self.assertEqual(self.call("page_eval", {"expression": "window.sent"}, self.target)["value"], 1)

    def test_public_page_recover_invalidates_real_snapshot(self):
        async def scenario():
            async def rpc(action, params=None, **context):
                return await asyncio.to_thread(self.engine.execute, {
                    "action": action, "params": params or {}, "session": context["session"],
                    "browser": context["browser"], "target": context.get("target"), "host": context.get("host"),
                })
            page = Page(self.target, browser="Chrome", host="local", session="a")
            page._rpc = rpc
            snapshot = await page.snap()
            self.assertIsNotNone(page.snapshot)
            await page.click(id="count")
            await asyncio.to_thread(self.drop)
            result = await page.recover()
            self.assertTrue(result["recovered"])
            self.assertEqual(page.target_id, self.target)
            self.assertIsNone(page.snapshot)
            with self.assertRaises(BrowserUseError) as stale:
                await page.click(idx=1)
            self.assertEqual(stale.exception.code, 4)
            fresh = await page.snap()
            self.assertNotEqual(fresh.snapshot, snapshot.snapshot)
            self.assertEqual(await page.evaluate("window.clickTotal"), 1)
        asyncio.run(scenario())

    def test_stale_session_recovers_without_replacing_live_transport(self):
        binding = self.engine.bindings[("Chrome", self.target)]
        old_sid = binding["driver"].session_id
        self.browser["cdp"].call("Target.detachFromTarget", {"sessionId": old_sid})
        transport = self.browser["cdp"]
        result = self.call("tab_recover", target=self.target)
        self.assertTrue(result["recovered"])
        self.assertIs(self.browser["cdp"], transport)
        self.assertNotEqual(self.engine.bindings[("Chrome", self.target)]["driver"].session_id, old_sid)

    def test_special_configuration_refused_without_new_attachment(self):
        self.call("network_headers_set", {"headers": {"x-recovery": "required"}}, self.target)
        self.drop()
        old = self.browser["cdp"]
        with self.assertRaises(BrowserUseError) as failed:
            self.call("tab_recover", target=self.target)
        self.assertEqual(failed.exception.code, 6)
        self.assertEqual(failed.exception.outcome, "not_sent")
        self.assertIn("network_headers_set", failed.exception.data["settings"])
        self.assertIs(self.browser["cdp"], old)
        # 故障保留到收尾；允许此测试的关闭报告旧调试连接失败，但专用进程必须停止。
        self.cleanup_may_fail = True


if __name__=="__main__":unittest.main()
