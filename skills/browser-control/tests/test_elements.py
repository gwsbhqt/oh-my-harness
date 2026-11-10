"""单元边界和只启动独立临时 Chrome 的元素逐项验收。"""
import contextlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.parse import quote
from unittest.mock import patch
from browser_control.cdp import CDP, discover
from browser_control.driver import PageDriver
from browser_control.elements import ElementService
from browser_control.errors import BrowserControlError
from test_page import FakeCDP

HTML = r"""<!doctype html><style>
body{margin:16px}#hover{width:120px;height:40px;background:lime}#off{position:absolute;top:3000px}
#scroll{width:150px;height:70px;overflow:auto}#scroll>div{height:200px;width:300px}
#hidden{display:none}#covered{width:100px;height:30px}#cover{position:absolute;background:white;z-index:99;width:100px;height:30px}
</style><input id="field" value="中文"><input id="check" type="checkbox"><input id="radio" type="radio">
<select id="select"><option value="a">甲</option><option value="b">乙</option><option value="x" disabled>禁用</option></select>
<button id="hover">悬停</button><p id="text" data-testid="text">原文</p>
<div id="one"><button>重名</button></div><div id="two"><button>重名</button></div>
<div id="scroll" role="region" aria-label="可滚"><div><button id="scrollchild">内部</button></div></div>
<button id="off">页外</button><button id="hidden">隐藏</button><button id="covered">遮挡</button><div id="cover"></div>
<div id="host"></div><iframe id="frame" srcdoc="<button id='inside'>框内</button>"></iframe>
<script>
window.events=[];for(const id of ['hover','check','select','field'])for(const type of ['mouseover','click','input','change','focus'])document.getElementById(id).addEventListener(type,e=>events.push({id,type,trusted:e.isTrusted}));
const h=document.querySelector('#host').attachShadow({mode:'open'});h.innerHTML='<button id="shadow">影子</button>';
const r=document.querySelector('#covered').getBoundingClientRect();Object.assign(document.querySelector('#cover').style,{left:r.x+'px',top:r.y+'px'});
</script>"""

class ElementTests(unittest.TestCase):
    def setUp(self):
        self.cdp=FakeCDP();self.driver=PageDriver(self.cdp,'root','session');self.service=ElementService(self.driver)
    def tearDown(self): self.service.close();self.driver.close()
    def handle(self):
        self.driver.check();return self.service._handle(self.service._resolve(12,'root'))
    def code(self,code,action,p):
        with self.assertRaises(BrowserControlError) as got:self.service.dispatch(action,p)
        self.assertEqual(got.exception.code,code);return got.exception
    def test_unknown_params_no_side_effect(self):
        self.cdp.calls.clear();self.code(2,'focus',{'handle':{},'authorized':True});self.assertEqual(self.cdp.calls,[])
    def test_handle_tamper_cross_service_and_document(self):
        h=self.handle();self.code(4,'read',dict(handle=dict(h,targetId='other')))
        other=ElementService(self.driver)
        with self.assertRaises(BrowserControlError):other.dispatch('read',{'handle':h})
        self.cdp.document=2;self.code(4,'read',{'handle':h})
    def test_removed_closed_and_connection_unknown(self):
        h=self.handle();self.cdp.connected=False;self.code(4,'read',{'handle':h})
        self.cdp.connected=True;self.cdp.timeout_method='DOM.resolveNode'
        self.assertEqual(self.code(4,'read',{'handle':h}).outcome,'unknown')
        self.cdp.timeout_method=None;self.cdp.destroyed=True;self.code(4,'read',{'handle':h})
    def test_patch_conflict_refuses_and_close_reports(self):
        h=self.handle()
        with patch.object(self.driver,'_function',return_value={'before':{'attrs':{}},'after':{'attrs':{}}}):
            result=self.service._patch(self.service._resolve(12,'root'),{'handle':h,'attrs':{'title':'a'}})
        with patch.object(self.driver,'_function',side_effect=[self.cdp.meta,{'restored':False,'conflict':'attrs.title'}]):
            self.code(6,'restore',{'patchId':result['patchId']})
        self.service.close();self.assertEqual(self.service.close_errors[0]['patchIds'],[result['patchId']])
    def test_check_timeout_not_replayed(self):
        h=self.handle();self.cdp.timeout_method='Input.dispatchMouseEvent'
        with patch.object(self.service,'_point',return_value=(20,30)),patch.object(self.driver,'_function',side_effect=[self.cdp.meta,self.cdp.meta,{'native':True,'checked':False,'type':'checkbox'}]):
            self.assertEqual(self.code(4,'check',{'handle':h}).outcome,'unknown')
        self.assertEqual(sum(c[0]=='Input.dispatchMouseEvent' for c in self.cdp.calls),1)
    def test_invalid_selector_scope_parameters(self):
        for selector in ({'css':'button','id':'x'},{'role':'button','oops':1},{'idx':1,'frame':'root'},{'id':''}): self.code(2,'resolve',{'selector':selector})
        self.code(4,'resolve',{'selector':{'css':'button'},'frame':'not-a-frame'})
    def test_driver_scrollable_not_derived_from_actions(self):
        self.cdp.meta.update(visible=True,offscreen=False,occluded=False,scrollable=False,scrollDirections=[],scrollAncestor=None)
        e=self.driver.dispatch('snap')['elements'][0]
        self.assertIn('ScrollToVisible',e['actions']);self.assertFalse(e['scrollable'])
        self.assertTrue(e['visible']);self.assertFalse(e['occluded'])
        self.assertIn('rootBounds',e);self.assertEqual(e['coordinateSpace'],'frame viewport CSS pixels')

