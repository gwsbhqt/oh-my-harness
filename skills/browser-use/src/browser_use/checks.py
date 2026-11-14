"""各服务共用的参数校验与目标消失判断；校验失败一律报参数错（码 2）。"""
from __future__ import annotations
import math
from urllib.parse import urlsplit
from .errors import BrowserUseError

# 页面、iframe 或它们的调试会话已经不在时，CDP 返回的错误文字。
GONE = (
    'Session with given id not found', 'No session with given id', 'Target closed',
    'No target with given id', 'Inspected target navigated or closed',
)
# 页面导航后旧执行上下文或远程对象失效时的错误文字；会话本身可能还在，所以不并进 GONE。
STALE = ('Cannot find context', 'Could not find object', 'Cannot find object')


def gone(exc):
    """错误表明页面、iframe 或调试会话已不在时返回 True。"""
    return any(marker in str(exc) for marker in GONE)


def stale(exc):
    """错误表明旧执行上下文或远程对象已失效时返回 True。"""
    return any(marker in str(exc) for marker in STALE)


def _finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _show(value):
    return int(value) if isinstance(value, float) and value.is_integer() else value


def boolean(value, name):
    """要求布尔值，原样返回。"""
    if not isinstance(value, bool):
        raise BrowserUseError(f'{name} 需要布尔值', 2)
    return value


def integer(value, name, low, high=None):
    """要求 low~high 的整数（不接受布尔和浮点），原样返回；high 为 None 时不设上限。"""
    if isinstance(value, bool) or not isinstance(value, int) or value < low or (high is not None and value > high):
        bound = f' {low}~{high} ' if high is not None else f'不小于 {low} '
        raise BrowserUseError(f'{name} 需要{bound}的整数', 2)
    return value


def choice(value, name, options):
    """要求取值是 options 之一，原样返回。"""
    if isinstance(value, (list, dict)) or value not in options:
        raise BrowserUseError(f'{name} 只能是 ' + '/'.join(options), 2)
    return value


def number(value, name, low, high=None, *, low_open=False):
    """要求不小于 low（low_open=True 时大于 low）、不大于 high 的有限数，原样返回（整数仍是整数）。"""
    if not _finite(value) or value < low or (low_open and value == low) or (high is not None and value > high):
        if high is None:
            bound = ('大于 ' if low_open else '不小于 ') + str(_show(low))
        elif low_open:
            bound = f'大于 {_show(low)}、不超过 {_show(high)}'
        else:
            bound = f' {_show(low)}~{_show(high)}'
        raise BrowserUseError(f'{name} 需要{bound} 的有限数', 2)
    return value


def positive(value, name, *, integer=False, zero=False):
    """要求有限正数（zero=True 时允许 0）；integer=True 时还要求整数值并返回 int，否则返回 float。"""
    if not _finite(value) or value < (0 if zero else 1e-12) or (integer and int(value) != value):
        kind = ('非负' if zero else '正') + ('整数' if integer else '数')
        raise BrowserUseError(f'{name} 需要有限的{kind}', 2)
    return int(value) if integer else float(value)


def seconds(value, name='timeout', high=None):
    """按 positive 的规则要求正秒数，给了 high 时不能超过它；返回 float。"""
    value = positive(value, name)
    if high is not None and value > high:
        raise BrowserUseError(f'{name} 上限 {high:g} 秒', 2)
    return value


def string(value, name, *, empty=False, limit=None):
    """要求字符串，默认不能为空，给了 limit 时限制长度；原样返回。"""
    if not isinstance(value, str) or (not empty and not value) or (limit is not None and len(value) > limit):
        kind = '字符串' if empty else '非空字符串'
        raise BrowserUseError(f'{name} 需要{kind}' + (f'（最长 {limit}）' if limit is not None else ''), 2)
    return value


def url_origin(url):
    """取 http/https 网址的规范化来源 scheme://host[:port]；不是这类网址时返回 None。"""
    try:
        parts = urlsplit(url)
        port = parts.port
    except (ValueError, TypeError):
        return None
    host = (parts.hostname or '').lower()
    if parts.scheme not in ('http', 'https') or not host:
        return None
    if ':' in host:
        host = f'[{host}]'
    if port is None or (parts.scheme, port) in (('http', 80), ('https', 443)):
        return f'{parts.scheme}://{host}'
    return f'{parts.scheme}://{host}:{port}'


def origin(value, *, limit=None, fetch_pattern=False):
    """校验 http(s)://主机[:端口] 形式的来源，返回规范化来源。

    fetch_pattern=True 时来源会拼进浏览器的网址匹配规则，额外拒绝通配符、反斜杠、空白和空字符。
    """
    string(value, 'origin', limit=limit)
    if fetch_pattern and any(c in value for c in '*?\\ \r\n\x00'):
        raise BrowserUseError('origin 不能含通配符、反斜杠、空白或空字符', 2)
    try:
        parts = urlsplit(value)
        parts.port
    except ValueError as exc:
        raise BrowserUseError('origin 的主机或端口无效', 2) from exc
    if parts.path not in ('', '/') or parts.query or parts.fragment or parts.username or parts.password:
        raise BrowserUseError('origin 只能是 http(s)://主机[:端口]，不能带路径、查询或账号', 2)
    normalized = url_origin(value)
    if normalized is None:
        raise BrowserUseError('origin 需要 http/https 来源', 2)
    return normalized
