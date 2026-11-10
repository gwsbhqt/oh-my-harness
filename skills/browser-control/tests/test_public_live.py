"""显式 BROWSER_CONTROL_PUBLIC_LIVE=1；独立RPC进程/Chrome和loopback真实HTTP。"""
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from browser_control.client import Client
from browser_control import Page
from test_network_live import LocalHTTP

@unittest.skipUnless(os.environ.get('BROWSER_CONTROL_PUBLIC_LIVE')=='1','需要显式BROWSER_CONTROL_PUBLIC_LIVE=1启动隔离服务')
class PublicLive(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='browser-control-public-live-')
        self.root=Path(self.temp.name).resolve();self.socket=self.root/'socket'/'daemon.sock'
        (self.root/'home').mkdir();self.socket.parent.mkdir(mode=0o700)
        self.log=tempfile.TemporaryFile()
        self.env={**os.environ,'HOME':str(self.root/'home'),'BROWSER_CONTROL_CONTEXT_ID':'','DSH_SESSION_ID':'','PYTHONPATH':str(Path(__file__).resolve().parents[1]/'src')}
        self.launcher=Path(__file__).resolve().parents[1]/'scripts'/'browser-control'
        self.proc=subprocess.Popen([sys.executable,str(self.launcher),'serve','--socket',str(self.socket)],env=self.env,stdout=self.log,stderr=self.log)
        self.client=Client(str(self.socket),autostart=False)
        self.http=LocalHTTP()
        self.addAsyncCleanup(self.cleanup)
        self.session='public_live'
        self.launcher=Path(__file__).resolve().parents[1]/'scripts'/'browser-control'
        await self.cli('capabilities')
        # socket初始化通过子进程readiness等待，不忙重发业务；probe只负责启动前连接。
        deadline=asyncio.get_running_loop().time()+5
        while not self.socket.exists():
            if self.proc.poll() is not None:
                self.log.seek(0)
                raise RuntimeError('隔离服务提前退出：'+self.log.read().decode(errors='replace'))
            if asyncio.get_running_loop().time()>deadline:raise RuntimeError('隔离服务未就绪')
            await asyncio.sleep(.025)
        result=await self.client.acall('tab_new',{'url':self.http.base,'executable':os.environ.get('BROWSER_CONTROL_TEST_CHROME','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')},session=self.session,browser='Chrome')
        self.p=Page(result['targetId'],session=self.session,browser='Chrome');self.p._bound=True;self.p.owned=True;self.p._rpc=self.client.acall
    async def cleanup(self):
        try:
            if hasattr(self,'p'):await self.client.acall('release',session=self.session,browser='Chrome')
        finally:
            await asyncio.to_thread(self.http.close)
            if self.proc.poll() is None:self.proc.terminate()
            await asyncio.to_thread(self.proc.wait,10)
            self.log.close();self.temp.cleanup()
            self.assertFalse(self.root.exists())
    async def cli(self,*args,ok=True):
        command=[sys.executable,str(self.launcher),'--socket',str(self.socket),'--session',self.session,'--browser','Chrome','--json',*args]
        proc=await asyncio.create_subprocess_exec(*command,env=self.env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        out,err=await proc.communicate()
        result=json.loads(out)
        if ok:self.assertEqual(proc.returncode,0,(result,err.decode()))
        return proc.returncode,result
    async def test_elements_both_entries_fixed_handle_and_screenshot(self):
        await self.p.evaluate("document.body.innerHTML='<input id=name><button id=query>查询</button><p id=result></p>';window.clicks=0;document.querySelector('#query').onclick=()=>{clicks++;document.querySelector('#result').textContent=document.querySelector('#name').value}")
        e=self.p.element(id='name')
        await e.set_value('初始');await e.key('Meta+A');await e.type_text('公开元素验收')
        await self.p.element(id='query').click()
        self.assertEqual(await self.p.evaluate('document.querySelector("#name").value'),'公开元素验收')
        self.assertEqual(await self.p.evaluate('clicks'),1)
        _,resolved=await self.cli('element',self.p.target_id,'resolve','--selector','{"id":"query"}')
        handle=resolved.get('result',resolved)['handle']
        _,measured=await self.cli('element',self.p.target_id,'measure','--handle',json.dumps(handle))
        self.assertGreater(measured.get('result',measured)['bounding']['viewport']['width'],0)
        shot=await self.p.element(id='query').screenshot()
        self.assertGreater(Path(shot['path']).stat().st_size,0)
        patch=await self.p.element(id='result').patch(text='patched')
        await self.p.element(id='result').restore(patch['patchId'])
        self.assertEqual(await self.p.evaluate('document.querySelector("#result").textContent'),'公开元素验收')
    async def test_network_both_entries_real_backend_once(self):
        rule=await self.p.network.route('*/rewrite',action='continue',rewrite={'url':self.http.base+'/echo','method':'POST','postData':'公开中文改包'})
        value=await self.p.evaluate("fetch('/rewrite').then(r=>r.json())")
        self.assertEqual(value['echo']['body'],'公开中文改包');self.assertEqual(value['echo']['method'],'POST')
        self.assertEqual(len(self.http.matching('/rewrite')),0);self.assertEqual(len(self.http.matching('/echo')),1)
        await self.p.network.unroute(rule['routeId'])
        _,created=await self.cli('network',self.p.target_id,'route','*/json','--action','response-transform','--params','{"transform":{"json":{"set":{"/change":"CLI改写"},"remove":["/remove"]}}}')
        rule=created.get('result',created)
        value=await self.p.evaluate("fetch('/json').then(r=>r.json())")
        self.assertEqual(value['change'],'CLI改写');self.assertEqual(value['keep'],{'server':'real','nested':[1,2]});self.assertNotIn('remove',value)
        self.assertEqual(len(self.http.matching('/json')),1)
        await self.cli('network',self.p.target_id,'unroute',rule['routeId'])
    async def test_debugger_both_entries_resume_blocked_eval(self):
        stream=await self.p.debug.subscribe(['Debugger.paused','Debugger.resumed'])
        await self.p.debug.enable()
        await self.p.evaluate('window.liveDebug=function(x){let y=x+1;debugger;return y*2}')
        pending=asyncio.create_task(self.p.evaluate('liveDebug(20)'))
        try:
            events=await stream.read(wait_timeout=5)
            self.assertTrue(any(e['method']=='Debugger.paused' for e in events['events']))
            stack=await self.p.debug.stack();frame=stack['pause']['callFrames'][0]['callFrameId']
            value=await self.p.debug.evaluate_frame(call_frame_id=frame,expression='y');self.assertEqual(value['result']['value'],21)
            await self.cli('debug',self.p.target_id,'resume')
            self.assertEqual(await pending,42)
        finally:
            if not pending.done():
                await self.p.debug.resume();await pending
            await stream.stop()
    async def test_upload_stage_survives_return_disconnect_and_cleans_on_close(self):
        stage=Path('/tmp')/('browser-control-stage-'+os.urandom(6).hex())
        stage.mkdir(mode=0o700)
        file=stage/('a'*32+'-upload.txt')
        file.write_text('uploaded after return');file.chmod(0o600)
        info=stage.stat()
        descriptor={'directory':str(stage),'device':info.st_dev,'inode':info.st_ino,'files':[file.name]}
        try:
            await self.p.evaluate("document.body.innerHTML='<input id=file type=file>'")
            snap=await self.p.snap(all=True)
            await self.client.acall('page_upload',{'idx':snap.one(id='file')['idx'],'snapshot':snap.snapshot,'files':[str(file)]},
                target=self.p.target_id,session=self.session,browser='Chrome',host='local',remote_stages=[descriptor])
            self.assertEqual(await self.p.evaluate("document.querySelector('#file').files[0].text()"),'uploaded after return')
            await self.client.acall('disconnect',session=self.session,browser='Chrome',host='local')
            self.p._bound=False
            self.assertEqual(await self.p.evaluate("document.querySelector('#file').files[0].text()"),'uploaded after return')
            await self.p.close()
            self.assertFalse(stage.exists())
        finally:
            if stage.exists():
                for entry in stage.iterdir():entry.unlink()
                stage.rmdir()

    async def test_disconnect_then_release_keeps_owned_metadata(self):
        result=await self.client.acall('disconnect',session=self.session,browser='Chrome')
        self.assertEqual(result['disconnected'],[self.p.target_id])
        self.p._bound=False
        await self.p.snap()
        self.assertTrue(self.p.owned)
        result=await self.client.acall('release',session=self.session,browser='Chrome')
        self.assertIn(self.p.target_id,result['released'])

if __name__=='__main__':unittest.main()
