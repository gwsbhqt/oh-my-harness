"""固定文档和节点的元素服务；不重新解释旧句柄，不重放副作用。"""
from __future__ import annotations
import base64
import json
import time
import uuid
from .checks import boolean, gone, integer, positive, seconds, string
from .driver import _META, _image_options, _image_size, _save_image
from .errors import BrowserUseError

_COMMON = {'handle'}
_PARAMS = {
    'resolve': {'selector','frame','within','shadow'},
    'list': {'selector','frame','within','shadow','limit'},
    'describe': _COMMON, 'read': _COMMON, 'attribute': _COMMON|{'name'}, 'html': _COMMON|{'outer'},
    'measure': _COMMON, 'styles': _COMMON|{'names'},
    'screenshot': _COMMON|{'out','shrink','overwrite','format','quality'},
    'click': _COMMON|{'count','button'}, 'type': _COMMON|{'text','allow_newline'},
    'key': _COMMON|{'keys','key'}, 'set': _COMMON|{'value'}, 'scroll': _COMMON|{'direction','pages'},
    'focus': _COMMON, 'hover': _COMMON, 'check': _COMMON|{'checked'}, 'uncheck': _COMMON,
    'select': _COMMON|{'value','values','label','labels'},
    'fill': _COMMON|{'value','allow_newline'},
    'evaluate': _COMMON|{'function','args','timeout'},
    'drag_to': _COMMON|{'target','target_selector','mode','steps'},
    'patch': _COMMON|{'attrs','text','styles'}, 'restore': {'patchId'},
}
_SEMANTIC = ('text','placeholder','alt','title')
_SELECTOR_KEYS = {'css','id','testid','label','role','idx','snapshot','match','ignore_case','nth'}|set(_SEMANTIC)
_SCOPE = ('frame','within','shadow')
_ARIA_CHECK = ('checkbox','switch','radio','menuitemcheckbox')


def parse_selector(selector, outer=None):
    """纯校验元素 selector（含 scope 与语义定位），返回规范化 spec；不发 CDP。"""
    if not isinstance(selector,dict): raise BrowserUseError('selector 需要 JSON 对象',2)
    selector=dict(selector); outer=outer or {}
    scope={}
    for key in _SCOPE:
        if key in selector and outer.get(key) is not None: raise BrowserUseError(key+' 不得重复指定',2)
        scope[key]=selector.pop(key) if key in selector else outer.get(key)
    keys=set(selector)
    if not keys or keys-_SELECTOR_KEYS: raise BrowserUseError('selector 字段不合法：'+', '.join(sorted(keys-_SELECTOR_KEYS)) if keys-_SELECTOR_KEYS else 'selector 不能为空',2)
    spec={'selector':selector,'frame':scope['frame'],'within':scope['within'],'shadow':scope['shadow'],'nth':None}
    if 'idx' in keys:
        if keys-{'idx','snapshot'}: raise BrowserUseError('idx 不得混用其他选择器',2)
        if any(v is not None for v in scope.values()): raise BrowserUseError('idx 已固定 frame，不得再指定 scope',2)
        positive(selector['idx'],'idx',integer=True)
        if not isinstance(selector.get('snapshot'),str): raise BrowserUseError('idx 需要 snapshot 凭证字符串',2)
        spec['kind']='idx'; return spec
    if 'snapshot' in keys: raise BrowserUseError('snapshot 只与 idx 一起使用',2)
    if 'nth' in keys:
        nth=selector['nth']
        if isinstance(nth,bool) or not isinstance(nth,int) or abs(nth)>100000: raise BrowserUseError('nth 需要整数（0 起，负数从末尾数）',2)
        spec['nth']=nth
    semantic=keys&set(_SEMANTIC)
    options=keys&{'match','ignore_case'}
    if options and not semantic: raise BrowserUseError('match/ignore_case 只用于 text/placeholder/alt/title',2)
    bases=keys&{'css','id','testid'}
    if len(semantic)>1 or semantic and keys-semantic-{'match','ignore_case','nth'}: raise BrowserUseError('text/placeholder/alt/title 只能单独使用一种，不与其他选择器混用',2)
    if len(bases)>1 or bases and keys-bases-{'nth'}: raise BrowserUseError('CSS/id/testid 不得混用其他选择器',2)
    if not keys-{'nth'}: raise BrowserUseError('nth 需要和一种定位字段一起使用',2)
    for key in keys-{'nth','match','ignore_case'}:
        string(selector[key],key)
    if 'match' in selector and selector['match'] not in ('exact','contains'): raise BrowserUseError('match 只能是 exact/contains',2)
    if 'ignore_case' in selector: boolean(selector['ignore_case'],'ignore_case')
    if scope['frame'] is not None and not isinstance(scope['frame'],str): raise BrowserUseError('frame 必须为固定 frame ID 字符串',2)
    if scope['within'] is not None and (not isinstance(scope['within'],str) or not scope['within']): raise BrowserUseError('within 需要非空 CSS 字符串',2)
    shadow=[] if scope['shadow'] is None else scope['shadow']
    if not isinstance(shadow,list) or any(not isinstance(s,str) or not s for s in shadow): raise BrowserUseError('shadow 需要唯一 CSS host 的有序列表',2)
    spec['shadow']=shadow
    if semantic:
        name=semantic.pop()
        spec['kind']='semantic'
        spec['query']={'semantic':{'kind':name,'value':selector[name]},'match':selector.get('match','exact'),'ignore_case':selector.get('ignore_case',False)}
    elif bases: spec['kind']='dom'; spec['query']={k:selector[k] for k in bases}
    else: spec['kind']='ax'; spec['query']={k:selector[k] for k in keys&{'role','label'}}
    return spec


def _handle_shape(value,name='handle'):
    if not isinstance(value,dict) or not isinstance(value.get('token'),str): raise BrowserUseError(f'{name} 需要 resolve 返回的完整句柄对象',2)


