"""网页驱动边界回归；真实 Chrome 测试只在显式 BROWSER_USE_TEST_CDP 指向专用实例时运行。"""
import base64
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from browser_use.errors import BrowserUseError
from browser_use.driver import PageDriver, _CLICK_POINTS, _DESCRIBE, _META


class FakeCDP:
    def __init__(self):
        self.listeners={}; self.calls=[]; self.document=1; self.connected=True
        self.id='go'; self.tag='BUTTON'; self.destroyed=False; self.timeout_method=None
        self.click_points={'rect':{'x':10,'y':20,'width':30,'height':20},'visible':{'x':10,'y':20,'width':30,'height':20},'clippedBy':None,'points':[{'name':'center','x':25,'y':30,'hit':True}],'blocker':None}
        self.child=False; self.meta={'connected':True,'id':'go','tag':'BUTTON','value':'','editable':False,'enabled':True,'bounds':{'x':10,'y':20,'width':30,'height':20}}
    def on(self,name,cb):
        self.listeners.setdefault(name,[]).append(cb)
        return lambda:self.listeners[name].remove(cb)
    def emit(self,name,p,sid=None):
        for cb in tuple(self.listeners.get(name,[])): cb(p,sid)
    def call(self,method,params=None,*,session_id=None,timeout=20):
        p=params or {}; self.calls.append((method,p,session_id))
        if method==self.timeout_method: raise BrowserUseError('timeout',4,outcome='unknown')
        if method=='Target.getTargetInfo':
            if self.destroyed: raise BrowserUseError('No target',1)
            return {'targetInfo':{'targetId':'root'}}
        if method=='Target.getTargets': return {'targetInfos':[]}
        if method=='Page.getFrameTree':
            frame='child' if session_id=='child-session' else 'root'
            return {'frameTree':{'frame':{'id':frame,'loaderId':str(self.document),**({'parentId':'root'} if frame=='child' else {})}}}
        if method=='Page.createIsolatedWorld': return {'executionContextId':2}
        if method=='Runtime.evaluate':
            return {'result':{'objectId':'doc'}} if p['expression']=='document' else {'result':{'value':True}}
        if method=='DOM.describeNode': return {'node':{'backendNodeId':self.document}}
        if method=='Accessibility.getFullAXTree': return {'nodes':[{'nodeId':'a','backendDOMNodeId':12,'role':{'value':'button'},'name':{'value':'Go'}}]}
        if method=='DOM.resolveNode': return {'object':{'objectId':'element'}}
        if method=='Runtime.callFunctionOn':
            if p['functionDeclaration']==_META: return {'result':{'value':dict(self.meta,connected=self.connected,id=self.id,tag=self.tag)}}
            if p['functionDeclaration']==_CLICK_POINTS: return {'result':{'value':self.click_points}}
            if p['functionDeclaration']==_DESCRIBE: return {'result':{'value':{'element':{'tag':self.tag.lower(),'role':'button','name':'Go','id':self.id},'kind':'none','secret':False}}}
            if 'const r=this.getBoundingClientRect' in p['functionDeclaration']: return {'result':{'value':{'x':10,'y':20,'w':30,'h':20}}}
            return {'result':{'value':True}}
        if method=='DOM.getContentQuads': return {'quads':[[10,20,40,20,40,40,10,40]]}
        if method=='Page.getLayoutMetrics': return {'cssVisualViewport':{'clientWidth':800,'clientHeight':600},'cssContentSize':{'x':0,'y':0,'width':800,'height':1200},'cssLayoutViewport':{'clientWidth':100,'clientHeight':100}}
        if method=='Page.captureScreenshot': return {'data':base64.b64encode(b'png fixture').decode()}
        if method=='Page.addScriptToEvaluateOnNewDocument': return {'identifier':'script-'+str(len(self.calls))}
        return {}


