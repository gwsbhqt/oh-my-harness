"""Cookie、网页存储与登录状态文件；值默认脱敏，共享浏览器 写入需授权并在释放时撤销。"""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit
from .checks import boolean, integer, origin as checked_origin, string, url_origin
from .errors import BrowserControlError

_AUTH = {'authorized'}
_STORE = {'kind', 'origin', 'frame'}
_PARAMS = {
    'cookies_get': {'urls', 'raw'} | _AUTH,
    'cookies_set': {'name', 'value', 'url', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'partitionKey'} | _AUTH,
    'cookies_delete': {'name', 'url', 'domain', 'path', 'partitionKey'} | _AUTH,
    'cookies_clear': _AUTH,
    'storage_get': _STORE | {'limit'},
    'storage_set': _STORE | {'key', 'value'} | _AUTH,
    'storage_remove': _STORE | {'key'} | _AUTH,
    'storage_clear': _STORE | _AUTH,
    'state_save': {'path', 'origins', 'session_storage'} | _AUTH,
    'state_load': {'path', 'origins', 'cookies', 'storage'},
    'state_show': {'path'},
}
_COOKIE_OUT = ('name', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey', 'partitionKeyOpaque')
_COOKIE_FILE = {'name', 'value', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey', 'partitionKeyOpaque'}
_CONTROL = re.compile(r'[\x00-\x1f\x7f]')
_HOST = re.compile(r'^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$|^\[[0-9A-Fa-f:.]+\]$')
_MAX_STATE_BYTES = 32 * 1024 * 1024


def _mask(value):
    """保留长度；8 字符以上才露出前后各 2 字符，短值全部打码。"""
    n = len(value)
    return value[:2] + '*' * (n - 4) + value[-2:] if n >= 8 else '*' * n


def _http_url(value, name='url'):
    string(value, name, limit=8192)
    parts = urlsplit(value)
    if parts.scheme not in ('http', 'https') or not parts.hostname or _CONTROL.search(value):
        raise BrowserControlError(f'{name} 需要 http/https 绝对网址', 2)
    return value


def _cookie_name(value):
    string(value, 'name', limit=4096)
    if _CONTROL.search(value) or any(c in value for c in ';= \t'):
        raise BrowserControlError('cookie name 不能含控制字符、分号、等号或空白', 2)
    return value


def _cookie_value(value):
    string(value, 'value', empty=True, limit=4096)
    if _CONTROL.search(value) or ';' in value:
        raise BrowserControlError('cookie value 不能含控制字符或分号', 2)
    return value


def _domain(value):
    string(value, 'domain', limit=255)
    if not _HOST.match(value):
        raise BrowserControlError('domain 需要主机名，可带前导点，不能带端口、路径或通配', 2)
    return value.lower()


def _path(value):
    string(value, 'path', limit=4096)
    if not value.startswith('/') or _CONTROL.search(value) or ';' in value:
        raise BrowserControlError('path 需要以 / 开头且不含控制字符或分号', 2)
    return value


def _partition(value):
    if not isinstance(value, dict) or set(value) != {'topLevelSite', 'hasCrossSiteAncestor'}:
        raise BrowserControlError('partitionKey 需要 {topLevelSite, hasCrossSiteAncestor}', 2)
    site = string(value['topLevelSite'], 'partitionKey.topLevelSite', limit=2048)
    if url_origin(site) is None:
        raise BrowserControlError('partitionKey.topLevelSite 需要 http/https 站点', 2)
    if not isinstance(value['hasCrossSiteAncestor'], bool):
        raise BrowserControlError('partitionKey.hasCrossSiteAncestor 需要布尔值', 2)
    return {'topLevelSite': site, 'hasCrossSiteAncestor': value['hasCrossSiteAncestor']}


def _expires(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise BrowserControlError('expires 需要正的 Unix 秒数', 2)
    return float(value)


def _domain_matches(cookie_domain, host):
    domain = cookie_domain.lower()
    if domain.startswith('.'):
        return host == domain[1:] or host.endswith(domain)
    return host == domain


def _host_of(origin):
    host = urlsplit(origin).hostname or ''
    return host.lower()


def _cookie_param(cookie):
    """把读回的 cookie 还原为 CookieParam；host-only 用 url 写回，避免变成整域 cookie。"""
    param = {'name': cookie['name'], 'value': cookie['value'], 'path': cookie.get('path', '/')}
    domain = cookie['domain']
    if domain.startswith('.'):
        param['domain'] = domain
    else:
        host = domain if ':' not in domain or domain.startswith('[') else '[' + domain + ']'
        param['url'] = ('https' if cookie.get('secure') else 'http') + '://' + host + param['path']
    for key in ('secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'):
        if cookie.get(key) is not None:
            param[key] = cookie[key]
    if not cookie.get('session') and isinstance(cookie.get('expires'), (int, float)) and cookie['expires'] > 0:
        param['expires'] = cookie['expires']
    return param


def _identity(cookie):
    return (cookie['name'], cookie['domain'].lower(), cookie.get('path', '/'), json.dumps(cookie.get('partitionKey'), sort_keys=True))


def _private_parent(path):
    parent = path.parent
    try:
        info = os.lstat(parent)
    except FileNotFoundError:
        try:
            os.lstat(parent.parent)
        except FileNotFoundError as exc:
            raise BrowserControlError('状态文件的上级目录不存在；只自动创建最后一级 700 目录', 3) from exc
        os.mkdir(parent, 0o700)
        os.chmod(parent, 0o700)
        info = os.lstat(parent)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise BrowserControlError('状态文件目录必须是本用户拥有、权限 700 的真实目录', 6, data={'directory': str(parent)})


def _checked_state_file(value):
    path = Path(string(value, 'path', limit=4096)).expanduser().absolute()
    try:
        info = os.lstat(path)
    except FileNotFoundError as exc:
        raise BrowserControlError('状态文件不存在', 3, data={'path': str(path)}) from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise BrowserControlError('状态文件必须是本用户拥有、权限 600 的普通文件（不跟随链接）', 6, data={'path': str(path)})
    if info.st_size > _MAX_STATE_BYTES:
        raise BrowserControlError('状态文件超过 32MiB 上限', 2)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as file:
        opened = os.fstat(file.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise BrowserControlError('状态文件在校验后被替换', 6)
        raw = file.read(_MAX_STATE_BYTES + 1)
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BrowserControlError('状态文件不是有效 JSON', 2) from exc
    return path, _validate_state(data)


def _validate_state(data):
    if not isinstance(data, dict) or set(data) - {'format', 'version', 'savedAt', 'source', 'cookies', 'origins'}:
        raise BrowserControlError('状态文件字段不合法', 2)
    if data.get('format') != 'browser-control-state' or data.get('version') != 1:
        raise BrowserControlError('不是 browser-control-state v1 状态文件', 2)
    cookies, origins = data.get('cookies'), data.get('origins')
    if not isinstance(cookies, list) or len(cookies) > 10000 or not isinstance(origins, list) or len(origins) > 100:
        raise BrowserControlError('状态文件 cookies/origins 结构不合法', 2)
    for cookie in cookies:
        if not isinstance(cookie, dict) or set(cookie) - _COOKIE_FILE or not {'name', 'value', 'domain'} <= set(cookie):
            raise BrowserControlError('状态文件中的 cookie 字段不合法', 2)
        _cookie_name(cookie['name']); _cookie_value(cookie['value']); _domain(cookie['domain'])
        _path(cookie.get('path', '/'))
        for key in ('secure', 'httpOnly', 'session'):
            if key in cookie and not isinstance(cookie[key], bool):
                raise BrowserControlError(f'cookie {key} 需要布尔值', 2)
        if cookie.get('sameSite') not in (None, 'Strict', 'Lax', 'None'):
            raise BrowserControlError('cookie sameSite 不合法', 2)
        if 'expires' in cookie and (isinstance(cookie['expires'], bool) or not isinstance(cookie['expires'], (int, float)) or not math.isfinite(cookie['expires'])):
            raise BrowserControlError('cookie expires 需要数字', 2)
        if cookie.get('partitionKey') is not None:
            _partition(cookie['partitionKey'])
    seen = set()
    for item in origins:
        if not isinstance(item, dict) or set(item) - {'origin', 'storageKey', 'localStorage', 'sessionStorage'} or 'origin' not in item:
            raise BrowserControlError('状态文件中的 origin 字段不合法', 2)
        origin = checked_origin(item['origin'], limit=2048)
        if 'storageKey' in item:
            string(item['storageKey'], 'storageKey', limit=4096)
        if origin != item['origin'] or origin in seen:
            raise BrowserControlError('状态文件 origin 未规范化或重复', 2)
        seen.add(origin)
        for kind in ('localStorage', 'sessionStorage'):
            values = item.get(kind, {})
            if not isinstance(values, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in values.items()):
                raise BrowserControlError(f'{kind} 需要字符串键值对象', 2)
    return data


def _summary(data):
    domains = {}
    for cookie in data['cookies']:
        domains[cookie['domain']] = domains.get(cookie['domain'], 0) + 1
    return {'savedAt': data.get('savedAt'), 'cookies': len(data['cookies']),
            'domains': [{'domain': d, 'cookies': n} for d, n in sorted(domains.items())],
            'origins': [{'origin': o['origin'], 'localStorageKeys': len(o.get('localStorage', {})),
                         **({'sessionStorageKeys': len(o['sessionStorage'])} if 'sessionStorage' in o else {})} for o in data['origins']]}


def _action(action):
    """父层按 state_ 前缀路由；完整名、去前缀名（cookies_get、save）都接受。"""
    if not isinstance(action, str):
        return action
    if action in _PARAMS:
        return action
    if action.startswith('state_') and action[6:] in _PARAMS:
        return action[6:]
    if 'state_' + action in _PARAMS:
        return 'state_' + action
    return action


class StateService:
    def __init__(self, driver):
        self.driver = driver
        self.cdp = driver.cdp
        self.close_errors = []
        self._journal = []
        self._closed = False

    @property
    def _shared(self):
        return getattr(self.driver, 'browser_owned', False) is not True

    @property
    def _context(self):
        return getattr(self.driver, 'browser_context_id', None)

    def dispatch(self, action, params=None):
        if self._closed:
            raise BrowserControlError('状态服务已释放', 4)
        p = {} if params is None else params
        action = _action(action)
        if action not in _PARAMS:
            raise BrowserControlError(f'不支持状态动作：{action}', 2)
        if not isinstance(p, dict):
            raise BrowserControlError('params 需要对象', 2)
        unknown = set(p) - _PARAMS[action]
        if unknown:
            raise BrowserControlError(f'{action} 不支持参数：' + ', '.join(sorted(unknown)), 2)
        if 'authorized' in p:
            boolean(p.get('authorized'), 'authorized')
        plan = getattr(self, '_check_' + action)(p)
        if action == 'state_show':
            return self._state_show(plan)
        with self.driver._lock:
            try:
                return getattr(self, '_' + action)(plan)
            except OSError as exc:
                raise BrowserControlError(f'状态文件无法读写：{exc}', 5) from exc

    def _authorize_write(self, p, what):
        if self._shared and p.get('authorized') is not True:
            raise BrowserControlError(f'{what}会改动共享浏览器 的真实登录状态；需要 authorized=True', 6)

    def _page_call(self, method, params=None, *, sid=None, timeout=20):
        return self.driver._call(sid or self.driver.session_id, method, params or {}, timeout)

    def _browser_call(self, method, params=None, timeout=20):
        return self.cdp.call(method, params or {}, timeout=timeout)

    # ---- 参数校验：不发任何 CDP 命令 ----
    def _check_cookies_get(self, p):
        raw = boolean(p.get('raw', False), 'raw')
        urls = p.get('urls')
        if urls is not None:
            if not isinstance(urls, list) or not 1 <= len(urls) <= 100:
                raise BrowserControlError('urls 需要 1~100 个网址的列表', 2)
            urls = [_http_url(u) for u in urls]
        if raw and self._shared and p.get('authorized') is not True:
            raise BrowserControlError('共享浏览器 返回 cookie 原值含登录凭据；需要 authorized=True', 6)
        return {'urls': urls, 'raw': raw}

    def _check_cookies_set(self, p):
        cookie = {'name': _cookie_name(p.get('name')), 'value': _cookie_value(p.get('value'))}
        if ('url' in p) == ('domain' in p):
            raise BrowserControlError('cookies_set 需要且只需要 url 或 domain', 2)
        if 'url' in p:
            cookie['url'] = _http_url(p['url'])
        else:
            cookie['domain'] = _domain(p['domain'])
        if 'path' in p:
            cookie['path'] = _path(p['path'])
        for key in ('secure', 'httpOnly'):
            if key in p:
                cookie[key] = boolean(p.get(key), key)
        if 'sameSite' in p:
            if p['sameSite'] not in ('Strict', 'Lax', 'None'):
                raise BrowserControlError('sameSite 只能是 Strict/Lax/None', 2)
            if p['sameSite'] == 'None' and cookie.get('secure') is not True:
                raise BrowserControlError('sameSite=None 需要 secure=True', 2)
            cookie['sameSite'] = p['sameSite']
        if 'expires' in p:
            cookie['expires'] = _expires(p['expires'])
        if 'partitionKey' in p:
            cookie['partitionKey'] = _partition(p['partitionKey'])
            if cookie.get('secure') is not True:
                raise BrowserControlError('分区 cookie 需要 secure=True', 2)
        self._authorize_write(p, '写 cookie ')
        return cookie

    def _check_cookies_delete(self, p):
        args = {'name': _cookie_name(p.get('name'))}
        if ('url' in p) == ('domain' in p):
            raise BrowserControlError('cookies_delete 需要且只需要 url 或 domain', 2)
        if 'url' in p:
            args['url'] = _http_url(p['url'])
        else:
            args['domain'] = _domain(p['domain'])
        if 'path' in p:
            args['path'] = _path(p['path'])
        if 'partitionKey' in p:
            args['partitionKey'] = _partition(p['partitionKey'])
        self._authorize_write(p, '删除 cookie ')
        return args

    def _check_cookies_clear(self, p):
        self._authorize_write(p, '清空 cookie ')
        if not self._shared and not self._context:
            raise BrowserControlError('私有 Chrome 缺少 browserContextId，拒绝清空默认 context', 5)
        return {}

    def _check_store(self, p):
        kind = p.get('kind', 'local')
        if kind not in ('local', 'session'):
            raise BrowserControlError('kind 只能是 local/session', 2)
        plan = {'kind': kind, 'origin': checked_origin(p['origin'], limit=2048) if 'origin' in p else None}
        if 'frame' in p:
            plan['frame'] = string(p['frame'], 'frame', limit=128)
        return plan

    def _check_storage_get(self, p):
        plan = self._check_store(p)
        plan['limit'] = integer(p.get('limit', 1000), 'limit', 1, 10000)
        return plan

    def _check_storage_set(self, p):
        plan = self._check_store(p)
        plan['key'] = string(p.get('key'), 'key', limit=65536)
        plan['value'] = string(p.get('value'), 'value', empty=True, limit=10 * 1024 * 1024)
        self._authorize_write(p, '写网页存储')
        return plan

    def _check_storage_remove(self, p):
        plan = self._check_store(p)
        plan['key'] = string(p.get('key'), 'key', limit=65536)
        self._authorize_write(p, '删除网页存储')
        return plan

    def _check_storage_clear(self, p):
        plan = self._check_store(p)
        self._authorize_write(p, '清空网页存储')
        return plan

    def _check_origins(self, value):
        if value is None:
            return None
        if not isinstance(value, list) or not 1 <= len(value) <= 20:
            raise BrowserControlError('origins 需要 1~20 个来源的列表', 2)
        origins = [checked_origin(o, limit=2048) for o in value]
        if len(set(origins)) != len(origins):
            raise BrowserControlError('origins 有重复', 2)
        return origins

    def _check_state_save(self, p):
        path = Path(string(p.get('path'), 'path', limit=4096)).expanduser().absolute()
        plan = {'path': path, 'origins': self._check_origins(p.get('origins')), 'session_storage': boolean(p.get('session_storage', False), 'session_storage')}
        if self._shared and p.get('authorized') is not True:
            raise BrowserControlError('从共享浏览器 导出含登录凭据；需要 authorized=True', 6)
        if os.path.lexists(path):
            raise BrowserControlError('状态文件已存在；不覆盖', 6, data={'path': str(path)})
        return plan

    def _check_state_load(self, p):
        if self._shared or not self._context:
            raise BrowserControlError('登录状态只能载入 browser-control 自启的私有 Chrome（独立 browser context）', 6)
        plan = {'cookies': boolean(p.get('cookies', True), 'cookies'), 'storage': boolean(p.get('storage', True), 'storage'), 'origins': self._check_origins(p.get('origins'))}
        if not plan['cookies'] and not plan['storage']:
            raise BrowserControlError('cookies 与 storage 不能都为 False', 2)
        plan['path'], plan['data'] = _checked_state_file(p.get('path'))
        if plan['origins'] is not None:
            missing = set(plan['origins']) - {o['origin'] for o in plan['data']['origins']}
            if missing:
                raise BrowserControlError('状态文件中没有这些 origin：' + ', '.join(sorted(missing)), 3)
        return plan

    def _check_state_show(self, p):
        return {'file': _checked_state_file(p.get('path'))}

    # ---- cookie ----
    def _public_cookie(self, cookie, raw):
        out = {k: cookie[k] for k in _COOKIE_OUT if k in cookie}
        value = cookie.get('value', '')
        out['valueLength'] = len(value)
        if raw:
            out['value'] = value
        else:
            out['value'] = _mask(value)
            out['valueMasked'] = True
        return out

    def _cookies_get(self, plan):
        self.driver.check()
        cookies = self._page_call('Network.getCookies', {'urls': plan['urls']} if plan['urls'] else {})['cookies']
        return {'ok': True, 'cookies': [self._public_cookie(c, plan['raw']) for c in cookies], 'count': len(cookies),
                'raw': plan['raw'], 'scope': 'urls' if plan['urls'] else 'current page and its frames'}

    def _jar(self):
        params = {'browserContextId': self._context} if self._context else {}
        return self._browser_call('Storage.getCookies', params)['cookies']

    def _journal_cookies(self, name, before, operation):
        """共享浏览器：按同名 cookie 前后快照记录撤销项；结果未知时只记待核对，不猜。"""
        entry = {'type': 'cookie', 'name': name, 'operation': operation, 'before': {_identity(c): c for c in before if c['name'] == name}, 'after': None}
        self._journal.append(entry)
        return entry

    def _cookie_write(self, method, args, operation):
        self.driver.check()
        entry = self._journal_cookies(args['name'], self._jar(), operation) if self._shared else None
        try:
            result = self._page_call(method, args)
        except BrowserControlError as exc:
            if entry is not None and exc.outcome != 'unknown':
                self._journal.remove(entry)
            raise
        if result.get('success') is False:
            if entry is not None:
                self._journal.remove(entry)
            raise BrowserControlError('浏览器拒绝该 cookie', 1)
        if entry is not None:
            entry['after'] = {_identity(c): c for c in self._jar() if c['name'] == args['name']}
            changed = [k for k in set(entry['before']) | set(entry['after']) if entry['before'].get(k) != entry['after'].get(k)]
            if not changed:
                self._journal.remove(entry)
            else:
                entry['changed'] = changed
        return self._cookie_scope()

    def _cookie_scope(self):
        if self._context:
            return {'scope': 'browserContext', 'browserContextId': self._context, 'revertOnRelease': False}
        return {'scope': 'shared default browser context', 'revertOnRelease': True}

    def _cookies_set(self, cookie):
        scope = self._cookie_write('Network.setCookie', cookie, 'set')
        target = {k: cookie[k] for k in ('name', 'url', 'domain', 'path') if k in cookie}
        return {'ok': True, 'cookie': target, **scope}

    def _cookies_delete(self, args):
        scope = self._cookie_write('Network.deleteCookies', args, 'delete')
        return {'ok': True, 'deleted': {k: args[k] for k in ('name', 'url', 'domain', 'path') if k in args}, **scope}

    def _cookies_clear(self, plan):
        self.driver.check()
        if self._context:
            self._browser_call('Storage.clearCookies', {'browserContextId': self._context})
            return {'ok': True, 'scope': 'browserContext', 'browserContextId': self._context, 'reversible': False}
        self._browser_call('Storage.clearCookies')
        return {'ok': True, 'scope': 'shared default browser context: all sites', 'reversible': False,
                'warning': '已清除共享浏览器 默认 context 中所有站点的 cookie，释放时无法恢复'}

    # ---- 网页存储 ----
    def _frame_origins(self):
        found = {}
        for fid, frame in self.driver._frames_cache.items():
            origin = url_origin(frame.get('url', ''))
            if origin:
                found.setdefault(origin, []).append((fid, frame))
        for frames in found.values():
            frames.sort(key=lambda item: item[1].get('parent') is not None)
        return found

    def _storage_key(self, fid, frame):
        try:
            return self._page_call('Storage.getStorageKey', {'frameId': fid}, sid=frame['session'])['storageKey']
        except BrowserControlError as exc:
            if "'Storage.getStorageKey' wasn't found" not in str(exc):
                raise
            return self._page_call('Storage.getStorageKeyForFrame', {'frameId': fid}, sid=frame['session'])['storageKey']

    def _store_target(self, plan, *, origin=None):
        """只在当前页面 frame 中存在的来源上操作；DOMStorage 也只能找到这些 frame 的存储。"""
        frames = self.driver._frames_cache
        origins = self._frame_origins()
        origin = origin or plan.get('origin')
        if plan.get('frame') is not None:
            frame = frames.get(plan['frame'])
            if frame is None:
                raise BrowserControlError('frame 不属于当前页面', 3)
            frame_origin = url_origin(frame.get('url', ''))
            if frame_origin is None:
                raise BrowserControlError('该 frame 没有 http/https 来源，不能使用网页存储', 5)
            if origin is not None and origin != frame_origin:
                raise BrowserControlError('origin 与 frame 的来源不一致', 2)
            fid, origin = plan['frame'], frame_origin
        else:
            if origin is None:
                main = next(((f, v) for f, v in frames.items() if not v.get('parent') and v['session'] == self.driver.session_id), None)
                origin = url_origin(main[1].get('url', '')) if main else None
                if origin is None:
                    raise BrowserControlError('当前页面没有 http/https 来源；请先导航或明确 origin', 5)
            if origin not in origins:
                raise BrowserControlError('只允许操作当前页面 frame 中存在的来源，不能读写其他站点数据', 6, data={'origin': origin, 'available': sorted(origins)})
            fid, frame = origins[origin][0]
        frame = frames[fid]
        key = self._storage_key(fid, frame)
        return {'origin': origin, 'frameId': fid, 'session': frame['session'], 'storageKey': key,
                'storageId': {'storageKey': key, 'isLocalStorage': plan['kind'] == 'local'}, 'kind': plan['kind']}

    def _items(self, target):
        return dict(self._page_call('DOMStorage.getDOMStorageItems', {'storageId': target['storageId']}, sid=target['session'])['entries'])

    @staticmethod
    def _where(target):
        return {k: target[k] for k in ('origin', 'frameId', 'storageKey', 'kind')}

    def _storage_get(self, plan):
        self.driver.check()
        target = self._store_target(plan)
        items = list(self._items(target).items())
        return {'ok': True, **self._where(target), 'items': dict(items[:plan['limit']]), 'count': len(items), 'truncated': len(items) > plan['limit']}

    def _storage_write(self, target, keys, method, args, after):
        """共享浏览器 先记撤销项再写；明确失败删记录，结果未知保留待核对。"""
        entry = None
        if self._shared:
            before = self._items(target)
            entry = {'type': 'storage', **self._where(target), 'before': {k: before.get(k) for k in keys}, 'after': None}
            self._journal.append(entry)
        try:
            self._page_call(method, dict(args, storageId=target['storageId']), sid=target['session'])
        except BrowserControlError as exc:
            if entry is not None and exc.outcome != 'unknown':
                self._journal.remove(entry)
            raise
        if entry is not None:
            entry['after'] = after
        return entry is not None

    def _storage_set(self, plan):
        self.driver.check()
        target = self._store_target(plan)
        revert = self._storage_write(target, [plan['key']], 'DOMStorage.setDOMStorageItem', {'key': plan['key'], 'value': plan['value']}, {plan['key']: plan['value']})
        return {'ok': True, **self._where(target), 'key': plan['key'], 'revertOnRelease': revert}

    def _storage_remove(self, plan):
        self.driver.check()
        target = self._store_target(plan)
        revert = self._storage_write(target, [plan['key']], 'DOMStorage.removeDOMStorageItem', {'key': plan['key']}, {plan['key']: None})
        return {'ok': True, **self._where(target), 'key': plan['key'], 'revertOnRelease': revert}

    def _storage_clear(self, plan):
        self.driver.check()
        target = self._store_target(plan)
        keys = list(self._items(target))
        revert = self._storage_write(target, keys, 'DOMStorage.clear', {}, {k: None for k in keys})
        return {'ok': True, **self._where(target), 'removedKeys': len(keys), 'revertOnRelease': revert}

    # ---- 状态文件 ----
    def _state_save(self, plan):
        self.driver.check()
        available = self._frame_origins()
        origins = plan['origins']
        if origins is None:
            main = next((v for v in self.driver._frames_cache.values() if not v.get('parent') and v['session'] == self.driver.session_id), None)
            origin = url_origin(main.get('url', '')) if main else None
            if origin is None:
                raise BrowserControlError('当前页面没有 http/https 来源；请明确 origins', 5)
            origins = [origin]
        missing = [o for o in origins if o not in available]
        if missing:
            raise BrowserControlError('只能导出当前页面 frame 中存在的来源', 6, data={'missing': missing, 'available': sorted(available)})
        _private_parent(plan['path'])
        hosts = [_host_of(o) for o in origins]
        cookies = [{k: c[k] for k in _COOKIE_FILE if k in c} for c in self._jar() if any(_domain_matches(c['domain'], h) for h in hosts)]
        entries = []
        for origin in origins:
            target = self._store_target({'kind': 'local'}, origin=origin)
            item = {'origin': origin, 'storageKey': target['storageKey'], 'localStorage': self._items(target)}
            if plan['session_storage']:
                item['sessionStorage'] = self._items(self._store_target({'kind': 'session'}, origin=origin))
            entries.append(item)
        data = {'format': 'browser-control-state', 'version': 1, 'savedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'source': {'browserOwned': not self._shared}, 'cookies': cookies, 'origins': entries}
        raw = json.dumps(data, ensure_ascii=False, indent=1).encode('utf-8')
        path = plan['path']
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'wb') as file:
                os.fchmod(file.fileno(), 0o600)
                file.write(raw)
                file.flush()
                os.fsync(file.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return {'ok': True, 'artifact': {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                'kind': 'browser-control-state', 'containsSecrets': True, 'complete': True}, 'summary': _summary(data)}

    def _state_show(self, plan):
        path, data = plan['file']
        return {'ok': True, 'path': str(path), **_summary(data)}

    def _state_load(self, plan):
        self.driver.check()
        data = plan['data']
        result = {'ok': True, 'path': str(plan['path']), 'scope': 'browserContext', 'browserContextId': self._context,
                  'cookies': None, 'storage': {'loaded': [], 'pending': []}}
        if plan['cookies']:
            now = time.time()
            live = [c for c in data['cookies'] if c.get('session') or not isinstance(c.get('expires'), (int, float)) or c['expires'] <= 0 or c['expires'] > now]
            params = [_cookie_param(c) for c in live]
            stats = {'inFile': len(data['cookies']), 'skippedExpired': len(data['cookies']) - len(live), 'sent': len(params), 'verified': 0}
            result['cookies'] = stats
            if params:
                try:
                    self._browser_call('Storage.setCookies', {'cookies': params, 'browserContextId': self._context})
                except BrowserControlError as exc:
                    raise BrowserControlError('载入 cookie 失败或结果未知；未重发', exc.code, outcome=exc.outcome, data={'cookies': stats}) from exc
                jar = {_identity(c): c.get('value') for c in self._jar()}
                stats['verified'] = sum(1 for c in live if jar.get(_identity(c)) == c['value'])
        if plan['storage']:
            available = self._frame_origins()
            wanted = plan['origins'] or [o['origin'] for o in data['origins']]
            for item in data['origins']:
                if item['origin'] not in wanted:
                    continue
                if item['origin'] not in available:
                    result['storage']['pending'].append({'origin': item['origin'], 'reason': '当前页面没有该来源的 frame；先导航到该来源再用 cookies=False 载入存储'})
                    continue
                probe = self._store_target({'kind': 'local'}, origin=item['origin'])
                # 跨站 iframe 的存储按顶层站点分区；分区不同就不是同一份存储，不写入。
                if item.get('storageKey') not in (None, probe['storageKey']):
                    result['storage']['pending'].append({'origin': item['origin'], 'reason': '当前页面中该来源的存储分区与保存时不同', 'saved': item['storageKey'], 'current': probe['storageKey']})
                    continue
                loaded = {'origin': item['origin'], 'verified': True}
                for kind, field in (('local', 'localStorage'), ('session', 'sessionStorage')):
                    if field not in item:
                        continue
                    target = self._store_target({'kind': kind}, origin=item['origin'])
                    try:
                        for key, value in item[field].items():
                            self._page_call('DOMStorage.setDOMStorageItem', {'storageId': target['storageId'], 'key': key, 'value': value}, sid=target['session'])
                    except BrowserControlError as exc:
                        raise BrowserControlError('载入网页存储失败或结果未知；未重发', exc.code, outcome=exc.outcome, data=result) from exc
                    current = self._items(target)
                    loaded[field] = len(item[field])
                    loaded['storageKey'] = target['storageKey']
                    if any(current.get(k) != v for k, v in item[field].items()):
                        loaded['verified'] = False
                result['storage']['loaded'].append(loaded)
        result['next'] = '页面需要重新加载才会按新 cookie/存储运行；本动作不自动导航'
        return result

    # ---- 撤销 ----
    def _undo_cookie(self, entry):
        if entry['after'] is None:
            return {'type': 'cookie', 'name': entry['name'], 'error': '写入结果未知；未自动撤销，请人工核对'}
        current = {_identity(c): c for c in self._jar() if c['name'] == entry['name']}
        for key in entry['changed']:
            if current.get(key) != entry['after'].get(key):
                return {'type': 'cookie', 'name': entry['name'], 'error': '释放前 cookie 已被别处修改；不覆盖'}
        for key in entry['changed']:
            before = entry['before'].get(key)
            if before is None:
                name, domain, path, partition = key
                args = {'name': name, 'domain': domain, 'path': path}
                if partition != 'null':
                    args['partitionKey'] = json.loads(partition)
                self._page_call('Network.deleteCookies', args, timeout=5)
            else:
                self._page_call('Network.setCookie', _cookie_param(before), timeout=5)
        return None

    def _undo_storage(self, entry):
        if entry['after'] is None:
            return {'type': 'storage', 'origin': entry['origin'], 'error': '写入结果未知；未自动撤销，请人工核对'}
        frames = self._frame_origins().get(entry['origin'], [])
        target = None
        for fid, frame in frames:
            if self._storage_key(fid, frame) == entry['storageKey']:
                target = {'session': frame['session'], 'storageId': {'storageKey': entry['storageKey'], 'isLocalStorage': entry['kind'] == 'local'}}
                break
        if target is None:
            return {'type': 'storage', 'origin': entry['origin'], 'error': '页面已不含该存储来源；无法撤销网页存储修改'}
        current = self._items(target)
        if any(current.get(k) != v for k, v in entry['after'].items()):
            return {'type': 'storage', 'origin': entry['origin'], 'error': '释放前网页存储已被页面修改；不覆盖'}
        for key, value in entry['before'].items():
            if value is None:
                self._page_call('DOMStorage.removeDOMStorageItem', {'storageId': target['storageId'], 'key': key}, sid=target['session'], timeout=5)
            else:
                self._page_call('DOMStorage.setDOMStorageItem', {'storageId': target['storageId'], 'key': key, 'value': value}, sid=target['session'], timeout=5)
        return None

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.close_errors = []
        if not self._journal:
            return
        with self.driver._lock:
            try:
                self.driver.check()
            except Exception as exc:
                self.close_errors.append({'domain': 'state', 'error': '页面不可用，共享浏览器 上的 cookie/存储修改未撤销：' + str(exc), 'pending': len(self._journal)})
                return
            for entry in reversed(self._journal):
                try:
                    error = self._undo_cookie(entry) if entry['type'] == 'cookie' else self._undo_storage(entry)
                except Exception as exc:
                    error = {'type': entry['type'], 'error': str(exc)}
                if error:
                    self.close_errors.append(dict(error, domain='state'))
        self._journal.clear()
