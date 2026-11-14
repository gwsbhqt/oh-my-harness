"""页面检查服务：CSS 规则来源与胜出覆盖；只读页面状态。"""
from __future__ import annotations
import math
import re
from urllib.parse import urlsplit
import uuid
from .checks import gone, integer, stale
from .errors import BrowserUseError

_PARAMS = {
    'css': {'handle', 'selector', 'page_idx', 'page_size'},
}
_HANDLE = {'token', 'targetId', 'frame', 'document', 'loader', 'backendNodeId'}
_BIG = 1 << 30

# CSS 规范标为 inherited 的属性；CDP 不提供这项元数据，与官方 DevTools CSSMetadata 对照维护。
_INHERITED = frozenset("""
border-collapse border-spacing caption-side color cursor direction empty-cells font font-family
font-feature-settings font-kerning font-language-override font-optical-sizing font-palette font-size
font-size-adjust font-stretch font-style font-synthesis font-synthesis-small-caps font-synthesis-style
font-synthesis-weight font-variant font-variant-alternates font-variant-caps font-variant-east-asian
font-variant-emoji font-variant-ligatures font-variant-numeric font-variant-position font-variation-settings
font-weight forced-color-adjust hyphenate-character hyphenate-limit-chars hyphens image-orientation
image-rendering letter-spacing line-break line-height list-style list-style-image list-style-position
list-style-type math-depth math-shift math-style orphans overflow-wrap paint-order pointer-events
print-color-adjust quotes ruby-align ruby-position speak tab-size text-align text-align-last text-anchor
text-combine-upright text-decoration-skip-ink text-emphasis text-emphasis-color text-emphasis-position
text-emphasis-style text-indent text-justify text-orientation text-rendering text-shadow text-size-adjust
text-transform text-underline-offset text-underline-position text-wrap text-wrap-mode text-wrap-style
visibility white-space white-space-collapse widows word-break word-spacing word-wrap writing-mode
caret-color accent-color color-scheme dominant-baseline fill fill-opacity fill-rule stroke stroke-dasharray
stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width clip-rule
color-interpolation color-interpolation-filters color-rendering marker marker-start marker-mid marker-end
shape-rendering -webkit-text-fill-color -webkit-text-stroke -webkit-text-stroke-color -webkit-text-stroke-width
-webkit-text-security -webkit-locale -webkit-font-smoothing -webkit-tap-highlight-color -webkit-text-size-adjust
-webkit-print-color-adjust -webkit-hyphenate-character -webkit-user-modify -webkit-rtl-ordering -webkit-line-break
-webkit-highlight -webkit-border-horizontal-spacing -webkit-border-vertical-spacing
""".split())

_DESCRIBE = r"""function(){
 const simple=e=>{let s=(e.localName||e.nodeName||'').toLowerCase();if(e.id)s+='#'+e.id;const c=typeof e.className==='string'?e.className.trim().split(/\s+/).filter(Boolean):[];if(c.length)s+='.'+c.slice(0,3).join('.');return s};
 const out=[];let n=this;
 for(let i=0;i<500;i++){n=n.assignedSlot||n.parentElement||(n.parentNode&&n.parentNode.host)||null;if(!n||n.nodeType!==1)break;out.push(simple(n))}
 return {connected:this.isConnected,element:this.nodeType===1,selector:this.nodeType===1?simple(this):null,ancestors:out};
}"""


def _css_selector(value, name):
    if not isinstance(value, dict) or set(value) != {'css'} or not isinstance(value['css'], str) or not value['css'].strip() or len(value['css']) > 2000:
        raise BrowserUseError(f'{name} 只接受 {{"css": "非空选择器"}}', 2)
    return value['css']


def _layer_key(rule):
    key = []
    for layer in rule.get('layers') or []:
        text = layer.get('text') or ''
        if text: key.extend(text.split('.'))
        else:
            start = layer.get('range') or {}
            key.append(('', layer.get('styleSheetId'), start.get('startLine'), start.get('startColumn')))
    return tuple(key)


def _declared(style):
    props = style.get('cssProperties') or []
    ranged = [p for p in props if p.get('range')]
    return ranged or props


def _longhands(prop):
    return [x['name'] for x in prop.get('longhandProperties') or [] if x.get('name')] or [prop['name']]


