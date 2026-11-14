"""Cookie、网页存储与状态文件单元测试；假 CDP，不连接浏览器。"""
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from browser_use.errors import BrowserUseError
from browser_use.state import StateService, _mask


class FakeCDP:
    """按 storageKey 保存存储、按 browserContextId 保存 cookie 的假浏览器。"""
    def __init__(self):
        self.calls = []
        self.jar = {}
        self.stores = {}
        self.fail = {}

    def call(self, method, params=None, *, session_id=None, timeout=20):
        params = params or {}
        self.calls.append((method, params, session_id))
        failure = self.fail.pop(method, None)
        if failure is not None:
            raise failure
        if method == 'Storage.getCookies':
            return {'cookies': [dict(c) for c in self.jar.values()]}
        if method == 'Storage.clearCookies':
            self.jar.clear(); return {}
        if method == 'Storage.setCookies':
            for c in params['cookies']: self._set(c)
            return {}
        if method == 'Network.getCookies':
            return {'cookies': [dict(c) for c in self.jar.values()]}
        if method == 'Network.setCookie':
            self._set(params); return {'success': True}
        if method == 'Network.deleteCookies':
            domain = params.get('domain') or params.get('url', '').split('/')[2].split(':')[0]
            for key in [k for k in self.jar if k[0] == params['name'] and k[1] == domain and k[2] == params.get('path', '/')]:
                del self.jar[key]
            return {}
        if method == 'Storage.getStorageKey':
            return {'storageKey': {'main': 'https://app.test/', 'child': 'https://cdn.test/^0https://app.test'}[params['frameId']]}
        if method.startswith('DOMStorage.'):
            sid = params['storageId']
            store = self.stores.setdefault((sid['storageKey'], sid['isLocalStorage']), {})
            if method == 'DOMStorage.getDOMStorageItems': return {'entries': [[k, v] for k, v in store.items()]}
            if method == 'DOMStorage.setDOMStorageItem': store[params['key']] = params['value']; return {}
            if method == 'DOMStorage.removeDOMStorageItem': store.pop(params['key'], None); return {}
            if method == 'DOMStorage.clear': store.clear(); return {}
        return {}

    def _set(self, c):
        domain = c.get('domain') or c['url'].split('/')[2].split(':')[0]
        path = c.get('path', '/')
        self.jar[(c['name'], domain, path)] = {'name': c['name'], 'value': c['value'], 'domain': domain, 'path': path,
                                               'expires': c.get('expires', -1), 'size': len(c['name']) + len(c['value']),
                                               'httpOnly': c.get('httpOnly', False), 'secure': c.get('secure', False),
                                               'session': 'expires' not in c, 'sourcePort': 443}

    def methods(self):
        return [c[0] for c in self.calls]


class FakeDriver:
    def __init__(self, cdp, *, owned=False, context=None):
        self.cdp = cdp
        self.session_id = 'page'
        self.browser_owned = owned
        self.browser_context_id = context
        self._lock = threading.RLock()
        self._frames_cache = {'main': {'session': 'page', 'parent': None, 'url': 'https://app.test/home'},
                              'child': {'session': 'oopif', 'parent': 'main', 'url': 'https://cdn.test/widget'}}
        self.checks = 0

    @property
    def session_ids(self): return {'page', 'oopif'}

    def check(self): self.checks += 1

    def _call(self, sid, method, params=None, timeout=20):
        return self.cdp.call(method, params, session_id=sid, timeout=timeout)


class Base(unittest.TestCase):
    owned = False
    context = None

    def setUp(self):
        self.cdp = FakeCDP()
        self.driver = FakeDriver(self.cdp, owned=self.owned, context=self.context)
        self.state = StateService(self.driver)
        self.tmp = tempfile.TemporaryDirectory(prefix='browser-use-state-test-')
        self.addCleanup(self.tmp.cleanup)
        os.chmod(self.tmp.name, 0o700)

    def call(self, action, **params):
        return self.state.dispatch(action, params)

    def rejected(self, action, code, **params):
        before = len(self.cdp.calls)
        with self.assertRaises(BrowserUseError) as raised:
            self.call(action, **params)
        self.assertEqual(raised.exception.code, code, str(raised.exception))
        return raised.exception, self.cdp.calls[before:]


