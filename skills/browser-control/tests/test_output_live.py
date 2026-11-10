"""BROWSER_CONTROL_OUTPUT_LIVE=1: 独立临时 Chrome + 本地 HTTP 夹具，核对截图比较与标注。"""
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

from browser_control.driver import PageDriver
from browser_control.output import OutputService, decode_png
import test_network_live

PAGES = {
    '/': b"""<!doctype html><title>output fixture</title><style>body{margin:0;font:16px sans-serif}#box{width:120px;height:60px;background:#2a7}</style>
<h1 id=title>Output fixture</h1><div id=box></div><p id=text>stable text</p><button id=btn style="position:absolute;left:200px;top:100px;width:80px;height:30px">Go</button>""",
}


class Fixture:
    def __init__(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                body = PAGES.get(self.path.split('?')[0])
                self.send_response(200 if body else 404)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body or b'')))
                self.end_headers()
                self.wfile.write(body or b'')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(5)


@unittest.skipUnless(os.environ.get('BROWSER_CONTROL_OUTPUT_LIVE') == '1', '需显式 BROWSER_CONTROL_OUTPUT_LIVE=1 启动独立 Chrome')
class OutputLiveTests(unittest.TestCase):
    # 复用网络实测的独立 Chrome 启停：临时资料目录、端口 0、退出后核对清理。
    setUpClass = classmethod(test_network_live.NetworkLiveTests.setUpClass.__func__)
    cleanup_temp = classmethod(test_network_live.NetworkLiveTests.cleanup_temp.__func__)
    stop_browser = classmethod(test_network_live.NetworkLiveTests.stop_browser.__func__)

    def setUp(self):
        if not hasattr(type(self), 'fixture'):
            type(self).fixture = Fixture()
            type(self).addClassCleanup(type(self).fixture.close)
        self.target = self.cdp.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.addCleanup(lambda: self.cdp.call('Target.closeTarget', {'targetId': self.target}))
        sid = self.cdp.call('Target.attachToTarget', {'targetId': self.target, 'flatten': True})['sessionId']
        self.driver = PageDriver(self.cdp, self.target, sid)
        self.driver.browser_owned = True
        self.addCleanup(self.driver.close)
        self.driver.dispatch('viewport', {'width': 800, 'height': 600})
        self.service = OutputService(self.driver)
        self.addCleanup(self.cleanup_service)
        self.private = Path(tempfile.mkdtemp(prefix='browser-control-output-live-'))
        self.addCleanup(shutil.rmtree, self.private)

    def cleanup_service(self):
        self.service.close()
        self.assertEqual([e for e in self.service.close_errors if 'error' in e], [])
        if self.service._root: shutil.rmtree(self.service._root)

    def goto(self, path):
        self.driver.dispatch('goto', {'url': self.fixture.base + path, 'timeout': 10})

    def test_shot_if_changed_and_diff(self):
        self.goto('/')
        first = self.service.dispatch('shot_if_changed', {'key': 'home'})
        self.assertTrue(first['changed'])
        started = time.monotonic()
        same = self.service.dispatch('shot_if_changed', {'key': 'home'})
        print('OUTPUT_SAME_S', round(time.monotonic() - started, 3), same['width'], same['height'])
        self.assertFalse(same['changed'])
        self.assertIsNone(same['artifact'])
        baseline = self.private / 'base.png'
        baseline.write_bytes(Path(first['artifact']['path']).read_bytes())
        self.driver.evaluate("document.getElementById('box').style.background='#a27';document.getElementById('text').textContent='CHANGED TEXT HERE'")
        started = time.monotonic()
        changed = self.service.dispatch('shot_if_changed', {'key': 'home', 'format': 'jpeg', 'quality': 70})
        print('OUTPUT_CHANGED', round(time.monotonic() - started, 3), changed['changed_pixels'], round(changed['ratio'], 4))
        self.assertTrue(changed['changed'])
        self.assertTrue(Path(changed['artifact']['path']).read_bytes().startswith(b'\xff\xd8'))
        out = self.private / 'diff.png'
        diff = self.service.dispatch('diff_screenshot', {'baseline': str(baseline), 'out': str(out)})
        w, h, rows = decode_png(out.read_bytes())
        print('OUTPUT_DIFF', json.dumps({k: diff[k] for k in ('changed_pixels', 'ratio', 'width', 'height')}))
        self.assertEqual((w, h), (diff['width'], diff['height']))
        self.assertEqual((w, h), (first['width'], first['height']))
        self.assertGreater(diff['changed_pixels'], 1000)
        self.assertTrue(any(b'\xff\x00\x00\xff' in r for r in rows))
        self.driver.dispatch('viewport', {'width': 700, 'height': 600})
        mismatch = self.service.dispatch('diff_screenshot', {'baseline': str(baseline), 'out': str(self.private / 'd2.png')})
        self.assertTrue(mismatch['size_mismatch'])

    def test_annotate_removes_overlay(self):
        self.goto('/')
        box = self.driver.evaluate("(()=>{const r=document.getElementById('btn').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()")
        before = self.driver.evaluate('document.documentElement.outerHTML')
        out = self.private / 'ann.png'
        result = self.service.dispatch('annotate', {'elements': [{'idx': 1, 'bounds': box}, {'idx': 2, 'bounds': {'x': 0, 'y': 0, 'width': 100, 'height': 30}}], 'out': str(out)})
        self.assertTrue(result['overlay_removed'])
        self.assertEqual(self.driver.evaluate("document.querySelectorAll('[data-browser-control-annotate],browser-control-annotate').length"), 0)
        self.assertEqual(self.driver.evaluate('document.documentElement.outerHTML'), before)
        w, h, rows = decode_png(out.read_bytes())
        px = lambda x, y: rows[y][4*x:4*x+3]
        self.assertEqual(px(int(box['x']) + 1, int(box['y']) + 10), bytes([0xe6, 0x19, 0x4b]))
        plain = self.private / 'plain.png'
        self.driver.dispatch('shot', {'out': str(plain), 'shrink': 0})
        self.assertNotEqual(decode_png(plain.read_bytes())[2][int(box['y']) + 10][4*(int(box['x'])+1):4*(int(box['x'])+1)+3], bytes([0xe6, 0x19, 0x4b]))


if __name__ == '__main__':
    unittest.main()
