"""BROWSER_USE_PARENT_LIVE=1：隔离服务+独立 Chrome，验证批量、动作后取态、持久资料与启动选项。"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from browser_use.client import Client
from test_network_live import LocalHTTP


@unittest.skipUnless(os.environ.get('BROWSER_USE_PARENT_LIVE') == '1', '需要显式 BROWSER_USE_PARENT_LIVE=1')
class ParentLive(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='browser-use-parent-live-')
        self.root = Path(self.temp.name).resolve()
        self.socket = self.root / 'socket' / 'daemon.sock'
        (self.root / 'home').mkdir()
        self.socket.parent.mkdir(mode=0o700)
        # 不改 HOME：品牌 Chrome 用默认 context 时，空 HOME 会让首次导航卡在系统钥匙串检查上。
        self.env = {**os.environ, 'XDG_STATE_HOME': str(self.root / 'state'), 'XDG_CACHE_HOME': str(self.root / 'cache'),
                    'BROWSER_USE_CONTEXT_ID': '', 'DSH_SESSION_ID': '', 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
        self.launcher = Path(__file__).resolve().parents[1] / 'scripts' / 'browser-use'
        self.log = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([sys.executable, str(self.launcher), 'serve', '--socket', str(self.socket)], env=self.env, stdout=self.log, stderr=self.log)
        self.client = Client(str(self.socket), autostart=False)
        self.http = LocalHTTP()
        deadline = asyncio.get_running_loop().time() + 5
        while not self.socket.exists():
            if self.proc.poll() is not None or asyncio.get_running_loop().time() > deadline:
                self.log.seek(0)
                raise RuntimeError('隔离服务未就绪：' + self.log.read().decode(errors='replace'))
            await asyncio.sleep(.025)
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        try:
            for session in ('parent_live', 'parent_profile'):
                try:
                    await self.client.acall('release', session=session, browser='Chrome')
                except Exception:
                    pass
        finally:
            await asyncio.to_thread(self.http.close)
            if self.proc.poll() is None:
                self.proc.terminate()
            await asyncio.to_thread(self.proc.wait, 10)
            self.log.close()
            self.temp.cleanup()

    async def cli(self, *args, stdin=None, session='parent_live'):
        command = [sys.executable, str(self.launcher), '--socket', str(self.socket), '--session', session, '--browser', 'Chrome', '--json', *args]
        proc = await asyncio.create_subprocess_exec(*command, env=self.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate(stdin.encode() if stdin else None)
        return proc.returncode, json.loads(out), err.decode()

    async def test_batch_and_snap_after_action(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        self.assertEqual(code, 0, (created, err))
        tab = created['targetId']
        setup = "document.body.innerHTML='<input id=name><button id=go>提交</button><p id=out></p>';document.querySelector('#go').onclick=()=>{document.querySelector('#out').textContent='你好 '+document.querySelector('#name').value}"
        script = json.dumps([
            ['eval', tab, '--', setup],
            ['type', tab, '--id', 'name', '--', '批量'],
            ['click', tab, '--id', 'go', '--snap'],
            ['click', tab, '--id', 'missing'],
            ['eval', tab, '--', 'window.notReached=true'],
        ])
        code, result, err = await self.cli('batch', stdin=script)
        self.assertNotEqual(code, 0)
        self.assertEqual(result['completed'], 4, result)
        self.assertEqual(result['stoppedAt'], 3)
        clicked = result['results'][2]['result']
        self.assertIn('你好 批量', json.dumps(clicked['snap'], ensure_ascii=False))
        code, value, err = await self.cli('eval', tab, '--', 'window.notReached === undefined')
        self.assertTrue(value['value'])

    async def test_persistent_profile_keeps_cookie_after_restart_and_lang_applies(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/', '--profile', 'live', '--lang', 'en-GB', session='parent_profile')
        self.assertEqual(code, 0, (created, err))
        tab = created['targetId']
        code, value, err = await self.cli('eval', tab, '--', "document.cookie='kept=yes; max-age=3600'; navigator.language", session='parent_profile')
        self.assertEqual(value['value'], 'en-GB')
        code, released, err = await self.cli('release', session='parent_profile')
        self.assertEqual(code, 0, (released, err))
        profile = self.root / 'state' / 'browser-use' / 'chrome-profiles' / 'live'
        self.assertTrue(profile.is_dir())
        self.assertEqual(profile.stat().st_mode & 0o777, 0o700)
        code, created, err = await self.cli('tab', 'new', self.http.base + '/', '--profile', 'live', '--lang', 'en-GB', session='parent_profile')
        self.assertEqual(code, 0, (created, err))
        code, value, err = await self.cli('eval', created['targetId'], '--', 'document.cookie', session='parent_profile')
        self.assertIn('kept=yes', value['value'])
        code, error, err = await self.cli('tab', 'new', self.http.base + '/', '--profile', 'other', session='parent_profile')
        self.assertEqual(error['code'], 2)


    async def test_state_through_cli(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        self.assertEqual(code, 0, (created, err))
        tab = created['targetId']
        code, cookie, err = await self.cli('state', tab, 'cookies-set', '--params', json.dumps({'name': 'sid', 'value': 'secret-value-123', 'url': self.http.base + '/'}))
        self.assertEqual(code, 0, (cookie, err))
        code, cookies, err = await self.cli('state', tab, 'cookies-get')
        sid = next(c for c in cookies['cookies'] if c['name'] == 'sid')
        self.assertNotIn('secret-value-123', json.dumps(cookies))
        self.assertEqual(sid['valueLength'], 16)


    async def test_python_entry_namespaces(self):
        import browser_use
        # Python 入口要连本测试的隔离服务，不能落到用户默认服务。
        original = browser_use._rpc
        async def rpc(action, params=None, *, target=None, session=None, browser='Chrome', host=None, timeout=60):
            return await self.client.acall(action, params, target=target, session=session, browser=browser, host=host, timeout=timeout)
        browser_use._rpc = rpc
        self.addCleanup(setattr, browser_use, '_rpc', original)
        page = await browser_use.open_page(self.http.base + '/', browser='Chrome', session='parent_live', host='local')
        page._rpc = rpc
        try:
            await page.state.storage_set(key='k', value='v')
            stored = await page.state.storage_get()
            self.assertIn('v', json.dumps(stored['items']))
            changed = await page.output.shot_if_changed(key='home')
            self.assertTrue(changed['first'])
            again = await page.output.shot_if_changed(key='home')
            self.assertFalse(again['changed'])
        finally:
            await self.client.acall('release', session='parent_live', browser='Chrome')


    async def test_diff_entry(self):
        before, after = self.root / 'a.txt', self.root / 'b.txt'
        before.write_text('一\n二\n'); after.write_text('一\n三\n')
        code, diff, err = await self.cli('diff', str(before), str(after))
        self.assertEqual((diff['added'], diff['removed']), (1, 1))


    async def test_inspect_and_network_entries(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        tab = created['targetId']
        setup = ("document.head.insertAdjacentHTML('beforeend','<style>#t{color:red}.c{color:blue}</style>');"
                 "document.body.innerHTML='<p id=t class=c>x</p>';"
                 "console.log('hello', {a: 1, b: [2, 3]}); 1")
        await self.cli('eval', tab, '--', setup)
        code, css, err = await self.cli('inspect', tab, 'css', '--params', json.dumps({'selector': {'css': '#t'}}))
        self.assertEqual(code, 0, (css, err))
        statuses = {(p['value'], p['status']) for rule in css['rules'] for p in rule.get('properties', []) if p['name'] == 'color'}
        self.assertIn(('red', 'active'), statuses)
        self.assertIn(('blue', 'overloaded'), statuses)
        code, console, err = await self.cli('network', tab, 'console', '--params', json.dumps({'types': ['log']}))
        message = next(m for m in console['console'] if 'hello' in m['text'])
        code, detail, err = await self.cli('network', tab, 'console-message', message['id'])
        self.assertEqual(code, 0, (detail, err))
        expanded = [a for a in detail['message']['argsDetail'] if a.get('expanded')]
        self.assertTrue(expanded and any(p['name'] == 'a' for p in expanded[0]['properties']))
        code, headers, err = await self.cli('network', tab, 'headers-set', '--params', json.dumps({'headers': {'X-Browser-Use-Live': 'yes'}}))
        self.assertEqual(code, 0, (headers, err))
        await self.cli('eval', tab, '--', "fetch('/echo-headers').then(r => r.status)")
        self.assertEqual(self.http.matching('/echo-headers')[0]['headers'].get('x-browser-use-live'), 'yes')
        import browser_use
        original = browser_use._rpc
        async def rpc(action, params=None, *, target=None, session=None, browser='Chrome', host=None, timeout=60):
            return await self.client.acall(action, params, target=target, session=session, browser=browser, host=host, timeout=timeout)
        browser_use._rpc = rpc
        self.addCleanup(setattr, browser_use, '_rpc', original)
        page = browser_use.page(tab, browser='Chrome', session='parent_live', host='local')
        page._rpc = rpc
        got = await page.network.headers_get()
        self.assertIn('X-Browser-Use-Live', json.dumps(got))
        await page.network.headers_clear()


    async def _python_page(self, tab):
        import browser_use
        original = browser_use._rpc
        async def rpc(action, params=None, *, target=None, session=None, browser='Chrome', host=None, timeout=60):
            return await self.client.acall(action, params, target=target, session=session, browser=browser, host=host, timeout=timeout)
        browser_use._rpc = rpc
        self.addCleanup(setattr, browser_use, '_rpc', original)
        page = browser_use.page(tab, browser='Chrome', session='parent_live', host='local')
        page._rpc = rpc
        return browser_use, page


    async def test_state_save_load_short_names_from_python(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        browser_use, page = await self._python_page(created['targetId'])
        await page.state.cookies_set(name='login', value='token-abcdef', url=self.http.base + '/')
        folder = self.root / 'state-files'
        folder.mkdir(mode=0o700)
        saved = await page.state.save(path=str(folder / 'login.json'), origins=[self.http.base])
        self.assertEqual(saved['artifact']['path'], str(folder / 'login.json'))
        self.assertEqual((folder / 'login.json').stat().st_mode & 0o777, 0o600)
        shown = await page.state.show(path=str(folder / 'login.json'))
        self.assertNotIn('token-abcdef', json.dumps(shown))
        await self.client.acall('release', session='parent_live', browser='Chrome')
        code, created, err = await self.cli('tab', 'new', self.http.base + '/', session='parent_other')
        browser_use, other = await self._python_page(created['targetId'])
        other.session = 'parent_other'
        loaded = await other.state.load(path=str(folder / 'login.json'))
        self.assertGreaterEqual(loaded['cookies']['verified'], 1)
        await self.cli('reload', created['targetId'], session='parent_other')
        code, value, err = await self.cli('eval', created['targetId'], '--', 'document.cookie', session='parent_other')
        self.assertIn('login=token-abcdef', value['value'])
        await self.client.acall('release', session='parent_other', browser='Chrome')


    async def test_input_locators_forms_and_shots_entries(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        tab = created['targetId']
        setup = ("document.body.innerHTML=`<input id=q placeholder=邮箱><select id=s><option value=a>甲</option><option value=b>乙</option></select>"
                 "<div role=checkbox aria-checked=false tabindex=0 id=c>同意</div><button id=go>提交</button><p id=out></p>"
                 "<div id=src draggable=true>拖我</div><div id=dst style='width:80px;height:40px'>放这</div>`;"
                 "document.querySelector('#c').onclick=e=>e.target.setAttribute('aria-checked',String(e.target.getAttribute('aria-checked')!=='true'));"
                 "window.keys=[];document.querySelector('#q').addEventListener('keypress',e=>keys.push(e.key));"
                 "document.querySelector('#go').onclick=()=>setTimeout(()=>{document.querySelector('#out').textContent='完成 '+document.querySelector('#q').value},300);"
                 "const d=document.querySelector('#dst');d.ondragover=e=>e.preventDefault();d.ondrop=e=>{e.preventDefault();d.textContent='收到'};1")
        await self.cli('eval', tab, '--', setup)
        code, filled, err = await self.cli('fill-form', tab, '--items', json.dumps([
            {'selector': {'placeholder': '邮箱'}, 'value': 'a@b.c'},
            {'selector': {'css': '#s'}, 'value': '乙', 'by': 'label'},
            {'selector': {'css': '#c'}, 'value': True}]))
        self.assertEqual(code, 0, (filled, err))
        self.assertEqual(filled['completed'], 3)
        code, clicked, err = await self.cli('click', tab, '--selector', json.dumps({'text': '提交'}))
        self.assertEqual(code, 0, (clicked, err))
        code, waited, err = await self.cli('wait', tab, '--any-text', '完成 a@b.c', '--any-text', '失败')
        self.assertEqual((code, waited.get('index')), (0, 0), (waited, err))
        code, value, err = await self.cli('eval', tab, '--', "[document.querySelector('#s').value, document.querySelector('#c').getAttribute('aria-checked')]")
        self.assertEqual(value['value'], ['b', 'true'])
        code, typed, err = await self.cli('type-keys', tab, '--selector', json.dumps({'css': '#q'}), '--', 'xy')
        self.assertEqual(code, 0, (typed, err))
        self.assertEqual((await self.cli('eval', tab, '--', 'keys.join("")'))[1]['value'], 'xy')
        out = self.root / 'shots'
        out.mkdir(mode=0o700)
        code, shot, err = await self.cli('shot', tab, '--format', 'jpeg', '--quality', '60', '--out', str(out / 'a.jpg'))
        self.assertEqual(code, 0, (shot, err))
        self.assertEqual((out / 'a.jpg').read_bytes()[:2], b'\xff\xd8')
        browser_use, page = await self._python_page(tab)
        info = await page.page_info()
        self.assertTrue(info['url'].startswith(self.http.base))
        text = await page.page_text(max_chars=10000)
        self.assertIn('完成 a@b.c', text['text'])
        source = browser_use.Element(page, {'css': '#src'})
        dropped = await source.drag_to(selector={'css': '#dst'})
        self.assertTrue(dropped['dropVerified'], dropped)
        self.assertEqual(await page.evaluate("document.querySelector('#dst').textContent"), '收到')
        field = page.element(placeholder='邮', match='contains')
        result = await field.fill('新值')
        self.assertTrue(result['matches'])
        self.assertEqual((await field.evaluate('function(){return this.value}'))['value'], '新值')
        await page.key_down('Shift')
        held = await page.key_up('Shift')
        self.assertEqual(held['key'], 'Shift')
        await page.wait(load='networkidle', timeout=10)
        await page.wait(selector={'css': '#out'}, state='visible')


    async def test_element_evaluate_from_file_and_stdin(self):
        code, created, err = await self.cli('tab', 'new', self.http.base + '/')
        tab = created['targetId']
        await self.cli('eval', tab, '--', "document.body.innerHTML='<p id=p data-n=7>段落</p>';1")
        source = self.root / 'fn.js'
        source.write_text('function(add){ return Number(this.dataset.n) + add }')
        code, resolved, err = await self.cli('element', tab, 'resolve', '--selector', json.dumps({'text': '段落'}))
        self.assertEqual(code, 0, (resolved, err))
        handle = json.dumps(resolved['handle'])
        code, result, err = await self.cli('element', tab, 'evaluate', '--handle', handle, '--file', str(source),
                                           '--params', json.dumps({'args': [3]}))
        self.assertEqual((code, result.get('value')), (0, 10), (result, err))
        code, result, err = await self.cli('element', tab, 'evaluate', '--handle', handle, '--file', '-',
                                           stdin='function(){ return this.id }')
        self.assertEqual((code, result.get('value')), (0, 'p'), (result, err))


    async def test_compare_two_urls_by_composition(self):
        code, a, err = await self.cli('tab', 'new', self.http.base + '/')
        code, b, err = await self.cli('tab', 'new', self.http.base + '/')
        await self.cli('eval', a['targetId'], '--', "document.body.innerHTML='<h1 style=color:black>版本一</h1>';1")
        await self.cli('eval', b['targetId'], '--', "document.body.innerHTML='<h1 style=color:red>版本二</h1>';1")
        folder = self.root / 'compare'
        folder.mkdir(mode=0o700)
        await self.cli('shot', a['targetId'], '--shrink', '0', '--out', str(folder / 'a.png'))
        code, diff, err = await self.cli('output', b['targetId'], 'diff-screenshot', '--params',
                                         json.dumps({'baseline': str(folder / 'a.png'), 'out': str(folder / 'diff.png')}))
        self.assertEqual(code, 0, (diff, err))
        self.assertFalse(diff['size_mismatch'], diff)
        self.assertGreater(diff['changed_pixels'], 0, diff)
        self.assertTrue((folder / 'diff.png').is_file())
        before = (await self.cli('page-text', a['targetId']))[1]['text']
        after = (await self.cli('page-text', b['targetId']))[1]['text']
        import browser_use
        text = browser_use.diff_text(before, after)
        self.assertTrue(text['changed'])
        self.assertIn('版本二', text['diff'])


    async def test_acceptance_script_login_fill_wait_result_shot(self):
        login = self.http.base + '/'
        code, created, err = await self.cli('tab', 'new', login, session='parent_seed')
        seed = created['targetId']
        await self.cli('eval', seed, '--', "document.cookie='user=张三; path=/';1", session='parent_seed')
        folder = self.root / 'accept'
        folder.mkdir(mode=0o700)
        code, saved, err = await self.cli('state', seed, 'state-save', '--params', json.dumps({'path': str(folder / 'login.json')}), session='parent_seed')
        self.assertEqual(code, 0, (saved, err))
        await self.client.acall('release', session='parent_seed', browser='Chrome')
        code, created, err = await self.cli('tab', 'new', 'about:blank')
        tab = created['targetId']
        form = ("document.body.innerHTML=`<p id=who></p><input placeholder=标题><select id=kind><option value=n>新闻</option><option value=f>财经</option></select>"
                "<label><input type=checkbox id=pub>发布</label><button>提交</button><p id=out></p>`;"
                "document.querySelector('#who').textContent=decodeURIComponent(document.cookie);"
                "document.querySelector('button').onclick=()=>setTimeout(()=>{out.textContent='已保存：'+document.querySelector('[placeholder=标题]').value+'/'+kind.value+'/'+pub.checked},200);1")
        steps = [
            ['state', tab, 'state-load', '--params', json.dumps({'path': str(folder / 'login.json')})],
            ['goto', tab, '--', login],
            ['eval', tab, '--', form],
            ['fill-form', tab, '--items', json.dumps([{'selector': {'placeholder': '标题'}, 'value': '日报'},
                                                      {'selector': {'css': '#kind'}, 'value': '财经', 'by': 'label'},
                                                      {'selector': {'css': '#pub'}, 'value': True}])],
            ['click', tab, '--selector', json.dumps({'text': '提交'})],
            ['wait', tab, '--any-text', '已保存', '--any-text', '失败'],
            ['page-text', tab],
            ['shot', tab, '--format', 'webp', '--quality', '80', '--out', str(folder / 'done.webp')],
        ]
        code, result, err = await self.cli('batch', stdin=json.dumps(steps))
        self.assertEqual(code, 0, (result, err))
        text = result['results'][6]['result']['text']
        self.assertIn('user=张三', text)
        self.assertIn('已保存：日报/f/true', text)
        self.assertEqual((folder / 'done.webp').read_bytes()[8:12], b'WEBP')
        broken = steps[:3] + [['click', tab, '--selector', json.dumps({'text': '不存在的按钮'})]] + steps[5:]
        code, result, err = await self.cli('batch', stdin=json.dumps(broken))
        self.assertNotEqual(code, 0)
        self.assertEqual(result['stoppedAt'], 3, result)




if __name__ == '__main__':
    unittest.main()