class SharedArcTests(Base):
    def test_strict_params_before_any_cdp(self):
        cases = [('cookies_get', {'unknown': 1}), ('cookies_get', {'raw': 'yes'}), ('cookies_get', {'urls': 'https://a'}),
                 ('cookies_get', {'urls': ['ftp://a/']}), ('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://a/', 'domain': 'a', 'authorized': True}),
                 ('cookies_set', {'name': 'a;b', 'value': 'b', 'url': 'https://a/', 'authorized': True}),
                 ('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://a/', 'sameSite': 'None', 'authorized': True}),
                 ('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://a/', 'expires': float('nan'), 'authorized': True}),
                 ('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://a/', 'authorized': 'true'}),
                 ('cookies_delete', {'name': 'a', 'authorized': True}), ('storage_get', {'kind': 'indexed'}),
                 ('storage_get', {'limit': 0}), ('storage_get', {'origin': 'https://app.test/path'}), ('storage_set', {'key': 'k', 'authorized': True}),
                 ('state_save', {'path': 7}), ('state_show', {'path': '/x', 'raw': True}), ('nope', {})]
        for action, params in cases:
            with self.subTest(action=action, params=params):
                _, calls = self.rejected(action, 2, **params)
                self.assertEqual(calls, [])
        self.assertEqual(self.driver.checks, 0)

    def test_default_output_masks_values_and_raw_needs_authorization(self):
        self.cdp._set({'name': 'sid', 'value': 'secret-token-123', 'url': 'https://app.test/'})
        self.cdp._set({'name': 'p', 'value': 'abc', 'url': 'https://app.test/'})
        result = self.call('cookies_get')
        text = json.dumps(result)
        self.assertNotIn('secret-token-123', text)
        self.assertNotIn('"abc"', text)
        sid = next(c for c in result['cookies'] if c['name'] == 'sid')
        self.assertEqual((sid['value'], sid['valueLength'], sid['valueMasked']), ('se************23', 16, True))
        self.assertEqual(_mask('abc'), '***')
        self.rejected('cookies_get', 6, raw=True)
        raw = self.call('cookies_get', raw=True, authorized=True, urls=['https://app.test/'])
        self.assertIn('secret-token-123', json.dumps(raw))
        self.assertEqual(self.cdp.calls[-1], ('Network.getCookies', {'urls': ['https://app.test/']}, 'page'))

    def test_writes_require_authorization_on_shared_arc(self):
        for action, params in [('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://app.test/'}), ('cookies_delete', {'name': 'a', 'url': 'https://app.test/'}),
                               ('cookies_clear', {}), ('storage_set', {'key': 'k', 'value': 'v'}), ('storage_remove', {'key': 'k'}),
                               ('storage_clear', {}), ('state_save', {'path': self.tmp.name + '/s.json'}), ('cookies_set', {'name': 'a', 'value': 'b', 'url': 'https://app.test/', 'authorized': False})]:
            with self.subTest(action=action):
                _, calls = self.rejected(action, 6, **params)
                self.assertEqual(calls, [])

    def test_shared_cookie_set_and_delete_revert_on_close(self):
        self.cdp._set({'name': 'keep', 'value': 'original-value', 'url': 'https://app.test/'})
        out = self.call('cookies_set', name='new', value='v1', url='https://app.test/', authorized=True)
        self.assertTrue(out['revertOnRelease'])
        self.call('cookies_set', name='keep', value='changed', url='https://app.test/', authorized=True)
        self.call('cookies_delete', name='keep', url='https://app.test/', authorized=True)
        self.assertNotIn(('keep', 'app.test', '/'), self.cdp.jar)
        self.state.close()
        self.assertEqual(self.state.close_errors, [])
        self.assertEqual(self.cdp.jar[('keep', 'app.test', '/')]['value'], 'original-value')
        self.assertNotIn(('new', 'app.test', '/'), self.cdp.jar)

    def test_close_does_not_overwrite_external_change(self):
        self.call('cookies_set', name='new', value='v1', url='https://app.test/', authorized=True)
        self.cdp._set({'name': 'new', 'value': 'by-user', 'url': 'https://app.test/'})
        self.state.close()
        self.assertEqual(self.cdp.jar[('new', 'app.test', '/')]['value'], 'by-user')
        self.assertIn('不覆盖', self.state.close_errors[0]['error'])

    def test_timeout_is_not_replayed_and_close_reports_unknown(self):
        self.cdp.fail['Network.setCookie'] = BrowserUseError('Network.setCookie 等待超时', 4, outcome='unknown')
        with self.assertRaises(BrowserUseError) as raised:
            self.call('cookies_set', name='t', value='v', url='https://app.test/', authorized=True)
        self.assertEqual((raised.exception.code, raised.exception.outcome), (4, 'unknown'))
        self.assertEqual(self.cdp.methods().count('Network.setCookie'), 1)
        self.state.close()
        self.assertEqual(self.cdp.methods().count('Network.setCookie'), 1)
        self.assertIn('结果未知', self.state.close_errors[0]['error'])

    def test_shared_clear_scope_is_explicit(self):
        out = self.call('cookies_clear', authorized=True)
        self.assertEqual(self.cdp.calls[-1], ('Storage.clearCookies', {}, None))
        self.assertFalse(out['reversible'])
        self.assertIn('all sites', out['scope'])

    def test_storage_origin_scope_and_revert(self):
        self.cdp.stores[('https://app.test/', True)] = {'a': '1'}
        got = self.call('storage_get')
        self.assertEqual((got['origin'], got['items'], got['storageKey']), ('https://app.test', {'a': '1'}, 'https://app.test/'))
        child = self.call('storage_get', origin='https://cdn.test', kind='session')
        self.assertEqual(child['frameId'], 'child')
        self.assertEqual(self.cdp.calls[-1][2], 'oopif')
        self.assertFalse(self.cdp.calls[-1][1]['storageId']['isLocalStorage'])
        _, calls = self.rejected('storage_get', 6, origin='https://evil.test')
        self.assertNotIn('DOMStorage.getDOMStorageItems', [c[0] for c in calls])
        self.rejected('storage_get', 3, frame='missing')
        self.rejected('storage_get', 2, frame='child', origin='https://app.test')
        self.call('storage_set', key='a', value='2', authorized=True)
        self.call('storage_set', key='b', value='new', authorized=True)
        self.call('storage_remove', key='a', authorized=True)
        self.call('storage_clear', origin='https://app.test', authorized=True)
        self.assertEqual(self.cdp.stores[('https://app.test/', True)], {})
        self.state.close()
        self.assertEqual(self.state.close_errors, [])
        self.assertEqual(self.cdp.stores[('https://app.test/', True)], {'a': '1'})

    def test_state_save_requires_authorization_then_writes_private_file(self):
        self.rejected('state_save', 6, path=self.tmp.name + '/s.json')
        self.cdp._set({'name': 'sid', 'value': 'secret-token-123', 'url': 'https://app.test/'})
        out = self.call('state_save', path=self.tmp.name + '/s.json', authorized=True)
        self.assertNotIn('secret-token-123', json.dumps(out))
        self.assertEqual(stat.S_IMODE(os.stat(out['artifact']['path']).st_mode), 0o600)


