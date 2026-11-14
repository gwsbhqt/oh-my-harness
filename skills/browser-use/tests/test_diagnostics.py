"""诊断单元与显式独立 Chrome 验收；不连接用户浏览器。"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from concurrent.futures import ThreadPoolExecutor
from browser_use.diagnostics import Diagnostics
from browser_use.errors import BrowserUseError

class FakeCDP:
    def __init__(self):
        self.listeners = {}
        self.calls = []
        self.event_loss = 0
        self.responses = {}
    def on(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)
        return lambda: self.listeners[name].remove(callback)
    def emit(self, name, params, sid='page'):
        for callback in tuple(self.listeners.get(name, [])): callback(params, sid)
    def call(self, method, params=None, *, session_id=None, timeout=20):
        self.calls.append((method, params or {}, session_id, timeout))
        value = self.responses.get(method, {})
        if callable(value): return value(params or {}, session_id)
        if isinstance(value, Exception): raise value
        return value
    def flush_events(self, timeout=20): pass

class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.cdp = FakeCDP()
        self.driver = Mock(cdp=self.cdp, session_id='page', session_ids={'page', 'frame'}, sessions={'page':'target','frame':'iframe'}, target_id='target', browser_owned=False)
        self.diag = Diagnostics(self.driver)
    def tearDown(self): self.diag.close()
    def call(self, action, **params): return self.diag.dispatch(action, params)
    def rejected(self, action, code=6, **params):
        with self.assertRaises(BrowserUseError) as raised: self.call(action, **params)
        self.assertEqual(raised.exception.code, code)
    def test_fixed_session_no_jscheck(self):
        self.call('call', method='Runtime.evaluate', params={'expression':'42'})
        self.assertEqual(self.cdp.calls[-1][2], 'page')
        self.driver.check.assert_not_called()
        self.call('call', method='Runtime.evaluate', session_id='frame')
        self.assertEqual(self.cdp.calls[-1][2], 'frame')
        self.rejected('call', method='Runtime.evaluate', session_id='foreign')
    def test_raw_cannot_bypass_ownership_network_lane(self):
        for method in ['Target.closeTarget','Target.createTarget','Target.sendMessageToTarget','Browser.close','Page.close','Page.crash','Fetch.enable','Network.setExtraHTTPHeaders','Network.setCookie','Network.setBypassServiceWorker','Tracing.start','HeapProfiler.takeHeapSnapshot','Debugger.setBreakpoint','DOMDebugger.setEventListenerBreakpoint','Page.addScriptToEvaluateOnNewDocument']:
            self.rejected('call', method=method, authorized=True, scope='browser')
        self.rejected('call', method='Runtime.evaluate', params={'sessionId':'foreign'})
        self.rejected('call', method='Page.createIsolatedWorld', params={'frameId':'foreign','grantUniveralAccess':True})
        self.rejected('call', method='Browser.getVersion')
        self.call('call', method='Browser.getVersion', authorized=True, scope='browser')
    def test_raw_frame_membership(self):
        self.cdp.responses['Page.getFrameTree']={'frameTree':{'frame':{'id':'main'},'childFrames':[{'frame':{'id':'child'}}]}}
        self.call('call', method='Page.createIsolatedWorld', params={'frameId':'child'})
        self.rejected('call', method='Page.createIsolatedWorld', params={'frameId':'foreign'})
    def test_event_cursor_overflow_and_scope(self):
        sub=self.call('events_start',methods=['Runtime.consoleAPICalled'],limit=2)['subscriptionId']
        self.cdp.emit('Runtime.consoleAPICalled',{'n':0},'foreign')
        for n in range(4): self.cdp.emit('Runtime.consoleAPICalled',{'n':n})
        first=self.call('events_read',id=sub,after=0,limit=1)
        self.assertEqual(first['cursor'],3)
        self.assertEqual(first['dropped'],2)
        self.assertEqual(first['lostSinceCursor'],2)
        self.assertFalse(first['complete'])
        second=self.call('events_read',id=sub,after=first['cursor'])
        self.assertEqual(second['events'][0]['params']['n'],3)
        self.assertEqual(second['cursor'],4)
        self.assertTrue(second['complete'])
        self.cdp.event_loss=1
        self.assertFalse(self.call('events_read',id=sub,after=4)['complete'])
        self.call('events_stop',id=sub)
        self.rejected('events_read',code=3,id=sub)
    def test_event_wait_and_stop_are_bounded(self):
        sub=self.call('events_start',methods=['Runtime.consoleAPICalled'])['subscriptionId']
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(self.call,'events_read',id=sub,wait_timeout=5)
            self.cdp.emit('Runtime.consoleAPICalled',{'value':42})
            self.assertEqual(future.result(1)['events'][0]['params']['value'],42)
            future=pool.submit(self.call,'events_read',id=sub,after=1,wait_timeout=5)
            self.call('events_stop',id=sub)
            try: self.assertEqual(future.result(1)['events'],[])
            except BrowserUseError as exc: self.assertEqual(exc.code,3)
        sub=self.call('events_start',methods=['Runtime.consoleAPICalled'])['subscriptionId']
        start=time.monotonic()
        self.assertEqual(self.call('events_read',id=sub,wait_timeout=0.01)['events'],[])
        self.assertLess(time.monotonic()-start,0.5)
        self.rejected('events_read',code=2,id=sub,wait_timeout=31)
    def test_event_byte_limit_marks_truncation(self):
        sub=self.call('events_start',methods=['Runtime.consoleAPICalled'],max_bytes=1024)['subscriptionId']
        self.cdp.emit('Runtime.consoleAPICalled',{'data':'x'*2000})
        result=self.call('events_read',id=sub)
        self.assertTrue(result['events'][0]['truncated'])
        self.assertFalse(result['complete'])
        self.assertIsNone(result['events'][0]['params'])
    def test_parameter_validation(self):
        self.rejected('call',code=2,method='Runtime.evaluate',timeout=float('nan'))
        self.rejected('call',code=2,method='Runtime.evaluate',sessionId='page')
        self.rejected('events_start',code=2,methods=['*'])
        self.rejected('events_start',code=2,methods=['Runtime.consoleAPICalled'],limit=True)
        self.rejected('events_start',methods=['Target.targetCreated'])
    def test_debugger_pause_stack_and_cleanup(self):
        self.call('enable')
        self.cdp.emit('Debugger.scriptParsed',{'scriptId':'s','url':'fixture.js'})
        self.cdp.responses['Debugger.setBreakpointByUrl']={'breakpointId':'b','locations':[]}
        self.call('breakpoint',url='fixture.js',line=0)
        self.cdp.emit('Debugger.paused',{'reason':'other','callFrames':[{'callFrameId':'frame1'}]})
        self.cdp.responses['Debugger.evaluateOnCallFrame']={'result':{'value':3}}
        self.assertEqual(self.call('evaluate_frame',call_frame_id='frame1',expression='x')['result']['value'],3)
        self.rejected('evaluate_frame',code=4,call_frame_id='foreign',expression='x')
        self.assertTrue(self.call('stack')['paused'])
        self.diag.close()
        methods=[c[0] for c in self.cdp.calls]
        self.assertIn('Debugger.resume',methods)
        self.assertIn('Debugger.removeBreakpoint',methods)
        self.assertIn('Debugger.disable',methods)
        self.assertEqual(self.diag.close_errors,[])
    def test_source_artifact_is_private_and_exact(self):
        self.cdp.emit('Debugger.scriptParsed',{'scriptId':'s','url':'fixture.js'})
        self.assertEqual(self.call('sources')['sources'][0]['scriptId'],'s')
        self.cdp.responses['Debugger.getScriptSource']={'scriptSource':'const x=42;'}
        result=self.call('source',script_id='s')['artifact']
        self.assertEqual(Path(result['path']).read_text(),'const x=42;')
        self.assertEqual(Path(result['path']).stat().st_mode & 0o777,0o600)
        self.assertEqual(Path(result['path']).parent.stat().st_mode & 0o777,0o700)
        self.rejected('source',code=3,script_id='foreign')
    def test_timeout_not_replayed(self):
        self.cdp.responses['Runtime.evaluate']=BrowserUseError('timeout',4,outcome='unknown')
        with self.assertRaises(BrowserUseError) as raised: self.call('call',method='Runtime.evaluate')
        self.assertEqual(raised.exception.outcome,'unknown')
        self.assertEqual(sum(c[0]=='Runtime.evaluate' for c in self.cdp.calls),1)
    def test_target_closed_stops_before_send(self):
        self.driver._target_check.side_effect=BrowserUseError('gone',4)
        self.rejected('resume',code=4)
        self.assertEqual(self.cdp.calls,[])

@unittest.skipUnless(os.environ.get('BROWSER_USE_TEST_DIAGNOSTICS'), '需显式 BROWSER_USE_TEST_DIAGNOSTICS=1，自动创建专用 Chrome')
class LiveDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        from browser_use.engine import Engine
        from browser_use.resources import ResourceLedger
        from browser_use.driver import PageDriver
        self.tmp=tempfile.TemporaryDirectory(prefix='browser-use-diagnostics-test-')
        self.engine=Engine(ledger=ResourceLedger(Path(self.tmp.name).resolve()/'resources.json'))
        import subprocess
        from unittest.mock import patch
        popen=subprocess.Popen
        def isolated_chrome(flags, **kwargs):
            return popen(flags+['--disable-component-extensions-with-background-pages','--disable-background-networking','--disable-default-apps'], **kwargs)
        with patch('browser_use.engine.subprocess.Popen',side_effect=isolated_chrome):
            self.browser=self.engine._browser('Chrome','diagnostics-test')
        self.cdp=self.browser['cdp']
        # 全部只属于本测试新启动的浏览器；不连接或清理用户浏览器。
        for info in self.cdp.call('Target.getTargets')['targetInfos']:
            self.cdp.call('Target.closeTarget',{'targetId':info['targetId']})
        self.target=self.cdp.call('Target.createTarget',{'url':'about:blank','browserContextId':self.browser['context_id']})['targetId']
        sid=self.cdp.call('Target.attachToTarget',{'targetId':self.target,'flatten':True})['sessionId']
        self.driver=PageDriver(self.cdp,self.target,sid)
        self.driver.browser_owned=True
        self.diag=Diagnostics(self.driver)
        self.pool=ThreadPoolExecutor(1)
    def tearDown(self):
        try:
            self.diag.close()
            self.driver.close()
            self.pool.shutdown(wait=True,cancel_futures=True)
            self.assertEqual(self.diag.close_errors,[])
        finally:
            self.engine.close()
            self.tmp.cleanup()
    def call(self,action,**params): return self.diag.dispatch(action,params)
    def paused(self):
        gate=threading.Event()
        data=[]
        def event(p,s):
            if s==self.driver.session_id: data.append(p);gate.set()
        unsub=self.cdp.on('Debugger.paused',event)
        return gate,data,unsub
    def test_real_breakpoint_step_resume_and_source(self):
        self.call('enable')
        source='function diagnosed(n){\n let value=n+1;\n value*=2;\n return value;\n}\n//# sourceURL=browser-use-diagnostics-fixture.js'
        self.call('call',method='Runtime.evaluate',params={'expression':source})
        self.cdp.flush_events(timeout=5)
        sources=self.call('sources')['sources']
        match=[s for s in sources if s['url']=='browser-use-diagnostics-fixture.js']
        self.assertEqual(len(match),1)
        artifact=self.call('source',script_id=match[0]['scriptId'])['artifact']
        self.assertEqual(Path(artifact['path']).read_text(),source)
        self.call('breakpoint',url='browser-use-diagnostics-fixture.js',line=2)
        gate,data,unsub=self.paused()
        future=self.pool.submit(self.call,'call',method='Runtime.evaluate',params={'expression':'diagnosed(20)','returnByValue':True})
        self.assertTrue(gate.wait(5),'真实断点没有暂停')
        self.cdp.flush_events(timeout=5)
        pause=self.call('stack')['pause']
        self.assertIsNotNone(pause)
        value=self.call('evaluate_frame',call_frame_id=pause['callFrames'][0]['callFrameId'],expression='value')
        self.assertEqual(value['result']['value'],21)
        unsub()
        gate,data,unsub=self.paused()
        self.call('step',kind='over')
        self.assertTrue(gate.wait(5),'真实单步没有再次暂停')
        unsub()
        self.call('resume')
        self.assertEqual(future.result(5)['result']['value'],42)
        self.assertFalse(self.call('stack')['paused'])
        self.assertEqual(Path(artifact['path']).stat().st_mode & 0o777,0o600)
        print('真实 Chrome 证据 '+json.dumps({'breakpointValue':21,'resumedValue':42,'source':artifact},ensure_ascii=False),flush=True)

if __name__=='__main__': unittest.main()