class PageTests(unittest.TestCase):
    def setUp(self): self.cdp=FakeCDP(); self.driver=PageDriver(self.cdp,'root','session')
    def tearDown(self): self.driver.close()
    def snap(self): return self.driver.dispatch('snap')
    def numbered(self,snap,**extra): return dict(idx=1,snapshot=snap['snapshot'],**extra)
    def assert_code(self,code,action,p):
        with self.assertRaises(BrowserUseError) as exc: self.driver.dispatch(action,p)
        self.assertEqual(exc.exception.code,code)
        return exc.exception
    def test_snap_rereads_when_frame_vanishes_mid_snapshot(self):
        original=self.cdp.call
        attempts={'ax':0}
        def call(method,params=None,**kwargs):
            if method=='Accessibility.getFullAXTree':
                attempts['ax']+=1
                if attempts['ax']==1:raise BrowserUseError('Accessibility.getFullAXTree：Frame with the given frameId is not found.',1)
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=call):snap=self.driver.dispatch('snap')
        self.assertEqual(attempts['ax'],2)
        self.assertEqual(snap['elements'][0]['label'],'Go')
        def broken(method,params=None,**kwargs):
            if method=='Accessibility.getFullAXTree':raise BrowserUseError('Accessibility.getFullAXTree：Frame with the given frameId is not found.',1)
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=broken):
            with self.assertRaises(BrowserUseError) as exc:self.driver.dispatch('snap')
        self.assertEqual(exc.exception.code,4)
    def test_frame_navigation_race_only_retries_document_read(self):
        self.cdp.calls.clear()
        original=self.cdp.call
        attempts={'describe':0}
        def call(method,params=None,**kwargs):
            if method=='DOM.describeNode':
                attempts['describe']+=1
                if attempts['describe']==1:raise BrowserUseError('Cannot find context with specified id',1)
            if method=='Runtime.releaseObject' and attempts['describe']==1:
                raise BrowserUseError('Cannot find context with specified id',1)
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=call):self.driver.check()
        self.assertEqual(attempts['describe'],2)
        self.assertFalse(any(c[0].startswith('Input.') for c in self.cdp.calls))

    def test_foreign_session_events_do_not_consume_page_queue(self):
        for _ in range(5001):
            self.cdp.emit('Page.frameNavigated', {'frame': {'id': 'foreign'}}, 'foreign-session')
        self.driver._target_check()
        self.assertEqual(self.driver._event_loss, 0)
        self.assertEqual(self.driver._epoch, 0)

    def test_child_events_arriving_before_drain_are_not_lost(self):
        self.cdp.emit('Target.attachedToTarget', {'sessionId': 'child-session', 'targetInfo': {'type': 'iframe', 'targetId': 'child'}}, 'session')
        self.cdp.emit('Page.javascriptDialogOpening', {'message': 'child dialog'}, 'child-session')
        self.driver._drain()
        self.assertEqual(self.driver._dialog['message'], 'child dialog')
        self.assertIn('child-session', self.driver.session_ids)

    def test_foreign_browser_events_do_not_consume_page_queue(self):
        for _ in range(5001):
            self.cdp.emit('Target.targetInfoChanged', {'targetInfo': {'targetId': 'other', 'openerId': 'foreign'}})
            self.cdp.emit('Browser.downloadProgress', {'guid': 'foreign', 'state': 'completed'})
        self.driver._target_check()
        self.assertEqual(self.driver._event_loss, 0)

    def test_download_progress_before_drain_keeps_own_guid(self):
        self.driver._frames_cache = {'root': {}}
        self.cdp.emit('Browser.downloadWillBegin', {'frameId': 'root', 'guid': 'own', 'url': 'https://fixture.invalid/file'})
        self.cdp.emit('Browser.downloadProgress', {'guid': 'own', 'state': 'completed', 'receivedBytes': 5, 'totalBytes': 5})
        self.driver._drain()
        self.assertEqual(self.driver._downloads['own']['state'], 'completed')

    def test_snap_contract(self):
        snap=self.snap(); e=snap['elements'][0]
        self.assertEqual(e['idx'],1); self.assertEqual(e['id'],'go'); self.assertEqual(e['role'],'button')
        self.assertNotIn('axid',e)
        for key in ('ok','mode','snapshot','shot','screenshot','truncated','timedOut'): self.assertIn(key,snap)
    def test_old_token_and_missing_token_rejected(self):
        old=self.snap(); self.snap()
        self.assert_code(4,'click',self.numbered(old)); self.assert_code(4,'click',{'idx':1})
        self.assertFalse(any(c[0] in ('Input.dispatchMouseEvent','Input.dispatchKeyEvent','Input.insertText') for c in self.cdp.calls))
    def test_pseudo_element_node_skipped(self):
        # ::before/::after 伪元素没有 isConnected 和 tagName，取态跳过它，不让整页失败。
        self.cdp.connected=False; self.cdp.tag=''; self.cdp.id=''
        self.assertEqual(self.snap()['elements'],[])
    def test_removed_element_still_fails_snapshot(self):
        # 真元素被移除时 tagName 还在，照旧按「页面已变化」报错，不因为跳过伪元素而放过。
        self.cdp.connected=False
        self.assert_code(4,'snap',{})
    def test_removed_node_not_reinterpreted(self):
        snap=self.snap(); self.cdp.connected=False
        self.assert_code(4,'click',self.numbered(snap))
    def test_identity_changed(self):
        snap=self.snap(); self.cdp.id='other'
        self.assert_code(4,'click',self.numbered(snap))
    def test_document_epoch_detected_without_events(self):
        snap=self.snap(); self.cdp.document=2
        self.assert_code(4,'click',self.numbered(snap))
    def test_navigation_event_invalidates(self):
        snap=self.snap(); self.cdp.emit('Page.frameNavigated',{'frame':{'id':'root'}},'session')
        self.assert_code(4,'click',self.numbered(snap))
    def test_destroyed_never_adopts(self):
        self.cdp.destroyed=True
        self.assert_code(4,'snap',{})
        self.assert_code(4,'snap',{})
    def test_click_timeout_not_replayed(self):
        snap=self.snap(); self.cdp.timeout_method='Input.dispatchMouseEvent'
        error=self.assert_code(4,'click',self.numbered(snap))
        self.assertEqual(error.outcome,'unknown')
        self.assertEqual(sum(c[0]=='Input.dispatchMouseEvent' for c in self.cdp.calls),1)
    def test_callback_never_calls_cdp(self):
        before=len(self.cdp.calls)
        self.cdp.emit('Target.attachedToTarget',{'sessionId':'child-session','targetInfo':{'type':'iframe','targetId':'child'}},'session')
        self.assertEqual(len(self.cdp.calls),before)
        self.driver.check(); self.assertIn('child-session',self.driver.session_ids)
    def test_child_frame_gone_before_init_is_dropped(self):
        original=self.cdp.call
        def call(method,params=None,**kwargs):
            if kwargs.get('session_id')=='gone-session':raise BrowserUseError('Page.enable：Session with given id not found.',1)
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=call):
            self.cdp.emit('Target.attachedToTarget',{'sessionId':'gone-session','targetInfo':{'type':'iframe','targetId':'gone'}},'session')
            self.driver.check()
        self.assertNotIn('gone-session',self.driver.session_ids)
        def broken(method,params=None,**kwargs):
            if kwargs.get('session_id')=='bad-session':raise BrowserUseError('Page.enable：Internal error',1)
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=broken):
            self.cdp.emit('Target.attachedToTarget',{'sessionId':'bad-session','targetInfo':{'type':'iframe','targetId':'bad'}},'session')
            with self.assertRaises(BrowserUseError):self.driver.check()
    def test_call_child_session(self):
        self.driver.call('Network.enable',session_id='child-session')
        self.assertEqual(self.cdp.calls[-1][2],'child-session')
    def test_close_unsubscribes_not_close_target(self):
        self.driver.close(); self.driver.close()
        self.assertTrue(all(not listeners for listeners in self.cdp.listeners.values()))
        self.assertFalse(any(c[0]=='Target.closeTarget' for c in self.cdp.calls))
    def test_bad_parameters(self):
        for p in ({'max':True},{'max':0},{'max':float('nan')},{'depth':101}): self.assert_code(2,'snap',p)
        self.assert_code(2,'click',{'at':[float('inf'),0]})
        self.assert_code(2,'click',{'idx':1,'id':'go'})
        self.assert_code(2,'viewport',{'width':0,'height':300})
    def test_newline_requires_explicit_permission(self): self.assert_code(6,'type',{'text':'a\nb'})
    def test_eval_exception_and_non_json(self):
        with self.assertRaises(BrowserUseError): PageDriver._result({'exceptionDetails':{'text':'boom'}})
        with self.assertRaises(BrowserUseError): PageDriver._result({'result':{'unserializableValue':'NaN'}})
    def test_shot_never_silently_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'shot.png'
            result=self.driver.dispatch('shot',{'out':str(path)})
            self.assertEqual(result['path'],str(path)); self.assertEqual(path.read_bytes(),b'png fixture')
            self.assert_code(6,'shot',{'out':str(path)})
    def test_init_registration_owned_and_removed(self):
        result=self.driver.dispatch('init_add',{'source':'window.test=1'})
        self.driver.dispatch('init_remove',{'identifier':result['identifier']})
        self.assert_code(3,'init_remove',{'identifier':result['identifier']})
    def test_shared_context_download_directory_refused(self): self.assert_code(5,'download',{'action':'directory','path':'/tmp/browser-use-invalid'})
    def test_download_progress_owned_frame_only(self):
        self.driver.check()
        self.cdp.emit('Browser.downloadWillBegin',{'guid':'foreign','frameId':'foreign'})
        self.cdp.emit('Browser.downloadWillBegin',{'guid':'own','frameId':'root'})
        self.cdp.emit('Browser.downloadProgress',{'guid':'own','state':'completed','receivedBytes':15})
        self.assertEqual(len(self.driver.dispatch('download')['downloads']),1)
        self.assertEqual(self.driver.dispatch('download',{'action':'wait','guid':'own','timeout':.1})['download']['state'],'completed')
    def test_download_timeout_unknown(self):
        self.assertEqual(self.assert_code(4,'download',{'action':'wait','guid':'missing','timeout':.01}).outcome,'unknown')
    def test_focus_emulation_uses_trusted_protocol_not_dom_click(self):
        self.driver.dispatch('click',{'id':'go'})
        self.assertTrue(any(c[0]=='Emulation.setFocusEmulationEnabled' and c[1]['enabled'] for c in self.cdp.calls))
        self.assertFalse(any(c[0]=='Runtime.callFunctionOn' and '.click()' in c[1].get('functionDeclaration','') for c in self.cdp.calls))
        self.driver.close()
        self.assertTrue(any(c[0]=='Emulation.setFocusEmulationEnabled' and not c[1]['enabled'] for c in self.cdp.calls))
    def test_id_and_label_refuse_truncated_snapshot(self):
        original=self.driver._snap
        self.driver._snap=lambda p:{**original(p),'truncated':True}
        self.cdp.calls.clear()
        for key,value in (('id','go'),('label','Go')):
            error=self.assert_code(3,'click',{key:value})
            self.assertEqual(error.outcome,'not_sent'); self.assertTrue(error.data['truncated'])
        self.assertFalse(any(c[0] in ('Input.dispatchMouseEvent','Input.dispatchTouchEvent') for c in self.cdp.calls))
        self.driver._snap=original
        self.driver.dispatch('click',{'id':'go'})
    def test_popups_do_not_rebind(self):
        self.cdp.emit('Target.targetCreated',{'targetInfo':{'targetId':'popup','openerId':'root','url':'about:blank'}})
        self.assertEqual(self.driver.dispatch('popups')['popups'][0]['targetId'],'popup')
        self.assertEqual(self.driver.target_id,'root')
    def test_unsupported_not_silent(self):
        self.assert_code(2,'unknown',{})
        self.assert_code(2,'act',dict(self.numbered(self.snap()),action='Increment'))

    def test_unknown_params_refused_before_side_effects(self):
        self.cdp.calls.clear()
        self.assert_code(2,'goto',{'url':'http://fixture','wait_until':'networkidle'})
        self.assert_code(2,'click',{'id':'go','allow_untrusted':True})
        self.assert_code(2,'snap',[])
        self.assertEqual(self.cdp.calls,[])

    def test_navigation_waits_without_replaying(self):
        original=self.cdp.call
        states=iter(('loading','interactive'))
        def call(method,params=None,**kwargs):
            if method=='Page.navigate':
                self.cdp.document+=1
                return {'loaderId':str(self.cdp.document)}
            if method=='Runtime.evaluate' and (params or {}).get('expression')=='document.readyState':
                return {'result':{'value':next(states)}}
            return original(method,params,**kwargs)
        with patch.object(self.cdp,'call',side_effect=call) as mocked:
            result=self.driver.dispatch('goto',{'url':'http://fixture'})
            self.assertFalse(result['loading']);self.assertTrue(result['stable'])
            self.assertEqual(sum(c.args[0]=='Page.navigate' for c in mocked.call_args_list),1)
    def test_navigation_readiness_timeout_reports_loading(self):
        with patch.object(self.driver,'_result',return_value='loading'):
            result=self.driver.dispatch('goto',{'url':'http://fixture','timeout':.02})
        self.assertTrue(result['loading']);self.assertFalse(result['stable'])
    def test_readonly_snap_stale_retries(self):
        with patch.object(self.driver,'_snap',side_effect=[BrowserUseError('navigation',4),{'ok':True}]) as snap:
            self.assertTrue(self.driver.dispatch('snap')['ok'])
            self.assertEqual(snap.call_count,2)

    def test_page_scroll_without_locator(self):
        self.driver.dispatch('scroll',{'idx':None,'direction':'down','pages':.5})
        self.assertTrue(any(c[0]=='Runtime.evaluate' and 'document.scrollingElement' in c[1].get('expression','') for c in self.cdp.calls))
        self.assertFalse(any(c[0]=='DOM.resolveNode' for c in self.cdp.calls))
        self.assert_code(2,'scroll',{'direction':'diagonal'})
        self.assert_code(2,'scroll',{'pages':0})

    def test_diff_counts_duplicate_elements(self):
        base=self.snap()['elements'][0]
        self.driver._previous=[dict(base),dict(base)]
        diff=self.driver.dispatch('snap',{'diff':True})
        self.assertTrue(diff['changed']); self.assertEqual(len(diff['removed']),1)
    def test_queue_overflow_explicit(self):
        for i in range(5001): self.cdp.emit('Page.javascriptDialogClosed',{},'session')
        self.assert_code(5,'snap',{})
    def test_close_gone_session_is_not_cleanup_failure(self):
        original=self.cdp.call
        def call(method,*args,**kwargs):
            if method=='Emulation.setFocusEmulationEnabled': raise BrowserUseError('Session with given id not found.',1)
            return original(method,*args,**kwargs)
        self.cdp.call=call
        self.driver.close()
        self.assertEqual(self.driver.close_errors,[])
    def test_close_unknown_cleanup_reported(self):
        self.cdp.timeout_method='Emulation.setFocusEmulationEnabled'
        self.driver.close()
        self.assertEqual(len(self.driver.close_errors),1)

    def test_close_disables_autoattach_after_restoring_children(self):
        self.cdp.emit('Target.attachedToTarget',{'sessionId':'child-session','targetInfo':{'type':'iframe','targetId':'child'}},'session')
        self.driver.check()
        self.cdp.calls.clear()
        self.driver.close()
        restore=[i for i,c in enumerate(self.cdp.calls) if c[0]=='Emulation.setFocusEmulationEnabled' and not c[1]['enabled']]
        detach=[i for i,c in enumerate(self.cdp.calls) if c[0]=='Target.setAutoAttach' and not c[1]['autoAttach']]
        self.assertEqual(len(restore),2);self.assertEqual(len(detach),2)
        self.assertLess(max(restore),min(detach))
        self.assertEqual(self.cdp.calls[detach[-1]][2],'session')
        self.assertFalse(any(c[0] in ('Target.closeTarget','Target.detachFromTarget') for c in self.cdp.calls))

    def test_close_network_not_under_page_lock(self):
        from unittest.mock import Mock
        network=Mock()
        finished=threading.Event()
        def close():
            def acquire():
                with self.driver._lock: finished.set()
            thread=threading.Thread(target=acquire);thread.start()
            self.assertTrue(finished.wait(.5));thread.join()
        network.close.side_effect=close
        self.driver.network=network
        self.driver.close()
        network.close.assert_called_once()


