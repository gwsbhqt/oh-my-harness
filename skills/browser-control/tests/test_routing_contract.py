"""固定机器与任务范围契约；不访问实际远程或默认配置。"""
import io
import json
import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import browser_control
from browser_control.client import Client, validate_context
from browser_control.commands import execute
from browser_control.errors import BrowserControlError
from browser_control.rpc import receive

class RoutingContract(unittest.IsolatedAsyncioTestCase):
    async def test_cli_no_scope_refuses_resource_action(self):
        with patch.dict(os.environ,{'BROWSER_CONTROL_CONTEXT_ID':'','DSH_SESSION_ID':''}):
            with self.assertRaises(BrowserControlError):await execute(['tab','new','about:blank'])
    async def test_cli_task_scope_stable_explicit_session_override(self):
        class Fake:
            def __init__(self):self.calls=[]
            async def acall(self,action,params=None,**context):self.calls.append(context);return {}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'HOME':str(Path(tmp).resolve()),'BROWSER_CONTROL_CONTEXT_ID':'isolated-task'}), patch('browser_control.client.resolve_host',return_value='local'):
            client=Fake();await execute(['tab','new','about:blank'],client=client);await execute(['snap','target'],client=client)
            self.assertEqual(client.calls[0]['session'],client.calls[-1]['session'])
            await execute(['--session','explicit','snap','target'],client=client)
            self.assertEqual(client.calls[-1]['session'],'explicit')
            await execute(['session','use','pinned'])
            await execute(['snap','target'],client=client);self.assertEqual(client.calls[-1]['session'],'pinned')
            await execute(['session','use','--clear'])
            await execute(['snap','target'],client=client);self.assertEqual(client.calls[0]['session'],client.calls[-1]['session'])
    async def test_page_pins_actual_host_before_machine_default_changes(self):
        with patch('browser_control.client.resolve_host',return_value='remote-a'):
            p=browser_control.page('target',session='fixed')
        calls=[]
        async def rpc(action,params=None,**ctx):calls.append(ctx);return {'elements':[],'snapshot':'s'}
        p._rpc=rpc
        with patch('browser_control.client.resolve_host',return_value='remote-b'):
            await p.snap()
        self.assertTrue(all(c['host']=='remote-a' for c in calls))
    async def test_local_flag_conflict_and_text_boundary(self):
        with self.assertRaises(BrowserControlError):await execute(['--local','-H','other','--session','x','status'])
    async def test_explicit_remote_never_calls_local_socket(self):
        with patch('browser_control.client.resolve_host',return_value='remote'),patch('browser_control.client.Client._ensure',side_effect=AssertionError('no local socket')),patch('browser_control.transport.RemoteTransport.call',side_effect=BrowserControlError('remote fixture disconnected',4,outcome='unknown')) as remote:
            with self.assertRaises(BrowserControlError) as got:await Client().acall('page_click',{'id':'submit'},host='remote',session='x',target='t')
        self.assertEqual(got.exception.outcome,'unknown');self.assertEqual(remote.call_count,1)
    async def test_rpc_rejects_recursive_remote_and_missing_owner(self):
        for request in ({'action':'status','host':'remote','session':'x'},{'action':'status','host':'local'}):
            with self.assertRaises(BrowserControlError):receive(io.BytesIO((json.dumps(request)+'\n').encode()))
    async def test_rpc_forces_explicit_local_and_timeout(self):
        request={'action':'status','host':'local','session':'fixed','browser':'Chrome','rpcTimeout':7}
        with patch('browser_control.rpc.Client') as client:
            client.return_value.call.return_value={'ready':False}
            reply=receive(io.BytesIO((json.dumps(request)+'\n').encode()))
        self.assertTrue(reply['ok']);self.assertEqual(client.return_value.call.call_args.kwargs['host'],'local');self.assertEqual(client.return_value.call.call_args.kwargs['timeout'],7)

if __name__=='__main__':unittest.main()