_LOGICAL = re.compile(r'^(margin|padding|border|inset|scroll-margin|scroll-padding)-(block|inline)-(start|end)(-[a-z]+)?$')
_SIZES = {'inline-size': ('width', 'height'), 'block-size': ('height', 'width'), 'min-inline-size': ('min-width', 'min-height'), 'min-block-size': ('min-height', 'min-width'),
          'max-inline-size': ('max-width', 'max-height'), 'max-block-size': ('max-height', 'max-width'), 'contain-intrinsic-inline-size': ('contain-intrinsic-width', 'contain-intrinsic-height'),
          'contain-intrinsic-block-size': ('contain-intrinsic-height', 'contain-intrinsic-width')}


def _physical(name, mode):
    """按元素的 writing-mode/direction 把逻辑属性换成对应物理属性，二者才会互相覆盖。"""
    if not mode: return name
    writing, direction = mode
    vertical = writing.startswith('vertical') or writing.startswith('sideways')
    if name in _SIZES: return _SIZES[name][1 if vertical else 0]
    match = _LOGICAL.match(name)
    if not match: return name
    prefix, axis, edge, suffix = match.group(1), match.group(2), match.group(3), match.group(4) or ''
    if axis == 'block':
        side = ('top', 'bottom') if not vertical else (('right', 'left') if writing.endswith('rl') else ('left', 'right'))
    else:
        side = ('left', 'right') if not vertical else ('top', 'bottom')
        if direction == 'rtl': side = side[::-1]
    side = side[0 if edge == 'start' else 1]
    return side if prefix == 'inset' else f'{prefix}-{side}{suffix}'


def _priority(source, important, position):
    author = source['origin'] != 'user-agent'
    tier = (3 if author else 5) if important else (2 if author else 0)
    attached = 1 if source['kind'] == 'inline' else 0
    if source['kind'] == 'attributes': layer = -_BIG - 1
    elif source['kind'] == 'inline' or not author: layer = 0
    else:
        rank = source.get('layer')
        layer = (_BIG if rank is None else rank) if not important else (-_BIG if rank is None else -rank)
    return (tier, attached, layer, source.get('specificity', (0, 0, 0)), source['index'], position)


def _cascade(sources, mode=None):
    """按层叠顺序返回每条声明及每个展开属性的胜负：{(来源序号, 声明序号): {longhand: 是否胜出}}。"""
    best, decls = {}, []
    for si, source in enumerate(sources):
        for di, prop in enumerate(_declared(source['style'])):
            valid = not prop.get('disabled') and prop.get('parsedOk', True) is not False
            key = _priority(source, bool(prop.get('important')), di)
            decls.append((si, di, _longhands(prop), valid, key))
            if valid:
                for name in _longhands(prop):
                    canonical = _physical(name, mode)
                    if canonical not in best or key > best[canonical][0]: best[canonical] = (key, (si, di))
    return {(si, di): {n: valid and best.get(_physical(n, mode), (None, None))[1] == (si, di) for n in names} for si, di, names, valid, _ in decls}


