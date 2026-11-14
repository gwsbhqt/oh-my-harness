"""InspectService 单元边界：严格参数、清理、层叠计算。"""
import unittest
from browser_use.driver import PageDriver
from browser_use.errors import BrowserUseError
from browser_use.inspect import InspectService, _cascade, _physical
from test_page import FakeCDP

HANDLE = {'token': 't', 'targetId': 'root', 'frame': 'root', 'document': 1, 'loader': '1', 'backendNodeId': 12}


def rule(selector, props, *, origin='regular', sheet='s1', line=0, layers=None, types=None, spec=(0, 1, 0), **extra):
    return {'rule': dict({'selectorList': {'text': selector, 'selectors': [{'text': selector, 'range': {'startLine': line, 'startColumn': 0, 'endLine': line, 'endColumn': len(selector)}, 'specificity': dict(zip('abc', spec))}]},
                          'origin': origin, 'styleSheetId': sheet if origin != 'user-agent' else None, 'layers': layers or [], 'ruleTypes': types or [],
                          'style': {'cssProperties': [dict(p, range={'startLine': line, 'startColumn': 0, 'endLine': line, 'endColumn': 1}) for p in props]}}, **extra),
            'matchingSelectors': [0]}


class InspectCDP(FakeCDP):
    def __init__(self):
        super().__init__()
        self.responses = {}

    def call(self, method, params=None, *, session_id=None, timeout=20):
        if method in self.responses:
            p = params or {}
            self.calls.append((method, p, session_id))
            if method == self.timeout_method: raise BrowserUseError('timeout', 4, outcome='unknown')
            value = self.responses[method]
            if isinstance(value, Exception): raise value
            if method == 'Runtime.evaluate' and p.get('expression') == 'document': return super().call(method, params, session_id=session_id, timeout=timeout)
            return value(p) if callable(value) else value
        return super().call(method, params, session_id=session_id, timeout=timeout)


