"""固定页面会话的有界诊断：断点调试、事件订阅与受控原始调用。"""
from __future__ import annotations
from collections import deque
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid
from .checks import boolean, gone, integer, number, string
from .errors import BrowserControlError
from . import scratch

_PARAMS = {
    'call': {'method', 'params', 'timeout', 'session_id', 'authorized', 'scope'},
    'events_start': {'methods', 'limit', 'max_bytes'},
    'events_read': {'id', 'subscriptionId', 'after', 'limit', 'wait_timeout'},
    'events_stop': {'id', 'subscriptionId'},
    'enable': {'session_id'}, 'sources': {'session_id', 'after', 'limit'},
    'source': {'script_id', 'session_id', 'timeout'},
    'breakpoint': {'url', 'url_regex', 'script_id', 'line', 'column', 'condition', 'session_id'},
    'remove': {'id'}, 'pause': {'session_id'}, 'resume': {'session_id'},
    'step': {'kind', 'session_id'}, 'stack': {'session_id'},
    'evaluate_frame': {'call_frame_id', 'expression', 'session_id', 'throw_on_side_effect', 'timeout'},
}


class Diagnostics:
    def __init__(self, driver):
        self.driver, self.cdp = driver, driver.cdp
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._subscriptions = {}
        self._source_records = {}
        self._source_cursor = 0
        self._source_dropped = 0
        self._paused = {}
        self._enabled = set()
        self._breakpoints = {}
        self._closed = False
        self.close_errors = []
        self._artifact_root = None
        self._unsubscribers = []
        for name in ('Debugger.scriptParsed', 'Debugger.scriptFailedToParse', 'Debugger.paused', 'Debugger.resumed'):
            self._unsubscribers.append(self.cdp.on(name, lambda p, s, name=name: self._domain_event(name, p, s)))

    def _sid(self, p):
        sid = p.get('session_id', self.driver.session_id)
        if not isinstance(sid, str) or sid not in self.driver.session_ids:
            raise BrowserControlError('诊断会话不属于绑定页面；不能跨目标', 6)
        return sid

    def _call(self, method, params=None, *, sid=None, timeout=20):
        return self.cdp.call(method, params or {}, session_id=sid or self.driver.session_id, timeout=timeout)

    def dispatch(self, action, params=None):
        if self._closed:
            raise BrowserControlError('诊断绑定已释放', 4)
        if action not in _PARAMS:
            raise BrowserControlError(f'不支持诊断动作：{action}', 2)
        p = {} if params is None else params
        if not isinstance(p, dict) or set(p) - _PARAMS[action]:
            raise BrowserControlError(f'{action} 参数包含未知字段或不是对象', 2)
        self.driver._target_check()  # 暂停中不能运行文档 JS 检查。
        try:
            return self._call_action(p) if action == 'call' else getattr(self, '_' + action)(p)
        except OSError as exc:
            raise BrowserControlError(f'诊断私有产物无法写入：{exc}', 5) from exc

    def _domain_event(self, name, p, sid):
        with self._lock:
            if sid not in self.driver.session_ids:
                return
            if name.startswith('Debugger.script'):
                self._source_cursor += 1
                self._source_records[(sid, p['scriptId'])] = dict(p, sessionId=sid, cursor=self._source_cursor)
                while len(self._source_records) > 2000:
                    del self._source_records[next(iter(self._source_records))]
                    self._source_dropped += 1
            elif name == 'Debugger.paused':
                self._paused[sid] = dict(p)
            elif name == 'Debugger.resumed':
                self._paused.pop(sid, None)

    def _subscription_event(self, sub, name, p, sid):
        if sid not in self.driver.session_ids:
            return
        with self._lock:
            if not sub['active']:
                return
            sub['cursor'] += 1
            size = len(json.dumps(p, ensure_ascii=False).encode('utf-8'))
            event = {'cursor': sub['cursor'], 'method': name, 'params': p, 'sessionId': sid}
            if size > sub['max_bytes']:
                event['params'] = None
                event.update(truncated=True, originalBytes=size)
                size = 128
                sub['truncated'] += 1
            while sub['events'] and (len(sub['events']) >= sub['limit'] or sub['bytes'] + size > sub['max_bytes']):
                _, oldsize = sub['events'].popleft()
                sub['bytes'] -= oldsize
                sub['dropped'] += 1
            sub['events'].append((event, size))
            sub['bytes'] += size
            self._condition.notify_all()

    def _events_start(self, p):
        methods = p.get('methods')
        if not isinstance(methods, list) or not methods or len(methods) > 64 or any(not isinstance(m, str) or not re.fullmatch(r'[A-Za-z]+\.[A-Za-z]+', m) for m in methods):
            raise BrowserControlError('methods 需要 1~64 个确切事件名，不支持通配 callback', 2)
        if any(m.startswith(('Browser.', 'Target.', 'Tracing.')) for m in methods):
            raise BrowserControlError('订阅只覆盖绑定页面会话，不开放 browser/target 全局事件', 6)
        if len(self._subscriptions) >= 32:
            raise BrowserControlError('诊断订阅超过 32 个', 5)
        sub = dict(events=deque(), cursor=0, dropped=0, truncated=0, bytes=0, active=True,
                   limit=integer(p.get('limit', 1000), 'limit', 1, 10000),
                   max_bytes=integer(p.get('max_bytes', 4*1024*1024), 'max_bytes', 1024, 16*1024*1024),
                   upstream_start=getattr(self.cdp, 'event_loss', 0), unsubscribers=[])
        token = uuid.uuid4().hex
        for name in dict.fromkeys(methods):
            sub['unsubscribers'].append(self.cdp.on(name, lambda data, sid, name=name: self._subscription_event(sub, name, data, sid)))
        self._subscriptions[token] = sub
        return {'subscriptionId': token, 'cursor': 0, 'methods': list(dict.fromkeys(methods)), 'coverage': {'scope': 'page-and-attached-frames', 'pastEvents': False}}

    def _subscription(self, p):
        token = p.get('id', p.get('subscriptionId'))
        if token not in self._subscriptions:
            raise BrowserControlError('诊断订阅不存在或已停止', 3)
        return token, self._subscriptions[token]

    def _events_read(self, p):
        _, sub = self._subscription(p)
        after = integer(p.get('after', 0), 'after', 0, 2**63-1)
        limit = integer(p.get('limit', 100), 'limit', 1, 10000)
        wait = number(p.get('wait_timeout', 0), 'wait_timeout', 0, 30)
        with self._condition:
            if after > sub['cursor']:
                raise BrowserControlError('after 超过该订阅的最新 cursor', 2)
            deadline = time.monotonic() + wait
            while sub['active'] and sub['cursor'] <= after and wait > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0: break
                self._condition.wait(remaining)
            events = [e for e, _ in sub['events'] if e['cursor'] > after][:limit]
            oldest = sub['events'][0][0]['cursor'] if sub['events'] else sub['cursor'] + 1
            upstream = getattr(self.cdp, 'event_loss', 0) - sub['upstream_start']
            return {'events': events, 'cursor': events[-1]['cursor'] if events else max(after, oldest-1),
                    'latestCursor': sub['cursor'], 'oldestCursor': oldest, 'dropped': sub['dropped'],
                    'lostSinceCursor': max(0, oldest-after-1), 'truncated': sub['truncated'],
                    'upstreamDropped': upstream, 'complete': not (upstream or sub['truncated'] or oldest-after-1 > 0)}

    def _events_stop(self, p):
        token, sub = self._subscription(p)
        with self._lock:
            sub['active'] = False
            self._condition.notify_all()
            for unsub in sub['unsubscribers']:
                unsub()
            del self._subscriptions[token]
        return {'stopped': True, 'subscriptionId': token}

    def _raw_guard(self, method, params, authorized, scope):
        domain, _, command = method.partition('.')
        if domain in {'Target', 'Fetch', 'IO', 'Tracing', 'Storage', 'ServiceWorker', 'SystemInfo', 'Tethering', 'Security'}:
            raise BrowserControlError(f'{domain} 不是安全单页 raw 能力；请使用有归属管理的领域接口', 6)
        if domain == 'Browser':
            if authorized is not True or scope != 'browser' or command not in {'getVersion', 'getBrowserCommandLine'}:
                raise BrowserControlError('Browser raw 只允许明确授权的只读元信息；破坏性方法不可绕过归属', 6)
            return
        allowed = {'Runtime', 'DOM', 'CSS', 'Accessibility', 'Page', 'Input', 'Emulation', 'Network', 'Debugger', 'Performance', 'Profiler', 'HeapProfiler', 'Log', 'Animation', 'Overlay', 'DOMSnapshot', 'Audits'}
        if domain not in allowed:
            raise BrowserControlError('未知 CDP 域的作用域未经核实，拒绝 raw', 6)
        if domain in {'Debugger', 'Profiler', 'HeapProfiler'} and command not in {'getScriptSource', 'getPossibleBreakpoints', 'getStackTrace', 'getBestEffortCoverage', 'getHeapObjectId', 'getObjectByHeapObjectId'}:
            raise BrowserControlError('该 raw 调试动作必须走领域接口，以便释放时恢复并清理', 6)
        if domain == 'Network' and command not in {'getResponseBody', 'getRequestPostData', 'getCertificate', 'getSecurityIsolationStatus', 'getResponseBodyForInterception'}:
            raise BrowserControlError('raw Network 不能绕网络记录器、拦截或泳道设置', 6)
        if domain == 'Page' and command in {'close', 'crash', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument', 'setDownloadBehavior', 'setBypassCSP'}:
            raise BrowserControlError('raw Page 不能绕目标归属、初始化脚本或下载管理', 6)
        if domain == 'Emulation' and command in {'setUserAgentOverride', 'setAutomationOverride', 'setCookieDisabled'}:
            raise BrowserControlError('该 raw 浏览器策略未经授权协调', 6)
        if params.get('grantUniveralAccess') or params.get('grantUniversalAccess'):
            raise BrowserControlError('raw 不能授予跨域全局访问', 6)
        def check(value):
            if isinstance(value, dict):
                if set(value) & {'targetId', 'sessionId', 'browserContextId'}:
                    raise BrowserControlError('raw 参数不能另选 target/session/browserContext', 6)
                for v in value.values(): check(v)
            elif isinstance(value, list):
                for v in value: check(v)
        check(params)
        if 'frameId' in params:
            tree = self._call('Page.getFrameTree')['frameTree']
            pending, ids = [tree], set()
            while pending:
                node = pending.pop()
                ids.add(node['frame']['id']); pending.extend(node.get('childFrames', []))
            if params['frameId'] not in ids:
                raise BrowserControlError('raw frameId 不属于绑定页面', 6)

    def _call_action(self, p):
        method = string(p.get('method'), 'method')
        if not re.fullmatch(r'[A-Za-z]+\.[A-Za-z]+', method):
            raise BrowserControlError('method 需要 Domain.method', 2)
        params = p.get('params', {})
        if not isinstance(params, dict): raise BrowserControlError('CDP params 需要对象', 2)
        sid = self._sid(p)
        timeout = number(p.get('timeout', 20), 'timeout', 0, 600, low_open=True)
        self._raw_guard(method, params, p.get('authorized'), p.get('scope'))
        return self._call(method, params, sid=sid, timeout=timeout)

    def _enable(self, p):
        sid = self._sid(p)
        self._call('Debugger.enable', sid=sid)
        self._enabled.add(sid)
        return {'enabled': True, 'sessionId': sid}

    def _sources(self, p):
        sid = self._sid(p)
        after = integer(p.get('after', 0), 'after', 0, 2**63-1)
        limit = integer(p.get('limit', 100), 'limit', 1, 2000)
        with self._lock:
            items = sorted((s for (session, _), s in self._source_records.items() if session == sid and s['cursor'] > after), key=lambda s: s['cursor'])[:limit]
            return {'sources': items, 'cursor': items[-1]['cursor'] if items else after, 'latestCursor': self._source_cursor, 'dropped': self._source_dropped, 'complete': not self._source_dropped, 'enabled': sid in self._enabled}

    def _source(self, p):
        sid = self._sid(p)
        script = string(p.get('script_id'), 'script_id')
        with self._lock:
            if (sid, script) not in self._source_records: raise BrowserControlError('script_id 未被本页面调试器观察', 3)
        result = self._call('Debugger.getScriptSource', {'scriptId': script}, sid=sid, timeout=number(p.get('timeout', 20), 'timeout', 0, 600, low_open=True))
        artifact = self._new_file('source', '.js')
        with artifact['file'] as file:
            file.write(result.get('scriptSource', '').encode('utf-8'))
        return self._artifact(artifact, complete=True, summary={'scriptId': script, 'sessionId': sid})

    def _breakpoint(self, p):
        sid = self._sid(p)
        if sid not in self._enabled: raise BrowserControlError('请先 enable 调试器', 5)
        line = integer(p.get('line'), 'line', 0, 2**31-1)
        column = integer(p.get('column', 0), 'column', 0, 2**31-1)
        condition = p.get('condition', '')
        string(condition, 'condition', empty=True)
        kinds = [k for k in ('url', 'url_regex', 'script_id') if k in p]
        if len(kinds) != 1: raise BrowserControlError('断点需唯一 url/url_regex/script_id', 2)
        value = string(p[kinds[0]], kinds[0])
        if kinds[0] == 'script_id':
            if (sid, value) not in self._source_records: raise BrowserControlError('script_id 未被观察', 3)
            result = self._call('Debugger.setBreakpoint', {'location': {'scriptId': value, 'lineNumber': line, 'columnNumber': column}, 'condition': condition}, sid=sid)
        else:
            key = 'url' if kinds[0] == 'url' else 'urlRegex'
            result = self._call('Debugger.setBreakpointByUrl', {key: value, 'lineNumber': line, 'columnNumber': column, 'condition': condition}, sid=sid)
        self._breakpoints[result['breakpointId']] = sid
        return dict(result, sessionId=sid)

    def _remove(self, p):
        token = p.get('id')
        if token not in self._breakpoints: raise BrowserControlError('断点不属于本任务', 6)
        self._call('Debugger.removeBreakpoint', {'breakpointId': token}, sid=self._breakpoints[token])
        del self._breakpoints[token]
        return {'removed': True}

    def _pause(self, p):
        sid = self._sid(p)
        if sid not in self._enabled: raise BrowserControlError('请先 enable 调试器', 5)
        return self._call('Debugger.pause', sid=sid)

    def _resume(self, p):
        sid = self._sid(p)
        with self._lock: self._paused.pop(sid, None)
        return self._call('Debugger.resume', sid=sid)

    def _step(self, p):
        kind = p.get('kind', 'over')
        methods = {'over': 'Debugger.stepOver', 'into': 'Debugger.stepInto', 'out': 'Debugger.stepOut'}
        if kind not in methods: raise BrowserControlError('step kind 需要 over/into/out', 2)
        sid = self._sid(p)
        if sid not in self._paused: raise BrowserControlError('页面当前没有已观察的暂停', 4)
        with self._lock: self._paused.pop(sid, None)
        return self._call(methods[kind], sid=sid)

    def _stack(self, p):
        sid = self._sid(p)
        with self._lock:
            paused = self._paused.get(sid)
            return {'paused': paused is not None, 'sessionId': sid, 'pause': paused, 'upstreamDropped': getattr(self.cdp, 'event_loss', 0)}

    def _evaluate_frame(self, p):
        if 'throw_on_side_effect' in p:
            boolean(p['throw_on_side_effect'], 'throw_on_side_effect')
        sid = self._sid(p)
        frame = string(p.get('call_frame_id'), 'call_frame_id')
        with self._lock:
            if frame not in {f['callFrameId'] for f in self._paused.get(sid, {}).get('callFrames', [])}:
                raise BrowserControlError('call_frame_id 不属于本页面当前暂停栈', 4)
        result = self._call('Debugger.evaluateOnCallFrame', {'callFrameId': frame, 'expression': string(p.get('expression'), 'expression'), 'returnByValue': True, 'throwOnSideEffect': p.get('throw_on_side_effect', True)}, sid=sid, timeout=number(p.get('timeout', 20), 'timeout', 0, 600, low_open=True))
        if result.get('exceptionDetails'): raise BrowserControlError('暂停栈表达式抛出异常', 1, data=result)
        return result

    def _new_file(self, kind, suffix):
        if self._artifact_root is None:
            self._artifact_root = Path(tempfile.mkdtemp(prefix='page-', dir=scratch.subdir('diagnostics')))
            os.chmod(self._artifact_root, 0o700)
        path = self._artifact_root / (kind + '-' + uuid.uuid4().hex + suffix)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        return {'path': str(path), 'file': os.fdopen(fd, 'wb')}

    @staticmethod
    def _artifact(a, *, complete, summary=None):
        return {'artifact': {'path': a['path'], 'bytes': Path(a['path']).stat().st_size, 'complete': complete, 'summary': summary or {}}}

    def close(self):
        if self._closed: return
        for token in list(self._subscriptions): self._events_stop({'id': token})
        # 页面或 iframe 已不在时，断点和调试器开关随会话一起没了，不算撤销失败。
        for token in list(self._breakpoints):
            try: self._remove({'id': token})
            except Exception as exc:
                if not gone(exc): self.close_errors.append({'action': 'remove', 'error': str(exc)})
        for sid in tuple(self._enabled):
            try:
                if sid in self._paused: self._call('Debugger.resume', sid=sid, timeout=5)
                self._call('Debugger.disable', sid=sid, timeout=5)
            except Exception as exc:
                if not gone(exc): self.close_errors.append({'action': 'debugger_cleanup', 'error': str(exc)})
        for unsubscribe in self._unsubscribers: unsubscribe()
        self._closed = True