class InspectService:
    def __init__(self, driver):
        self.driver, self.cdp = driver, driver.cdp
        self.close_errors = []
        self._group = 'browser-use-inspect-' + uuid.uuid4().hex
        self._sheets = {}
        self._css_sessions = set()
        self._sheet_loss = False
        self._closed = False
        self._unsubscribers = [
            self.cdp.on('CSS.styleSheetAdded', lambda p, s: self._sheet_added(p, s)),
            self.cdp.on('CSS.styleSheetRemoved', lambda p, s: self._sheets.pop((s, p.get('styleSheetId')), None)),
        ]

    def _sheet_added(self, params, sid):
        header = params.get('header') or {}
        if sid in self.driver.session_ids and header.get('styleSheetId'):
            self._sheets[(sid, header['styleSheetId'])] = header
            while len(self._sheets) > 5000: self._sheets.pop(next(iter(self._sheets)))

    def dispatch(self, action, params=None):
        if action.startswith('inspect_'): action = action[8:]
        if self._closed: raise BrowserUseError('检查服务已释放', 4)
        if action not in _PARAMS: raise BrowserUseError(f'不支持检查动作：{action}', 2)
        p = {} if params is None else params
        if not isinstance(p, dict): raise BrowserUseError('params 需要对象', 2)
        unknown = set(p) - _PARAMS[action]
        if unknown: raise BrowserUseError(f'{action} 不支持参数：' + ', '.join(sorted(unknown)), 2)
        options = getattr(self, '_check_' + action)(p)
        with self.driver._lock:
            self.driver.check()
            try: return getattr(self, '_' + action)(options)
            finally: self._release_group()

    def _release_group(self):
        for sid in self.driver.session_ids:
            try: self.driver._call(sid, 'Runtime.releaseObjectGroup', {'objectGroup': self._group}, 5)
            except BrowserUseError as exc:
                if exc.outcome == 'unknown' or not (gone(exc) or stale(exc)): raise

    def _main_frame(self):
        for fid, frame in self.driver._frames_cache.items():
            if not frame.get('parent') and frame['session'] == self.driver.session_id: return fid, frame
        raise BrowserUseError('主页面文档不可用', 4)

    def _object(self, sid, backend, context):
        result = self.driver._call(sid, 'DOM.resolveNode', {'backendNodeId': backend, 'executionContextId': context, 'objectGroup': self._group})
        oid = result.get('object', {}).get('objectId')
        if not oid: raise BrowserUseError('元素节点已失效', 4)
        return oid

    def _call_on(self, sid, oid, function, args=(), timeout=20):
        result = self.driver._call(sid, 'Runtime.callFunctionOn', {'objectId': oid, 'functionDeclaration': function, 'arguments': [{'value': a} for a in args], 'returnByValue': True, 'awaitPromise': True}, timeout)
        return self.driver._result(result)

    # ---------------- CSS ----------------
    def _check_css(self, p):
        if ('handle' in p) == ('selector' in p): raise BrowserUseError('css 需要且只需要 handle 或 selector', 2)
        options = {'page_idx': integer(p.get('page_idx', 0), 'page_idx', 0, 100000), 'page_size': integer(p.get('page_size', 10), 'page_size', 1, 100)}
        if 'handle' in p:
            handle = p['handle']
            if not isinstance(handle, dict) or set(handle) != _HANDLE or not all(isinstance(handle[k], str) and handle[k] for k in ('token', 'targetId', 'frame')) or isinstance(handle['backendNodeId'], bool) or not isinstance(handle['backendNodeId'], int) or handle['backendNodeId'] <= 0:
                raise BrowserUseError('handle 结构不合法；只能原样传 element resolve 返回的句柄', 2)
            options['handle'] = dict(handle)
        else: options['css'] = _css_selector(p['selector'], 'selector')
        return options

    def _css_node(self, options):
        if 'handle' in options:
            handle = options['handle']
            frame = self.driver._frames_cache.get(handle['frame'])
            if handle['targetId'] != self.driver.target_id or not frame or frame['document'] != handle['document'] or frame.get('loader') != handle['loader']:
                raise BrowserUseError('元素所属目标或文档已变化；不能跨目标或跨文档使用句柄', 4)
            fid, backend = handle['frame'], handle['backendNodeId']
            root = self.driver._call(frame['session'], 'DOM.getDocument', {'depth': 0})['root']['nodeId']
        else:
            fid, frame = self._main_frame()
            root = self.driver._call(frame['session'], 'DOM.getDocument', {'depth': 0})['root']['nodeId']
            try: ids = self.driver._call(frame['session'], 'DOM.querySelectorAll', {'nodeId': root, 'selector': options['css']})['nodeIds']
            except BrowserUseError as exc:
                if exc.outcome == 'unknown' or exc.code != 1: raise
                raise BrowserUseError('CSS 选择器无效：' + str(exc), 2) from exc
            if len(ids) != 1: raise BrowserUseError(f'选择器匹配到 {len(ids)} 个元素；拒绝猜测', 3, data={'count': len(ids)})
            backend = self.driver._call(frame['session'], 'DOM.describeNode', {'nodeId': ids[0]})['node']['backendNodeId']
        sid = frame['session']
        try:
            info = self._call_on(sid, self._object(sid, backend, frame['context']), _DESCRIBE)
        except BrowserUseError as exc:
            if exc.outcome == 'unknown' or exc.code == 5: raise
            raise BrowserUseError('元素节点已失效', 4) from exc
        if not info['connected']: raise BrowserUseError('元素已从文档移除', 4)
        if not info['element']: raise BrowserUseError('css 只检查元素节点', 2)
        pushed = self.driver._call(sid, 'DOM.pushNodesByBackendIdsToFrontend', {'backendNodeIds': [backend]})['nodeIds']
        if not pushed or not pushed[0]: raise BrowserUseError('元素节点已失效', 4)
        return fid, sid, backend, pushed[0], info

    def _css(self, options):
        fid, sid, backend, node, info = self._css_node(options)
        if sid not in self._css_sessions:
            loss = getattr(self.cdp, 'event_loss', 0)
            self.driver._call(sid, 'CSS.enable')
            self._css_sessions.add(sid)
            flush = getattr(self.cdp, 'flush_events', None)
            if callable(flush): flush(timeout=10)
            if getattr(self.cdp, 'event_loss', 0) != loss: self._sheet_loss = True
        matched = self.driver._call(sid, 'CSS.getMatchedStylesForNode', {'nodeId': node})
        computed = self.driver._call(sid, 'CSS.getComputedStyleForNode', {'nodeId': node}).get('computedStyle', [])
        values = {c.get('name'): c.get('value', '') for c in computed}
        rules = self._css_rules(sid, node, matched, info, (values.get('writing-mode', 'horizontal-tb'), values.get('direction', 'ltr')))
        total, size, index = len(rules), options['page_size'], options['page_idx']
        pages = max(1, math.ceil(total / size))
        if index >= pages: raise BrowserUseError(f'page_idx 超出范围；共 {pages} 页', 2, data={'totalRules': total, 'totalPages': pages})
        custom = [{'name': c['name'], 'value': c['value']} for c in computed if c.get('name', '').startswith('--')]
        missing = sorted({r['source']['styleSheetId'] for r in rules if r.get('source', {}).get('styleSheetId') and r['source'].get('url') is None and r['source'].get('kind') == 'stylesheet'})
        result = {'ok': True, 'element': {'selector': info['selector'], 'frame': fid, 'backendNodeId': backend},
                  'rules': rules[index*size:(index+1)*size],
                  'pagination': {'pageIdx': index, 'pageSize': size, 'totalRules': total, 'totalPages': pages, 'hasNextPage': index + 1 < pages},
                  'customProperties': custom[:200], 'customPropertiesTruncated': len(custom) > 200,
                  'source': 'CDP CSS.getMatchedStylesForNode',
                  'limitations': ['胜负按层叠规则自行计算：来源与 !important、内联、@layer、特异性、出现顺序；逻辑属性按元素的 writing-mode/direction 映射到物理属性', '不含动画、过渡、@scope 就近规则与 shadow DOM 上下文的层叠优先级', '继承属性按 CSS 规范列表判断，未注册自定义属性一律视为可继承']}
        if missing or self._sheet_loss: result['sourceComplete'] = False; result['unknownStyleSheets'] = missing
        else: result['sourceComplete'] = True
        if 'handle' in options: result['element']['handle'] = options['handle']
        return result

    def _source(self, sid, rule, origin):
        if origin == 'user-agent': return {'kind': 'user-agent', 'label': 'user agent stylesheet'}
        if origin == 'injected': base = {'kind': 'injected', 'label': 'injected stylesheet'}
        elif origin == 'inspector': base = {'kind': 'inspector', 'label': 'via inspector'}
        else: base = {'kind': 'stylesheet'}
        ssid = rule.get('styleSheetId')
        header = self._sheets.get((sid, ssid)) if ssid else None
        selectors = (rule.get('selectorList') or {}).get('selectors') or []
        rng = (selectors[0].get('range') if selectors else None) or (rule.get('propertyName') or {}).get('range') or (rule.get('keyText') or {}).get('range') or (rule.get('style') or {}).get('range')
        base['styleSheetId'] = ssid
        if header is None:
            base.update(url=None, line=None, column=None)
            base.setdefault('label', '<unknown>')
            return base
        url = header.get('sourceURL') or ''
        line = column = None
        if rng:
            line = header.get('startLine', 0) + rng['startLine'] + 1
            column = (header.get('startColumn', 0) if rng['startLine'] == 0 else 0) + rng['startColumn'] + 1
        base.update(url=url or None, line=line, column=column, inline=bool(header.get('isInline')), constructed=bool(header.get('isConstructed')))
        if 'label' not in base:
            if header.get('isConstructed') and not url: name = 'constructed stylesheet'
            elif header.get('isInline') or not url: name = '<style>'
            elif url.startswith('data:'): name = 'data-uri'
            elif url.startswith('blob:'): name = 'blob'
            else: name = urlsplit(url).path.rstrip('/').rsplit('/', 1)[-1] or 'index'
            base['label'] = name + (f':{line}' if line else '')
        return base

    def _ancestors(self, sid, node, rule, containers):
        counters = {k: 0 for k in ('media', 'containerQueries', 'layers', 'scopes', 'supports', 'nestingSelectors', 'navigations')}
        # ruleTypes 由内向外排列；Chrome 的 layers 数组却是由外向内，其余数组与 ruleTypes 同向（Chrome 155 实测）。
        def take(field):
            values = rule.get(field) or []
            i = counters[field]; counters[field] += 1
            if field == 'layers': i = len(values) - 1 - i
            return values[i] if 0 <= i < len(values) else None
        out = []
        for kind in rule.get('ruleTypes') or []:
            item = None
            if kind == 'MediaRule':
                q = take('media'); item = {'type': 'media', 'query': q['text']} if q and q.get('text') else None
            elif kind == 'ContainerRule':
                q = take('containerQueries')
                if q is not None:
                    item = {'type': 'container', 'query': q.get('text', '')}
                    if q.get('name'): item['name'] = q['name']
                    container = self._container(sid, node, q, containers)
                    if container: item['container'] = container
            elif kind == 'LayerRule':
                q = take('layers'); item = {'type': 'layer', 'name': q['text']} if q and q.get('text') else ({'type': 'layer'} if q is not None else None)
            elif kind == 'ScopeRule':
                q = take('scopes'); item = ({'type': 'scope', 'query': q['text']} if q.get('text') else {'type': 'scope'}) if q is not None else None
            elif kind == 'SupportsRule':
                q = take('supports')
                if q and q.get('text'): item = {'type': 'supports', 'query': q['text'], 'active': q.get('active', True)}
            elif kind == 'StartingStyleRule': item = {'type': 'starting-style'}
            elif kind == 'StyleRule':
                q = take('nestingSelectors'); item = {'type': 'nesting', 'selector': q} if q else None
            elif kind == 'NavigationRule':
                q = take('navigations'); item = {'type': 'navigation', 'query': q['text']} if q and q.get('text') else None
            if item: out.append(item)
        out.reverse()
        return out

    def _container(self, sid, node, query, cache):
        key = (query.get('name'), query.get('physicalAxes'), query.get('logicalAxes'))
        if key not in cache:
            cache[key] = None
            args = {'nodeId': node}
            for name in ('physicalAxes', 'logicalAxes', 'queriesScrollState', 'queriesAnchored'):
                if query.get(name) is not None: args[name] = query[name]
            if query.get('name'): args['containerName'] = query['name']
            try:
                found = self.driver._call(sid, 'CSS.getContainerForNode', args).get('nodeId')
                if found:
                    described = self.driver._call(sid, 'DOM.describeNode', {'nodeId': found})['node']
                    attrs = described.get('attributes') or []
                    attrs = dict(zip(attrs[0::2], attrs[1::2]))
                    selector = described.get('localName') or described.get('nodeName', '').lower()
                    if attrs.get('id'): selector += '#' + attrs['id']
                    classes = attrs.get('class', '').split()
                    if classes: selector += '.' + '.'.join(classes[:3])
                    cache[key] = {'selector': selector, 'backendNodeId': described.get('backendNodeId')}
            except BrowserUseError as exc:
                if exc.outcome == 'unknown' or exc.code != 1: raise
        return cache[key]

    def _props(self, style, verdicts, si, keep=None):
        out = []
        for di, prop in enumerate(_declared(style)):
            names = _longhands(prop)
            if keep is not None and not any(keep(n) for n in names + [prop['name']]): continue
            wins = verdicts.get((si, di), {})
            if keep is not None: wins = {n: w for n, w in wins.items() if keep(n)}
            if prop.get('parsedOk', True) is False: status = 'invalid'
            elif prop.get('disabled'): status = 'disabled'
            else: status = 'active' if any(wins.values()) else 'overloaded'
            value = prop.get('value', '')
            important = bool(prop.get('important'))
            if important:
                lowered = value.rstrip()
                if lowered.lower().endswith('!important'): value = lowered[:-10].rstrip()
            item = {'name': prop['name'], 'value': value[:1000], 'status': status}
            if len(value) > 1000: item['valueTruncated'] = True
            if important: item['important'] = True
            if prop.get('longhandProperties'):
                item['longhands'] = [{'name': x['name'], 'value': x.get('value', ''), 'status': ('active' if wins.get(x['name']) else 'overloaded') if status in ('active', 'overloaded') else status}
                                     for x in prop['longhandProperties'] if keep is None or keep(x['name'])]
            out.append(item)
        return out

    @staticmethod
    def _specificity(match):
        selectors = (match['rule'].get('selectorList') or {}).get('selectors') or []
        specs = [selectors[i]['specificity'] for i in match.get('matchingSelectors') or [] if i < len(selectors) and selectors[i].get('specificity')]
        return max(((s.get('a', 0), s.get('b', 0), s.get('c', 0)) for s in specs), default=(0, 0, 0))

    def _sources(self, matches, inline=None, attributes=None):
        ranks = {}
        for match in matches:
            rule = match['rule']
            key = _layer_key(rule)
            if rule.get('origin') != 'user-agent' and key and key not in ranks: ranks[key] = len(ranks)
        sources = []
        if attributes and attributes.get('cssProperties'): sources.append({'kind': 'attributes', 'origin': 'regular', 'index': -1, 'style': attributes})
        for i, match in enumerate(matches):
            rule = match['rule']; key = _layer_key(rule)
            sources.append({'kind': 'rule', 'origin': rule.get('origin', 'regular'), 'index': i, 'layer': ranks.get(key) if key else None, 'specificity': self._specificity(match), 'style': rule.get('style') or {}, 'match': match})
        if inline and inline.get('cssProperties'): sources.append({'kind': 'inline', 'origin': 'regular', 'index': len(matches), 'style': inline})
        return sources

    def _rule(self, sid, node, source, verdicts, si, containers, keep=None):
        if source['kind'] == 'inline': return {'type': 'inline', 'selector': 'element.style', 'properties': self._props(source['style'], verdicts, si, keep)}
        if source['kind'] == 'attributes': return {'type': 'attributes', 'selector': '[attributes style]', 'properties': self._props(source['style'], verdicts, si, keep)}
        match = source['match']; rule = match['rule']
        selectors = (rule.get('selectorList') or {}).get('selectors') or []
        indexes = match.get('matchingSelectors') or []
        item = {'type': 'matched', 'selector': (rule.get('selectorList') or {}).get('text', ''), 'origin': rule.get('origin', 'regular'),
                'source': self._source(sid, rule, rule.get('origin', 'regular'))}
        if len(selectors) > 1 and indexes: item['matchingSelectors'] = [selectors[i]['text'] for i in indexes if i < len(selectors)]
        if any(i < len(selectors) and selectors[i].get('specificity') for i in indexes): item['specificity'] = list(source['specificity'])
        ancestors = self._ancestors(sid, node, rule, containers)
        if ancestors: item['ancestors'] = ancestors
        item['properties'] = self._props(source['style'], verdicts, si, keep)
        return item

    def _css_rules(self, sid, node, matched, info, mode=None):
        containers = {}
        own = self._sources(matched.get('matchedCSSRules') or [], matched.get('inlineStyle'), matched.get('attributesStyle'))
        verdicts = _cascade(own, mode)
        rules = []
        order = [i for i, s in enumerate(own) if s['kind'] == 'inline'] + [i for i, s in reversed(list(enumerate(own))) if s['kind'] == 'rule' and s['origin'] != 'user-agent'] + [i for i, s in enumerate(own) if s['kind'] == 'attributes'] + [i for i, s in reversed(list(enumerate(own))) if s['kind'] == 'rule' and s['origin'] == 'user-agent']
        for si in order:
            rule = self._rule(sid, node, own[si], verdicts, si, containers)
            if rule['properties']: rules.append(rule)
        taken = {name for wins in verdicts.values() for name, won in wins.items() if won}
        registered = {r.get('propertyName'): r.get('inherits') for r in matched.get('cssPropertyRegistrations') or []}
        for rule in matched.get('cssPropertyRules') or []:
            name = (rule.get('propertyName') or {}).get('text')
            for prop in (rule.get('style') or {}).get('cssProperties') or []:
                if prop.get('name') == 'inherits': registered[name] = prop.get('value', '').strip() == 'true'
        def inheritable(name): return registered.get(name, True) if name.startswith('--') else name in _INHERITED
        ancestors = info.get('ancestors') or []
        for depth, level in enumerate(matched.get('inherited') or []):
            sources = self._sources(level.get('matchedCSSRules') or [], level.get('inlineStyle'))
            level_verdicts = _cascade(sources)
            adjusted = {k: {n: w and n not in taken for n, w in v.items()} for k, v in level_verdicts.items()}
            label = ancestors[depth] if depth < len(ancestors) else None
            for si in [i for i, s in enumerate(sources) if s['kind'] == 'inline'] + [i for i, s in reversed(list(enumerate(sources))) if s['kind'] == 'rule']:
                rule = self._rule(sid, node, sources[si], adjusted, si, containers, inheritable)
                if not rule['properties']: continue
                rule['type'] = 'inherited'
                rule['node'] = {'selector': label, 'distance': depth + 1}
                rules.append(rule)
            taken |= {n for wins in level_verdicts.values() for n, won in wins.items() if won and inheritable(n)}
        for pseudo in matched.get('pseudoElements') or []:
            sources = self._sources(pseudo.get('matches') or [])
            pseudo_verdicts = _cascade(sources)
            name = '::' + pseudo.get('pseudoType', '') + (f"({pseudo['pseudoIdentifier']})" if pseudo.get('pseudoIdentifier') else '')
            for si in reversed(range(len(sources))):
                rule = self._rule(sid, node, sources[si], pseudo_verdicts, si, containers)
                if not rule['properties']: continue
                rule['type'] = 'pseudo'; rule['pseudoType'] = name
                rules.append(rule)
        for frames in matched.get('cssKeyframesRules') or []:
            name = (frames.get('animationName') or {}).get('text', '')
            steps = [{'keyText': (k.get('keyText') or {}).get('text', ''), 'properties': [{'name': p['name'], 'value': p.get('value', '')} for p in _declared(k.get('style') or {})]} for k in frames.get('keyframes') or []]
            first = (frames.get('keyframes') or [{}])[0]
            rules.append({'type': 'keyframes', 'name': name, 'selector': '@keyframes ' + name, 'source': self._source(sid, first, first.get('origin', 'regular')), 'keyframes': steps})
        for rule in matched.get('cssPropertyRules') or []:
            name = (rule.get('propertyName') or {}).get('text', '')
            rules.append({'type': 'property', 'name': name, 'selector': '@property ' + name, 'source': self._source(sid, rule, rule.get('origin', 'regular')),
                          'properties': [{'name': p['name'], 'value': p.get('value', '')} for p in _declared(rule.get('style') or {})]})
        for rule in matched.get('cssAtRules') or []:
            kind = rule.get('type', 'at-rule'); name = (rule.get('name') or {}).get('text')
            rules.append({'type': 'at-rule', 'atRuleType': kind, 'name': name, 'selector': '@' + kind + (' ' + name if name else ''), 'source': self._source(sid, rule, rule.get('origin', 'regular')),
                          'properties': [{'name': p['name'], 'value': p.get('value', '')} for p in _declared(rule.get('style') or {})]})
        return rules

    def close(self):
        if self._closed: return
        self._closed = True
        errors = []
        def attempt(domain, sid, method, params=None):
            try: self.driver._call(sid, method, params or {}, 5)
            except BrowserUseError as exc:
                if not (gone(exc) or stale(exc)): errors.append({'domain': domain, 'sessionId': sid, **exc.as_dict()})
        with self.driver._lock:
            sessions = self.driver.session_ids
            for sid in sessions: attempt('inspect', sid, 'Runtime.releaseObjectGroup', {'objectGroup': self._group})
            for sid in sorted(self._css_sessions & sessions): attempt('inspect.css', sid, 'CSS.disable')
            self._css_sessions.clear()
        for unsubscribe in self._unsubscribers: unsubscribe()
        self._unsubscribers.clear()
        self._sheets.clear()
        self.close_errors = errors