class Phase3PageTests(unittest.TestCase):
    """新增页面动作：参数在 CDP 前全部校验、超时不重放、清理撤销本绑定副作用。"""
    def setUp(self): self.cdp=FakeCDP(); self.driver=PageDriver(self.cdp,'root','session')
    def tearDown(self): self.driver.close()
    def assert_code(self,code,action,p):
        with self.assertRaises(BrowserUseError) as exc: self.driver.dispatch(action,p)
        self.assertEqual(exc.exception.code,code,str(exc.exception))
        return exc.exception
    def methods(self): return [c[0] for c in self.cdp.calls]

    def test_strict_params_rejected_before_any_cdp(self):
        bad=[
            ('key',{'keys':'Hyper+K'}),('key',{'keys':'F25'}),('key',{'keys':'Control+Control+K'}),('key',{'keys':''}),('key',{'keys':'a','key':'b'}),
            ('key_down',{'key':'NoSuchKey'}),('key_up',{}),('key_down',{'key':'a','repeat':True}),
            ('type_keys',{'text':''}),('type_keys',{'text':'a','delay_ms':1001}),('type_keys',{'text':'a','delay_ms':-1}),('type_keys',{'text':'a','delay_ms':1.5}),
            ('edit',{'command':'delete'}),('edit',{'command':'copy','authorized':True}),('type',{'text':'a','position':'middle'}),('click',{'id':'go','position':'bottom'}),
            ('mouse_move',{'x':1}),('mouse_move',{'x':1,'y':2,'steps':0}),('mouse_move',{'x':1,'y':2,'steps':241}),('mouse_move',{'x':float('nan'),'y':1}),('mouse_move',{'x':True,'y':1}),
            ('mouse_down',{'button':'back'}),('mouse_down',{'x':1}),('mouse_up',{'click_count':4}),
            ('wheel',{}),('wheel',{'dy':'1'}),('wheel',{'dy':1,'x':1}),
            ('wait',{}),('wait',{'url':'*','load':'load'}),('wait',{'load':'idle'}),('wait',{'selector':{'css':'a'},'state':'gone'}),
            ('wait',{'url':'*','state':'visible'}),('wait',{'any_text':[]}),('wait',{'any_text':['ok',1]}),('wait',{'selector':{'text':'a','role':'button'}}),
            ('wait',{'url':'*','timeout':601}),('wait',{'selector':{'css':'a'},'gone':True}),
            ('goto',{'url':'http://x','timeout':121}),('goto',{'url':'http://x','timeout':0}),('goto',{'url':'http://x','before_unload':'ignore'}),('reload',{'ignore_cache':'yes'}),
            ('page_text',{'max_chars':0}),('page_text',{'max_chars':1000001}),('page_text',{'max_chars':'10'}),('page_info',{'x':1}),('frames',{'all':True}),
            ('shot',{'format':'gif'}),('shot',{'format':'png','quality':5}),('shot',{'format':'jpeg','quality':101}),('shot',{'format':'jpeg','out':'/tmp/x.png'}),('shot',{'overwrite':'yes'}),
            ('snap',{'interactive_only':'yes'}),('snap',{'within':''}),('snap',{'all':True,'interactive_only':True}),('snap',{'include_urls':1}),
            ('click',{'selector':{'text':'a'},'id':'go'}),('click',{'selector':{'text':'a','css':'b'}}),('click',{'selector':{'css':'a','match':'contains'}}),
            ('click',{'selector':{'text':'a','nth':True}}),('click',{'selector':{'text':'a','match':'regex'}}),('click',{'selector':{'text':'a','ignore_case':1}}),
            ('fill_form',{'items':[]}),('fill_form',{'items':[{'selector':{'id':'a'},'value':'x','extra':1}]}),('fill_form',{'items':[{'selector':{'id':'a'},'kind':'radio','value':'x'}]}),
            ('fill_form',{'items':[{'selector':{'id':'a'},'kind':'check','value':True}]}),('fill_form',{'items':[{'selector':{'id':'a'},'kind':'text','value':1}]}),
            ('fill_form',{'items':[{'selector':{'id':'a'},'kind':'text','value':'x','by':'label'}]}),('fill_form',{'items':['x']}),
            ('upload_via_chooser',{'selector':{'id':'a'},'files':[]}),('upload_via_chooser',{'files':['/etc/hosts']}),('upload_via_chooser',{'selector':{'id':'a'},'files':['/etc/hosts'],'timeout':31}),
        ]
        for action,params in bad:
            self.cdp.calls.clear()
            with self.subTest(action=action,params=params):
                self.assert_code(2,action,params)
                self.assertEqual(self.cdp.calls,[])

    def test_safety_refusals_before_cdp(self):
        for action,params in (('type_keys',{'text':'a\nb'}),('fill_form',{'items':[{'selector':{'id':'a'},'value':'a\nb'}]})):
            self.cdp.calls.clear(); self.assert_code(6,action,params); self.assertEqual(self.cdp.calls,[])
        self.cdp.calls.clear(); self.assert_code(3,'upload_via_chooser',{'selector':{'id':'a'},'files':['/definitely/missing.txt']})
        self.assertEqual(self.cdp.calls,[])

    def test_key_combo_and_plus_key(self):
        from browser_use.driver import _combo
        mods,info=_combo('Control+Shift+K'); self.assertEqual((mods,info['code']),(['Control','Shift'],'KeyK'))
        mods,info=_combo('Ctrl++'); self.assertEqual((mods,info['key']),(['Control'],'+'))
        mods,info=_combo('Cmd+Option+F12'); self.assertEqual((mods,info['key'],info['keyCode']),(['Meta','Alt'],'F12',123))
        self.assertEqual(_combo('+')[1]['key'],'+')
        self.assertEqual(_combo('pagedown')[1]['key'],'PageDown')
        self.assertEqual((_combo('KeyA')[1]['key'],_combo('Digit1')[1]['key'],_combo('Semicolon')[1]['key']),('a','1',';'))
        self.assertEqual(_combo('é')[1]['text'],'é')
        self.driver.dispatch('key',{'keys':'Control+Shift+K'})
        keys=[c[1] for c in self.cdp.calls if c[0]=='Input.dispatchKeyEvent']
        expected=[('rawKeyDown','Control',2),('rawKeyDown','Shift',10),('rawKeyDown','K',10),('keyUp','K',10),('keyUp','Shift',2),('keyUp','Control',0)]
        self.assertEqual([(k['type'],k['key'],k['modifiers']) for k in keys],expected)
        self.assertTrue(all('text' not in k for k in keys))

    def test_type_keys_generates_keypress_events_and_stops_on_timeout(self):
        self.driver.dispatch('type_keys',{'text':'aB'})
        keys=[c[1] for c in self.cdp.calls if c[0]=='Input.dispatchKeyEvent']
        self.assertEqual([(k['type'],k.get('text')) for k in keys],[('keyDown','a'),('keyUp',None),('keyDown','B'),('keyUp',None)])
        self.cdp.calls.clear(); self.cdp.timeout_method='Input.dispatchKeyEvent'
        error=self.assert_code(4,'type_keys',{'text':'abc'})
        self.assertEqual(error.outcome,'unknown'); self.assertEqual(error.data['sentEvents'],0)
        self.assertEqual(sum(c[0]=='Input.dispatchKeyEvent' for c in self.cdp.calls),1)

    def test_key_down_released_on_close(self):
        self.driver.dispatch('key_down',{'key':'Shift'})
        self.driver.dispatch('key',{'keys':'a'})
        down=[c[1] for c in self.cdp.calls if c[0]=='Input.dispatchKeyEvent' and c[1]['key']=='A']
        self.assertEqual(down[0]['modifiers'],8)
        self.cdp.calls.clear(); self.driver.close()
        self.assertIn(('Input.dispatchKeyEvent','keyUp','Shift'),[(c[0],c[1].get('type'),c[1].get('key')) for c in self.cdp.calls])
        self.assertEqual(self.driver.close_errors,[])

    def test_mouse_buttons_tracked_and_released_on_close(self):
        self.driver.dispatch('mouse_move',{'x':10,'y':20,'steps':4})
        moves=[c[1] for c in self.cdp.calls if c[0]=='Input.dispatchMouseEvent']
        self.assertEqual(len(moves),4); self.assertEqual((moves[-1]['x'],moves[-1]['y']),(10,20))
        self.driver.dispatch('mouse_down',{'button':'right'})
        self.assert_code(1,'mouse_down',{'button':'right'})
        self.driver.dispatch('wheel',{'dy':120})
        wheel=[c[1] for c in self.cdp.calls if c[1].get('type')=='mouseWheel'][-1]
        self.assertEqual((wheel['deltaY'],wheel['x'],wheel['buttons']),(120,10,2))
        self.cdp.calls.clear(); self.driver.close()
        self.assertTrue(any(c[0]=='Input.dispatchMouseEvent' and c[1]['type']=='mouseReleased' and c[1]['button']=='right' for c in self.cdp.calls))

    def test_mouse_timeout_not_replayed(self):
        self.cdp.timeout_method='Input.dispatchMouseEvent'
        self.assertEqual(self.assert_code(4,'mouse_move',{'x':5,'y':5,'steps':10}).outcome,'unknown')
        self.assertEqual(sum(c[0]=='Input.dispatchMouseEvent' for c in self.cdp.calls),1)

    def test_edit_commands_require_headless_for_clipboard(self):
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Browser.getVersion': return {'userAgent':'Mozilla/5.0 Chrome/155'}
            return original(method,params,**kw)
        self.cdp.call=call
        self.cdp.calls.clear()
        self.assert_code(5,'edit',{'command':'paste'})
        self.assertFalse(any(c[0]=='Input.dispatchKeyEvent' for c in self.cdp.calls))
        result=self.driver.dispatch('edit',{'command':'select_all'})
        self.assertEqual(result['editingCommand'],'selectAll')
        self.cdp.call=lambda method,params=None,**kw:{'userAgent':'HeadlessChrome/155'} if method=='Browser.getVersion' else original(method,params,**kw)
        self.cdp.calls.clear()
        self.assertEqual(self.driver.dispatch('edit',{'command':'copy'})['clipboard'],'headless-private')
        commands=[c[1].get('commands') for c in self.cdp.calls if c[0]=='Input.dispatchKeyEvent' and c[1].get('commands')]
        self.assertEqual(commands,[['copy']])

    def test_page_info_text_frames(self):
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Runtime.evaluate' and 'innerText' in (params or {}).get('expression',''): return {'result':{'value':{'text':'abcde','length':12}}}
            if method=='Runtime.evaluate' and 'readyState:document.readyState' in (params or {}).get('expression',''): return {'result':{'value':{'url':'http://fixture/','title':'T','readyState':'complete','viewport':{'innerWidth':800,'innerHeight':600,'devicePixelRatio':2,'scrollX':0,'scrollY':5}}}}
            return original(method,params,**kw)
        self.cdp.call=call
        info=self.driver.dispatch('page_info')
        self.assertEqual((info['title'],info['readyState'],info['loaderId'],info['viewport']['scrollY']),('T','complete','1',5))
        text=self.driver.dispatch('page_text',{'max_chars':5})
        self.assertEqual((text['text'],text['length'],text['truncated']),('abcde',12,True))
        frames=self.driver.dispatch('frames')
        self.assertEqual(frames['frames'][0]['frameId'],'root'); self.assertFalse(frames['frames'][0]['oopif'])
        self.assertIsNone(frames['frames'][0]['parentId'])

    def test_wait_condition_types(self):
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Page.getFrameTree': return {'frameTree':{'frame':{'id':'root','loaderId':'1','url':'http://fixture/done?x=1'}}}
            return original(method,params,**kw)
        self.cdp.call=call
        self.assertTrue(self.driver.dispatch('wait',{'url':'*/done?x=*','timeout':.2})['found'])
        self.assertEqual(self.assert_code(4,'wait',{'url':'*/never','timeout':.05}).outcome,'not_sent')
        self.assertEqual(self.assert_code(4,'wait',{'load':'networkidle','timeout':.05}).data['condition'],'load')
        self.assertTrue(any(c[0]=='Page.setLifecycleEventsEnabled' and c[1]['enabled'] for c in self.cdp.calls))
        self.cdp.emit('Page.lifecycleEvent',{'frameId':'root','loaderId':'1','name':'networkIdle'},'session')
        self.assertIn('networkIdle',self.driver.dispatch('wait',{'load':'networkidle','timeout':.2})['lifecycle'])
        self.cdp.calls.clear(); self.driver.close()
        self.assertTrue(any(c[0]=='Page.setLifecycleEventsEnabled' and not c[1]['enabled'] for c in self.cdp.calls))

    def test_before_unload_report_does_not_choose(self):
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Page.navigate':
                self.cdp.emit('Page.javascriptDialogOpening',{'type':'beforeunload','message':'','url':'http://fixture/','frameId':'root'},'session')
                time.sleep(.3)
                return {'frameId':'root','errorText':'net::ERR_ABORTED'}
            return original(method,params,**kw)
        self.cdp.call=call
        error=self.assert_code(1,'goto',{'url':'http://next'})
        self.assertEqual((error.outcome,error.data['dialog']['type']),('dialog_open','beforeunload'))
        self.assertFalse(any(c[0]=='Page.handleJavaScriptDialog' for c in self.cdp.calls))
        self.cdp.calls.clear()
        self.assertEqual(self.assert_code(1,'goto',{'url':'http://next'}).outcome,'not_sent')
        self.assertFalse(any(c[0]=='Page.navigate' for c in self.cdp.calls))
        self.driver.dispatch('dialog',{'accept':False})
        result=self.driver.dispatch('goto',{'url':'http://next','before_unload':'dismiss'})
        self.assertEqual((result['navigated'],result['beforeUnload']),(False,'dismissed'))
        self.assertIn(('Page.handleJavaScriptDialog',{'accept':False}),[(c[0],c[1]) for c in self.cdp.calls])

    def test_navigation_timeout_is_unknown_not_replayed(self):
        self.cdp.timeout_method='Page.navigate'
        self.assertEqual(self.assert_code(4,'goto',{'url':'http://next','timeout':.1}).outcome,'unknown')
        self.assertEqual(sum(c[0]=='Page.navigate' for c in self.cdp.calls),1)

    def test_upload_via_chooser_disables_interception_on_failure(self):
        with tempfile.NamedTemporaryFile() as handle:
            error=self.assert_code(1,'upload_via_chooser',{'id':'go','files':[handle.name],'timeout':.05})
        self.assertEqual(error.outcome,'unknown')
        intercept=[c[1]['enabled'] for c in self.cdp.calls if c[0]=='Page.setInterceptFileChooserDialog']
        self.assertEqual(intercept,[True,False])
        self.assertEqual(sum(c[0]=='Input.dispatchMouseEvent' and c[1]['type']=='mousePressed' for c in self.cdp.calls),1)
        self.assertFalse(any(c[0]=='DOM.setFileInputFiles' for c in self.cdp.calls))

    def test_upload_via_chooser_uses_chooser_backend_node(self):
        original=self.cdp.call
        def call(method,params=None,**kw):
            if method=='Input.dispatchMouseEvent' and (params or {}).get('type')=='mouseReleased':
                self.cdp.emit('Page.fileChooserOpened',{'frameId':'root','mode':'selectSingle','backendNodeId':77},'session')
            return original(method,params,**kw)
        self.cdp.call=call
        with tempfile.NamedTemporaryFile() as one, tempfile.NamedTemporaryFile() as two:
            self.assert_code(2,'upload_via_chooser',{'id':'go','files':[one.name,two.name]})
            self.cdp.calls.clear()
            result=self.driver.dispatch('upload_via_chooser',{'id':'go','files':[one.name]})
        self.assertEqual(result['mode'],'selectSingle')
        self.assertIn(('DOM.setFileInputFiles',77),[(c[0],c[1].get('backendNodeId')) for c in self.cdp.calls])

    def test_shot_formats_private_files(self):
        import stat
        original=self.cdp.call
        jpeg=b'\xff\xd8\xff\xc0\x00\x11\x08\x00\x0a\x00\x14\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xd9'
        def call(method,params=None,**kw):
            if method=='Page.captureScreenshot':
                self.cdp.calls.append((method,params,kw.get('session_id')))
                return {'data':base64.b64encode(jpeg).decode()}
            return original(method,params,**kw)
        self.cdp.call=call
        result=self.driver.dispatch('shot',{'format':'jpeg','quality':60,'shrink':0})
        self.assertEqual(result['screenshot']['format'],'jpeg'); self.assertEqual((result['screenshot']['width'],result['screenshot']['height']),(20,10))
        path=Path(result['path'])
        self.assertTrue(path.name.endswith('.jpg'))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600); self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode),0o700)
        args=[c[1] for c in self.cdp.calls if c[0]=='Page.captureScreenshot'][-1]
        self.assertEqual((args['format'],args['quality'],args['clip']['scale']),('jpeg',60,1))
        path.unlink()

    def test_snap_within_requires_unique_container(self):
        original=self.cdp.call
        self.cdp.call=lambda method,params=None,**kw:{'result':{'type':'number','value':3}} if method=='Runtime.evaluate' and 'querySelectorAll' in (params or {}).get('expression','') else original(method,params,**kw)
        self.assertEqual(self.assert_code(3,'snap',{'within':'div'}).data['count'],3)

    def test_fill_form_stops_and_reports_position(self):
        from unittest.mock import MagicMock
        service=MagicMock()
        service.locate.side_effect=[({'session':'session','object':'element','backend':12,'frame':'root'},{'enabled':True}),BrowserUseError('元素匹配到 0 个',3)]
        service.infer_kind.return_value='text'
        service.form_item.return_value={'ok':True,'kind':'input','value':'a','matches':True}
        self.driver._locator=service
        error=self.assert_code(3,'fill_form',{'items':[{'selector':{'id':'a'},'value':'a'},{'selector':{'id':'b'},'value':'b'},{'selector':{'id':'c'},'value':'c'}]})
        self.assertEqual(error.data['stoppedAt'],1); self.assertEqual(len(error.data['results']),1)
        self.assertEqual(service.form_item.call_count,1)
        self.driver._locator=None