class PrivateChromeTests(Base):
    owned = True
    context = 'ctx-1'

    def test_private_writes_need_no_authorization_and_scope_is_context(self):
        out = self.call('cookies_set', name='a', value='b', url='https://app.test/')
        self.assertEqual((out['scope'], out['browserContextId'], out['revertOnRelease']), ('browserContext', 'ctx-1', False))
        self.assertNotIn('Storage.getCookies', self.cdp.methods())
        self.call('cookies_clear')
        self.assertEqual(self.cdp.calls[-1], ('Storage.clearCookies', {'browserContextId': 'ctx-1'}, None))
        self.state.close()
        self.assertEqual(self.state.close_errors, [])

    def test_save_show_load_round_trip(self):
        self.cdp._set({'name': 'sid', 'value': 'secret-token-123', 'url': 'https://app.test/', 'httpOnly': True})
        self.cdp._set({'name': 'other', 'value': 'x', 'domain': 'elsewhere.test'})
        self.cdp._set({'name': 'cdn', 'value': 'y', 'url': 'https://cdn.test/'})
        self.cdp.stores[('https://app.test/', True)] = {'token': 'local-secret'}
        self.cdp.stores[('https://app.test/', False)] = {'tab': 'session-value'}
        directory = Path(self.tmp.name) / 'private'
        out = self.call('state_save', path=str(directory / 'state.json'), session_storage=True)
        path = out['artifact']['path']
        self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertTrue(out['artifact']['containsSecrets'])
        self.assertEqual(out['artifact']['bytes'], os.stat(path).st_size)
        data = json.loads(Path(path).read_text())
        self.assertEqual({c['name'] for c in data['cookies']}, {'sid'})
        self.assertEqual(data['origins'], [{'origin': 'https://app.test', 'storageKey': 'https://app.test/', 'localStorage': {'token': 'local-secret'}, 'sessionStorage': {'tab': 'session-value'}}])
        _, calls = self.rejected('state_save', 6, path=path)
        self.assertEqual(calls, [])
        shown = self.call('state_show', path=path)
        self.assertNotIn('secret', json.dumps(shown))
        self.assertEqual(shown['domains'], [{'domain': 'app.test', 'cookies': 1}])
        self.assertEqual(shown['origins'][0]['localStorageKeys'], 1)
        self.cdp.jar.clear(); self.cdp.stores.clear(); self.cdp.calls.clear()
        loaded = self.call('state_load', path=path)
        set_call = next(c for c in self.cdp.calls if c[0] == 'Storage.setCookies')
        self.assertEqual(set_call[1]['browserContextId'], 'ctx-1')
        self.assertEqual(set_call[1]['cookies'][0]['url'], 'http://app.test/')
        self.assertEqual(loaded['cookies'], {'inFile': 1, 'skippedExpired': 0, 'sent': 1, 'verified': 1})
        self.assertEqual(self.cdp.stores[('https://app.test/', True)], {'token': 'local-secret'})
        self.assertTrue(loaded['storage']['loaded'][0]['verified'])
        self.assertNotIn('secret', json.dumps(loaded))

    def test_state_save_requires_private_parent(self):
        loose = Path(self.tmp.name) / 'loose'
        loose.mkdir(mode=0o755); os.chmod(loose, 0o755)
        with self.assertRaises(BrowserUseError) as raised:
            self.call('state_save', path=str(loose / 's.json'))
        self.assertEqual(raised.exception.code, 6)
        self.assertFalse((loose / 's.json').exists())
        self.rejected('state_save', 3, path=self.tmp.name + '/a/b/s.json')

    def test_state_save_rejects_origin_not_in_page(self):
        self.rejected('state_save', 6, path=self.tmp.name + '/s.json', origins=['https://evil.test'])
        self.assertFalse(Path(self.tmp.name, 's.json').exists())

    def test_load_checks_file_permissions_owner_and_format(self):
        path = Path(self.tmp.name) / 'state.json'
        path.write_text(json.dumps({'format': 'browser-use-state', 'version': 1, 'cookies': [], 'origins': []}))
        os.chmod(path, 0o644)
        _, calls = self.rejected('state_load', 6, path=str(path))
        self.assertEqual(calls, [])
        os.chmod(path, 0o600)
        link = Path(self.tmp.name) / 'link.json'
        link.symlink_to(path)
        self.rejected('state_load', 6, path=str(link))
        path.write_text(json.dumps({'format': 'other', 'version': 1, 'cookies': [], 'origins': []}))
        self.rejected('state_load', 2, path=str(path))
        path.write_text(json.dumps({'format': 'browser-use-state', 'version': 1, 'cookies': [{'name': 'a', 'value': 'b', 'domain': 'x', 'evil': 1}], 'origins': []}))
        self.rejected('state_load', 2, path=str(path))
        self.rejected('state_load', 3, path=self.tmp.name + '/missing.json')
        self.rejected('state_load', 2, path=str(path), cookies=False, storage=False)

    def test_load_storage_for_absent_origin_is_pending_not_navigated(self):
        path = Path(self.tmp.name) / 'state.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({'format': 'browser-use-state', 'version': 1, 'cookies': [], 'origins': [{'origin': 'https://other.test', 'localStorage': {'k': 'v'}}]}, f)
        out = self.call('state_load', path=str(path))
        self.assertEqual(out['storage']['loaded'], [])
        self.assertEqual(out['storage']['pending'][0]['origin'], 'https://other.test')
        self.assertNotIn('Page.navigate', self.cdp.methods())
        self.rejected('state_load', 3, path=str(path), origins=['https://nothere.test'])

    def test_load_skips_different_storage_partition(self):
        path = Path(self.tmp.name) / 'state.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({'format': 'browser-use-state', 'version': 1, 'cookies': [], 'origins': [{'origin': 'https://cdn.test', 'storageKey': 'https://cdn.test/', 'localStorage': {'k': 'v'}}]}, f)
        out = self.call('state_load', path=str(path))
        self.assertEqual(out['storage']['pending'][0]['current'], 'https://cdn.test/^0https://app.test')
        self.assertNotIn('DOMStorage.setDOMStorageItem', self.cdp.methods())

    def test_load_timeout_not_replayed(self):
        path = Path(self.tmp.name) / 'state.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({'format': 'browser-use-state', 'version': 1, 'cookies': [{'name': 'a', 'value': 'b', 'domain': 'app.test', 'path': '/', 'session': True}], 'origins': []}, f)
        self.cdp.fail['Storage.setCookies'] = BrowserUseError('timeout', 4, outcome='unknown')
        with self.assertRaises(BrowserUseError) as raised:
            self.call('state_load', path=str(path))
        self.assertEqual(raised.exception.outcome, 'unknown')
        self.assertEqual(self.cdp.methods().count('Storage.setCookies'), 1)


class LoadGuardTests(Base):
    def test_load_rejected_on_shared_arc_even_when_authorized(self):
        _, calls = self.rejected('state_load', 6, path='/nonexistent.json')
        self.assertEqual(calls, [])
        self.rejected('state_load', 2, path='/nonexistent.json', authorized=True)

    def test_load_rejected_without_private_context(self):
        self.driver.browser_owned = True
        self.rejected('state_load', 6, path='/nonexistent.json')


if __name__ == '__main__':
    unittest.main()