_QUERY = r"""function(s,within,shadow,limit,nth){
 let root=this;
 function one(root,css){const hits=root.querySelectorAll(css);if(hits.length!==1)throw Error('scope 必须唯一，实际 '+hits.length);return hits[0]}
 if(within)root=one(root,within);
 for(const css of shadow){root=one(root,css).shadowRoot;if(!root)throw Error('shadow scope 不是可访问的 open shadow root')}
 let nodes;
 if(s.css!==undefined)nodes=Array.from(root.querySelectorAll(s.css));
 else if(s.semantic){
  const norm=t=>String(t??'').replace(/\s+/g,' ').trim(),fold=t=>s.ignore_case?t.toLowerCase():t,want=fold(norm(s.semantic.value));
  const same=t=>{t=fold(norm(t));return s.match==='contains'?t.includes(want):t===want};
  const all=Array.from(root.querySelectorAll('*')),kind=s.semantic.kind;
  if(kind==='text'){
   const skip=/^(HTML|HEAD|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|META|LINK)$/;
   const textOf=e=>e.tagName==='INPUT'&&/^(button|submit|reset)$/i.test(e.type)?e.value:e.innerText;
   const visible=e=>e.getClientRects().length>0&&e.checkVisibility?.({checkVisibilityCSS:true})!==false;
   nodes=all.filter(e=>!skip.test(e.tagName)&&visible(e)&&same(textOf(e)));
   nodes=nodes.filter(e=>!nodes.some(o=>o!==e&&e.contains(o)));
  } else nodes=all.filter(e=>e.hasAttribute(kind)&&same(e.getAttribute(kind)));
 }
 else {nodes=Array.from(root.querySelectorAll('*'));nodes=nodes.filter(e=>{
  if(s.id!==undefined&&e.id!==s.id)return false;
  if(s.testid!==undefined&&e.getAttribute('data-testid')!==s.testid)return false;
  return true;
 })}
 const count=nodes.length;
 if(nth!==null){const i=nth<0?count+nth:nth;nodes=i>=0&&i<count?[nodes[i]]:[]}
 return {count,nodes:nodes.slice(0,limit)};
}"""

_FILL_PREPARE = r"""function(){
 const tag=this.tagName,editable=this.isContentEditable;
 const textual=['text','search','email','url','tel','password','number'];
 let kind=null;
 if(tag==='TEXTAREA')kind='textarea';else if(tag==='INPUT'&&textual.includes(this.type))kind='input';else if(editable)kind='contenteditable';
 if(!kind)throw Error('fill 只支持文本类 input、textarea 和 contenteditable；'+(tag==='INPUT'?'type='+this.type+' ':'')+'请改用 set/select/check');
 if(kind!=='contenteditable'&&(this.disabled||this.readOnly))throw Error('元素只读或禁用');
 return {kind,password:tag==='INPUT'&&this.type==='password',empty:kind==='contenteditable'?!this.textContent:!this.value};
}"""
_FILL_SELECT = r"""function(){
 const root=this.getRootNode(),active=root.activeElement??this.ownerDocument.activeElement;
 if(this.isContentEditable&&!(active===this||this.contains(active)))return false;
 if(!this.isContentEditable&&active!==this)return false;
 if(this.isContentEditable){const sel=this.ownerDocument.getSelection(),r=this.ownerDocument.createRange();r.selectNodeContents(this);sel.removeAllRanges();sel.addRange(r)}else this.select();
 return true;
}"""
_FILL_VALUE = r"""function(){return this.isContentEditable?this.innerText.replace(/\n$/,''):String(this.value)}"""
_ARIA_STATE = r"""function(){const role=(this.getAttribute('role')||'').trim().toLowerCase();return {native:this.tagName==='INPUT'&&['checkbox','radio'].includes(this.type),checked:this.tagName==='INPUT'?this.checked:null,type:this.type??null,role,aria:this.getAttribute('aria-checked')}}"""
_DROP_WATCH = r"""function(){
 const record={drop:0,dragenter:0,dragover:0,defaultPrevented:false,types:[]};
 const doc=this.ownerDocument,el=this;
 const on=e=>{if(!(e.target===el||el.contains(e.target)))return;record[e.type]++;if(e.type==='drop'){record.types=Array.from(e.dataTransfer?.types||[]);setTimeout(()=>{record.defaultPrevented=e.defaultPrevented},0)}};
 for(const t of ['dragenter','dragover','drop'])doc.addEventListener(t,on,true);
 record.stop=()=>{for(const t of ['dragenter','dragover','drop'])doc.removeEventListener(t,on,true)};
 return record;
}"""

_PATCH = r"""function(attrs,text,styles){
 if(text!==null&&this.childElementCount)throw Error('text patch 只接受无子元素节点，不能破坏后代身份');
 if(text!==null&&/^(SCRIPT|STYLE|IFRAME|OBJECT)$/.test(this.tagName))throw Error('text patch 禁止脚本和导航内容');
 const probe=this.ownerDocument.createElement('div');for(const[k,v]of Object.entries(attrs))probe.setAttribute(k,v??'');for(const[k,v]of Object.entries(styles)){if(v===null)continue;probe.style.setProperty(k,v);if(!probe.style.getPropertyValue(k))throw Error('无效样式 '+k);probe.style.removeProperty(k)}
 const before={attrs:{},styles:{}},after={attrs:{},styles:{}};
 for(const [k,v]of Object.entries(attrs)){before.attrs[k]=this.getAttribute(k);if(v===null)this.removeAttribute(k);else this.setAttribute(k,v);after.attrs[k]=this.getAttribute(k)}
 if(text!==null){before.text=this.textContent;this.textContent=text;after.text=this.textContent}
 for(const [k,v]of Object.entries(styles)){before.styles[k]={value:this.style.getPropertyValue(k),priority:this.style.getPropertyPriority(k)};if(v===null)this.style.removeProperty(k);else this.style.setProperty(k,v);after.styles[k]={value:this.style.getPropertyValue(k),priority:this.style.getPropertyPriority(k)}}
 return {before,after};
}"""
_RESTORE = r"""function(before,after){
 for(const[k,v]of Object.entries(after.attrs))if(this.getAttribute(k)!==v)return {restored:false,conflict:'attrs.'+k};
 if('text'in after&&this.textContent!==after.text)return {restored:false,conflict:'text'};
 for(const[k,v]of Object.entries(after.styles))if(this.style.getPropertyValue(k)!==v.value||this.style.getPropertyPriority(k)!==v.priority)return {restored:false,conflict:'styles.'+k};
 for(const[k,v]of Object.entries(before.attrs)){if(v===null)this.removeAttribute(k);else this.setAttribute(k,v)}
 if('text'in before)this.textContent=before.text;
 for(const[k,v]of Object.entries(before.styles)){if(v.value)this.style.setProperty(k,v.value,v.priority);else this.style.removeProperty(k)}
 return {restored:true};
}"""