@unittest.skipUnless(os.environ.get('BROWSER_USE_TEST_CDP'),'需要专用 BROWSER_USE_TEST_CDP 实例')
class ChromePageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from browser_use.cdp import CDP,discover
        from fixture_server import FixtureServer
        cls.cdp=CDP(discover(os.environ['BROWSER_USE_TEST_CDP']))
        cls.context=cls.cdp.call('Target.createBrowserContext')['browserContextId']
        target=cls.cdp.call('Target.createTarget',{'url':'about:blank','browserContextId':cls.context})['targetId']
        session=cls.cdp.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
        cls.driver=PageDriver(cls.cdp,target,session);cls.driver.browser_context_id=cls.context
        cls.fixture=FixtureServer().__enter__()
    @classmethod
    def tearDownClass(cls):
        cls.driver.close();cls.cdp.call('Target.disposeBrowserContext',{'browserContextId':cls.context});cls.cdp.close();cls.fixture.__exit__(None,None,None)
    def fresh(self):
        self.driver.dispatch('goto',{'url':self.fixture.url})
        self.driver.dispatch('wait',{'expression':'document.readyState==="complete"'})
    def test_real_create_navigate_immediate_snapshot(self):
        for i in range(5):
            target=self.cdp.call('Target.createTarget',{'url':'about:blank','browserContextId':self.context})['targetId']
            session=self.cdp.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
            driver=PageDriver(self.cdp,target,session)
            try:
                result=driver.dispatch('goto',{'url':self.fixture.url+'/?immediate='+str(i)})
                self.assertFalse(result['loading'])
                snapshot=driver.dispatch('snap',{'max':300})
                self.assertTrue(any(e['id']=='query' for e in snapshot['elements']))
                driver.dispatch('reload')
                self.assertTrue(any(e['id']=='query' for e in driver.dispatch('snap',{'max':300})['elements']))
            finally:
                driver.close();self.cdp.call('Target.closeTarget',{'targetId':target})

    def test_real_query_shadow_and_stale(self):
        self.fresh(); snap=self.driver.dispatch('snap',{'max':300})
        self.assertTrue(any(e['id']=='shadow-button' for e in snap['elements']))
        self.driver.dispatch('set',{'id':'name','value':'中文验证'})
        self.driver.dispatch('click',{'id':'query'})
        self.driver.dispatch('wait',{'label':'结果：中文验证'})
        self.assertEqual(self.driver.evaluate('clicks'),1)
        with self.assertRaises(BrowserUseError): self.driver.dispatch('click',{'idx':1,'snapshot':snap['snapshot']})
    def test_real_same_process_and_oopif(self):
        self.fresh()
        self.driver.evaluate("document.querySelector('iframe').contentDocument.querySelector('#frame-button').onclick=()=>window.frameClicked=1")
        self.driver.dispatch('click',{'id':'frame-button'})
        self.assertEqual(self.driver.evaluate('window.frameClicked'),1)
        self.driver.evaluate("document.querySelector('iframe').src='http://localhost:'+location.port+'/frame'")
        self.driver.dispatch('wait',{'label':'嵌套按钮'})
        snap=self.driver.dispatch('snap',{'max':300})
        element=next(e for e in snap['elements'] if e['id']=='frame-button')
        frame=self.driver._frames_cache[element['frame']]
        self.assertNotEqual(frame['session'],self.driver.session_id)
        self.driver._eval("document.querySelector('#frame-button').onclick=()=>document.body.dataset.clicked='yes'",frame)
        self.driver.dispatch('click',{'idx':element['idx'],'snapshot':snap['snapshot']})
        self.assertEqual(self.driver._eval('document.body.dataset.clicked',frame),'yes')
        self.driver.dispatch('type',{'id':'frame-input','text':'跨进程中文'})
        self.assertEqual(self.driver._eval("document.querySelector('#frame-input').value",frame),'跨进程中文')
    def test_real_read_select_scroll_upload_shot_init(self):
        self.fresh()
        self.driver.dispatch('set',{'id':'name','value':'abcdef'})
        self.driver.dispatch('selecttext',{'id':'name','text':'bcd'})
        self.assertEqual(self.driver.dispatch('read',{'id':'name','selected':True})['text'],'bcd')
        self.driver.dispatch('scroll',{'id':'scroll','pages':1})
        self.assertGreater(self.driver.evaluate("document.querySelector('#scroll').scrollTop"),0)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'file.txt';path.write_text('test')
            self.driver.dispatch('upload',{'id':'upload','files':[str(path)]})
            self.assertEqual(self.driver.evaluate("document.querySelector('#upload').files[0].name"),'file.txt')
            shot=self.driver.dispatch('shot',{'out':str(Path(tmp)/'shot.png'),'shrink':500})
            self.assertTrue(Path(shot['path']).read_bytes().startswith(b'\x89PNG'))
            self.assertLessEqual(max(shot['screenshot']['width'],shot['screenshot']['height']),500)
        init=self.driver.dispatch('init_add',{'source':'window.buInit=123'})
        self.driver.dispatch('reload');self.driver.dispatch('wait',{'expression':'window.buInit===123'})
        self.driver.dispatch('init_remove',{'identifier':init['identifier']})
    def test_real_key_dialog_viewport_history_and_popup(self):
        self.fresh()
        self.driver.dispatch('click',{'id':'name'})
        self.driver.dispatch('type',{'text':'键盘输入'})
        self.driver.dispatch('key',{'keys':'Backspace'})
        self.assertEqual(self.driver.evaluate("document.querySelector('#name').value"),'键盘输')
        self.driver.dispatch('viewport',{'width':700,'height':500})
        self.assertEqual(self.driver.evaluate('innerWidth'),700)
        self.driver.dispatch('viewport',{'reset':True})
        self.driver.dispatch('click',{'id':'dialog'})
        self.driver.dispatch('dialog',{'accept':True})
        self.driver.dispatch('goto',{'url':self.fixture.url+'/second'})
        self.driver.dispatch('wait',{'expression':'location.pathname==="/second"'})
        self.driver.dispatch('back')
        self.driver.dispatch('wait',{'expression':'location.pathname==="/"'})
        self.driver.dispatch('forward')
        self.driver.dispatch('wait',{'expression':'location.pathname==="/second"'})
        self.cdp.call('Runtime.evaluate',{'expression':"window.open('about:blank','browser-use-fixture-popup')",'userGesture':True,'returnByValue':False},session_id=self.driver.session_id)
        popups=self.driver.dispatch('popups')['popups']
        self.assertEqual(len(popups),1)
        self.assertNotEqual(popups[0]['targetId'],self.driver.target_id)
        self.cdp.call('Target.closeTarget',{'targetId':popups[0]['targetId']})

    def test_real_stale_removal_ambiguity_and_overlay(self):
        self.fresh()
        with self.assertRaises(BrowserUseError) as exc: self.driver.dispatch('click',{'label':'重名'})
        self.assertEqual(exc.exception.code,3)
        snapshot=self.driver.dispatch('snap',{'max':300})
        element=next(e for e in snapshot['elements'] if e['id']=='remove')
        self.driver.dispatch('click',{'idx':element['idx'],'snapshot':snapshot['snapshot']})
        with self.assertRaises(BrowserUseError) as exc: self.driver.dispatch('click',{'idx':element['idx'],'snapshot':snapshot['snapshot']})
        self.assertEqual(exc.exception.code,4)
        self.driver.evaluate("const overlay=document.createElement('div');overlay.id='overlay';Object.assign(overlay.style,{position:'fixed',inset:'0',zIndex:'99999',background:'white'});document.body.append(overlay)")
        with self.assertRaises(BrowserUseError) as exc: self.driver.dispatch('click',{'id':'query'})
        self.assertEqual(exc.exception.code,1)

    def test_real_page_scroll_without_locator(self):
        self.fresh()
        self.driver.evaluate("document.body.style.minHeight='4000px';document.body.style.minWidth='4000px';document.querySelector('#name').focus();document.scrollingElement.scrollTo(0,0)")
        height=self.driver.evaluate('document.scrollingElement.clientHeight')
        width=self.driver.evaluate('document.scrollingElement.clientWidth')
        result=self.driver.dispatch('scroll',{'idx':None,'direction':'down','pages':.5})
        self.assertEqual(result['scope'],'page')
        self.assertAlmostEqual(self.driver.evaluate('document.scrollingElement.scrollTop'),height*.5,delta=1)
        self.assertEqual(self.driver.evaluate("document.querySelector('#scroll').scrollTop"),0)
        self.driver.dispatch('scroll',{'direction':'right','pages':.5})
        self.assertAlmostEqual(self.driver.evaluate('document.scrollingElement.scrollLeft'),width*.5,delta=1)
        self.driver.dispatch('scroll',{'direction':'up','pages':.5})
        self.driver.dispatch('scroll',{'direction':'left','pages':.5})
        self.assertAlmostEqual(self.driver.evaluate('document.scrollingElement.scrollTop'),0,delta=1)
        self.assertAlmostEqual(self.driver.evaluate('document.scrollingElement.scrollLeft'),0,delta=1)

    def test_real_download_complete(self):
        self.fresh()
        with tempfile.TemporaryDirectory() as tmp:
            self.driver.dispatch('download',{'action':'directory','path':tmp})
            self.driver.dispatch('click',{'label':'下载文件'})
            downloads=self.driver.dispatch('download')['downloads']
            self.assertEqual(len(downloads),1)
            result=self.driver.dispatch('download',{'action':'wait','guid':downloads[0]['guid'],'timeout':5})
            self.assertEqual(result['download']['state'],'completed')
            self.assertEqual((Path(tmp)/'browser_use.txt').read_bytes(),b'browser-use download fixture')

if __name__=='__main__': unittest.main()
