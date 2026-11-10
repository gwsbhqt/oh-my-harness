"""动作落点、插入位置、撤销、点击换点、取态截断说明和候选提示；只用假 CDP 和假客户端，不连浏览器。"""
import json
import unittest
from unittest.mock import patch

import browser_control
from browser_control import actions
from browser_control.commands import execute
from browser_control.driver import (PageDriver, _ACTIVE, _CARET, _CLICK_POINTS, _CONTAINERS, _DESCRIBE, _EDIT_HOST, _FOCUS_ALTERNATIVE,
                       _FOCUS_RELATION, _META, _PLACE_CARET, _brief, _similar)
from browser_control.errors import BrowserControlError


def describe(value, *, tag='input', role='textbox', name='标题', id='title', kind='input', secret=False):
    info = {'element': {'tag': tag, 'role': role, 'name': name, 'id': id}, 'kind': kind, 'secret': secret}
    if kind != 'none':
        info.update(digest=hash(value) & 0xffffffff, length=len(value), value=None if secret else value, truncated=False)
    return info


class FakeCDP:
    """最小页面：一个按钮（id=go）和一个输入框（id=title），记录发出的每个调用。"""
    def __init__(self):
        self.listeners = {}
        self.calls = []
        self.value = '每日晨报'
        self.nodes = [
            {'nodeId': 'n1', 'backendDOMNodeId': 11, 'role': {'value': 'textbox'}, 'name': {'value': '标题'}},
            {'nodeId': 'n2', 'backendDOMNodeId': 12, 'role': {'value': 'button'}, 'name': {'value': '保存'}},
        ]
        self.ids = {11: 'title', 12: 'save'}
        self.focus_error = None
        self.points = {'rect': {'x': 10, 'y': 20, 'width': 30, 'height': 20}, 'visible': {'x': 10, 'y': 20, 'width': 30, 'height': 20},
                       'clippedBy': None, 'points': [{'name': 'center', 'x': 25, 'y': 30, 'hit': True}], 'blocker': None}
        self.layout = None
        self.containers = [{'css': '#content', 'tag': 'main', 'interactive': 3, 'main': True, 'inViewport': True}]
        self.host = False

    def on(self, name, callback):
        self.listeners.setdefault(name, []).append(callback)
        return lambda: self.listeners[name].remove(callback)

    def call(self, method, params=None, *, session_id=None, timeout=20):
        p = params or {}
        self.calls.append((method, p))
        if method == 'Target.getTargetInfo':
            return {'targetInfo': {'targetId': 'root'}}
        if method == 'Page.getFrameTree':
            return {'frameTree': {'frame': {'id': 'root', 'loaderId': '1'}}}
        if method == 'Page.createIsolatedWorld':
            return {'executionContextId': 2}
        if method == 'Runtime.evaluate':
            expression = p.get('expression')
            if expression == 'document':
                return {'result': {'objectId': 'doc'}}
            if expression == _ACTIVE:
                return {'result': {'objectId': 'active'}}
            if expression == _CONTAINERS:
                return {'result': {'value': self.containers}}
            return {'result': {'value': True}}
        if method == 'DOM.describeNode':
            if p.get('objectId') == 'active':
                return {'node': {'backendNodeId': 11}}
            if p.get('objectId') == 'host':
                return {'node': {'backendNodeId': 20}}
            return {'node': {'backendNodeId': 1}}
        if method == 'Accessibility.getFullAXTree':
            return {'nodes': self.nodes}
        if method == 'DOM.resolveNode':
            return {'object': {'objectId': 'node-' + str(p['backendNodeId'])}}
        if method == 'DOM.focus' and self.focus_error and p['backendNodeId'] == self.focus_error:
            raise BrowserControlError('DOM.focus：Element is not focusable', 1, data={'cdp': {'message': 'Element is not focusable'}})
        if method == 'DOMSnapshot.captureSnapshot':
            if self.layout is None:
                raise BrowserControlError('DOMSnapshot 不可用', 1)
            return self.layout
        if method == 'Input.insertText':
            self.value += p['text']
        if method == 'Runtime.callFunctionOn':
            function, oid = p['functionDeclaration'], p.get('objectId', '')
            backend = int(oid.split('-')[1]) if oid.startswith('node-') else 11
            if function == _META:
                editable = backend == 11
                return {'result': {'value': {'connected': True, 'id': self.ids.get(backend, ''), 'tag': 'INPUT' if editable else 'BUTTON',
                                             'value': self.value if editable else '', 'editable': editable, 'enabled': True,
                                             'bounds': {'x': 0, 'y': backend, 'width': 10, 'height': 10}, 'visible': True,
                                             'offscreen': False, 'occluded': False}}}
            if function == _DESCRIBE:
                if backend == 11:
                    return {'result': {'value': describe(self.value)}}
                return {'result': {'value': describe('', tag='p', role='paragraph', name='', id='p' + str(backend), kind='none')}}
            if function == _CLICK_POINTS:
                return {'result': {'value': self.points}}
            if function == _FOCUS_RELATION:
                return {'result': {'value': 'self'}}
            if function == _EDIT_HOST:
                return {'result': {'objectId': 'host'} if self.host else {'type': 'object', 'subtype': 'null', 'value': None}}
            if function == _FOCUS_ALTERNATIVE:
                return {'result': {'value': None}}
            if function in (_PLACE_CARET, _CARET):
                return {'result': {'value': True}}
            return {'result': {'value': True}}
        if method == 'DOM.getContentQuads':
            return {'quads': [[10, 20, 40, 20, 40, 40, 10, 40]]}
        if method == 'Page.getLayoutMetrics':
            return {'cssLayoutViewport': {'clientWidth': 100, 'clientHeight': 100}}
        return {}