class InspectTests(unittest.TestCase):
    def setUp(self):
        self.cdp = InspectCDP()
        self.driver = PageDriver(self.cdp, 'root', 'session')
        self.driver.owned = True
        self.service = InspectService(self.driver)

    def tearDown(self):
        self.service.close()
        self.driver.close()

    def code(self, code, action, params):
        with self.assertRaises(BrowserUseError) as raised: self.service.dispatch(action, params)
        self.assertEqual(raised.exception.code, code, str(raised.exception))
        return raised.exception

    def methods(self):
        return [c[0] for c in self.cdp.calls]

    def test_strict_params_reject_before_any_cdp(self):
        bad = [
            ('css', {}), ('css', {'handle': HANDLE, 'selector': {'css': 'p'}}), ('css', {'selector': {'css': ''}}),
            ('css', {'selector': {'id': 'x'}}), ('css', {'selector': {'css': 'p'}, 'page_size': 0}), ('css', {'selector': {'css': 'p'}, 'page_idx': -1}),
            ('css', {'selector': {'css': 'p'}, 'page_size': True}), ('css', {'handle': dict(HANDLE, extra=1)}), ('css', {'handle': dict(HANDLE, backendNodeId='12')}),
            ('unknown', {}), ('css', ['not', 'dict']),
        ]
        for action, params in bad:
            with self.subTest(action=action, params=params):
                self.cdp.calls.clear()
                self.code(2, action, params)
                self.assertEqual(self.cdp.calls, [])

    def test_prefix_routing_and_closed_service(self):
        self.code(2, 'inspect_css', {})
        self.service.close()
        self.code(4, 'inspect_css', {'selector': {'css': 'p'}})

    def test_css_handle_must_match_document(self):
        self.driver.check()
        self.code(4, 'css', {'handle': dict(HANDLE, targetId='other')})
        self.code(4, 'css', {'handle': dict(HANDLE, document=99)})
        self.assertNotIn('CSS.enable', self.methods())

    def test_css_selector_must_be_unique(self):
        self.cdp.responses['DOM.getDocument'] = {'root': {'nodeId': 1}}
        self.cdp.responses['DOM.querySelectorAll'] = {'nodeIds': [3, 4]}
        self.assertEqual(self.code(3, 'css', {'selector': {'css': 'p'}}).data['count'], 2)
        self.cdp.responses['DOM.querySelectorAll'] = BrowserUseError('DOM Error while querying', 1)
        self.code(2, 'css', {'selector': {'css': '[['}})
        self.assertNotIn('CSS.enable', self.methods())

    def test_css_output_cascade_sources_pagination_and_cleanup(self):
        self.cdp.responses.update({
            'DOM.getDocument': {'root': {'nodeId': 1}}, 'DOM.querySelectorAll': {'nodeIds': [7]},
            'DOM.describeNode': lambda p: {'node': {'backendNodeId': 12 if p.get('nodeId') == 7 else self.cdp.document}},
            'DOM.pushNodesByBackendIdsToFrontend': {'nodeIds': [7]},
            'CSS.enable': lambda p: self.cdp.emit('CSS.styleSheetAdded', {'header': {'styleSheetId': 's1', 'sourceURL': 'http://x/a.css', 'startLine': 0, 'startColumn': 0, 'origin': 'regular'}}, 'session') or {},
            'CSS.getComputedStyleForNode': {'computedStyle': [{'name': '--accent', 'value': 'red'}, {'name': 'color', 'value': 'green'}]},
            'CSS.getMatchedStylesForNode': {
                'inlineStyle': {'cssProperties': [{'name': 'margin-top', 'value': '4px', 'range': {}}]},
                'attributesStyle': {'cssProperties': [{'name': 'text-align', 'value': 'center'}]},
                'matchedCSSRules': [
                    rule('p', [{'name': 'display', 'value': 'block'}, {'name': 'margin-block-start', 'value': '1em'}], origin='user-agent'),
                    rule('#t', [{'name': 'color', 'value': 'red !important', 'important': True}], line=2, layers=[{'text': 'base'}], types=['LayerRule'], spec=(1, 0, 0)),
                    rule('#t', [{'name': 'color', 'value': 'green !important', 'important': True}], line=5, layers=[{'text': 'theme'}], types=['LayerRule'], spec=(1, 0, 0)),
                    rule('.box', [{'name': 'color', 'value': 'blue'}, {'name': 'margin', 'value': '1px', 'longhandProperties': [{'name': n, 'value': '1px'} for n in ('margin-top', 'margin-right', 'margin-bottom', 'margin-left')]}], line=7,
                         media=[{'text': '(min-width: 1px)'}], types=['MediaRule']),
                    rule('#t', [{'name': 'color', 'value': 'black'}], line=9, spec=(1, 0, 0)),
                ],
                'inherited': [{'matchedCSSRules': [rule('body', [{'name': 'color', 'value': 'purple'}, {'name': 'font-size', 'value': '20px'}, {'name': 'display', 'value': 'flex'}, {'name': '--x', 'value': '1'}], line=0)]}],
                'pseudoElements': [{'pseudoType': 'before', 'matches': [rule('.box::before', [{'name': 'content', 'value': '"x"'}], line=11)]}],
            }})
        self.cdp.responses['Runtime.callFunctionOn'] = lambda p: {'result': {'value': {'connected': True, 'element': True, 'selector': 'p#t.box', 'ancestors': ['div#wrap', 'body', 'html']}}} if 'ancestors' in p['functionDeclaration'] else {'result': {'value': self.cdp.meta}}
        result = self.service.dispatch('css', {'selector': {'css': '#t'}, 'page_size': 3})
        self.assertEqual(result['pagination'], {'pageIdx': 0, 'pageSize': 3, 'totalRules': 9, 'totalPages': 3, 'hasNextPage': True})
        first = result['rules']
        self.assertEqual([r['type'] for r in first], ['inline', 'matched', 'matched'])
        self.assertEqual(first[1]['source'], {'kind': 'stylesheet', 'styleSheetId': 's1', 'url': 'http://x/a.css', 'line': 10, 'column': 1, 'inline': False, 'constructed': False, 'label': 'a.css:10'})
        self.assertEqual(first[1]['properties'][0]['status'], 'overloaded')
        media = first[2]
        self.assertEqual(media['ancestors'], [{'type': 'media', 'query': '(min-width: 1px)'}])
        margin = media['properties'][1]
        self.assertEqual(margin['status'], 'active')
        self.assertEqual({x['name']: x['status'] for x in margin['longhands']}['margin-top'], 'overloaded')
        rules = first + self.service.dispatch('css', {'selector': {'css': '#t'}, 'page_size': 3, 'page_idx': 1})['rules'] + self.service.dispatch('css', {'selector': {'css': '#t'}, 'page_size': 3, 'page_idx': 2})['rules']
        layered = {r['ancestors'][0]['name']: r['properties'][0] for r in rules if r.get('ancestors') and r['ancestors'][0]['type'] == 'layer'}
        self.assertEqual(layered['base']['status'], 'active')
        self.assertEqual(layered['theme']['status'], 'overloaded')
        self.assertTrue(layered['base']['important'])
        self.assertEqual(layered['base']['value'], 'red')
        ua = next(r for r in rules if r.get('origin') == 'user-agent')
        self.assertEqual(ua['source']['label'], 'user agent stylesheet')
        self.assertEqual({p['name']: p['status'] for p in ua['properties']}['margin-block-start'], 'overloaded')
        inherited = next(r for r in rules if r['type'] == 'inherited')
        self.assertEqual(inherited['node'], {'selector': 'div#wrap', 'distance': 1})
        self.assertEqual({p['name']: p['status'] for p in inherited['properties']}, {'color': 'overloaded', 'font-size': 'active', '--x': 'active'})
        self.assertEqual(next(r for r in rules if r['type'] == 'pseudo')['pseudoType'], '::before')
        self.assertEqual(result['customProperties'], [{'name': '--accent', 'value': 'red'}])
        self.assertTrue(result['sourceComplete'])
        self.code(2, 'css', {'selector': {'css': '#t'}, 'page_idx': 9})
        self.assertEqual(self.methods().count('CSS.enable'), 1)
        self.service.close()
        self.assertIn('CSS.disable', self.methods())