class Phase3ElementTests(unittest.TestCase):
    """新增元素动作：语义 selector、fill、select、ARIA 勾选、evaluate、drag_to、截图格式。"""
    def setUp(self):
        self.cdp=FakeCDP();self.driver=PageDriver(self.cdp,'root','session');self.service=ElementService(self.driver)
    def tearDown(self): self.service.close();self.driver.close()
    def handle(self):
        self.driver.check();return self.service._handle(self.service._resolve(12,'root'))
    def code(self,code,action,p):
        with self.assertRaises(BrowserControlError) as got:self.service.dispatch(action,p)
        self.assertEqual(got.exception.code,code,str(got.exception));return got.exception

    def test_parse_selector_semantic_rules(self):
        from browser_control.elements import parse_selector
        spec=parse_selector({'text':'保存','match':'contains','ignore_case':True,'nth':-1})
        self.assertEqual((spec['kind'],spec['nth'],spec['query']['match']),('semantic',-1,'contains'))
        self.assertEqual(parse_selector({'placeholder':'姓名'})['query']['semantic'],{'kind':'placeholder','value':'姓名'})
        self.assertEqual(parse_selector({'css':'button','nth':0,'within':'#form'})['within'],'#form')
        for bad in ({'text':'a','title':'b'},{'text':'a','role':'button'},{'css':'a','match':'exact'},{'text':''},{'alt':1},
                    {'text':'a','match':'prefix'},{'text':'a','nth':1.5},{'text':'a','nth':True},{'idx':1,'nth':0},{'nth':0},{'text':'a','ignore_case':'yes'},{'title':'a','frame':5}):
            with self.subTest(bad=bad), self.assertRaises(BrowserControlError) as got: parse_selector(bad)
            self.assertEqual(got.exception.code,2)

    def test_strict_fields_before_cdp(self):
        h=self.handle()
        bad=[('fill',{'handle':h}),('fill',{'handle':h,'value':1}),('fill',{'handle':h,'value':'a','allow_newline':'yes'}),
             ('select',{'handle':h,'value':'a','label':'b'}),('select',{'handle':h}),('select',{'handle':h,'labels':[]}),('select',{'handle':h,'labels':['a','a']}),
             ('check',{'handle':h,'checked':'yes'}),('uncheck',{'handle':h,'checked':False}),
             ('evaluate',{'handle':h}),('evaluate',{'handle':h,'function':' '}),('evaluate',{'handle':h,'function':'function(){}','args':{'a':1}}),
             ('evaluate',{'handle':h,'function':'function(){}','args':[float('nan')]}),('evaluate',{'handle':h,'function':'function(){}','timeout':121}),
             ('drag_to',{'handle':h}),('drag_to',{'handle':h,'target':h,'target_selector':{'id':'x'}}),('drag_to',{'handle':h,'target':'x'}),
             ('drag_to',{'handle':h,'target':h,'mode':'synthetic'}),('drag_to',{'handle':h,'target':h,'steps':0}),
             ('screenshot',{'handle':h,'format':'bmp'}),('screenshot',{'handle':h,'format':'png','quality':10}),('screenshot',{'handle':h,'format':'webp','quality':-1}),
             ('resolve',{'selector':{'text':'a','css':'b'}}),('list',{'selector':{'text':'a'},'limit':0}),('click',{'handle':h,'count':4}),
             ('fill',{'value':'a'}),('focus',{'handle':'token'})]
        for action,params in bad:
            self.cdp.calls.clear()
            with self.subTest(action=action,params=params):
                self.code(2,action,params);self.assertEqual(self.cdp.calls,[])
        self.cdp.calls.clear();self.code(6,'fill',{'handle':h,'value':'a\nb'});self.assertEqual(self.cdp.calls,[])

    def test_semantic_query_ambiguous_reports_count_and_nth(self):
        self.driver.check()
        with patch.object(self.service,'_query',return_value=(3,[])):
            error=self.code(3,'resolve',{'selector':{'text':'保存'}})
        self.assertEqual(error.data['count'],3)
        with patch.object(self.service,'_query',return_value=(3,[])):
            error=self.code(3,'resolve',{'selector':{'text':'保存','nth':7}})
        self.assertIn('nth',str(error))
        ref=self.service._resolve(12,'root')
        with patch.object(self.service,'_query',return_value=(3,[ref])):
            result=self.service.dispatch('resolve',{'selector':{'text':'保存','nth':-1}})
        self.assertEqual((result['count'],result['nth']),(3,-1))

    def test_query_function_gets_semantic_spec(self):
        self.driver.check()
        self.cdp.calls.clear()
        with self.assertRaises(Exception): self.service.dispatch('resolve',{'selector':{'alt':'标志','ignore_case':True,'nth':0}})
        call=next(c for c in self.cdp.calls if c[0]=='Runtime.callFunctionOn' and 'semantic' in c[1]['functionDeclaration'])
        args=[a['value'] for a in call[1]['arguments']]
        self.assertEqual(args[0],{'semantic':{'kind':'alt','value':'标志'},'match':'exact','ignore_case':True})
        self.assertEqual(args[4],0)

    def test_aria_switch_checked_after_trusted_click_and_unchanged_is_error(self):
        h=self.handle()
        states=iter([{'native':False,'checked':None,'type':None,'role':'switch','aria':'false'},'true'])
        with patch.object(self.service,'_point',return_value=(5,6)),patch.object(self.driver,'_function',side_effect=lambda ref,fn,args=(),**k:self.cdp.meta if fn.startswith('function(){\n const e=this') else next(states)):
            result=self.service.dispatch('check',{'handle':h})
        self.assertEqual((result['kind'],result['ariaChecked'],result['changed']),('aria','true',True))
        presses=[c for c in self.cdp.calls if c[0]=='Input.dispatchMouseEvent' and c[1]['type']=='mousePressed']
        self.assertEqual(len(presses),1)
        self.cdp.calls.clear()
        def unchanged(ref,fn,args=(),**k):
            if fn.startswith('function(){\n const e=this'): return self.cdp.meta
            if 'native' in fn: return {'native':False,'checked':None,'type':None,'role':'checkbox','aria':'false'}
            return 'false'
        with patch.object(self.service,'_point',return_value=(5,6)),patch.object(self.driver,'_function',side_effect=unchanged),patch('browser_control.elements.time.sleep'):
            error=self.code(1,'check',{'handle':h})
        self.assertEqual(error.data['after'],'false')
        self.assertEqual(sum(c[0]=='Input.dispatchMouseEvent' and c[1]['type']=='mousePressed' for c in self.cdp.calls),1)
        with patch.object(self.driver,'_function',side_effect=lambda ref,fn,args=(),**k:self.cdp.meta if fn.startswith('function(){\n const e=this') else {'native':False,'checked':None,'type':None,'role':'button','aria':None}):
            self.code(5,'uncheck',{'handle':h})

    def test_fill_inserts_after_select_and_verifies(self):
        h=self.handle();self.cdp.meta['editable']=True
        answers={'prepare':{'kind':'input','password':False,'empty':False},'select':True,'value':'新值'}
        def fn(ref,source,args=(),**k):
            if source.startswith('function(){\n const e=this'): return self.cdp.meta
            if 'fill 只支持' in source: return answers['prepare']
            if 'selectNodeContents' in source: return answers['select']
            return answers['value']
        with patch.object(self.driver,'_function',side_effect=fn):
            self.assertEqual(self.service.dispatch('fill',{'handle':h,'value':'新值'})['value'],'新值')
            inserted=[c[1]['text'] for c in self.cdp.calls if c[0]=='Input.insertText']
            self.assertEqual(inserted,['新值'])
            answers['value']='新'
            error=self.code(1,'fill',{'handle':h,'value':'新值'})
            self.assertEqual(error.data['value'],'新')
            self.cdp.calls.clear();answers['value']=''
            self.service.dispatch('fill',{'handle':h,'value':''})
            self.assertEqual([c[1]['key'] for c in self.cdp.calls if c[0]=='Input.dispatchKeyEvent'],['Delete','Delete'])
            self.cdp.calls.clear();answers['select']=False
            self.code(1,'fill',{'handle':h,'value':'x'})
            self.assertFalse(any(c[0]=='Input.insertText' for c in self.cdp.calls))
        self.cdp.meta['editable']=False

    def test_fill_insert_timeout_not_replayed(self):
        h=self.handle();self.cdp.timeout_method='Input.insertText'
        def fn(ref,source,args=(),**k):
            if source.startswith('function(){\n const e=this'): return self.cdp.meta
            if 'fill 只支持' in source: return {'kind':'input','password':False,'empty':True}
            return True
        with patch.object(self.driver,'_function',side_effect=fn):
            self.assertEqual(self.code(4,'fill',{'handle':h,'value':'x'}).outcome,'unknown')
        self.assertEqual(sum(c[0]=='Input.insertText' for c in self.cdp.calls),1)

    def test_evaluate_returns_value_and_exception_text(self):
        h=self.handle();original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Runtime.callFunctionOn' and params.get('functionDeclaration','').startswith('function(x)'):
                self.cdp.calls.append((method,params,kw.get('session_id')))
                if params['arguments'][0]['value']=='boom': return {'exceptionDetails':{'text':'Uncaught','exception':{'description':'Error: 炸了'}}}
                return {'result':{'type':'object','value':{'got':params['arguments'][0]['value']}}}
            return original(method,params,**kw)
        self.cdp.call=call
        result=self.service.dispatch('evaluate',{'handle':h,'function':'function(x){return {got:x}}','args':['ok']})
        self.assertEqual(result['value'],{'got':'ok'})
        sent=[c[1] for c in self.cdp.calls if c[0]=='Runtime.callFunctionOn' and c[1]['functionDeclaration'].startswith('function(x)')][-1]
        self.assertTrue(sent['returnByValue']);self.assertEqual(sent['objectId'],'element')
        error=self.code(1,'evaluate',{'handle':h,'function':'function(x){throw 1}','args':['boom']})
        self.assertIn('炸了',str(error))

    def test_html5_drag_requires_drop_and_cleans_interception(self):
        h=self.handle();target=self.handle()
        def fn(ref,source,args=(),**k):
            if source.startswith('function(){\n const e=this'): return self.cdp.meta
            if 'draggable' in source: return True
            return True
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Input.dispatchMouseEvent' and params['type']=='mouseMoved' and params['buttons']==1:
                self.cdp.emit('Input.dragIntercepted',{'data':{'items':[{'mimeType':'text/plain','data':'x'}],'dragOperationsMask':1}},'session')
            if method=='Runtime.callFunctionOn' and 'drop:this.drop' in params.get('functionDeclaration',''):
                self.cdp.calls.append((method,params,kw.get('session_id')))
                return {'result':{'value':{'drop':0,'dragenter':1,'dragover':1,'defaultPrevented':False,'types':[]}}}
            if method=='Runtime.callFunctionOn' and 'record.stop' in params.get('functionDeclaration',''):
                return {'result':{'objectId':'watch'}}
            return original(method,params,**kw)
        self.cdp.call=call
        points=iter([(1,1),(50,50),(1,1)])
        with patch.object(self.driver,'_function',side_effect=fn):
            self.code(2,'drag_to',{'handle':h,'target':target})
        self.cdp.calls.clear()
        with patch.object(self.service,'_point',side_effect=lambda ref:next(points)),patch.object(self.driver,'_function',side_effect=fn),patch.object(self.service,'_ref',side_effect=lambda handle:dict(self.service._resolve(12,'root'),backend=99 if handle is target else 12)):
            error=self.code(1,'drag_to',{'handle':h,'target':target,'mode':'html5'})
        self.assertEqual(error.outcome,'unknown')
        methods=[(c[0],c[1].get('type'),c[1].get('enabled')) for c in self.cdp.calls]
        self.assertEqual([m for m in methods if m[0]=='Input.dispatchDragEvent'],[('Input.dispatchDragEvent','dragEnter',None),('Input.dispatchDragEvent','dragOver',None),('Input.dispatchDragEvent','drop',None)])
        self.assertEqual([m[2] for m in methods if m[0]=='Input.setInterceptDrags'],[True,False])
        self.assertEqual(sum(m[:2]==('Input.dispatchMouseEvent','mousePressed') for m in methods),1)

    def test_screenshot_formats(self):
        import base64, stat
        from browser_control.driver import _image_size
        self.assertEqual(_image_size(b'RIFF\x00\x00\x00\x00WEBPVP8X'+b'\x00'*8+(99).to_bytes(3,'little')+(49).to_bytes(3,'little')),(100,50))
        self.assertEqual(_image_size(b'\xff\xd8\xff\xc0\x00\x11\x08\x00\x0a\x00\x14\x03'),(20,10))
        h=self.handle();original=self.cdp.call
        webp=b'RIFF\x00\x00\x00\x00WEBPVP8X'+b'\x00'*8+(29).to_bytes(3,'little')+(19).to_bytes(3,'little')
        def call(method,params=None,**kw):
            if method=='Page.captureScreenshot':
                self.cdp.calls.append((method,params,kw.get('session_id')));return {'data':base64.b64encode(webp).decode()}
            if method=='DOM.getBoxModel': return {'model':{'border':[10,20,40,20,40,40,10,40]}}
            if method=='Page.getLayoutMetrics': return {'cssLayoutViewport':{'pageX':0,'pageY':0,'clientWidth':100,'clientHeight':100}}
            return original(method,params,**kw)
        self.cdp.call=call
        with patch.object(self.service,'_geometry',return_value=(None,None,0,0)),patch.object(self.driver,'_eval',return_value=1):
            result=self.service.dispatch('screenshot',{'handle':h,'format':'webp','quality':70,'shrink':0})
        self.assertEqual((result['screenshot']['format'],result['screenshot']['width'],result['screenshot']['height']),('webp',30,20))
        args=[c[1] for c in self.cdp.calls if c[0]=='Page.captureScreenshot'][-1]
        self.assertEqual((args['format'],args['quality'],args['clip']['scale']),('webp',70,1))
        self.assertEqual(stat.S_IMODE(Path(result['path']).stat().st_mode),0o600)
        Path(result['path']).unlink()


