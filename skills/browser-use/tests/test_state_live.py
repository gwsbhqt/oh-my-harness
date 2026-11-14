"""BROWSER_USE_STATE_LIVE=1: 独立临时 Chrome + loopback 夹具，验证 cookie、存储与登录状态文件；不连接用户浏览器。"""
import contextlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from browser_use.cdp import CDP
from browser_use.driver import PageDriver
from browser_use.errors import BrowserUseError
from browser_use.state import StateService


def until(observe, description, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        result = observe()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise AssertionError('等待超时：' + description)
        time.sleep(0.025)


class Fixture:
    """127.0.0.1 主页面内嵌 localhost 跨站 iframe；/login 下发 HttpOnly 登录 cookie，/whoami 回显请求 cookie。"""
    def __init__(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                path = urlsplit(self.path).path
                port = self.server.server_port
                headers = [('Content-Type', 'text/html; charset=utf-8'), ('Cache-Control', 'no-store')]
                if path == '/':
                    body = f"<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>outer</title><body>outer<iframe id=f src='http://localhost:{port}/inner'></iframe>"
                elif path == '/inner':
                    body = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>inner</title><body>inner"
                elif path == '/login':
                    body = '<!doctype html><title>login</title><body>logged in'
                    headers.append(('Set-Cookie', 'login=fixture-session-0123456789; Path=/; HttpOnly; Max-Age=3600'))
                elif path == '/whoami':
                    body = json.dumps({'cookie': self.headers.get('Cookie', '')})
                    headers[0] = ('Content-Type', 'application/json')
                else:
                    self.send_response(404); self.end_headers(); return
                raw = body.encode()
                self.send_response(200)
                for name, value in headers + [('Content-Length', str(len(raw)))]:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.base = f'http://127.0.0.1:{self.port}'
        self.other = f'http://localhost:{self.port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class Chrome:
    """独立 headless Chrome：临时资料目录、随机调试端口、私有 browser context。"""
    def __init__(self, label):
        self.label = label
        self.temp = tempfile.TemporaryDirectory(prefix='browser-use-' + label + '-live-')
        self.output = tempfile.TemporaryFile()
        self.process = subprocess.Popen([
            os.environ.get('BROWSER_USE_TEST_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
            '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--disable-component-update', '--disable-sync', '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0', '--user-data-dir=' + self.temp.name, 'about:blank',
        ], stdout=self.output, stderr=self.output, start_new_session=True)
        port_file = Path(self.temp.name) / 'DevToolsActivePort'

        def endpoint():
            if self.process.poll() is not None:
                self.output.seek(0)
                raise AssertionError('Chrome 提前退出：' + self.output.read().decode(errors='replace'))
            if port_file.is_file():
                data = port_file.read_text().splitlines()
                if len(data) >= 2:
                    return 'http://127.0.0.1:' + data[0]
        try:
            self.endpoint = until(endpoint, 'DevToolsActivePort')
            with urllib.request.urlopen(self.endpoint + '/json/version', timeout=3) as response:
                self.version = json.load(response)
            self.cdp = CDP(self.version['webSocketDebuggerUrl'])
            self.context = self.cdp.call('Target.createBrowserContext', {'disposeOnDetach': True})['browserContextId']
        except BaseException:
            self.close()
            raise
        self.drivers = []

    def page(self, url):
        target = self.cdp.call('Target.createTarget', {'url': 'about:blank', 'browserContextId': self.context})['targetId']
        sid = self.cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        driver = PageDriver(self.cdp, target, sid)
        driver.browser_context_id = self.context
        driver.browser_owned = True
        self.drivers.append(driver)
        driver.dispatch('goto', {'url': url})
        return driver

    def close(self):
        for driver in getattr(self, 'drivers', []):
            with contextlib.suppress(Exception):
                driver.close()
        if getattr(self, 'cdp', None) is not None:
            with contextlib.suppress(Exception):
                self.cdp.call('Browser.close', timeout=3)
            with contextlib.suppress(Exception):
                self.cdp.close()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(10)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGKILL)
        self.output.close()
        path = Path(self.temp.name)
        self.temp.cleanup()
        if path.exists():
            raise AssertionError('Chrome 临时目录未清理')


def evaluate(driver, expression, sid=None):
    result = driver.cdp.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True}, session_id=sid or driver.session_id)
    if result.get('exceptionDetails'):
        raise AssertionError(result['exceptionDetails'])
    return result['result'].get('value')


def wait_frames(driver, count=2):
    def ready():
        driver.check()
        return len(driver._frames_cache) >= count and len(driver.session_ids) >= count
    until(ready, 'iframe 会话接入')