class CascadeTests(unittest.TestCase):
    def source(self, index, props, *, origin='regular', kind='rule', layer=None, spec=(0, 0, 0)):
        return {'kind': kind, 'origin': origin, 'index': index, 'layer': layer, 'specificity': spec, 'style': {'cssProperties': props}}

    def test_specificity_beats_order_and_important_reverses_layers(self):
        sources = [self.source(0, [{'name': 'color', 'value': 'a'}], spec=(1, 0, 0)), self.source(1, [{'name': 'color', 'value': 'b'}], spec=(0, 1, 0))]
        self.assertEqual(_cascade(sources), {(0, 0): {'color': True}, (1, 0): {'color': False}})
        sources = [self.source(0, [{'name': 'color', 'value': 'a', 'important': True}], layer=0), self.source(1, [{'name': 'color', 'value': 'b', 'important': True}], layer=1),
                   self.source(2, [{'name': 'color', 'value': 'c', 'important': True}])]
        self.assertTrue(_cascade(sources)[(0, 0)]['color'])
        sources = [self.source(0, [{'name': 'color', 'value': 'a'}], layer=0), self.source(1, [{'name': 'color', 'value': 'b'}], layer=1), self.source(2, [{'name': 'color', 'value': 'c'}])]
        self.assertTrue(_cascade(sources)[(2, 0)]['color'])

    def test_inline_user_agent_disabled_and_invalid(self):
        sources = [self.source(0, [{'name': 'color', 'value': 'ua', 'important': True}], origin='user-agent'),
                   self.source(1, [{'name': 'color', 'value': 'x', 'important': True}]),
                   self.source(2, [{'name': 'width', 'value': '1px'}], kind='inline'),
                   self.source(3, [{'name': 'width', 'value': '2px', 'disabled': True}, {'name': 'width', 'value': 'bad', 'parsedOk': False}], spec=(9, 9, 9))]
        result = _cascade(sources)
        self.assertTrue(result[(0, 0)]['color'])
        self.assertTrue(result[(2, 0)]['width'])
        self.assertFalse(result[(3, 0)]['width'])
        self.assertFalse(result[(3, 1)]['width'])

    def test_logical_properties_map_by_writing_mode(self):
        self.assertEqual(_physical('margin-inline-start', ('horizontal-tb', 'ltr')), 'margin-left')
        self.assertEqual(_physical('margin-inline-start', ('horizontal-tb', 'rtl')), 'margin-right')
        self.assertEqual(_physical('padding-block-end', ('vertical-rl', 'ltr')), 'padding-left')
        self.assertEqual(_physical('border-block-start-color', ('horizontal-tb', 'ltr')), 'border-top-color')
        self.assertEqual(_physical('inset-inline-end', ('horizontal-tb', 'ltr')), 'right')
        self.assertEqual(_physical('inline-size', ('vertical-lr', 'ltr')), 'height')


if __name__ == '__main__':
    unittest.main()
