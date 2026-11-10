"""输出服务单元测试：假 CDP，不连接浏览器。"""
import base64
import os
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import Mock
import zlib
from browser_control.output import OutputService, decode_png, encode_png, diff_text
from browser_control.errors import BrowserControlError


class FakeCDP:
    def __init__(self):
        self.listeners = {}
        self.calls = []
        self.event_loss = 0
        self.responses = {}
        self.lock = threading.Lock()
    def on(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)
        return lambda: self.listeners[name].remove(callback) if callback in self.listeners.get(name, []) else None
    def emit(self, name, params, sid='page'):
        for callback in tuple(self.listeners.get(name, [])): callback(params, sid)
    def call(self, method, params=None, *, session_id=None, timeout=20):
        with self.lock: self.calls.append((method, params or {}, session_id, timeout))
        value = self.responses.get(method, {})
        if callable(value): value = value(params or {}, session_id)
        if isinstance(value, Exception): raise value
        return value
    def methods(self): return [c[0] for c in self.calls]


def png(width, height, pixel):
    rows = [bytes(b for x in range(width) for b in pixel(x, y)) for y in range(height)]
    return encode_png(width, height, rows, channels=len(pixel(0, 0)))

def solid(width, height, color=(255, 255, 255)):
    return png(width, height, lambda x, y: color)

def b64(data): return base64.b64encode(data).decode()

def filtered_png(width, height, rows, channels, color_type, filters):
    """参考实现：按指定过滤类型逐行编码，用来核对解码器。"""
    out, prev = bytearray(), bytes(width * channels)
    for y, row in enumerate(rows):
        kind = filters[y % len(filters)]
        line = bytearray()
        for i, value in enumerate(row):
            a = row[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if kind == 0: pred = 0
            elif kind == 1: pred = a
            elif kind == 2: pred = b
            elif kind == 3: pred = (a + b) // 2
            else:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else b if pb <= pc else c
            line.append((value - pred) & 255)
        out += bytes([kind]) + line
        prev = row
    def chunk(kind, body): return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    data = zlib.compress(bytes(out))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)) + chunk(b'IDAT', data[:7]) + chunk(b'IDAT', data[7:]) + chunk(b'IEND', b'')


class Base(unittest.TestCase):
    def setUp(self):
        self.cdp = FakeCDP()
        self.driver = Mock(cdp=self.cdp, session_id='page', target_id='target', browser_owned=False)
        self.driver._lock = threading.RLock()
        self.service = OutputService(self.driver)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name) / 'private'
        self.private.mkdir(mode=0o700)
        os.chmod(self.private, 0o700)
    def tearDown(self):
        self.service.close()
        root = self.service._root
        if root is not None:
            for item in root.iterdir(): item.unlink()
            root.rmdir()
    def call(self, action, **params): return self.service.dispatch(action, params)
    def rejected(self, action, code=2, **params):
        before = len(self.cdp.calls)
        with self.assertRaises(BrowserControlError) as raised: self.call(action, **params)
        self.assertEqual(raised.exception.code, code, str(raised.exception))
        if code == 2: self.assertEqual(len(self.cdp.calls), before, '参数错误时不能发出 CDP 命令')
        return raised.exception
    def private_file(self, path):
        mode = Path(path).stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)


class PngTests(unittest.TestCase):
    def test_all_filters_and_color_types(self):
        width, height = 7, 10
        for color_type, channels in ((2, 3), (6, 4), (0, 1), (4, 2)):
            rows = [bytes((x * 37 + y * 11 + c * 101 + x * y) & 255 for x in range(width) for c in range(channels)) for y in range(height)]
            data = filtered_png(width, height, rows, channels, color_type, [0, 1, 2, 3, 4])
            w, h, decoded = decode_png(data)
            self.assertEqual((w, h), (width, height))
            for y in range(height):
                for x in range(width):
                    px = decoded[y][4*x:4*x+4]
                    src = rows[y][channels*x:channels*x+channels]
                    expect = {3: src + b'\xff', 4: src, 1: src * 3 + b'\xff', 2: src[:1] * 3 + src[1:]}[channels]
                    self.assertEqual(px, expect, (color_type, x, y))
    def test_sub_filter_wraps_mod_256(self):
        rows = [bytes([250, 10, 255, 200, 30, 255, 7, 255, 255])]
        w, h, decoded = decode_png(filtered_png(3, 1, rows, 3, 2, [1]))
        self.assertEqual(decoded[0], bytes([250, 10, 255, 255, 200, 30, 255, 255, 7, 255, 255, 255]))
    def test_rejects_corrupt_interlaced_and_16bit(self):
        good = solid(2, 2)
        with self.assertRaises(BrowserControlError): decode_png(good[:-5])
        broken = bytearray(good); broken[30] ^= 1
        with self.assertRaises(BrowserControlError): decode_png(bytes(broken))
        for depth, interlace in ((16, 0), (8, 1)):
            body = struct.pack('>IIBBBBB', 2, 2, depth, 2, 0, 0, interlace)
            data = good[:8] + struct.pack('>I', 13) + b'IHDR' + body + struct.pack('>I', zlib.crc32(b'IHDR' + body)) + good[33:]
            with self.assertRaises(BrowserControlError) as raised: decode_png(data)
            self.assertEqual(raised.exception.code, 5)
        with self.assertRaises(BrowserControlError): decode_png(b'not png')
    def test_encode_roundtrip(self):
        data = png(3, 2, lambda x, y: (x * 80, y * 100, 7))
        self.assertEqual(decode_png(data)[2][1][:8], bytes([0, 100, 7, 255, 80, 100, 7, 255]))