def _validate(action,p):
    """在任何 CDP 调用前校验字段类型和取值。"""
    if 'handle' in p: _handle_shape(p['handle'])
    elif action not in ('resolve','list','restore'): raise BrowserUseError('缺少 handle',2)
    if action in ('resolve','list'):
        parse_selector(p.get('selector'),{k:p.get(k) for k in _SCOPE})
        if 'limit' in p: positive(p['limit'],'limit',integer=True)
    elif action=='select':
        given=[k for k in ('value','values','label','labels') if k in p]
        if len(given)!=1: raise BrowserUseError('select 需要且只需要 value / values / label / labels 之一',2)
        v=p[given[0]]
        if given[0] in ('value','label'):
            if not isinstance(v,str): raise BrowserUseError(given[0]+' 需要字符串',2)
        elif not isinstance(v,list) or not v or any(not isinstance(x,str) for x in v) or len(set(v))!=len(v): raise BrowserUseError(given[0]+' 需要非空且不重复的字符串列表',2)
    elif action=='check':
        if 'checked' in p: boolean(p['checked'],'checked')
    elif action=='fill':
        value=string(p.get('value'),'value',empty=True)
        if 'allow_newline' in p: boolean(p['allow_newline'],'allow_newline')
        if ('\n' in value or '\r' in value) and not p.get('allow_newline',False): raise BrowserUseError('填写换行需要 allow_newline=True，避免意外发送',6)
        if len(value)>1000000: raise BrowserUseError('value 上限 1000000 字符',2)
    elif action=='evaluate':
        function=string(p.get('function'),'function',empty=True)
        if not function.strip(): raise BrowserUseError('function 需要非空函数源码',2)
        args=p.get('args',[])
        if not isinstance(args,list) or len(args)>32: raise BrowserUseError('args 需要最多 32 项的 JSON 列表',2)
        try: json.dumps(args,allow_nan=False)
        except (TypeError,ValueError) as exc: raise BrowserUseError('args 必须是 JSON 兼容值',2) from exc
        if 'timeout' in p: seconds(p['timeout'],'timeout',120)
    elif action=='drag_to':
        if ('target' in p)==('target_selector' in p): raise BrowserUseError('drag_to 需要且只需要 target（句柄）或 target_selector',2)
        if 'target' in p: _handle_shape(p['target'],'target')
        else: parse_selector(p['target_selector'])
        if p.get('mode','auto') not in ('auto','html5','mouse'): raise BrowserUseError('mode 只能是 auto/html5/mouse',2)
        if 'steps' in p: integer(p['steps'],'steps',1,240)
    elif action=='screenshot':
        _image_options(p)
        if 'shrink' in p: positive(p['shrink'],'shrink',integer=True,zero=True)
    elif action=='click':
        if 'count' in p: integer(p['count'],'count',1,3)
        if p.get('button','left') not in ('left','right','middle'): raise BrowserUseError('button 只能是 left/right/middle',2)