@unittest.skipUnless(os.environ.get('BROWSER_USE_STATE_LIVE') == '1', '需显式 BROWSER_USE_STATE_LIVE=1 启动独立 Chrome')
class StateLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = Fixture()
        cls.addClassCleanup(cls.http.close)
        cls.dir = tempfile.TemporaryDirectory(prefix='browser-use-state-files-')
        cls.addClassCleanup(cls.dir.cleanup)
        os.chmod(cls.dir.name, 0o700)

    def chrome(self, label):
        chrome = Chrome(label)
        self.addCleanup(chrome.close)
        print('STATE_CHROME ' + chrome.version['Browser'])
        return chrome

    def test_cookies_storage_scope_and_masking(self):
        chrome = self.chrome('state-a')
        driver = chrome.page(self.http.base + '/login')
        driver.dispatch('goto', {'url': self.http.base + '/'})
        wait_frames(driver)
        service = StateService(driver)
        self.addCleanup(service.close)
        got = service.dispatch('cookies_get', {})
        login = next(c for c in got['cookies'] if c['name'] == 'login')
        self.assertTrue(login['httpOnly'])
        self.assertEqual(login['valueLength'], len('fixture-session-0123456789'))
        self.assertNotIn('fixture-session-0123456789', json.dumps(got))
        raw = service.dispatch('cookies_get', {'raw': True})
        self.assertIn('fixture-session-0123456789', json.dumps(raw))
        service.dispatch('cookies_set', {'name': 'pref', 'value': 'dark-mode', 'url': self.http.base + '/'})
        self.assertIn('pref=dark-mode', evaluate(driver, 'document.cookie'))
        service.dispatch('cookies_delete', {'name': 'pref', 'url': self.http.base + '/'})
        self.assertNotIn('pref=', evaluate(driver, 'document.cookie'))
        service.dispatch('storage_set', {'key': 'k', 'value': '本地值'})
        service.dispatch('storage_set', {'kind': 'session', 'key': 's', 'value': 'tab'})
        self.assertEqual(evaluate(driver, "[localStorage.getItem('k'),sessionStorage.getItem('s')]"), ['本地值', 'tab'])
        child_sid = next(s for s in driver.session_ids if s != driver.session_id)
        service.dispatch('storage_set', {'origin': self.http.other, 'key': 'c', 'value': 'iframe'})
        self.assertEqual(evaluate(driver, "localStorage.getItem('c')", child_sid), 'iframe')
        self.assertIsNone(evaluate(driver, "localStorage.getItem('c')"))
        self.assertEqual(service.dispatch('storage_get', {'origin': self.http.other})['items'], {'c': 'iframe'})
        with self.assertRaises(BrowserUseError) as raised:
            service.dispatch('storage_get', {'origin': 'https://example.com'})
        self.assertEqual(raised.exception.code, 6)
        service.dispatch('storage_remove', {'key': 'k'})
        self.assertIsNone(evaluate(driver, "localStorage.getItem('k')"))
        service.dispatch('storage_clear', {'kind': 'session'})
        self.assertEqual(evaluate(driver, 'sessionStorage.length'), 0)
        cleared = service.dispatch('cookies_clear', {})
        self.assertEqual(cleared['browserContextId'], chrome.context)
        self.assertEqual(chrome.cdp.call('Storage.getCookies', {'browserContextId': chrome.context})['cookies'], [])
        print('STATE_COOKIES_STORAGE ' + json.dumps({'masked': login['value'], 'scope': cleared['scope']}, ensure_ascii=False))

    def test_save_in_one_chrome_load_in_new_process(self):
        path = Path(self.dir.name) / 'login' / 'state.json'
        first = self.chrome('state-save')
        driver = first.page(self.http.base + '/login')
        evaluate(driver, "localStorage.setItem('token','local-login-token')")
        service = StateService(driver)
        saved = service.dispatch('state_save', {'path': str(path)})
        service.close()
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(path.parent).st_mode), 0o700)
        self.assertNotIn('local-login-token', json.dumps(saved))
        shown = StateService(driver).dispatch('state_show', {'path': str(path)})
        self.assertNotIn('fixture-session', json.dumps(shown))
        first.close()

        second = self.chrome('state-load')
        page = second.page(self.http.base + '/whoami')
        self.assertNotIn('login=', json.loads(evaluate(page, 'document.body.innerText'))['cookie'])
        loader = StateService(page)
        loaded = loader.dispatch('state_load', {'path': str(path)})
        self.assertEqual(loaded['cookies']['verified'], loaded['cookies']['sent'])
        self.assertTrue(loaded['storage']['loaded'][0]['verified'])
        page.dispatch('reload', {})
        seen = json.loads(evaluate(page, 'document.body.innerText'))['cookie']
        self.assertIn('login=fixture-session-0123456789', seen)
        self.assertEqual(evaluate(page, "localStorage.getItem('token')"), 'local-login-token')
        self.assertNotIn('login=', evaluate(page, 'document.cookie'))
        print('STATE_LOAD_SERVER_SAW ' + json.dumps({'cookieHeaderHasLogin': True, 'summary': shown['domains']}))


if __name__ == '__main__':
    unittest.main()