class DiffTextTests(Base):
    def test_counts_and_truncation(self):
        result = self.call('diff_text', before='a\nb\nc\n', after='a\nB\nc\nd\n', context_lines=0)
        self.assertEqual((result['added'], result['removed'], result['changed']), (2, 1, True))
        self.assertIn('+B', result['diff'])
        big = self.call('diff_text', before='\n'.join(map(str, range(1000))), after='', max_chars=100)
        self.assertTrue(big['truncated'])
        self.assertEqual(big['removed'], 1000)
        self.assertLessEqual(len(big['diff']), 100)
        same = diff_text('x', 'x')
        self.assertFalse(same['changed'])
        self.assertEqual(self.cdp.calls, [])
    def test_strict(self):
        self.rejected('diff_text', before='a')
        self.rejected('diff_text', before=1, after='a')
        self.rejected('diff_text', before='a', after='b', context_lines=-1)
        self.rejected('diff_text', before='a', after='b', context_lines=True)
        self.rejected('diff_text', before='a', after='b', extra=1)
        self.rejected('nope')


class ShotTests(Base):
    def screen(self, data):
        self.cdp.responses['Page.captureScreenshot'] = lambda params, sid: {'data': b64(data if params['format'] == 'png' else b'\xff\xd8jpeg')}
    def test_shot_if_changed(self):
        self.screen(solid(10, 10))
        first = self.call('shot_if_changed', key='k')
        self.assertTrue(first['changed'] and first['first'])
        self.private_file(first['artifact']['path'])
        same = self.call('shot_if_changed', key='k')
        self.assertFalse(same['changed'])
        self.assertIsNone(same['artifact'])
        self.screen(png(10, 10, lambda x, y: (0, 0, 0) if x == 0 and y < 5 else (255, 255, 255)))
        small = self.call('shot_if_changed', key='k', threshold=0.1)
        self.assertEqual((small['changed'], small['changed_pixels'], small['ratio']), (False, 5, 0.05))
        changed = self.call('shot_if_changed', key='k', threshold=0.01, format='jpeg', quality=60)
        self.assertTrue(changed['changed'])
        self.assertTrue(changed['artifact']['path'].endswith('.jpg'))
        self.screen(solid(12, 10))
        resized = self.call('shot_if_changed', key='k')
        self.assertTrue(resized['size_changed'])
        files = list(self.service._root.iterdir())
        self.assertEqual(len(files), 3)
        self.rejected('shot_if_changed')
        self.rejected('shot_if_changed', key='k', threshold=2)
        self.rejected('shot_if_changed', key='k', format='png', quality=5)
        self.rejected('shot_if_changed', key='k', format='gif')
        self.rejected('shot_if_changed', key='k', full_page='no')
    def test_diff_screenshot(self):
        baseline = self.private / 'base.png'
        baseline.write_bytes(solid(4, 3, (100, 100, 100)))
        self.screen(png(4, 3, lambda x, y: (200, 100, 100) if (x, y) == (1, 1) else (110, 100, 100)))
        out = self.private / 'diff.png'
        result = self.call('diff_screenshot', baseline=str(baseline), out=str(out), color_threshold=0.1)
        self.assertEqual((result['changed_pixels'], result['width'], result['height']), (1, 4, 3))
        self.assertAlmostEqual(result['ratio'], 1 / 12)
        self.private_file(out)
        w, h, rows = decode_png(out.read_bytes())
        self.assertEqual((w, h), (4, 3))
        self.assertEqual(rows[1][4:8], b'\xff\x00\x00\xff')
        self.assertNotEqual(rows[0][0:3], b'\xff\x00\x00')
        self.assertGreater(rows[0][0], 110)
        strict = self.call('diff_screenshot', baseline=str(baseline), out=str(self.private / 'd2.png'), color_threshold=0)
        self.assertEqual(strict['changed_pixels'], 12)
        self.screen(solid(5, 3))
        mismatch = self.call('diff_screenshot', baseline=str(baseline), out=str(self.private / 'd3.png'))
        self.assertTrue(mismatch['size_mismatch'])
        self.assertFalse((self.private / 'd3.png').exists())
        self.rejected('diff_screenshot', code=3, baseline=str(self.private / 'none.png'))
        self.rejected('diff_screenshot', baseline=str(baseline), color_threshold=-0.1)
        self.rejected('diff_screenshot', baseline=5)
        self.rejected('diff_screenshot', code=6, baseline=str(baseline), out=str(out))


