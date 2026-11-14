"""第二阶段普通命令与pyskill共用领域动作。"""
import unittest
from browser_use.commands import execute

class FakeClient:
    def __init__(self): self.calls=[]
    async def acall(self,action,params=None,**context):
        self.calls.append((action,params or {},context));return {"ok":True}

class CommandContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_debug_fixed_target_and_params(self):
        c=FakeClient()
        await execute(['--session','task','debug','target','call','--params','{"method":"DOM.getDocument","params":{"depth":0}}'],client=c)
        self.assertEqual(c.calls[-1][0],'debug_call')
        self.assertEqual(c.calls[-1][2]['target'],'target')
    async def test_elements_resolve_and_restore(self):
        c=FakeClient()
        await execute(['--session','task','element','target','resolve','--selector','{"css":"#query"}'],client=c)
        self.assertEqual(c.calls[-1][1],{'selector':{'css':'#query'}})
        await execute(['--session','task','element','target','restore','--params','{"patchId":"patch"}'],client=c)
        self.assertEqual(c.calls[-1][1],{'patchId':'patch'})
    async def test_response_transform_parameters(self):
        c=FakeClient()
        await execute(['--session','task','network','target','route','*/api/*','--action','response-transform','--params','{"transform":{"json":{"set":{"/name":"changed"}}}}'],client=c)
        self.assertEqual(c.calls[-1][1]['action'],'response_transform')
        self.assertEqual(c.calls[-1][1]['transform']['json']['set']['/name'],'changed')
    async def test_probe_without_rpc(self):
        c=FakeClient();r=await execute(['capabilities'],client=c)
        self.assertEqual(c.calls,[]);self.assertEqual(r['protocol'],1)

if __name__=='__main__':unittest.main()