class ElementService:
    def __init__(self, driver, *, private=False):
        self.driver=driver
        self.private=private
        self._handles={}
        self._patches={}
        self.close_errors=[]
        self._group='browser-use-elements-'+uuid.uuid4().hex

    def _resolve(self,backend,fid):
        frame=self.driver._frames_cache[fid]
        result=self.driver._call(frame['session'],'DOM.resolveNode',{'backendNodeId':backend,'executionContextId':frame['context'],'objectGroup':self._group})
        oid=result.get('object',{}).get('objectId')
        if not oid: raise BrowserUseError('元素引用已失效',4)
        return {'backend':backend,'frame':fid,'session':frame['session'],'document':frame['document'],'object':oid}

    def dispatch(self, action, params=None):
        if not isinstance(action,str): raise BrowserUseError('元素动作需要字符串',2)
        if action.startswith('element_'): action=action[8:]
        p={} if params is None else params
        if action not in _PARAMS: raise BrowserUseError('未实现元素动作 '+action,2)
        if not isinstance(p,dict): raise BrowserUseError('元素参数需要对象',2)
        unknown=set(p)-_PARAMS[action]
        if unknown: raise BrowserUseError('元素参数含未知字段：'+', '.join(sorted(map(str,unknown))),2)
        _validate(action,p)
        with self.driver._lock:
            self.driver.check()
            self._release_group()
            if action in ('resolve','list'): return self._find(action,p)
            if action=='restore': return self._restore(p)
            ref=self._ref(p.get('handle'))
            meta=self.driver._function(ref,_META)
            if action=='describe': return {'ok':True,'handle':dict(p['handle']),'count':1,'metadata':self.driver.enrich(ref,meta)}
            if action=='read':
                value=self.driver._function(ref,"function(){return {text:this.innerText??this.textContent??'',value:'value'in this?String(this.value):null}}")
                return dict(ok=True,**value)
            if action=='attribute':
                name=string(p.get('name'),'name',empty=True)
                return {'ok':True,'name':name,'value':self.driver._function(ref,'function(n){return this.getAttribute(n)}',(name,))}
            if action=='html':
                boolean(p.get('outer',True),'outer')
                return {'ok':True,'html':self.driver._function(ref,'function(outer){return outer?this.outerHTML:this.innerHTML}',(p.get('outer',True),))}
            if action=='measure': return self._measure(ref)
            if action=='styles':
                names=p.get('names',['display','visibility','opacity','overflow-x','overflow-y','position'])
                if not isinstance(names,list) or not names or any(not isinstance(n,str) or not n for n in names): raise BrowserUseError('names 需要非空样式名称列表',2)
                return {'ok':True,'styles':self.driver._function(ref,'function(ns){const s=this.ownerDocument.defaultView.getComputedStyle(this);return Object.fromEntries(ns.map(n=>[n,s.getPropertyValue(n)]))}',(names,))}
            if action=='screenshot': return self._screenshot(ref,p)
            if action=='patch': return self._patch(ref,p)
            if action=='evaluate': return self._evaluate(ref,p)
            if not meta['enabled']: raise BrowserUseError('元素不可用',1)
            if action=='click':
                self._geometry(ref)
                return self.driver._click({k:v for k,v in p.items() if k!='handle'},fixed_ref=(ref,meta))
            if action=='key':
                if ('keys' in p)==('key' in p): raise BrowserUseError('key 需要且只需要 keys 或 key',2)
                result=self.driver._key({k:v for k,v in p.items() if k!='handle'},fixed_ref=ref)
                return dict(result,via='cdp',trusted=True)
            if action in ('type','set'):
                if not meta['editable']: raise BrowserUseError('元素不能输入或赋值',1)
                if action=='type':
                    boolean(p.get('allow_newline',False),'allow_newline')
                    return {**self.driver._insert({k:v for k,v in p.items() if k!='handle'},fixed_ref=(ref,meta)),'trusted':True}
                value=string(p.get('value'),'value',empty=True)
                self.driver._function(ref,"""function(v){if(this.isContentEditable)this.textContent=v;else{let p=this,d;while(p&&!d){d=Object.getOwnPropertyDescriptor(p,'value');p=Object.getPrototypeOf(p)}if(!d?.set)throw Error('value 不可写');d.set.call(this,v)}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}""",(value,))
                return {'ok':True,'via':'property','trusted':False}
            if action=='scroll':
                direction=p.get('direction','down');pages=positive(p.get('pages',1),'pages')
                if direction not in ('up','down','left','right'): raise BrowserUseError('direction 只能是 up/down/left/right',2)
                result=self.driver._function(ref,r"""function(d,p){const horizontal=d==='left'||d==='right';let e=this;while(e){const s=this.ownerDocument.defaultView.getComputedStyle(e);if(/auto|scroll|overlay/.test(horizontal?s.overflowX:s.overflowY)&&(horizontal?e.scrollWidth>e.clientWidth:e.scrollHeight>e.clientHeight))break;e=e.parentElement||e.getRootNode()?.host}e=e||this.ownerDocument.scrollingElement;if(!e)throw Error('无可滚动祖先');e.scrollBy({left:horizontal?(d==='left'?-1:1)*e.clientWidth*p:0,top:horizontal?0:(d==='up'?-1:1)*e.clientHeight*p,behavior:'instant'});return {id:e.id||'',x:e.scrollLeft,y:e.scrollTop}}""",(direction,pages))
                return {'ok':True,'via':'property','trusted':False,'scope':'element-or-ancestor','scroll':result}
            if action=='focus':
                self.driver._call(ref['session'],'DOM.focus',{'backendNodeId':ref['backend']})
                focused=self.driver._function(ref,'function(){return this.getRootNode().activeElement===this}')
                if not focused: raise BrowserUseError('元素不能获得焦点',1)
                return {'ok':True,'via':'cdp','trusted':True}
            if action=='hover':
                if ref['session']!=self.driver.session_id: raise BrowserUseError('跨进程 iframe 的可信 hover 尚不能保证实际命中；不发送或合成事件',5)
                _,q,x,y=self._geometry(ref)
                self.driver.call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':x,'y':y})
                hovered=self.driver._function(ref,'function(){return new Promise(resolve=>{requestAnimationFrame(()=>{requestAnimationFrame(()=>{resolve(this.matches(":hover"));});});});}',timeout=2)
                if not hovered: raise BrowserUseError('可信鼠标移动后元素未进入 hover；未重放',1)
                return {'ok':True,'via':'cdp','trusted':True}
            if action=='check': return self._check(ref,p.get('checked',True))
            if action=='uncheck': return self._check(ref,False)
            if action=='select': return self._select(ref,p)
            if action=='fill': return self._fill(ref,meta,p)
            if action=='drag_to': return self._drag_to(ref,p)
            raise BrowserUseError('未实现元素动作 '+action,2)

    def _release_group(self):
        for sid in self.driver.session_ids:
            self.driver._call(sid,'Runtime.releaseObjectGroup',{'objectGroup':self._group})

    def _frame(self,value):
        frames=self.driver._frames_cache
        if value is None: return next(fid for fid,f in frames.items() if not f.get('parent') and f['session']==self.driver.session_id)
        if not isinstance(value,str): raise BrowserUseError('frame 必须为固定 frame ID 字符串',2)
        if value not in frames: raise BrowserUseError('指定 frame 已不存在',4)
        return value

    def _find(self,action,p):
        spec=parse_selector(p.get('selector'),{k:p.get(k) for k in _SCOPE})
        selector=spec['selector']
        if spec['kind']=='idx':
            ref,meta=self.driver._ref(selector)
            handle=self._handle(ref)
            meta=self.driver.enrich(ref,meta)
            item={'handle':handle,'metadata':meta}
            if action=='list': return {'ok':True,'selector':selector,'count':1,'elements':[item],'limit':1,'truncated':False}
            return dict(ok=True,selector=selector,count=1,**item)
        limit=positive(p.get('limit',100),'limit',integer=True)
        if limit>1000: raise BrowserUseError('limit 上限 1000',2)
        if len(self._handles)+limit>10000: raise BrowserUseError('元素句柄数量达到10000上限；释放页面后重新绑定',5)
        count,refs=self._query(spec,limit)
        if action=='resolve': self._unique(spec,count,refs)
        elements=[]
        for ref in refs:
            meta=self.driver._function(ref,_META)
            if not meta or not meta['connected']: raise BrowserUseError('取元素期间节点已移除',4)
            elements.append({'handle':self._handle(ref),'metadata':self.driver.enrich(ref,meta)})
        self.driver.check()
        for item in elements: self._ref(item['handle'])
        extra={'nth':spec['nth']} if spec['nth'] is not None else {}
        if action=='resolve': return dict(ok=True,selector=selector,count=count,**extra,**elements[0])
        return {'ok':True,'selector':selector,'count':count,**extra,'elements':elements,'limit':limit,'truncated':len(refs)<count and spec['nth'] is None}

    @staticmethod
    def _unique(spec,count,refs):
        if spec['nth'] is None and count!=1: raise BrowserUseError(f'元素匹配到 {count} 个；拒绝猜测，请用 nth、list 或精确 scope',3,data={'count':count})
        if not refs: raise BrowserUseError(f'nth={spec["nth"]} 超出匹配范围（共 {count} 个）',3,data={'count':count})

    def _query(self,spec,limit):
        """按规范化 spec 查询，返回 (总匹配数, 按 nth 选取并截到 limit 的 refs)。"""
        fid=self._frame(spec['frame']); frame=self.driver._frames_cache[fid]
        within=spec['within']; shadow=spec['shadow']; nth=spec['nth']; query=spec['query']
        if spec['kind']=='ax':
            nodes=self.driver._call(frame['session'],'Accessibility.getFullAXTree',{'frameId':fid})['nodes']
            backend=[n['backendDOMNodeId'] for n in nodes if not n.get('ignored') and n.get('backendDOMNodeId') and
                     ('role' not in query or n.get('role',{}).get('value')==query['role']) and
                     ('role' in query or n.get('role',{}).get('value') not in ('StaticText','InlineTextBox')) and
                     ('label' not in query or n.get('name',{}).get('value')==query['label'])]
            refs=[]
            for b in backend:
                ref=self._resolve(b,fid)
                if within or shadow:
                    inside=self.driver._function(ref,r"""function(within,shadow){let root=this.ownerDocument;function one(r,s){const a=r.querySelectorAll(s);if(a.length!==1)throw Error('scope 必须唯一');return a[0]}if(within)root=one(root,within);for(const s of shadow){root=one(root,s).shadowRoot;if(!root)throw Error('无法访问 shadow scope')}return root.contains(this)}""",(within,shadow))
                    if not inside: continue
                refs.append(ref)
            count=len(refs)
            if nth is not None:
                index=nth+count if nth<0 else nth
                refs=[refs[index]] if 0<=index<count else []
            return count,refs[:limit]
        document=self.driver._call(frame['session'],'Runtime.evaluate',{'expression':'document','contextId':frame['context'],'returnByValue':False})['result']['objectId']
        objects=[]
        try:
            result=self.driver._call(frame['session'],'Runtime.callFunctionOn',{'objectId':document,'functionDeclaration':_QUERY,'arguments':[{'value':a} for a in (query,within,shadow,limit,nth)],'returnByValue':False})
            if result.get('exceptionDetails'): self.driver._result(result)
            oid=result['result']['objectId']; objects.append(oid)
            props=self.driver._call(frame['session'],'Runtime.getProperties',{'objectId':oid,'ownProperties':True})['result']
            values={v['name']:v.get('value',{}) for v in props}; count=values['count']['value']; array=values['nodes']['objectId']; objects.append(array)
            items=self.driver._call(frame['session'],'Runtime.getProperties',{'objectId':array,'ownProperties':True})['result']
            refs=[]
            for item in sorted((i for i in items if i['name'].isdigit()),key=lambda i:int(i['name'])):
                node=item['value']['objectId']; objects.append(node)
                b=self.driver._call(frame['session'],'DOM.describeNode',{'objectId':node})['node']['backendNodeId']
                refs.append(self._resolve(b,fid))
        finally:
            for obj in [document]+objects: self.driver._call(frame['session'],'Runtime.releaseObject',{'objectId':obj})
        return count,refs

    def _no_match(self, spec):
        """selector 一个都没匹配到：报错并列出页面上最像的几个元素。"""
        from .driver import _NEAR, _brief, _similar
        query = spec['query']
        if spec['kind'] == 'semantic':
            wanted, fields = query['semantic']['value'], (query['semantic']['kind'], 'label', 'text')
        elif spec['kind'] == 'dom':
            wanted = query.get('id') or query.get('testid') or query.get('css')
            fields = ('id', 'testid', 'label') if 'css' not in query else ('id', 'label', 'text')
        else:
            wanted, fields = query.get('label') or query.get('role'), ('label', 'role')
        candidates = []
        try:
            frame = self.driver._frames_cache[self._frame(spec['frame'])]
            document = self.driver._call(frame['session'], 'Runtime.evaluate', {'expression': 'document', 'contextId': frame['context'], 'returnByValue': False})['result']['objectId']
            try:
                found = self.driver._result(self.driver._call(frame['session'], 'Runtime.callFunctionOn', {'objectId': document, 'functionDeclaration': _NEAR, 'arguments': [{'value': 3000}], 'returnByValue': True}))
            finally:
                self.driver._call(frame['session'], 'Runtime.releaseObject', {'objectId': document})
            candidates = [{k: v for k, v in item.items() if v and k in ('tag', 'role', 'label', 'id', 'placeholder', 'testid')}
                          for item in _similar(wanted, found or [], fields)]
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
        message = f'selector {json.dumps(spec["selector"], ensure_ascii=False)} 匹配到 0 个元素；拒绝猜测'
        if candidates:
            message += '。相近的元素：' + '；'.join(_brief(c) for c in candidates)
        raise BrowserUseError(message, 3, data={'count': 0, 'candidates': candidates})

    def locate(self,selector,*,release=True):
        """供页面动作用：selector 唯一解析为 (ref, metadata)；不生成公开句柄。"""
        spec=parse_selector(selector)
        if spec['kind']=='idx': return self.driver._ref(spec['selector'])
        if release: self._release_group()
        count,refs=self._query(spec,1)
        if count==0 and spec['nth'] is None: self._no_match(spec)
        self._unique(spec,count,refs)
        ref=refs[0]
        meta=self.driver._function(ref,_META)
        if not meta or not meta['connected']: raise BrowserUseError('元素已从文档移除',4)
        ref['identity']=(meta['tag'],meta['id'])
        return ref,meta

    def probe(self,selector):
        """供 wait 用：返回 {count, present, visible}；多匹配且无 nth 时 visible 为 None。"""
        spec=parse_selector(selector)
        self._release_group()
        count,refs=self._query(spec,1)
        present=bool(refs) if spec['nth'] is not None else count>0
        if spec['nth'] is None and count>1: return {'count':count,'present':True,'visible':None}
        if not refs: return {'count':count,'present':False,'visible':False}
        meta=self.driver._function(refs[0],_META)
        return {'count':count,'present':present,'visible':bool(meta and meta['connected'] and meta['visible'])}

    def _handle(self,ref):
        frame=self.driver._frames_cache[ref['frame']]
        handle={'token':uuid.uuid4().hex,'targetId':self.driver.target_id,'frame':ref['frame'],'document':ref['document'],'loader':frame.get('loader'),'backendNodeId':ref['backend']}
        self._handles[handle['token']]=dict(handle)
        return handle

    def _ref(self,handle):
        if not isinstance(handle,dict) or not isinstance(handle.get('token'),str) or self._handles.get(handle.get('token'))!=handle: raise BrowserUseError('未知或被改动的元素句柄；不能跨目标或服务使用',4)
        frame=self.driver._frames_cache.get(handle['frame'])
        if handle['targetId']!=self.driver.target_id or not frame or frame['document']!=handle['document'] or frame.get('loader')!=handle['loader']: raise BrowserUseError('元素所属目标或文档已变化',4)
        try:
            ref=self._resolve(handle['backendNodeId'],handle['frame'])
            meta=self.driver._function(ref,_META)
        except BrowserUseError as exc:
            if exc.outcome=='unknown' or exc.code==5: raise
            raise BrowserUseError('元素节点已失效',4) from exc
        if not meta or not meta['connected']: raise BrowserUseError('元素已从文档移除',4)
        return ref

    def _measure(self,ref):
        meta=self.driver.enrich(ref,self.driver._function(ref,_META))
        geom=self.driver._function(ref,r"""function(){const r=this.getBoundingClientRect(),w=this.ownerDocument.defaultView;return {viewport:{x:r.x,y:r.y,width:r.width,height:r.height},document:{x:r.x+w.scrollX,y:r.y+w.scrollY,width:r.width,height:r.height},scroll:{x:w.scrollX,y:w.scrollY},transform:w.getComputedStyle(this).transform}}""")
        quads=self.driver._call(ref['session'],'DOM.getContentQuads',{'backendNodeId':ref['backend']}).get('quads',[])
        return {'ok':True,'bounding':geom,'quads':quads,'coordinateSpace':{'viewport':'frame CSS pixels','document':'frame document CSS pixels','quads':'session viewport CSS pixels'},'frame':ref['frame'],'metadata':meta}

    def _geometry(self,ref):
        self.driver._call(ref['session'],'DOM.scrollIntoViewIfNeeded',{'backendNodeId':ref['backend']})
        self.driver._function(ref,'function(){return new Promise(resolve=>{requestAnimationFrame(()=>{requestAnimationFrame(()=>{resolve(true);});});});}',timeout=2)
        rect=self.driver._function(ref,'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}')
        if rect['width']<=0 or rect['height']<=0: raise BrowserUseError('元素没有可操作区域',1)
        x,y=rect['x']+rect['width']/2,rect['y']+rect['height']/2
        clear=self.driver._function(ref,'function(x,y){const hit=this.getRootNode().elementFromPoint?.(x,y)||this.ownerDocument.elementFromPoint(x,y);return hit===this||this.contains(hit)}',(x,y))
        if not clear: raise BrowserUseError('元素被遮挡，拒绝操作别的元素',1)
        meta=self.driver.enrich(ref,self.driver._function(ref,_META))
        if meta.get('rootOccluded'): raise BrowserUseError('元素被父 frame 遮挡，拒绝操作别的元素',1)
        if meta.get('coordinateLimitation'): raise BrowserUseError('变换 iframe 操作坐标尚未验收',5)
        quads=self.driver._call(ref['session'],'DOM.getContentQuads',{'backendNodeId':ref['backend']}).get('quads',[])
        if len(quads)!=1: raise BrowserUseError('多片或缺失内容区域不能确定操作坐标',5)
        q=quads[0]
        if abs(q[1]-q[3])>.5 or abs(q[5]-q[7])>.5 or abs(q[0]-q[6])>.5 or abs(q[2]-q[4])>.5: raise BrowserUseError('旋转或透视元素坐标尚不支持',5)
        x,y=self.driver._root_point(ref['session'],sum(q[0::2])/4,sum(q[1::2])/4)
        return rect,q,x,y

    def _point(self,ref):
        _,_,x,y=self._geometry(ref)
        return x,y

    def infer_kind(self,ref,item):
        """fill_form 未给 kind 时按元素推断：原生 SELECT→select，勾选类→check/uncheck，其余→text。"""
        info=self.driver._function(ref,r"""function(){const role=(this.getAttribute('role')||'').toLowerCase();return {tag:this.tagName,type:this.type??null,role}}""")
        value=item.get('value')
        if info['tag']=='SELECT': return 'select'
        if info['tag']=='INPUT' and info['type'] in ('checkbox','radio') or info['role'] in _ARIA_CHECK:
            if not isinstance(value,bool): raise BrowserUseError('勾选类元素需要 value=true/false 或显式 kind=check/uncheck',2)
            return 'check' if value else 'uncheck'
        if not isinstance(value,str): raise BrowserUseError('文本类元素需要字符串 value',2)
        return 'text'

    def form_item(self,ref,meta,kind,item):
        if kind=='text':
            if not isinstance(item.get('value'),str): raise BrowserUseError('kind=text 需要字符串 value',2)
            return self._fill(ref,meta,{'value':item['value']})
        if kind=='select':
            value=item.get('value'); by=item.get('by','value')
            field={('value',True):'value',('value',False):'values',('label',True):'label',('label',False):'labels'}[(by,isinstance(value,str))]
            if not isinstance(value,(str,list)): raise BrowserUseError('kind=select 需要字符串或字符串列表 value',2)
            return self._select(ref,{field:value})
        return self._check(ref,kind=='check')

    def _trusted_click(self,ref):
        x,y=self._point(ref)
        for kind in ('mousePressed','mouseReleased'): self.driver.call('Input.dispatchMouseEvent',{'type':kind,'x':x,'y':y,'button':'left','buttons':1 if kind=='mousePressed' else 0,'clickCount':1},timeout=5)

    def _check(self,ref,desired):
        state=self.driver._function(ref,_ARIA_STATE)
        if state['native']:
            if state['type']=='radio' and not desired: raise BrowserUseError('原生 radio 不能靠可信点击取消',5)
            if state['checked']==desired: return {'ok':True,'changed':False,'checked':desired,'kind':'native','via':'cdp','trusted':True}
            self._trusted_click(ref)
            actual=self.driver._function(ref,'function(){return this.checked}')
            if actual!=desired: raise BrowserUseError('可信点击后 checked 未达到要求；未重放',1,data={'checked':actual})
            return {'ok':True,'changed':True,'checked':actual,'kind':'native','via':'cdp','trusted':True}
        if state['role'] not in _ARIA_CHECK: raise BrowserUseError('check 只支持原生 checkbox/radio 和 role=checkbox/switch/radio/menuitemcheckbox；不会合成 click',5,data={'role':state['role'] or None})
        before=state['aria']
        if before not in ('true','false','mixed',None): raise BrowserUseError(f'aria-checked 值 {before!r} 不可识别',5)
        if (before=='true')==desired: return {'ok':True,'changed':False,'checked':desired,'kind':'aria','role':state['role'],'ariaChecked':before,'via':'cdp','trusted':True}
        if state['role']=='radio' and not desired: raise BrowserUseError('ARIA radio 不能靠点击取消',5)
        self._trusted_click(ref)
        deadline=time.monotonic()+1
        while True:
            after=self.driver._function(ref,"function(){return this.getAttribute('aria-checked')}")
            if after!=before or time.monotonic()>=deadline: break
            time.sleep(.03)
        if (after=='true')!=desired:
            raise BrowserUseError('可信点击后 aria-checked 未变为期望值；未重放',1,data={'before':before,'after':after,'role':state['role']})
        return {'ok':True,'changed':True,'checked':desired,'kind':'aria','role':state['role'],'ariaChecked':after,'via':'cdp','trusted':True}

    def _select(self,ref,p):
        field=next(k for k in ('value','values','label','labels') if k in p)
        wanted=[p[field]] if field in ('value','label') else p[field]
        by='label' if field.startswith('label') else 'value'
        result=self.driver._function(ref,r"""function(vs,by){if(this.tagName!=='SELECT')throw Error('select 需要原生 SELECT');if(this.matches(':disabled'))throw Error('select 已禁用');if(!this.multiple&&vs.length!==1)throw Error('单选只接受一个值');const norm=t=>String(t).replace(/\s+/g,' ').trim(),key=o=>by==='label'?norm(o.label||o.text):o.value;const chosen=[];for(const v of vs){const a=Array.from(this.options).filter(o=>key(o)===(by==='label'?norm(v):v));if(a.length!==1)throw Error('option '+JSON.stringify(v)+(a.length?' 重复 '+a.length+' 个':' 不存在'));if(a[0].disabled||a[0].parentElement.disabled)throw Error('option '+JSON.stringify(v)+' 已禁用');chosen.push(a[0])}for(const o of this.options)o.selected=chosen.includes(o);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {values:Array.from(this.selectedOptions).map(o=>o.value),labels:Array.from(this.selectedOptions).map(o=>norm(o.label||o.text))}}""",(wanted,by))
        return {'ok':True,**result,'by':by,'via':'property','trusted':False}

    def _fill(self,ref,meta,p):
        value=p['value']
        info=self.driver._function(ref,_FILL_PREPARE)
        if ('\n' in value or '\r' in value) and info['kind']=='input': raise BrowserUseError('单行 input 不接受换行',2)
        sid=ref['session']
        self.driver._call(sid,'DOM.focus',{'backendNodeId':ref['backend']})
        if not self.driver._function(ref,_FILL_SELECT): raise BrowserUseError('元素未能获得焦点；未输入',1)
        if value: self.driver._call(sid,'Input.insertText',{'text':value},timeout=10)
        elif not info['empty']:
            for kind in ('rawKeyDown','keyUp'):
                self.driver._call(sid,'Input.dispatchKeyEvent',{'type':kind,'key':'Delete','code':'Delete','windowsVirtualKeyCode':46,'nativeVirtualKeyCode':46},timeout=5)
        if info['password']:
            matches=self.driver._function(ref,'function(v){return this.value===v}',(value,))
            if not matches: raise BrowserUseError('填写后密码框内容与期望不一致；未重放',1,data={'kind':info['kind'],'redacted':True})
            return {'ok':True,'kind':info['kind'],'matches':True,'redacted':True,'via':'cdp','trusted':True}
        actual=self.driver._function(ref,_FILL_VALUE)
        expected=value.replace('\r\n','\n').replace('\r','\n')
        if actual!=expected: raise BrowserUseError('填写后值与期望不一致（可能被页面格式化或限长）；未重放',1,data={'kind':info['kind'],'value':actual,'expected':value})
        return {'ok':True,'kind':info['kind'],'value':actual,'matches':True,'via':'cdp','trusted':True}

    def _evaluate(self,ref,p):
        params={'objectId':ref['object'],'functionDeclaration':p['function'],'arguments':[{'value':a} for a in p.get('args',[])],'returnByValue':True,'awaitPromise':True}
        result=self.driver._call(ref['session'],'Runtime.callFunctionOn',params,p.get('timeout',20))
        if result.get('exceptionDetails'):
            detail=result['exceptionDetails']
            raise BrowserUseError(detail.get('exception',{}).get('description') or detail.get('text','元素脚本异常'),1,data={'exception':detail.get('exception',{}).get('description') or detail.get('text')})
        obj=result.get('result',{})
        if 'unserializableValue' in obj: raise BrowserUseError('元素脚本返回值不是 JSON 兼容值：'+obj['unserializableValue'],1)
        return {'ok':True,'value':obj.get('value'),'type':obj.get('type')}

    def _drag_to(self,ref,p):
        if 'target' in p: target=self._ref(p['target'])
        else: target,_=self.locate(p['target_selector'],release=False)
        if (target['frame'],target['backend'])==(ref['frame'],ref['backend']): raise BrowserUseError('拖动源和目标是同一元素',2)
        source=self._point(ref); dest=self._point(target)
        again=self._point(ref)
        if abs(again[0]-source[0])>1 or abs(again[1]-source[1])>1: raise BrowserUseError('源和目标不能同时显示在视口内；拒绝猜测坐标',5)
        mode=p.get('mode','auto'); steps=p.get('steps',10)
        draggable=self.driver._function(ref,"function(){let e=this;while(e&&e.nodeType===1){if(e.draggable)return true;e=e.parentElement}return false}")
        if mode=='auto': mode='html5' if draggable else 'mouse'
        if mode=='mouse': return self._drag_mouse(source,dest,steps)
        if not draggable: raise BrowserUseError('源元素不是 HTML5 draggable；改用 mode="mouse"',1)
        for item in (ref,target):
            if item['session']!=self.driver.session_id: raise BrowserUseError('跨进程 iframe 内的 HTML5 拖放尚不支持',5)
        return self._drag_html5(target,source,dest,steps)

    def _drag_mouse(self,source,dest,steps):
        call=lambda kind,x,y,buttons:self.driver.call('Input.dispatchMouseEvent',{'type':kind,'x':x,'y':y,'button':'left','buttons':buttons,'clickCount':1 if kind!='mouseMoved' else 0},timeout=5)
        call('mouseMoved',*source,0); call('mousePressed',*source,1)
        for i in range(1,steps+1): call('mouseMoved',source[0]+(dest[0]-source[0])*i/steps,source[1]+(dest[1]-source[1])*i/steps,1)
        call('mouseReleased',*dest,0)
        return {'ok':True,'mode':'mouse','from':list(source),'to':list(dest),'dropVerified':False,'via':'cdp','trusted':True}

    def _drag_html5(self,target,source,dest,steps):
        driver=self.driver
        watch=driver._call(target['session'],'Runtime.callFunctionOn',{'objectId':target['object'],'functionDeclaration':_DROP_WATCH,'returnByValue':False,'objectGroup':self._group})
        if watch.get('exceptionDetails'): driver._result(watch)
        record=watch['result']['objectId']
        pressed=False; warnings=[]; phase='dragstart'
        driver._drain(); driver._drag_data=None
        driver.call('Input.setInterceptDrags',{'enabled':True})
        try:
            mouse=lambda kind,x,y,buttons:driver.call('Input.dispatchMouseEvent',{'type':kind,'x':x,'y':y,'button':'left','buttons':buttons,'clickCount':0 if kind=='mouseMoved' else 1},timeout=5)
            mouse('mouseMoved',*source,0); mouse('mousePressed',*source,1); pressed=True
            data=None
            for i in range(1,steps+1):
                mouse('mouseMoved',source[0]+(dest[0]-source[0])*i/steps,source[1]+(dest[1]-source[1])*i/steps,1)
                driver._drain(); data=driver._drag_data
                if data is not None: break
            deadline=time.monotonic()+1
            while data is None and time.monotonic()<deadline:
                time.sleep(.02); driver._drain(); data=driver._drag_data
            if data is None: raise BrowserUseError('源元素没有开始 HTML5 拖动（未拦截到 dragstart 数据）；未重放',1,data={'phase':phase})
            phase='drop'
            for kind in ('dragEnter','dragOver','drop'):
                driver.call('Input.dispatchDragEvent',{'type':kind,'x':dest[0],'y':dest[1],'data':data,'modifiers':0},timeout=5)
            mouse('mouseReleased',*dest,0); pressed=False
            deadline=time.monotonic()+.5
            while True:
                seen=driver._result(driver._call(target['session'],'Runtime.callFunctionOn',{'objectId':record,'functionDeclaration':'function(){return {drop:this.drop,dragenter:this.dragenter,dragover:this.dragover,defaultPrevented:this.defaultPrevented,types:this.types}}','returnByValue':True}))
                if seen['drop'] or time.monotonic()>=deadline: break
                time.sleep(.03)
            if not seen['drop']: raise BrowserUseError('浏览器拖放事件已发出，但目标没有收到 drop；结果未知，未重放',1,outcome='unknown',data={'phase':phase,'observed':seen})
            return {'ok':True,'mode':'html5','from':list(source),'to':list(dest),'dropVerified':True,'dropAccepted':seen['defaultPrevented'],'types':seen['types'],'dataItems':len(data.get('items',[])),'via':'cdp','trusted':True,'warnings':warnings}
        finally:
            if pressed:
                try: driver.call('Input.dispatchMouseEvent',{'type':'mouseReleased','x':dest[0],'y':dest[1],'button':'left','buttons':0,'clickCount':1},timeout=2)
                except BrowserUseError as exc: warnings.append({'cleanup':'mouseReleased','error':str(exc)})
            try: driver.call('Input.setInterceptDrags',{'enabled':False},timeout=2)
            except BrowserUseError as exc:
                warnings.append({'cleanup':'setInterceptDrags','error':str(exc)})
                self.close_errors.append({'domain':'drag','error':str(exc)})
            try: driver._call(target['session'],'Runtime.callFunctionOn',{'objectId':record,'functionDeclaration':'function(){this.stop()}'},timeout=2)
            except BrowserUseError as exc: warnings.append({'cleanup':'dropWatch','error':str(exc)})
            driver._drag_data=None

    def _patch(self,ref,p):
        if not (set(p)-{'handle'}): raise BrowserUseError('patch 需要 attrs/text/styles',2)
        attrs=p.get('attrs',{}); styles=p.get('styles',{}); text=p.get('text')
        if not isinstance(attrs,dict) or not isinstance(styles,dict): raise BrowserUseError('attrs/styles 需要对象',2)
        for name,value in attrs.items():
            if not isinstance(name,str) or not name or any(c.isspace() or c in '\"\'>/=' for c in name) or value is not None and not isinstance(value,str): raise BrowserUseError('attrs 名称或值不合法',2)
            if name.lower().startswith('on') or name.lower() in ('src','srcdoc','href','action','formaction','style'): raise BrowserUseError('patch 禁止脚本/导航属性；请用明确页面API',6)
        for name,value in styles.items():
            if not isinstance(name,str) or not name or value is not None and not isinstance(value,str): raise BrowserUseError('styles 名称或值不合法',2)
        if 'text'in p and not isinstance(text,str): raise BrowserUseError('text 需要字符串',2)
        if len(self._patches)>=1000: raise BrowserUseError('未还原 patch 已达到1000上限',5)
        changed=self.driver._function(ref,_PATCH,(attrs,text,styles))
        identifier=uuid.uuid4().hex
        self._patches[identifier]={'handle':dict(p['handle']),**changed}
        return {'ok':True,'patchId':identifier,'via':'property','trusted':False,**changed}

    def _restore(self,p):
        identifier=string(p.get('patchId'),'patchId',empty=True); patch=self._patches.get(identifier)
        if patch is None: raise BrowserUseError('未知或已还原的 patchId',3)
        ref=self._ref(patch['handle'])
        result=self.driver._function(ref,_RESTORE,(patch['before'],patch['after']))
        if not result['restored']: raise BrowserUseError('页面已外部修改，拒绝覆盖',6,data=result)
        del self._patches[identifier]
        return {'ok':True,'patchId':identifier,'restored':True,'via':'property','trusted':False}

    def _screenshot(self,ref,p):
        shrink=positive(p.get('shrink',1400),'shrink',integer=True,zero=True)
        fmt,quality=_image_options(p)
        rect,q,x,y=self._geometry(ref)
        q=self.driver._call(ref['session'],'DOM.getBoxModel',{'backendNodeId':ref['backend']})['model']['border']
        if ref['session']!=self.driver.session_id:
            points=[self.driver._root_geometry(ref['session'],q[i],q[i+1]) for i in range(0,8,2)]
            q=[v for point in points for v in point]
        if abs(q[1]-q[3])>.5 or abs(q[5]-q[7])>.5 or abs(q[0]-q[6])>.5 or abs(q[2]-q[4])>.5: raise BrowserUseError('旋转或透视 iframe 截图区域尚不支持',5)
        metrics=self.driver.call('Page.getLayoutMetrics')['cssLayoutViewport']
        clip={'x':min(q[0::2])+metrics['pageX'],'y':min(q[1::2])+metrics['pageY'],'width':max(q[0::2])-min(q[0::2]),'height':max(q[1::2])-min(q[1::2])}
        if clip['width']<=0 or clip['height']<=0: raise BrowserUseError('元素没有截图区域',1)
        dpr=self.driver._eval('devicePixelRatio') or 1
        clip['scale']=min(1,shrink/(max(clip['width'],clip['height'])*dpr)) if shrink else 1
        args={'format':fmt,'fromSurface':True,'captureBeyondViewport':True,'clip':clip}
        if quality is not None: args['quality']=quality
        raw=base64.b64decode(self.driver.call('Page.captureScreenshot',args)['data'],validate=True)
        size=_image_size(raw)
        path=_save_image(raw,p.get('out'),p.get('overwrite',False),fmt,'browser-use-element')
        width,height=size or (round(clip['width']*clip['scale']*dpr),round(clip['height']*clip['scale']*dpr))
        return {'ok':True,'path':str(path),'clip':clip,'quads':[q],'coordinateSpace':'root document CSS pixels','screenshot':{'width':width,'height':height,'format':fmt,'quality':quality,'bytes':len(raw),'scaled':clip['scale']<1,'sizeSource':'file' if size else 'estimate'}}

    def close(self):
        """仅清服务句柄；patch 必须显式 restore，不隐式覆盖页面。拖放清理失败等先前错误保留。"""
        self.close_errors=[e for e in self.close_errors if e.get('domain')=='drag']
        with self.driver._lock:
            sessions=self.driver.session_ids
            page_gone=self.driver.session_id not in sessions
            for sid in sessions:
                try: self.driver._call(sid,'Runtime.releaseObjectGroup',{'objectGroup':self._group})
                except BrowserUseError as exc:
                    if not gone(exc): self.close_errors.append(exc.as_dict())
                    elif sid==self.driver.session_id: page_gone=True
        # 页面已不在时 patch 随文档一起消失，没有可还原的东西。
        if self._patches and not page_gone: self.close_errors.append({'error':'存在未显式还原的元素 patch','patchIds':list(self._patches)})
        self._handles.clear()
        self._patches.clear()
