"""第二阶段公开对象与RPC参数契约，不启动用户浏览器。"""
import asyncio
import unittest
from unittest.mock import patch
import browser_use
from browser_use.errors import BrowserUseError

class PublicContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls=[]
        async def rpc(action,params=None,**ctx):
            self.calls.append((action,params or {},ctx))
            if action=="tab_bind":return {"owned":False}
            if action=="element_resolve":return {"handle":{"token":"fixed"},"metadata":{"visible":True}}
            if action=="debug_events_start":return {"subscriptionId":"events"}
            if action=="debug_events_read":return {"cursor":2,"events":[{"name":"x"}]}
            return {"ok":True}
        self.p=browser_use.page("target",session="contract")
        self.p._rpc=rpc
    async def test_element_lazy_resolve_and_fixed_handle(self):
        e=self.p.element(css="#button")
        self.assertEqual(self.calls,[])
        await e.measure();await e.styles(names=["color"])
        self.assertEqual(sum(c[0]=="element_resolve" for c in self.calls),1)
        self.assertEqual(self.calls[-1][1]["handle"],{"token":"fixed"})
        await e.restore("patch")
        self.assertEqual(self.calls[-1][1],{"patchId":"patch"})
    async def test_events_cursor_across_reads(self):
        stream=await self.p.debug.subscribe(["Runtime.consoleAPICalled"])
        await stream.read();await stream.read()
        self.assertEqual(self.calls[-1][1]["after"],2)
        await stream.stop()
        with self.assertRaises(BrowserUseError):await stream.read()
    async def test_raw_cdp_stays_exact_target(self):
        await self.p.debug.call("DOM.getDocument",{"depth":1})
        self.assertEqual(self.calls[-1][2]["target"],"target")
        self.assertEqual(self.calls[-1][1]["method"],"DOM.getDocument")
    async def test_probe_does_not_connect(self):
        with patch.object(browser_use,"_rpc",side_effect=AssertionError("no browser")):
            version=await browser_use.version();caps=await browser_use.capabilities()
        self.assertEqual(version["protocol"],1)
        self.assertTrue(caps["capabilities"]["remote"]["supported"])

if __name__=="__main__":unittest.main()