class LandingTests(unittest.TestCase):
    def setUp(self):
        self.cdp = FakeCDP()
        self.driver = PageDriver(self.cdp, 'root', 'session')

    def tearDown(self):
        self.driver.close()

    def methods(self):
        return [c[0] for c in self.cdp.calls]

    def test_untargeted_type_reports_current_focus_and_values(self):
        result = self.driver.dispatch('type', {'text': '【误输入】'})
        self.assertEqual(result['target']['id'], 'title')
        self.assertEqual((result['before'], result['after'], result['changed']), ('每日晨报', '每日晨报【误输入】', True))
        self.assertEqual(result['focus'], 'current-focus')
        self.assertIn('当前焦点', result['note'])
        self.assertNotIn('DOM.focus', self.methods())

    def test_snapshot_index_only_from_callers_snapshot(self):
        snap = self.driver.dispatch('snap')
        result = self.driver.dispatch('type', {'text': 'x'})
        self.assertEqual(result['target']['idx'], next(e['idx'] for e in snap['elements'] if e['id'] == 'title'))
        # id 定位会在内部重新取态，调用方没有那份凭证，不能把内部编号报出去。
        result = self.driver.dispatch('type', {'text': 'y', 'id': 'title'})
        self.assertNotIn('idx', result['target'])

    def test_secret_fields_report_only_length(self):
        self.cdp.value = 'secret'
        original = self.cdp.call
        def call(method, params=None, **kw):
            if method == 'Runtime.callFunctionOn' and params['functionDeclaration'] == _DESCRIBE:
                return {'result': {'value': describe(self.cdp.value, secret=True)}}
            return original(method, params, **kw)
        with patch.object(self.cdp, 'call', side_effect=call):
            result = self.driver.dispatch('type', {'text': 'x'})
        self.assertTrue(result['redacted'])
        self.assertIsNone(result['before'])
        self.assertEqual((result['beforeLength'], result['afterLength']), (6, 7))
        self.assertNotIn('secret', json.dumps(result))

    def test_position_places_caret_before_insert(self):
        self.driver.dispatch('type', {'text': 'x', 'id': 'title', 'position': 'start'})
        place = [c for c in self.cdp.calls if c[0] == 'Runtime.callFunctionOn' and c[1]['functionDeclaration'] == _PLACE_CARET]
        self.assertEqual([c[1]['arguments'] for c in place], [[{'value': 'start'}]])
        self.assertLess(self.cdp.calls.index(place[0]), self.methods().index('Input.insertText'))

    def test_default_position_leaves_caret_alone(self):
        self.driver.dispatch('type', {'text': 'x', 'id': 'title'})
        self.driver.dispatch('type_keys', {'text': 'y'})
        self.assertFalse(any(c[0] == 'Runtime.callFunctionOn' and c[1]['functionDeclaration'] == _PLACE_CARET for c in self.cdp.calls))

    def test_unfocusable_inside_editor_focuses_editing_host(self):
        self.cdp.focus_error = 12
        self.cdp.host = True
        snap = self.driver.dispatch('snap')
        save = next(e['idx'] for e in snap['elements'] if e['id'] == 'save')
        result = self.driver.dispatch('key', {'keys': 'Home', 'idx': save, 'snapshot': snap['snapshot']})
        self.assertEqual(result['focus'], 'editing-host')
        focused = [c[1]['backendNodeId'] for c in self.cdp.calls if c[0] == 'DOM.focus']
        self.assertEqual(focused, [12, 20])
        place = [c for c in self.cdp.calls if c[0] == 'Runtime.callFunctionOn' and c[1]['functionDeclaration'] == _PLACE_CARET]
        self.assertEqual(place[0][1]['objectId'], 'node-12')

    def test_unfocusable_outside_editor_explains_and_sends_nothing(self):
        self.cdp.focus_error = 12
        snap = self.driver.dispatch('snap')
        save = next(e['idx'] for e in snap['elements'] if e['id'] == 'save')
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch('key', {'keys': 'Home', 'idx': save, 'snapshot': snap['snapshot']})
        self.assertIn('不能获得输入焦点', str(raised.exception))
        self.assertIn('先 snap 找可输入的元素', str(raised.exception))
        self.assertNotIn('Input.dispatchKeyEvent', self.methods())

    def test_undo_and_redo_use_trusted_shortcuts(self):
        for command, shifted in (('undo', False), ('redo', True)):
            self.cdp.calls.clear()
            result = self.driver.dispatch('edit', {'command': command})
            keys = [c[1] for c in self.cdp.calls if c[0] == 'Input.dispatchKeyEvent']
            main = next(k for k in keys if k.get('commands'))
            self.assertEqual(main['commands'], [command])
            self.assertEqual(main['code'], 'KeyZ')
            self.assertEqual(bool(main['modifiers'] & 8), shifted)
            self.assertEqual(keys[-1]['modifiers'], 0)
            self.assertIn('after', result)
            self.assertIsNone(result['clipboard'])

    def test_click_reports_focus_and_point(self):
        result = self.driver.dispatch('click', {'id': 'save'})
        self.assertTrue(result['focusInTarget'])
        self.assertEqual(result['focusRelation'], 'self')
        self.assertEqual(result['point']['position'], 'center')
        self.assertEqual(result['focused']['id'], 'title')

    def test_click_retries_other_visible_point(self):
        self.cdp.points['points'] = [{'name': 'center', 'x': 25, 'y': 30, 'hit': False},
                                     {'name': 'top-left', 'x': 14, 'y': 24, 'hit': True}]
        result = self.driver.dispatch('click', {'id': 'save'})
        presses = [c[1] for c in self.cdp.calls if c[0] == 'Input.dispatchMouseEvent']
        self.assertEqual((presses[0]['x'], presses[0]['y']), (14, 24))
        self.assertEqual(result['point']['retried'], ['center'])
        self.assertIn('改点', result['point']['note'])

    def test_click_blocked_everywhere_names_blocker(self):
        self.cdp.points['points'] = [{'name': 'center', 'x': 25, 'y': 30, 'hit': False}]
        self.cdp.points['blocker'] = {'tag': 'div', 'id': 'mask', 'classes': ['overlay'], 'text': '加载中', 'relation': 'unrelated', 'point': 'center'}
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch('click', {'id': 'save'})
        message = str(raised.exception)
        for part in ('被遮挡', 'id="mask"', 'class="overlay"', '加载中', '与它无关的元素'):
            self.assertIn(part, message)
        self.assertEqual(raised.exception.data['blocker']['id'], 'mask')
        self.assertNotIn('Input.dispatchMouseEvent', self.methods())

    def test_numeric_id_hints_idx_and_lists_candidates(self):
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch('click', {'id': '12'})
        self.assertEqual(raised.exception.code, 3)
        self.assertIn('请用 idx=12', str(raised.exception))
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch('click', {'label': '保 存'})
        candidates = raised.exception.data['candidates']
        self.assertEqual([c['id'] for c in candidates], ['save'])
        self.assertIn('相近的元素', str(raised.exception))
        self.assertEqual(raised.exception.data['snapshot'], self.driver._token)

    def test_truncation_explains_limit_and_suggests_within(self):
        self.cdp.nodes = [{'nodeId': f'n{i}', 'backendDOMNodeId': 100 + i, 'role': {'value': 'button'}, 'name': {'value': f'按钮{i}'}} for i in range(10)]
        snap = self.driver.dispatch('snap', {'max': 4})
        info = snap['truncation']
        self.assertTrue(snap['truncated'])
        self.assertEqual((info['limits'], info['max'], info['skippedNodes']), (['max'], 4, 6))
        self.assertGreater(info['suggestedMax'], 4)
        self.assertEqual(info['containers'][0]['css'], '#content')
        self.assertIn('within="#content"', info['hint'])
        self.assertEqual(info['kept'], 'page-order')

    def test_overflow_keeps_viewport_elements_in_page_order(self):
        self.cdp.nodes = [{'nodeId': f'n{i}', 'backendDOMNodeId': 100 + i, 'role': {'value': 'button'}, 'name': {'value': f'按钮{i}'}} for i in range(10)]
        self.cdp.layout = {'strings': ['root'], 'documents': [{'frameId': 0, 'nodes': {'backendNodeId': [100 + i for i in range(10)]},
                           'layout': {'nodeIndex': [7, 9, 1], 'bounds': [[0, 0, 10, 10], [0, 20, 10, 10], [0, 500, 10, 10]]},
                           'scrollOffsetX': 0, 'scrollOffsetY': 0}]}
        snap = self.driver.dispatch('snap', {'max': 3})
        self.assertEqual([e['label'] for e in snap['elements']], ['按钮0', '按钮7', '按钮9'])
        self.assertEqual([e['idx'] for e in snap['elements']], [1, 2, 3])
        self.assertEqual(snap['truncation']['kept'], 'viewport-first')
        clicked = self.driver.dispatch('click', {'idx': 2, 'snapshot': snap['snapshot']})
        self.assertTrue(clicked['ok'])
        resolved = [c[1]['backendNodeId'] for c in self.cdp.calls if c[0] == 'DOM.scrollIntoViewIfNeeded']
        self.assertEqual(resolved, [107])

    def test_default_max_is_300(self):
        self.cdp.nodes = [{'nodeId': f'n{i}', 'backendDOMNodeId': 100 + i, 'role': {'value': 'button'}, 'name': {'value': str(i)}} for i in range(301)]
        snap = self.driver.dispatch('snap')
        self.assertEqual(len(snap['elements']), 300)
        self.assertEqual(snap['truncation']['max'], 300)

    def test_new_params_validated_before_cdp(self):
        for action, params in (('type', {'text': 'a', 'position': 'middle'}), ('type_keys', {'text': 'a', 'position': 1}),
                               ('click', {'id': 'go', 'position': 'bottom'}), ('click', {'at': [1, 2], 'position': 'top-left'}),
                               ('edit', {'command': 'delete'})):
            self.cdp.calls.clear()
            with self.subTest(action=action, params=params):
                with self.assertRaises(BrowserControlError) as raised:
                    self.driver.dispatch(action, params)
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(self.cdp.calls, [])


