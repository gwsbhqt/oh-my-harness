"""BROWSER_CONTROL_INSPECT_LIVE=1：独立临时 Chrome + 本地 HTTP 夹具，核对 CSS 来源。"""
import contextlib
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request

from browser_control.cdp import CDP
from browser_control.driver import PageDriver
from browser_control.elements import ElementService
from browser_control.errors import BrowserControlError
from browser_control.inspect import InspectService

FILES = {
    'base.css': """@layer base, theme;
@layer base {
  #target { color: red !important; margin: 1px; }
}
@layer theme {
  #target { color: green !important; }
}
.card { color: blue; padding: 2px 3px; --accent: #f00; }
@media (min-width: 1px) {
  .card { padding-left: 9px; }
}
""",
    'extra.css': """#wrap { container-type: inline-size; container-name: panel; }
@container panel (min-width: 10px) {
  .card { border: 1px solid; }
}
@supports (display: grid) {
  .card { display: grid; }
}
.card::before { content: "x"; }
""",
    'css.html': """<!doctype html><html lang=en><head><title>css</title><link rel=stylesheet href=base.css><link rel=stylesheet href=extra.css>
<style>
body { font-size: 20px; color: purple; --page: 1; }
</style></head><body><div id=wrap style="line-height:3"><p id=target class=card style="margin-top:4px">hello</p></div></body></html>""",
    'frame.html': """<!doctype html><html lang=en><head><title>frame</title></head><body><main><input type=text></main></body></html>""",
    'frames.html': """<!doctype html><html lang=en><head><title>frames</title></head><body><main><h1>Frames</h1>
<img src="logo.png"><p id=pale style="color:#bbb;background:#fff">low contrast text</p>
<section id=scope><img src="scoped.png"></section>
<iframe id=cross title="cross" src="CROSS/frame.html"></iframe>
</main></body></html>""",
}


