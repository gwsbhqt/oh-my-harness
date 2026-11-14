"""页面输出与比较：截图变化与差异、编号标注、文本 diff；产物写私有新文件。"""
from __future__ import annotations
import base64
import difflib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import uuid
import zlib
from .checks import boolean, gone, integer, number, string
from .errors import BrowserUseError
from . import scratch

_PARAMS = {
    'shot_if_changed': {'key', 'threshold', 'format', 'quality', 'full_page'},
    'diff_screenshot': {'baseline', 'out', 'color_threshold', 'full_page', 'overwrite'},
    'annotate': {'elements', 'out', 'format', 'quality', 'full_page', 'overwrite'},
    'diff_text': {'before', 'after', 'context_lines', 'max_chars', 'from_label', 'to_label'},
}
_MAX_PIXELS = 16 * 1024 * 1024
_MAX_KEYS = 16
_PNG = b'\x89PNG\r\n\x1a\n'
_COLORS = ('#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000')
_FADE = bytes(191 + c // 4 for c in range(256))


def _image_format(p):
    fmt = p.get('format', 'png')
    if fmt not in ('png', 'jpeg', 'webp'): raise BrowserUseError('format 只能是 png/jpeg/webp', 2)
    if fmt == 'png' and 'quality' in p: raise BrowserUseError('png 不接受 quality', 2)
    quality = integer(p.get('quality', 80), 'quality', 0, 100) if fmt != 'png' else None
    return fmt, quality


def decode_png(data, max_pixels=_MAX_PIXELS):
    """解码 8-bit 非交错 PNG，返回 (width, height, RGBA 行列表)。"""
    if not isinstance(data, (bytes, bytearray)) or not data.startswith(_PNG): raise BrowserUseError('不是 PNG 数据', 2)
    pos, header, chunks = 8, None, []
    while True:
        if pos + 12 > len(data): raise BrowserUseError('PNG 数据不完整', 2)
        length, kind = struct.unpack('>I4s', data[pos:pos+8])
        body = data[pos+8:pos+8+length]
        if len(body) != length or pos + 12 + length > len(data): raise BrowserUseError('PNG 分块不完整', 2)
        if struct.unpack('>I', data[pos+8+length:pos+12+length])[0] != zlib.crc32(kind + body): raise BrowserUseError('PNG 分块校验失败', 2)
        if kind == b'IHDR': header = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT': chunks.append(body)
        elif kind == b'IEND': break
        pos += 12 + length
    if header is None or not chunks: raise BrowserUseError('PNG 缺少 IHDR 或 IDAT', 2)
    width, height, depth, color, compression, filtering, interlace = header
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color)
    if depth != 8 or channels is None or interlace or compression or filtering:
        raise BrowserUseError('只支持 8-bit 灰度/RGB/RGBA 非交错 PNG', 5, data={'depth': depth, 'colorType': color, 'interlace': interlace})
    if not width or not height: raise BrowserUseError('PNG 尺寸为 0', 2)
    if width * height > max_pixels: raise BrowserUseError(f'图像 {width}x{height} 超过纯 Python 比较上限 {max_pixels} 像素', 5)
    stride = width * channels
    expected = height * (stride + 1)
    inflater = zlib.decompressobj()
    try: raw = inflater.decompress(b''.join(chunks), expected)
    except zlib.error as exc: raise BrowserUseError(f'PNG 压缩数据损坏：{exc}', 2) from exc
    if len(raw) != expected or inflater.unconsumed_tail: raise BrowserUseError('PNG 像素数据长度不符', 2)
    rows, prev = [], bytes(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind, line = raw[start], raw[start+1:start+1+stride]
        if kind == 0: cur = line
        elif kind == 1: cur = _sub(line, channels)
        elif kind == 2: cur = _add(line, prev)
        elif kind == 3: cur = _average(line, prev, channels)
        elif kind == 4: cur = _paeth(line, prev, channels)
        else: raise BrowserUseError(f'PNG 行过滤类型 {kind} 无效', 2)
        rows.append(_rgba(cur, color, width))
        prev = cur
    return width, height, rows

_MASKS = {}
def _masks(n):
    masks = _MASKS.get(n)
    if masks is None:
        masks = (int.from_bytes(b'\x7f' * n, 'big'), int.from_bytes(b'\x80' * n, 'big'))
        if len(_MASKS) > 64: _MASKS.clear()
        _MASKS[n] = masks
    return masks

def _add_int(x, y, n):
    low, high = _masks(n)
    return ((x & low) + (y & low)) ^ ((x ^ y) & high)

def _add(a, b):
    # 逐字节模 256 相加：低 7 位相加不会进位到相邻字节，最高位单独异或。
    n = len(a)
    return _add_int(int.from_bytes(a, 'big'), int.from_bytes(b, 'big'), n).to_bytes(n, 'big')

def _sub(line, bpp):
    # Sub 是同通道前缀和；倍增扫描让每步都是整行大整数运算，避免逐字节循环。
    n = len(line)
    value, shift = int.from_bytes(line, 'big'), bpp
    while shift < n:
        value = _add_int(value, value >> (8 * shift), n)
        shift *= 2
    return value.to_bytes(n, 'big')

def _average(line, prev, bpp):
    out = bytearray(line)
    for i in range(min(bpp, len(out))): out[i] = (out[i] + (prev[i] >> 1)) & 255
    for i in range(bpp, len(out)): out[i] = (out[i] + ((out[i-bpp] + prev[i]) >> 1)) & 255
    return bytes(out)

def _paeth(line, prev, bpp):
    out = bytearray(line)
    for i in range(len(out)):
        a = out[i-bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i-bpp] if i >= bpp else 0
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        out[i] = (out[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    return bytes(out)

def _rgba(row, color, width):
    if color == 6: return bytes(row)
    out = bytearray(b'\xff' * (width * 4))
    if color == 2:
        out[0::4], out[1::4], out[2::4] = row[0::3], row[1::3], row[2::3]
    elif color == 0:
        out[0::4] = out[1::4] = out[2::4] = row
    else:
        gray = row[0::2]
        out[0::4] = out[1::4] = out[2::4] = gray
        out[3::4] = row[1::2]
    return bytes(out)

def encode_png(width, height, rows, *, channels=3):
    """把 RGB 或 RGBA 行编码为 PNG 字节（过滤类型 0）。"""
    color = {3: 2, 4: 6}[channels]
    def chunk(kind, body): return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return _PNG + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, color, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')

def compare_pixels(a_rows, b_rows, width, tolerance=0):
    """返回 (变化像素数, {行号: [变化列]})；tolerance 是允许的最大单通道差 0~255。"""
    changed, where = 0, {}
    for y, (ra, rb) in enumerate(zip(a_rows, b_rows)):
        if ra == rb: continue
        cols = []
        for x in range(width):
            o = 4 * x
            if ra[o:o+4] == rb[o:o+4]: continue
            if tolerance and max(abs(ra[o] - rb[o]), abs(ra[o+1] - rb[o+1]), abs(ra[o+2] - rb[o+2]), abs(ra[o+3] - rb[o+3])) <= tolerance: continue
            cols.append(x)
        if cols:
            where[y] = cols
            changed += len(cols)
    return changed, where

def diff_text(before, after, *, context_lines=3, max_chars=200000, from_label='before', to_label='after'):
    """统一 diff；计数覆盖全部差异，diff 文本按 max_chars 截断。"""
    added = removed = total = 0
    kept, truncated = [], False
    for line in difflib.unified_diff(before.splitlines(), after.splitlines(), fromfile=from_label, tofile=to_label, n=context_lines, lineterm=''):
        if line.startswith('+') and not line.startswith('+++'): added += 1
        elif line.startswith('-') and not line.startswith('---'): removed += 1
        size = len(line) + 1
        if total + size <= max_chars: kept.append(line)
        else: truncated = True
        total += size
    return {'changed': bool(added or removed), 'added': added, 'removed': removed, 'diff': '\n'.join(kept), 'diff_chars': total, 'truncated': truncated}


class _Artifact:
    def __init__(self, final, work, fd):
        self.final, self.work, self.fd = final, work, fd
        self.file = os.fdopen(fd, 'wb') if fd is not None else None

    def commit(self):
        if self.file is not None and not self.file.closed: self.file.close()
        if self.work != self.final: os.replace(self.work, self.final)
        return {'path': str(self.final), 'bytes': self.final.stat().st_size}

    def discard(self):
        if self.file is not None and not self.file.closed: self.file.close()
        try: self.work.unlink()
        except FileNotFoundError: pass


class OutputService:
    def __init__(self, driver):
        self.driver, self.cdp = driver, driver.cdp
        self.close_errors = []
        self._closed = False
        self._root = None
        self._baselines = {}
        self._overlays = {}
    def _call(self, method, params=None, *, timeout=20):
        return self.cdp.call(method, params or {}, session_id=self.driver.session_id, timeout=timeout)

    def dispatch(self, action, params=None):
        if isinstance(action, str) and action.startswith('output_'): action = action[7:]
        if self._closed: raise BrowserUseError('输出服务已释放', 4)
        if action not in _PARAMS: raise BrowserUseError(f'不支持输出动作：{action}', 2)
        p = {} if params is None else params
        if not isinstance(p, dict): raise BrowserUseError('params 需要对象', 2)
        unknown = set(p) - _PARAMS[action]
        if unknown: raise BrowserUseError(f'{action} 不支持参数：' + ', '.join(sorted(map(str, unknown))), 2)
        spec = getattr(self, '_check_' + action)(p)
        if action == 'diff_text': return diff_text(**spec)
        try:
            return getattr(self, '_' + action)(spec)
        except OSError as exc:
            raise BrowserUseError(f'输出私有产物无法写入：{exc}', 5) from exc

    # 参数校验：全部在任何 CDP 命令和文件写入之前完成。

    def _check_out(self, p):
        out = p.get('out')
        if out is not None and (not isinstance(out, str) or not out): raise BrowserUseError('out 需要非空路径字符串', 2)
        return out, boolean(p.get('overwrite', False), 'overwrite')

    def _check_shot_if_changed(self, p):
        fmt, quality = _image_format(p)
        return {'key': string(p.get('key'), 'key', limit=128), 'threshold': number(p.get('threshold', 0), 'threshold', 0, 1), 'format': fmt, 'quality': quality, 'full_page': boolean(p.get('full_page', False), 'full_page')}

    def _check_diff_screenshot(self, p):
        out, overwrite = self._check_out(p)
        baseline = Path(string(p.get('baseline'), 'baseline', limit=4096)).expanduser().absolute()
        return {'baseline': baseline, 'out': out, 'overwrite': overwrite, 'color_threshold': number(p.get('color_threshold', 0.1), 'color_threshold', 0, 1), 'full_page': boolean(p.get('full_page', False), 'full_page')}

    def _check_annotate(self, p):
        out, overwrite = self._check_out(p)
        fmt, quality = _image_format(p)
        elements = p.get('elements')
        if not isinstance(elements, list) or not 1 <= len(elements) <= 1000: raise BrowserUseError('elements 需要 1~1000 个 {idx, bounds}', 2)
        items, seen = [], set()
        for item in elements:
            if not isinstance(item, dict) or set(item) != {'idx', 'bounds'}: raise BrowserUseError('elements 每项需要且只需要 idx 与 bounds', 2)
            idx = None if item['idx'] is None else integer(item['idx'], 'idx', 1, 2**31 - 1)
            if idx in seen: raise BrowserUseError(f'elements idx {idx} 重复', 2)
            seen.add(idx)
            bounds = item['bounds']
            if not isinstance(bounds, dict) or set(bounds) != {'x', 'y', 'width', 'height'}: raise BrowserUseError('bounds 需要且只需要 x/y/width/height', 2)
            box = {k: float(number(bounds[k], k, -1e6 if k in ('x', 'y') else 0, 1e6)) for k in ('x', 'y', 'width', 'height')}
            items.append({'idx': idx, 'bounds': box})
        return {'elements': items, 'out': out, 'overwrite': overwrite, 'format': fmt, 'quality': quality, 'full_page': boolean(p.get('full_page', False), 'full_page')}

    def _check_diff_text(self, p):
        for name in ('before', 'after'):
            if not isinstance(p.get(name), str) or len(p[name]) > 32 * 1024 * 1024: raise BrowserUseError(f'{name} 需要不超过 32Mi 字符的字符串', 2)
        return {'before': p['before'], 'after': p['after'], 'context_lines': integer(p.get('context_lines', 3), 'context_lines', 0, 1000),
                'max_chars': integer(p.get('max_chars', 200000), 'max_chars', 1, 10 * 1024 * 1024),
                'from_label': string(p.get('from_label', 'before'), 'from_label', limit=1024), 'to_label': string(p.get('to_label', 'after'), 'to_label', limit=1024)}

    # 私有产物

    def _private_root(self):
        if self._root is None:
            self._root = Path(tempfile.mkdtemp(prefix='page-', dir=scratch.subdir('output')))
            os.chmod(self._root, 0o700)
        return self._root

    def _reserve(self, out, overwrite, kind, suffix):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
        if out is None:
            path = self._private_root() / f'{kind}-{uuid.uuid4().hex}{suffix}'
            return _Artifact(path, path, os.open(path, flags, 0o600))
        path = Path(out).expanduser().absolute()
        parent = path.parent
        if not parent.exists(): parent.mkdir(parents=True, mode=0o700)
        info = parent.lstat()
        if parent.is_symlink() or not parent.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise BrowserUseError('out 的父目录需为本用户拥有的 700 私有目录', 6, data={'parent': str(parent), 'mode': oct(info.st_mode & 0o777)})
        if path.is_symlink() or (path.exists() and not path.is_file()): raise BrowserUseError('out 已存在且不是普通文件', 6)
        if overwrite:
            work = parent / f'.{path.name}.{uuid.uuid4().hex}.partial'
            return _Artifact(path, work, os.open(work, flags, 0o600))
        try: return _Artifact(path, path, os.open(path, flags, 0o600))
        except FileExistsError as exc: raise BrowserUseError('out 已存在；需显式 overwrite=True', 6, data={'path': str(path)}) from exc

    # 截图

    def _capture(self, fmt='png', quality=None, full_page=False, *, fast=False):
        params = {'format': fmt, 'fromSurface': True}
        # 比较用截图只在内存解码，优先编码速度，避免 Chrome 的自适应过滤让纯 Python 解码变慢。
        if fast: params['optimizeForSpeed'] = True
        if quality is not None: params['quality'] = quality
        if full_page:
            metrics = self._call('Page.getLayoutMetrics')
            content = metrics.get('cssContentSize') or metrics.get('contentSize') or {}
            if not content.get('width') or not content.get('height'): raise BrowserUseError('页面没有可截图区域', 1)
            params.update(captureBeyondViewport=True, clip={'x': 0, 'y': 0, 'width': content['width'], 'height': content['height'], 'scale': 1})
        data = self._call('Page.captureScreenshot', params, timeout=60).get('data')
        if not data: raise BrowserUseError('浏览器没有返回截图数据', 1)
        return base64.b64decode(data, validate=True)

    def _write(self, artifact, data):
        try:
            artifact.file.write(data)
            return artifact.commit()
        except BaseException:
            artifact.discard()
            raise

    # 截图比较

    def _shot_if_changed(self, s):
        if s['key'] not in self._baselines and len(self._baselines) >= _MAX_KEYS: raise BrowserUseError(f'变化检测 key 超过 {_MAX_KEYS} 个', 5)
        with self.driver._lock:
            self.driver._target_check()
            png = self._capture('png', None, s['full_page'], fast=True)
            width, height = struct.unpack('>II', png[16:24]) if png[12:16] == b'IHDR' else (0, 0)
            previous = self._baselines.get(s['key'])
            result = {'key': s['key'], 'width': width, 'height': height, 'threshold': s['threshold'], 'compared_to': 'last_written', 'format': s['format']}
            if previous is None:
                decode_png(png)
                result.update(first=True, changed=True, changed_pixels=None, ratio=None)
            elif previous == png:
                result.update(first=False, changed=False, changed_pixels=0, ratio=0.0)
            else:
                old_w, old_h, old_rows = decode_png(previous)
                width, height, rows = decode_png(png)
                if (old_w, old_h) != (width, height):
                    result.update(first=False, changed=True, size_changed=True, changed_pixels=None, ratio=None, previous={'width': old_w, 'height': old_h})
                else:
                    count, _ = compare_pixels(old_rows, rows, width)
                    ratio = count / (width * height)
                    result.update(first=False, changed=ratio > s['threshold'] if s['threshold'] else count > 0, changed_pixels=count, ratio=ratio)
            if not result['changed']:
                result['artifact'] = None
                return result
            data = png if s['format'] == 'png' else self._capture(s['format'], s['quality'], s['full_page'])
            if s['format'] != 'png': result['captures'] = 2
        artifact = self._reserve(None, False, 'shot-' + re.sub(r'[^A-Za-z0-9_.-]', '_', s['key'])[:40], '.' + ('jpg' if s['format'] == 'jpeg' else s['format']))
        result['artifact'] = dict(self._write(artifact, data), format=s['format'])
        self._baselines[s['key']] = png
        return result

    def _diff_screenshot(self, s):
        path = s['baseline']
        if not path.is_file(): raise BrowserUseError('baseline 文件不存在或不是普通文件', 3, data={'path': str(path)})
        if path.stat().st_size > 256 * 1024 * 1024: raise BrowserUseError('baseline 超过 256MiB', 2)
        base_w, base_h, base_rows = decode_png(path.read_bytes())
        artifact = self._reserve(s['out'], s['overwrite'], 'diff', '.png')
        try:
            with self.driver._lock:
                self.driver._target_check()
                width, height, rows = decode_png(self._capture('png', None, s['full_page'], fast=True))
            baseline = {'path': str(path), 'width': base_w, 'height': base_h}
            if (width, height) != (base_w, base_h):
                artifact.discard()
                return {'size_mismatch': True, 'width': width, 'height': height, 'baseline': baseline, 'artifact': None, 'changed_pixels': None, 'ratio': None}
            count, where = compare_pixels(base_rows, rows, width, round(s['color_threshold'] * 255))
            out_rows = []
            for y, row in enumerate(rows):
                rgb = bytearray(width * 3)
                rgb[0::3], rgb[1::3], rgb[2::3] = row[0::4], row[1::4], row[2::4]
                rgb = bytearray(bytes(rgb).translate(_FADE))
                for x in where.get(y, ()): rgb[3*x:3*x+3] = b'\xff\x00\x00'
                out_rows.append(rgb)
            info = self._write(artifact, encode_png(width, height, out_rows))
        except BaseException:
            artifact.discard()
            raise
        return dict(artifact=dict(info, format='png', width=width, height=height), size_mismatch=False, changed_pixels=count, ratio=count / (width * height), width=width, height=height,
                    baseline=baseline, color_threshold=s['color_threshold'], rule='像素任一 RGBA 通道差 > color_threshold*255 记为变化')

    # 标注

    def _annotate(self, s):
        artifact = self._reserve(s['out'], s['overwrite'], 'annotate', '.' + ('jpg' if s['format'] == 'jpeg' else s['format']))
        token = uuid.uuid4().hex
        legend = [{'idx': e['idx'], 'color': _COLORS[i % len(_COLORS)], 'bounds': e['bounds']} for i, e in enumerate(s['elements'])]
        warning = None
        try:
            with self.driver._lock:
                self.driver._target_check()
                frame = self._call('Page.getFrameTree')['frameTree']['frame']['id']
                context = self._call('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'browser-use-annotate-' + token})['executionContextId']
                items = [{'idx': e['idx'], 'c': e['color'], **e['bounds']} for e in legend]
                self._overlays[token] = frame
                try:
                    view = self._evaluate(context, _OVERLAY % (json.dumps(token), json.dumps(items), json.dumps(s['full_page'])), timeout=10)
                    data = self._capture(s['format'], s['quality'], s['full_page'])
                finally:
                    warning = self._remove_overlay(token, context)
            for item in legend:
                b = item['bounds']
                item['in_viewport'] = bool(view) and b['x'] < view['w'] and b['y'] < view['h'] and b['x'] + b['width'] > 0 and b['y'] + b['height'] > 0
            info = self._write(artifact, data)
        except BaseException:
            artifact.discard()
            raise
        result = dict(artifact=dict(info, format=s['format']), legend=legend, full_page=s['full_page'], overlay_removed=warning is None, coordinate_space='viewport CSS pixels')
        if warning: result['warning'] = warning
        return result

    def _evaluate(self, context, expression, timeout=10):
        result = self._call('Runtime.evaluate', {'expression': expression, 'contextId': context, 'awaitPromise': True, 'returnByValue': True}, timeout=timeout)
        if result.get('exceptionDetails'): raise BrowserUseError('标注脚本异常', 1, data={'exceptionDetails': result['exceptionDetails']})
        return result.get('result', {}).get('value')

    def _remove_overlay(self, token, context=None):
        try:
            if context is None:
                frame = self._call('Page.getFrameTree', timeout=5)['frameTree']['frame']['id']
                context = self._call('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'browser-use-annotate-' + token}, timeout=5)['executionContextId']
            left = self._evaluate(context, _REMOVE % json.dumps(token), timeout=5)
            if left: raise BrowserUseError(f'覆盖层仍有 {left} 个节点', 1)
            self._overlays.pop(token, None)
            return None
        except BrowserUseError as exc:
            if 'Cannot find context' in str(exc) or gone(exc):
                self._overlays.pop(token, None)
                return {'overlay': token, 'note': '执行上下文已销毁（页面导航或关闭），覆盖层随旧文档消失；未能直接核对'}
            entry = {'action': 'annotate_remove', 'overlay': token, 'error': str(exc), 'outcome': exc.outcome}
            self.close_errors.append(entry)
            return entry

    def close(self):
        if self._closed: return
        self._closed = True
        for token in list(self._overlays):
            self._remove_overlay(token)
        self._baselines.clear()



_OVERLAY = r"""((token,items,full)=>{
 const doc=document,host=doc.createElement('browser-use-annotate');
 host.setAttribute('data-browser-use-annotate',token);
 host.style.cssText='all:initial;display:block;position:'+(full?'absolute':'fixed')+';left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;';
 const root=host.attachShadow({mode:'closed'}),sx=full?scrollX:0,sy=full?scrollY:0;
 for(const it of items){
  const box=doc.createElement('div'),tag=doc.createElement('span');
  box.style.cssText=`position:absolute;left:${it.x+sx}px;top:${it.y+sy}px;width:${it.width}px;height:${it.height}px;border:2px solid ${it.c};box-sizing:border-box;pointer-events:none;`;
  tag.textContent=String(it.idx);
  tag.style.cssText=`position:absolute;left:-2px;top:${it.y>=16?'-16px':'0'};background:${it.c};color:#fff;font:bold 11px/14px monospace;padding:0 3px;white-space:nowrap;`;
  box.appendChild(tag);root.appendChild(box);
 }
 (doc.documentElement||doc).appendChild(host);
 return new Promise(resolve=>{let done=false;const finish=()=>{if(!done){done=true;resolve({w:innerWidth,h:innerHeight})}};requestAnimationFrame(()=>requestAnimationFrame(finish));setTimeout(finish,150)});
})(%s,%s,%s)"""

_REMOVE = r"""(token=>{const sel='[data-browser-use-annotate="'+token+'"]';document.querySelectorAll(sel).forEach(e=>e.remove());return document.querySelectorAll(sel).length})(%s)"""