@unittest.skipUnless(os.environ.get('BROWSER_CONTROL_ELEMENTS_LIVE')=='1','显式 BROWSER_CONTROL_ELEMENTS_LIVE=1 才启动独立 Chrome')
class ElementLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='browser-control-elements-live-');cls.output=tempfile.TemporaryFile();cls.error=tempfile.TemporaryFile()
        def clean_temp():
            path=Path(cls.temp.name);cls.temp.cleanup()
            if path.exists(): raise AssertionError('元素测试临时目录未清理')
            print('ELEMENTS_TEMP_CLEANED true')
        cls.addClassCleanup(clean_temp);cls.addClassCleanup(cls.output.close);cls.addClassCleanup(cls.error.close)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        chrome=os.environ.get('BROWSER_CONTROL_TEST_CHROME','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        cls.process=subprocess.Popen([chrome,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+str(port),'--user-data-dir='+cls.temp.name,'about:blank'],stdout=cls.output,stderr=cls.error,start_new_session=True)
        cls.addClassCleanup(cls.stop)
        endpoint='http://127.0.0.1:'+str(port);cls.endpoint=endpoint;deadline=time.monotonic()+15
        while True:
            try:ws=discover(endpoint);break
            except BrowserControlError:
                if time.monotonic()>deadline or cls.process.poll() is not None:
                    cls.error.seek(0);raise AssertionError(cls.error.read().decode(errors='replace'))
                time.sleep(.05)
        cls.cdp=CDP(ws)
    @classmethod
    def stop(cls):
        if hasattr(cls,'cdp'):
            if cls.process.poll() is None:
                try:cls.cdp.call('Browser.close',timeout=3)
                except BrowserControlError:pass
            cls.cdp.close()
        try:cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(cls.process.pid,signal.SIGTERM);cls.process.wait(timeout=10)
        with contextlib.suppress(ProcessLookupError):os.killpg(cls.process.pid,signal.SIGKILL)
        print('ELEMENTS_CHROME_EXIT',cls.process.returncode)
        if cls.process.returncode!=0:raise AssertionError('独立 Chrome 退出码非0：'+str(cls.process.returncode))
    def setUp(self):
        self.target=self.cdp.call('Target.createTarget',{'url':'about:blank'})['targetId']
        self.addCleanup(lambda:self.cdp.call('Target.closeTarget',{'targetId':self.target}))
        sid=self.cdp.call('Target.attachToTarget',{'targetId':self.target,'flatten':True})['sessionId']
        self.driver=PageDriver(self.cdp,self.target,sid);self.addCleanup(self.driver.close)
        self.service=ElementService(self.driver);self.addCleanup(self.service.close)
        self.driver.dispatch('goto',{'url':'data:text/html;charset=utf-8,'+quote(HTML)})
        self.driver.dispatch('wait',{'expression':'document.readyState==="complete"'})
    def resolve(self,**selector):return self.service.dispatch('resolve',{'selector':selector})['handle']
    def act(self,action,handle,**p):return self.service.dispatch(action,{'handle':handle,**p})
    def error_code(self,code,action,p):
        with self.assertRaises(BrowserControlError) as got:self.service.dispatch(action,p)
        self.assertEqual(got.exception.code,code)
    def test_resolve_list_scope_and_shadow(self):
        self.error_code(3,'resolve',{'selector':{'label':'重名'}})
        result=self.service.dispatch('list',{'selector':{'role':'button','label':'重名'},'limit':1})
        self.assertEqual(result['count'],2);self.assertTrue(result['truncated'])
        h=self.resolve(label='重名',within='#one');self.assertEqual(self.act('read',h)['text'],'重名')
        self.assertEqual(self.act('read',self.resolve(css='#shadow',shadow=['#host']))['text'],'影子')
        self.error_code(1,'resolve',{'selector':{'css':'button','within':'div'}})
        self.assertEqual(self.act('read',self.resolve(testid='text'))['text'],'原文')
        json.dumps(h)
    def test_frame_css_scope(self):
        self.driver.check();fid=next(fid for fid,f in self.driver._frames_cache.items() if f.get('parent'))
        h=self.resolve(css='#inside',frame=fid);self.assertEqual(h['frame'],fid);self.assertEqual(self.act('read',h)['text'],'框内')
        self.error_code(3,'resolve',{'selector':{'css':'#inside'}})
        meta=self.service.dispatch('resolve',{'selector':{'css':'#inside','frame':fid}})['metadata']
        self.assertFalse(meta['rootOccluded']);self.assertGreater(meta['rootBounds']['y'],meta['bounds']['y'])
        self.assertTrue(self.act('hover',h)['trusted'])
        self.assertTrue(self.driver._function(self.service._ref(h),'function(){return this.matches(":hover")}'))
        with tempfile.TemporaryDirectory() as outdir:
            shot=self.act('screenshot',h,out=str(Path(outdir)/'frame.png'))
            self.assertGreater(shot['screenshot']['width'],0)
        self.driver.evaluate("(()=>{const f=document.querySelector('#frame'),r=f.getBoundingClientRect(),o=document.createElement('div');Object.assign(o.style,{position:'absolute',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',zIndex:9999,background:'white'});document.body.append(o)})()")
        meta=self.service.dispatch('resolve',{'selector':{'css':'#inside','frame':fid}})['metadata']
        self.assertTrue(meta['rootOccluded'])
        self.error_code(1,'hover',{'handle':h})
    def test_driver_existing_live_regressions(self):
        from test_page import ChromePageTests
        with patch.dict(os.environ,{'BROWSER_CONTROL_TEST_CDP':self.endpoint}):
            with patch.object(ChromePageTests,'__unittest_skip__',False,create=True):
                result=unittest.TestResult()
                unittest.defaultTestLoader.loadTestsFromTestCase(ChromePageTests).run(result)
        self.assertFalse(result.errors,result.errors);self.assertFalse(result.failures,result.failures)
        self.assertFalse(result.skipped,result.skipped)
        print('ELEMENTS_DRIVER_LIVE_REGRESSIONS',result.testsRun)

    def test_oopif_scope_metadata_shot_and_hover_refusal(self):
        from fixture_server import FixtureServer
        with FixtureServer() as fixture:
            self.driver.dispatch('goto',{'url':fixture.url})
            self.driver.evaluate("document.querySelector('iframe').src='http://localhost:'+location.port+'/frame'")
            self.driver.dispatch('wait',{'label':'嵌套按钮'})
            snap=self.driver.dispatch('snap',{'max':300})
            e=next(e for e in snap['elements'] if e['id']=='frame-button')
            fid=e['frame'];self.assertNotEqual(self.driver._frames_cache[fid]['session'],self.driver.session_id)
            h=self.resolve(css='#frame-button',frame=fid)
            self.assertEqual(self.act('read',h)['text'],'嵌套按钮')
            self.assertFalse(e['rootOccluded']);self.assertIsNotNone(e['rootBounds'])
            self.driver._eval("document.querySelector('#frame-button').addEventListener('mouseover',e=>document.body.dataset.trusted=String(e.isTrusted))",self.driver._frames_cache[fid])
            self.error_code(5,'hover',{'handle':h})
            self.assertIsNone(self.driver._eval('document.body.dataset.trusted',self.driver._frames_cache[fid]))
            out=str(Path(self.temp.name)/'oopif.png')
            shot=self.act('screenshot',h,out=out)
            self.assertAlmostEqual(shot['screenshot']['width'],e['bounds']['width'],delta=1)
            self.assertAlmostEqual(shot['screenshot']['height'],e['bounds']['height'],delta=1)
            self.assertTrue(Path(out).read_bytes().startswith(b'\x89PNG'))
            self.assertEqual(shot['coordinateSpace'],'root document CSS pixels')

    def test_fixed_handle_click_type_key_set_scroll(self):
        field=self.resolve(id='field');button=self.resolve(id='hover')
        self.driver.evaluate("document.querySelector('#field').id='renamed';document.querySelector('#hover').id='renamed-button'")
        self.assertFalse(self.act('set',field,value='')['trusted'])
        self.assertTrue(self.act('type',field,text='固定中文')['trusted'])
        self.assertEqual(self.act('read',field)['value'],'固定中文')
        self.assertTrue(self.act('key',field,keys='Meta+A')['trusted'])
        self.assertEqual(self.driver._function(self.service._ref(field),'function(){return [this.selectionStart,this.selectionEnd]}'),[0,4])
        self.act('type',field,text='替换');self.assertEqual(self.act('read',field)['value'],'替换')
        self.assertTrue(self.act('click',button)['trusted'])
        self.assertEqual(self.driver.evaluate("events.filter(e=>e.id==='hover'&&e.type==='click').length"),1)
        self.assertTrue(self.driver.evaluate("events.find(e=>e.id==='hover'&&e.type==='click').trusted"))
        self.error_code(6,'type',{'handle':field,'text':'x\ny'})
        sc=self.resolve(id='scrollchild');r=self.act('scroll',sc,direction='down',pages=.5)
        self.assertEqual(r['scroll']['id'],'scroll');self.assertGreater(r['scroll']['y'],0)
        self.act('scroll',sc,direction='right',pages=.5)
        self.assertGreater(self.driver.evaluate("document.querySelector('#scroll').scrollLeft"),0)
        self.driver.evaluate("document.querySelector('#renamed-button').remove()")
        self.error_code(4,'click',{'handle':button})

    def test_read_attribute_html(self):
        h=self.resolve(id='field');self.assertEqual(self.act('read',h)['value'],'中文')
        self.assertEqual(self.act('attribute',h,name='id')['value'],'field')
        self.assertIsNone(self.act('attribute',h,name='absent')['value'])
        self.assertIn('<input',self.act('html',h)['html'])
        self.assertEqual(self.act('html',h,outer=False)['html'],'')
    def test_measure_computed_styles(self):
        h=self.resolve(css='#hover');r=self.act('measure',h)
        self.assertEqual(r['bounding']['viewport']['width'],120)
        self.assertEqual(r['bounding']['document']['width'],120)
        self.assertEqual(self.act('styles',h,names=['background-color'])['styles']['background-color'],'rgb(0, 255, 0)')
    def test_metadata_visibility_scrollable(self):
        meta=lambda id:self.service.dispatch('resolve',{'selector':{'id':id}})['metadata']
        self.assertTrue(meta('hover')['visible']);self.assertFalse(meta('hover')['scrollable'])
        self.assertFalse(meta('hidden')['visible']);self.assertTrue(meta('off')['offscreen']);self.assertTrue(meta('off')['visible'])
        self.assertTrue(meta('covered')['occluded']);self.assertTrue(meta('scroll')['scrollable'])
        self.assertEqual(set(meta('scroll')['scrollDirections']),{'down','right'})
        self.assertEqual(meta('scrollchild')['scrollAncestor']['id'],'scroll')
        snap=self.driver.dispatch('snap',{'max':300,'all':True})
        self.assertFalse(next(e for e in snap['elements'] if e['id']=='hover')['scrollable'])
    def test_focus_trusted(self):
        r=self.act('focus',self.resolve(id='field'));self.assertTrue(r['trusted'])
        self.assertEqual(self.driver.evaluate('document.activeElement.id'),'field')
        self.assertTrue(self.driver.evaluate("events.some(e=>e.id==='field'&&e.type==='focus'&&e.trusted)"))
    def test_hover_trusted_and_overlay_rejected(self):
        r=self.act('hover',self.resolve(id='hover'));self.assertTrue(r['trusted'])
        self.assertTrue(self.driver.evaluate("events.some(e=>e.id==='hover'&&e.type==='mouseover'&&e.trusted)"))
        self.error_code(1,'hover',{'handle':self.resolve(id='covered')})
    def test_check_trusted_and_noop(self):
        h=self.resolve(id='check');self.assertTrue(self.act('check',h)['checked']);self.assertFalse(self.act('check',h)['changed'])
        self.assertFalse(self.act('check',h,checked=False)['checked'])
        self.assertTrue(self.driver.evaluate("events.filter(e=>e.id==='check'&&e.type==='click').every(e=>e.trusted)"))
        self.error_code(5,'check',{'handle':self.resolve(id='radio'),'checked':False})
    def test_select_explicit_property(self):
        h=self.resolve(id='select');r=self.act('select',h,value='b')
        self.assertEqual(r['values'],['b']);self.assertFalse(r['trusted']);self.assertEqual(r['via'],'property')
        self.assertFalse(self.driver.evaluate("events.find(e=>e.id==='select'&&e.type==='change').trusted"))
        self.error_code(1,'select',{'handle':h,'value':'x'})
        self.assertEqual(self.driver.evaluate("document.querySelector('#select').value"),'b')
    def test_screenshot_clip_and_overwrite(self):
        h=self.resolve(id='hover');out=str(Path(self.temp.name)/'element.png')
        r=self.act('screenshot',h,out=out);self.assertEqual(r['screenshot']['width'],120);self.assertEqual(r['screenshot']['height'],40)
        self.assertTrue(Path(out).read_bytes().startswith(b'\x89PNG'))
        self.error_code(6,'screenshot',{'handle':h,'out':out});self.act('screenshot',h,out=out,overwrite=True,shrink=60)
        self.assertEqual(self.act('screenshot',h,out=str(Path(self.temp.name)/'small.png'),shrink=60)['screenshot']['width'],60)
    def test_patch_restore_and_external_conflict(self):
        h=self.resolve(id='text');r=self.act('patch',h,attrs={'title':'new'},text='改文',styles={'color':'red'})
        self.assertEqual(r['before']['text'],'原文');self.assertEqual(self.act('read',h)['text'],'改文')
        self.service.dispatch('restore',{'patchId':r['patchId']});self.assertEqual(self.act('read',h)['text'],'原文')
        self.assertIsNone(self.act('attribute',h,name='title')['value'])
        p=self.act('patch',h,attrs={'title':'ours'});self.driver.evaluate("document.querySelector('#text').title='external'")
        self.error_code(6,'restore',{'patchId':p['patchId']});self.assertEqual(self.act('attribute',h,name='title')['value'],'external')
    def test_stale_navigation_removal_and_identity_preserved(self):
        h=self.resolve(id='text');self.driver.evaluate("document.querySelector('#text').id='changed'")
        self.assertEqual(self.act('read',h)['text'],'原文')
        self.driver.evaluate("document.querySelector('#changed').remove()")
        self.error_code(4,'read',{'handle':h})
        h=self.resolve(id='field');self.driver.dispatch('goto',{'url':'about:blank'});self.error_code(4,'read',{'handle':h})
    def test_idx_snapshot_and_handle_survives_new_snap(self):
        snap=self.driver.dispatch('snap',{'max':300});e=next(e for e in snap['elements'] if e['id']=='hover')
        h=self.resolve(idx=e['idx'],snapshot=snap['snapshot']);self.driver.dispatch('snap')
        self.assertEqual(self.act('read',h)['text'],'悬停')
        self.assertEqual(self.act('describe',h)['handle'],h)
        new=self.driver.dispatch('snap',{'max':300});e=next(e for e in new['elements'] if e['id']=='hover')
        self.assertEqual(len(self.service.dispatch('list',{'selector':{'idx':e['idx'],'snapshot':new['snapshot']}})['elements']),1)
    def test_rotated_geometry_and_patch_scripts_refused(self):
        h=self.resolve(id='hover');self.error_code(6,'patch',{'handle':h,'attrs':{'onclick':'alert(1)'}})
        self.error_code(1,'patch',{'handle':h,'attrs':{'title':'must-not-write'},'styles':{'definitely-invalid-property':'a'}})
        self.assertIsNone(self.act('attribute',h,name='title')['value'])
        self.driver.evaluate("document.querySelector('#hover').style.transform='rotate(30deg)'")
        self.error_code(5,'hover',{'handle':h})

if __name__=='__main__':unittest.main()