def until(observe, description, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        result = observe()
        if result: return result
        if time.monotonic() >= deadline: raise AssertionError('等待超时：' + description)
        time.sleep(.025)


@unittest.skipUnless(os.environ.get('BROWSER_CONTROL_INSPECT_LIVE') == '1', '需显式 BROWSER_CONTROL_INSPECT_LIVE=1 启动独立 Chrome')
class InspectLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='browser-control-inspect-live-')
        cls.addClassCleanup(cls.cleanup_temp)
        root = Path(cls.temp.name) / 'www'
        root.mkdir(parents=True)
        handler = functools.partial(type('Quiet', (SimpleHTTPRequestHandler,), {'log_message': lambda *a: None}), directory=str(root))
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.stop_server)
        port = cls.server.server_port
        cls.base = 'http://127.0.0.1:' + str(port)
        for name, text in FILES.items():
            (root / name).write_text(text.replace('CROSS', 'http://localhost:' + str(port)))
        cls.output = tempfile.TemporaryFile()
        cls.addClassCleanup(cls.output.close)
        cls.process = subprocess.Popen([
            os.environ.get('BROWSER_CONTROL_TEST_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
            '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--disable-component-update', '--disable-sync', '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0', '--user-data-dir=' + str(Path(cls.temp.name) / 'profile'), 'about:blank',
        ], stdout=cls.output, stderr=cls.output, start_new_session=True)
        cls.addClassCleanup(cls.stop_browser)
        port_file = Path(cls.temp.name) / 'profile' / 'DevToolsActivePort'
        def endpoint():
            if cls.process.poll() is not None:
                cls.output.seek(0)
                raise AssertionError('Chrome 提前退出：' + str(cls.process.returncode) + cls.output.read().decode(errors='replace'))
            if port_file.is_file():
                data = port_file.read_text().splitlines()
                if len(data) >= 2: return 'http://127.0.0.1:' + data[0]
        cls.endpoint = until(endpoint, '独立 Chrome DevToolsActivePort')
        with urllib.request.urlopen(cls.endpoint + '/json/version', timeout=3) as response:
            version = json.load(response)
        cls.cdp = CDP(version['webSocketDebuggerUrl'])
        cls.addClassCleanup(cls.cdp.close)
        print('INSPECT_CHROME ' + version['Browser'])

    @classmethod
    def stop_server(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(5)
        if cls.thread.is_alive(): raise AssertionError('HTTP fixture 未停止')

    @classmethod
    def cleanup_temp(cls):
        path = Path(cls.temp.name)
        cls.temp.cleanup()
        if path.exists(): raise AssertionError('临时目录未清理')
        print('INSPECT_TEMP_CLEANED true')

    @classmethod
    def stop_browser(cls):
        if cls.process.poll() is None:
            with contextlib.suppress(Exception):
                with urllib.request.urlopen(cls.endpoint + '/json/version', timeout=2) as response:
                    close_cdp = CDP(json.load(response)['webSocketDebuggerUrl'])
                try: close_cdp.call('Browser.close', timeout=3)
                finally: close_cdp.close()
        try: cls.process.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(cls.process.pid, signal.SIGTERM)
            cls.process.wait(10)
        with contextlib.suppress(ProcessLookupError): os.killpg(cls.process.pid, signal.SIGKILL)
        print('INSPECT_CHROME_EXIT ' + str(cls.process.returncode))
        if cls.process.returncode != 0: raise AssertionError('Chrome 退出非 0：' + str(cls.process.returncode))

    def setUp(self):
        self.target = self.cdp.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.addCleanup(lambda: self.cdp.call('Target.closeTarget', {'targetId': self.target}))
        sid = self.cdp.call('Target.attachToTarget', {'targetId': self.target, 'flatten': True})['sessionId']
        self.driver = PageDriver(self.cdp, self.target, sid)
        self.driver.owned = True
        self.addCleanup(self.driver.close)
        self.elements = ElementService(self.driver)
        self.addCleanup(self.elements.close)
        self.inspect = InspectService(self.driver)
        self.addCleanup(self.close_inspect)

    def close_inspect(self):
        self.inspect.close()
        self.assertEqual(self.inspect.close_errors, [])

    def goto(self, path):
        self.driver.dispatch('goto', {'url': self.base + '/' + path, 'timeout': 10})
        self.driver.dispatch('wait', {'expression': 'document.readyState==="complete"'})

    def all_rules(self, params):
        first = self.inspect.dispatch('css', dict(params, page_size=5))
        rules = list(first['rules'])
        for index in range(1, first['pagination']['totalPages']):
            rules += self.inspect.dispatch('css', dict(params, page_size=5, page_idx=index))['rules']
        self.assertEqual(len(rules), first['pagination']['totalRules'])
        return first, rules

    def test_css_cascade_sources_and_wrappers(self):
        self.goto('css.html')
        handle = self.elements.dispatch('resolve', {'selector': {'css': '#target'}})['handle']
        first, rules = self.all_rules({'handle': handle})
        self.assertTrue(first['sourceComplete'])
        self.assertEqual(first['element']['selector'], 'p#target.card')
        by = lambda selector, name: [r for r in rules if r.get('selector') == selector and any(p['name'] == name for p in r['properties'])]
        layered = {r['ancestors'][0]['name']: r for r in by('#target', 'color')}
        base, theme = layered['base'], layered['theme']
        self.assertEqual(base['source']['label'], 'base.css:3')
        self.assertEqual((base['source']['line'], base['source']['column']), (3, 3))
        self.assertEqual(theme['source']['label'], 'base.css:6')
        self.assertEqual(base['properties'][0], {'name': 'color', 'value': 'red', 'status': 'active', 'important': True})
        self.assertEqual(theme['properties'][0]['status'], 'overloaded')
        card = next(r for r in by('.card', 'color') if 'ancestors' not in r)
        self.assertEqual(card['source']['label'], 'base.css:8')
        self.assertEqual(next(p for p in card['properties'] if p['name'] == 'color')['status'], 'overloaded')
        padding = next(p for p in card['properties'] if p['name'] == 'padding')
        self.assertEqual({x['name']: x['status'] for x in padding['longhands']}['padding-left'], 'overloaded')
        media = by('.card', 'padding-left')[0]
        self.assertEqual(media['ancestors'], [{'type': 'media', 'query': '(min-width: 1px)'}])
        self.assertEqual(media['source']['label'], 'base.css:10')
        container = by('.card', 'border')[0]
        self.assertEqual(container['ancestors'][0]['type'], 'container')
        self.assertEqual(container['ancestors'][0]['name'], 'panel')
        self.assertEqual(container['source']['label'], 'extra.css:3')
        self.assertEqual(by('.card', 'display')[0]['ancestors'], [{'type': 'supports', 'query': '(display: grid)', 'active': True}])
        margin = next(p for r in by('#target', 'margin') for p in r['properties'] if p['name'] == 'margin')
        self.assertEqual({x['name']: x['status'] for x in margin['longhands']}['margin-top'], 'overloaded')
        inline = rules[0]
        self.assertEqual((inline['type'], inline['properties'][0]['status']), ('inline', 'active'))
        inherited = [r for r in rules if r['type'] == 'inherited']
        self.assertEqual(inherited[0]['node']['selector'], 'div#wrap')
        body = next(r for r in inherited if r.get('selector') == 'body')
        self.assertEqual(body['source']['label'], '<style>:3')
        self.assertEqual({p['name']: p['status'] for p in body['properties']}, {'font-size': 'active', 'color': 'overloaded', '--page': 'active'})
        self.assertEqual(next(r for r in rules if r['type'] == 'pseudo')['pseudoType'], '::before')
        self.assertIn({'name': '--accent', 'value': '#f00'}, first['customProperties'])
        computed = self.driver.evaluate("getComputedStyle(document.querySelector('#target')).color")
        self.assertEqual(computed, 'rgb(255, 0, 0)')
        print('INSPECT_CSS ' + json.dumps({'rules': first['pagination']['totalRules'], 'base': base['source'], 'theme': theme['properties'][0]}, ensure_ascii=False))

    def test_css_selector_and_cross_process_frame(self):
        self.goto('frames.html')
        until(lambda: len(self.driver.session_ids) > 1, '跨进程 iframe 接入')
        self.driver.check()
        result = self.inspect.dispatch('css', {'selector': {'css': '#pale'}})
        inline = result['rules'][0]
        self.assertEqual(inline['type'], 'inline')
        self.assertEqual({p['name'] for p in inline['properties']}, {'color', 'background'})
        with self.assertRaises(BrowserControlError) as raised: self.inspect.dispatch('css', {'selector': {'css': 'img'}})
        self.assertEqual(raised.exception.code, 3)
        cross = next(fid for fid, frame in self.driver._frames_cache.items() if frame['session'] != self.driver.session_id)
        handle = self.elements.dispatch('resolve', {'selector': {'css': 'input'}, 'frame': cross})['handle']
        result = self.inspect.dispatch('css', {'handle': handle})
        self.assertEqual(result['element']['frame'], cross)
        self.assertTrue(any(r.get('origin') == 'user-agent' for r in result['rules']))
        print('INSPECT_CSS_OOPIF ' + str(result['pagination']['totalRules']))


if __name__ == '__main__':
    unittest.main()