class HelperTests(unittest.TestCase):
    def test_brief(self):
        self.assertEqual(_brief({'role': 'textbox', 'name': '标题', 'id': 'title', 'idx': 5}), 'textbox「标题」#title（编号 5）')
        self.assertEqual(_brief(None), '（未知元素）')

    def test_similar_prefers_contains_and_skips_noise(self):
        items = [{'label': '保存草稿'}, {'label': '删除'}, {'label': '保存'}, {'label': 'x'}]
        self.assertEqual([i['label'] for i in _similar('保存', items, ('label',))], ['保存', '保存草稿'])
        self.assertEqual(_similar('完全不同的东西', items, ('label',)), [])


class SurfaceTests(unittest.IsolatedAsyncioTestCase):
    """新参数只在 actions 表登记一次，命令行和 Python 都从表生成。"""
    def test_table_registers_new_parameters(self):
        def options(name):
            return {opt for arg in actions.COMMANDS[name].cli_args() for opt in arg.names}
        self.assertIn('--position', options('click'))
        self.assertIn('--position', options('type'))
        self.assertIn('--position', options('type-keys'))
        edit_choices = next(arg for arg in actions.COMMANDS['edit'].cli_args() if arg.dest == 'edit_command').options['choices']
        self.assertIn('undo', edit_choices)
        self.assertIn('redo', edit_choices)

    async def test_cli_and_python_send_position_only_when_given(self):
        class Client:
            def __init__(self):
                self.calls = []
            async def acall(self, action, params=None, **kwargs):
                self.calls.append((action, params))
                return {'ok': True}
        client = Client()
        await execute(['--session', 's', 'type', 'exact', '--position', 'start', '--', '前缀'], client=client)
        self.assertEqual(client.calls[-1], ('page_type', {'text': '前缀', 'allow_newline': False, 'position': 'start'}))
        await execute(['--session', 's', 'click', 'exact', '--id', 'editor', '--position', 'top-left'], client=client)
        self.assertEqual(client.calls[-1][1]['position'], 'top-left')
        await execute(['--session', 's', 'edit', 'exact', 'undo'], client=client)
        self.assertEqual(client.calls[-1], ('page_edit', {'command': 'undo'}))
        await execute(['--session', 's', 'click', 'exact', '--id', 'x'], client=client)
        self.assertNotIn('position', client.calls[-1][1])
        calls = []
        async def rpc(action, params=None, **kwargs):
            calls.append((action, params))
            return {'ok': True}
        with patch.object(browser_control, '_rpc', rpc):
            page = browser_control.page('exact')
            page._bound = True
            await page.type_text('尾巴', id='editor', position='end')
            await page.type_keys('a', position='start')
            await page.click(id='editor', position='top-left')
            await page.edit('redo')
            await page.type_text('x')
        self.assertEqual(calls[0], ('page_type', {'text': '尾巴', 'allow_newline': False, 'position': 'end', 'id': 'editor'}))
        self.assertEqual(calls[1][1]['position'], 'start')
        self.assertEqual(calls[2][1]['position'], 'top-left')
        self.assertEqual(calls[3][1], {'command': 'redo'})
        self.assertNotIn('position', calls[4][1])

    def test_snap_object_exposes_truncation_hint(self):
        snap = browser_control.Snap({'elements': [], 'truncated': True, 'truncation': {'hint': '或用 within 只看一个区域，例如 within="#content"'}})
        self.assertIn('#content', repr(snap))
        with self.assertRaises(LookupError) as raised:
            snap.one('保存')
        self.assertIn('within="#content"', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