class AnnotateTests(Base):
    def setUp(self):
        super().setUp()
        self.scripts = []
        self.cdp.responses['Page.getFrameTree'] = {'frameTree': {'frame': {'id': 'main'}}}
        self.cdp.responses['Page.createIsolatedWorld'] = {'executionContextId': 7}
        def evaluate(params, sid):
            self.scripts.append(params['expression'])
            self.assertEqual(params['contextId'], 7)
            return {'result': {'value': 0 if 'querySelectorAll' in params['expression'] else {'w': 800, 'h': 600}}}
        self.cdp.responses['Runtime.evaluate'] = evaluate
        self.cdp.responses['Page.captureScreenshot'] = {'data': b64(solid(2, 2))}
    def elements(self):
        return [{'idx': 1, 'bounds': {'x': 10, 'y': 20, 'width': 30, 'height': 40}}, {'idx': 2, 'bounds': {'x': 900, 'y': 0, 'width': 5, 'height': 5}}]
    def test_overlay_injected_captured_removed(self):
        result = self.call('annotate', elements=self.elements(), out=str(self.private / 'a.png'))
        self.assertTrue(result['overlay_removed'])
        self.assertEqual([i['idx'] for i in result['legend']], [1, 2])
        self.assertEqual([i['in_viewport'] for i in result['legend']], [True, False])
        self.private_file(result['artifact']['path'])
        methods = self.cdp.methods()
        self.assertLess(methods.index('Page.captureScreenshot'), len(methods) - 1)
        self.assertIn('pointer-events:none', self.scripts[0])
        self.assertIn('2147483647', self.scripts[0])
        self.assertIn('querySelectorAll', self.scripts[-1])
        world = next(c[1] for c in self.cdp.calls if c[0] == 'Page.createIsolatedWorld')
        self.assertTrue(world['worldName'].startswith('browser-control-annotate-'))
    def test_overlay_removed_even_when_capture_fails(self):
        self.cdp.responses['Page.captureScreenshot'] = BrowserControlError('超时', 4, outcome='unknown')
        self.rejected('annotate', code=4, elements=self.elements(), out=str(self.private / 'a.png'))
        self.assertIn('querySelectorAll', self.scripts[-1])
        self.assertFalse((self.private / 'a.png').exists())
        self.assertEqual(self.cdp.methods().count('Page.captureScreenshot'), 1)
    def test_remove_failure_reported(self):
        def evaluate(params, sid):
            if 'querySelectorAll' in params['expression']: raise BrowserControlError('Runtime.evaluate：boom', 1)
            return {'result': {'value': {'w': 800, 'h': 600}}}
        self.cdp.responses['Runtime.evaluate'] = evaluate
        result = self.call('annotate', elements=self.elements())
        self.assertFalse(result['overlay_removed'])
        self.assertIn('boom', result['warning']['error'])
        self.assertEqual(self.service.close_errors[0]['action'], 'annotate_remove')
    def test_strict(self):
        for bad in [dict(), dict(elements=[]), dict(elements=[{'idx': 1}]), dict(elements=[{'idx': 0, 'bounds': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]),
                    dict(elements=[{'idx': 1, 'bounds': {'x': 0, 'y': 0, 'width': -1, 'height': 1}}]),
                    dict(elements=[{'idx': 1, 'bounds': {'x': 0, 'y': 0, 'width': 1}}]),
                    dict(elements=[{'idx': 1, 'bounds': {'x': 0, 'y': 0, 'width': 1, 'height': 1}, 'role': 'x'}]),
                    dict(elements=self.elements() + [self.elements()[0]]),
                    dict(elements=self.elements(), quality=50), dict(elements=self.elements(), full_page=1)]:
            self.rejected('annotate', **bad)


if __name__ == '__main__':
    unittest.main()
