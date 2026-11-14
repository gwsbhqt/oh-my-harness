"""后台网页驱动：固定目标、文档身份和快照引用，不重放操作。"""
from __future__ import annotations
import base64
import fnmatch
import json
import math
import os
from pathlib import Path
import queue
import re
import struct
import sys
import threading
import time
import uuid
from .checks import boolean, choice, gone, integer, number, positive, seconds, stale, string
from .errors import BrowserUseError

_META = """function(){
 const e=this,r=e.getBoundingClientRect?.(),w=e.ownerDocument?.defaultView;
 if(!r||!w)return {connected:!!e.isConnected,id:e.id||'',tag:e.tagName||'',value:'',editable:false,enabled:false,bounds:null,visible:false,offscreen:false,occluded:false,scrollable:false,scrollDirections:[]};
 const s=w.getComputedStyle(e),visible=!!(r.width&&r.height)&&s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false;
 const offscreen=r.bottom<=0||r.right<=0||r.top>=w.innerHeight||r.left>=w.innerWidth;
 const x=Math.max(0,Math.min(w.innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(w.innerHeight-1,r.y+r.height/2));
 const hit=e.getRootNode().elementFromPoint?.(x,y)||e.ownerDocument.elementFromPoint(x,y);
 const directions=n=>{const c=w.getComputedStyle(n),a=[];if(/auto|scroll|overlay/.test(c.overflowY)&&n.scrollHeight>n.clientHeight){if(n.scrollTop>0)a.push('up');if(n.scrollTop+n.clientHeight<n.scrollHeight-1)a.push('down')}if(/auto|scroll|overlay/.test(c.overflowX)&&n.scrollWidth>n.clientWidth){if(n.scrollLeft>0)a.push('left');if(n.scrollLeft+n.clientWidth<n.scrollWidth-1)a.push('right')}return a};
 const dirs=directions(e);let ancestor=e.parentElement,scrollAncestor=null;
 while(ancestor){const ds=directions(ancestor);if(ds.length){scrollAncestor={id:ancestor.id||'',tag:ancestor.tagName,directions:ds};break}ancestor=ancestor.parentElement||ancestor.getRootNode()?.host}
 return {connected:!!e.isConnected,id:e.id||'',tag:e.tagName||'',value:('value'in e?String(e.value):(e.isContentEditable?e.innerText:'')),editable:e.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName),enabled:!e.matches(':disabled')&&!e.closest('[inert]')&&e.getAttribute('aria-disabled')!=='true',bounds:{x:r.x,y:r.y,width:r.width,height:r.height},visible,offscreen,occluded:visible&&!offscreen&&!(hit===e||e.contains(hit)),scrollable:dirs.length>0,scrollDirections:dirs,scrollAncestor};}"""


# 动作落点：元素的可辨认描述和动作前后的值。密码、验证码、卡号字段只给长度；digest 只用来判断值有没有变。
_DESCRIBE = r"""function(limit){
  const e = this, doc = e.ownerDocument;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const attr = name => (e.getAttribute ? e.getAttribute(name) : null);
  let host = null;
  if (e.isContentEditable) {
    host = e;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
  }
  const tag = (e.tagName || '').toLowerCase();
  let name = attr('aria-label');
  if (!name && attr('aria-labelledby')) {
    name = attr('aria-labelledby').split(/\s+/).map(id => (doc.getElementById(id) || {}).innerText || '').join(' ');
  }
  if (!name && e.labels && e.labels.length) name = e.labels[0].innerText;
  if (!name) name = attr('placeholder') || attr('title') || attr('alt') || '';
  if (!name && /^(button|a|summary|option|label|h[1-6]|p|li|span|td|th|div)$/.test(tag) && !host) name = e.innerText;
  const types = {checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox'};
  const implicit = {textarea: 'textbox', button: 'button', a: 'link', select: 'combobox', p: 'paragraph', li: 'listitem', body: 'document'};
  let role = attr('role') || '';
  if (!role && tag === 'input') role = types[e.type] || 'textbox';
  role = role || implicit[tag] || (host ? 'textbox' : '');
  const auto = (attr('autocomplete') || '').toLowerCase();
  const secret = (tag === 'input' && e.type === 'password') || /password|one-time-code|(^|\s)cc-/.test(auto);
  const element = {tag: tag, role: role, name: clean(name).slice(0, 80), id: e.id || ''};
  if (attr('placeholder')) element.placeholder = clean(attr('placeholder')).slice(0, 80);
  let kind = 'none', value = null;
  if (tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) {
    kind = 'checked';
    value = String(e.checked);
  } else if (tag === 'select') {
    kind = 'select';
    value = Array.from(e.selectedOptions).map(o => o.value).join(', ');
  } else if (tag === 'input' || tag === 'textarea') {
    kind = tag;
    value = String(e.value);
  } else if (host) {
    kind = 'contenteditable';
    value = host.innerText;
  }
  if (kind !== 'none') element.editable = kind;
  if (host && host !== e) {
    element.host = {tag: host.tagName.toLowerCase(), id: host.id || '', name: clean(host.getAttribute('aria-label') || '').slice(0, 80)};
  }
  const out = {element: element, kind: kind, secret: secret};
  if (value !== null) {
    let digest = 2166136261;
    for (let i = 0; i < value.length; i++) digest = Math.imul(digest ^ value.charCodeAt(i), 16777619) >>> 0;
    out.digest = digest;
    out.length = value.length;
    out.value = secret ? null : value.slice(0, limit);
    out.truncated = !secret && value.length > limit;
  }
  return out;
}"""

# 当前真正拿着焦点的元素：穿过 shadow DOM 和同进程 iframe 往里找。
_ACTIVE = r"""(() => {
  let e = document.activeElement;
  for (let i = 0; i < 20 && e; i++) {
    if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    if (/^I?FRAME$/.test(e.tagName)) {
      let inner = null;
      try { inner = e.contentDocument; } catch (error) { inner = null; }
      if (inner && inner.activeElement) { e = inner.activeElement; continue; }
    }
    break;
  }
  return e || document.body;
})()"""

# 光标停在哪：输入框给选区起止，富文本给光标所在的元素和前后几个字。
_CARET = r"""function(){
  const e = this;
  if (/^(INPUT|TEXTAREA)$/.test(e.tagName)) {
    try { return {start: e.selectionStart, end: e.selectionEnd}; } catch (error) { return null; }
  }
  const root = e.getRootNode();
  const sel = (root.getSelection && root.getSelection()) || e.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode, at = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!at) return null;
  let inside = false;
  for (let n = at; n; n = n.parentNode || n.host) if (n === e) { inside = true; break; }
  const text = node.nodeType === 3 ? node.textContent : '';
  const caret = {
    element: {tag: at.tagName.toLowerCase(), id: at.id || '', text: (at.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30)},
    collapsed: sel.isCollapsed,
    textBefore: text.slice(Math.max(0, sel.anchorOffset - 15), sel.anchorOffset),
    textAfter: text.slice(sel.anchorOffset, sel.anchorOffset + 15),
  };
  if (!inside) caret.outside = true;
  return caret;
}"""

# 把光标放到元素开头或末尾；富文本按第一个、最后一个有字的文本位置放，避开段落之间的空白节点。
_PLACE_CARET = r"""function(where){
  const e = this;
  if (/^(INPUT|TEXTAREA)$/.test(e.tagName)) {
    if (where === 'cursor') return true;
    const n = where === 'start' ? 0 : e.value.length;
    try { e.setSelectionRange(n, n); } catch (error) { return false; }
    return true;
  }
  const doc = e.ownerDocument, root = e.getRootNode();
  const sel = (root.getSelection && root.getSelection()) || doc.getSelection();
  if (where === 'cursor') {
    if (sel.rangeCount && e.contains(sel.anchorNode)) return true;
    where = 'start';
  }
  const walker = doc.createTreeWalker(e, NodeFilter.SHOW_TEXT, {acceptNode: n => /\S/.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP});
  let first = null, last = null, n;
  while ((n = walker.nextNode())) { if (!first) first = n; last = n; }
  const range = doc.createRange();
  if (where === 'start') {
    if (first) range.setStart(first, 0); else range.setStart(e, 0);
  } else {
    if (last) range.setStart(last, last.length); else range.setStart(e, e.childNodes.length);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}"""

# 点完之后焦点和被点元素的关系：就是它、在它里面、是包着它的富文本编辑区，还是别处。
_FOCUS_RELATION = r"""function(){
  const doc = this.ownerDocument;
  if (!doc.hasFocus()) return 'other';
  let a = doc.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === doc.body || a === doc.documentElement) return 'none';
  const within = (inner, outer) => { for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true; return false; };
  if (a === this) return 'self';
  if (within(a, this)) return 'descendant';
  if (a.isContentEditable && within(this, a)) return 'editing-host';
  return 'other';
}"""

# 不可聚焦的元素若在富文本里，返回整个编辑区（最外层 contenteditable）；否则 null。
_EDIT_HOST = r"""function(){
  if (!this.isContentEditable) return null;
  let host = this;
  while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
  return host;
}"""

# 不能输入时给替代：最近的可聚焦祖先，没有就找它里面第一个可输入的元素。
_FOCUS_ALTERNATIVE = r"""function(){
  const pick = 'input,textarea,select,[contenteditable=""],[contenteditable="true"],[tabindex],button,a[href]';
  const up = this.parentElement && this.parentElement.closest(pick);
  const down = this.querySelector && this.querySelector('input,textarea,[contenteditable=""],[contenteditable="true"]');
  const e = up || down;
  if (!e) return null;
  return {relation: up ? 'ancestor' : 'descendant', tag: e.tagName.toLowerCase(), id: e.id || '',
          name: (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)};
}"""

# 点击取点：先按要求的位置，再在元素真正看得见的部分（扣掉视口外和滚动容器裁掉的部分）里换几个点，
# 每个点都用 elementFromPoint 核对命中的是它自己或它里面的元素。
_CLICK_POINTS = r"""function(position){
  const e = this, w = e.ownerDocument.defaultView, r = e.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return {empty: true};
  const within = (inner, outer) => { for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true; return false; };
  const brief = n => n ? {tag: n.tagName.toLowerCase(), id: n.id || '', classes: Array.from(n.classList || []).slice(0, 3),
                          text: (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)} : null;
  let v = {l: Math.max(r.left, 0), t: Math.max(r.top, 0), r: Math.min(r.right, w.innerWidth), b: Math.min(r.bottom, w.innerHeight)};
  let clip = null;
  const up = n => n.parentElement || (n.getRootNode() && n.getRootNode().host) || null;
  for (let a = up(e); a && a !== e.ownerDocument.documentElement; a = up(a)) {
    const s = w.getComputedStyle(a);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    if (!a.clientWidth || !a.clientHeight) continue;
    const ar = a.getBoundingClientRect(), left = ar.left + a.clientLeft, top = ar.top + a.clientTop;
    const box = {l: left, t: top, r: left + a.clientWidth, b: top + a.clientHeight};
    if (box.l > v.l + 0.5 || box.t > v.t + 0.5 || box.r < v.r - 0.5 || box.b < v.b - 0.5) clip = clip || a;
    v = {l: Math.max(v.l, box.l), t: Math.max(v.t, box.t), r: Math.min(v.r, box.r), b: Math.min(v.b, box.b)};
  }
  const visible = v.r - v.l >= 1 && v.b - v.t >= 1;
  const style = w.getComputedStyle(e), inset = 4;
  const contentLeft = r.left + e.clientLeft + (parseFloat(style.paddingLeft) || 0);
  const contentTop = r.top + e.clientTop + (parseFloat(style.paddingTop) || 0);
  const clamp = (x, y) => visible ? [Math.min(Math.max(x, v.l + 1), v.r - 1), Math.min(Math.max(y, v.t + 1), v.b - 1)] : [x, y];
  const points = [];
  const add = (name, xy) => {
    if (!points.some(p => Math.abs(p.x - xy[0]) < 1 && Math.abs(p.y - xy[1]) < 1)) points.push({name: name, x: xy[0], y: xy[1]});
  };
  const topLeft = clamp(contentLeft + inset, contentTop + inset);
  if (position === 'top-left') add('top-left', topLeft);
  else add('center', [r.left + r.width / 2, r.top + r.height / 2]);
  if (visible) {
    const midX = (v.l + v.r) / 2, midY = (v.t + v.b) / 2;
    add('visible-center', [midX, midY]);
    add('top-left', topLeft);
    add('left-middle', [Math.min(v.l + inset, midX), midY]);
    add('top-middle', [midX, Math.min(v.t + inset, midY)]);
  }
  const root = e.getRootNode();
  let blocker = null;
  for (const p of points) {
    const hit = (root.elementFromPoint && root.elementFromPoint(p.x, p.y)) || e.ownerDocument.elementFromPoint(p.x, p.y);
    p.hit = !!hit && within(hit, e);
    if (!p.hit && !blocker) {
      blocker = hit ? Object.assign(brief(hit), {relation: within(e, hit) ? 'ancestor' : 'unrelated'}) : {outside: true};
      blocker.point = p.name;
    }
  }
  return {rect: {x: r.left, y: r.top, width: r.width, height: r.height},
          visible: visible ? {x: v.l, y: v.t, width: v.r - v.l, height: v.b - v.t} : null,
          clippedBy: brief(clip), points: points, blocker: blocker};
}"""

_VALUE_LIMIT = 1000


# 选择器一个都没匹配到时，收集页面上可能是目标的元素，交给 _similar 挑最像的。
_NEAR = r"""function(limit){
  const pick = 'a,button,input,textarea,select,summary,label,[role],[contenteditable],[tabindex],[id],[placeholder],[title],[alt],[data-testid]';
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const out = [];
  const visit = root => {
    for (const e of root.querySelectorAll('*')) {
      if (out.length >= limit) return;
      if (e.shadowRoot) visit(e.shadowRoot);
      if (!e.matches(pick)) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const text = e.children.length > 8 ? '' : clean(e.innerText);
      out.push({tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', id: e.id || '',
                label: clean(e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || text),
                text: text, placeholder: clean(e.getAttribute('placeholder')), testid: e.getAttribute('data-testid') || ''});
    }
  };
  visit(this);
  return out;
}"""

# 截断时给 within 用的候选容器：主内容区、导航、侧栏和带 id 的大区域，CSS 写法保证在主文档里唯一。
_CONTAINERS = r"""(() => {
  const pick = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[contenteditable],[tabindex]';
  const total = document.querySelectorAll(pick).length || 1;
  const unique = s => { try { return document.querySelectorAll(s).length === 1; } catch (error) { return false; } };
  const css = e => {
    const tag = e.tagName.toLowerCase(), role = e.getAttribute('role');
    if (e.id && unique('#' + CSS.escape(e.id))) return '#' + CSS.escape(e.id);
    for (const s of [tag, role ? '[role="' + role + '"]' : '', role ? tag + '[role="' + role + '"]' : '']) if (s && unique(s)) return s;
    const label = e.getAttribute('aria-label');
    if (label) { const s = tag + '[aria-label="' + label.replace(/"/g, '\\"') + '"]'; if (unique(s)) return s; }
    return null;
  };
  const area = innerWidth * innerHeight;
  const seen = new Set(), out = [];
  const nodes = document.querySelectorAll('main,[role=main],nav,[role=navigation],aside,[role=complementary],header,footer,section,article,form,[role=region],[aria-label],[id]');
  for (const e of nodes) {
    if (out.length >= 40 || e === document.body || e === document.documentElement) continue;
    const r = e.getBoundingClientRect();
    if (r.width * r.height < area * 0.05) continue;
    const count = e.querySelectorAll(pick).length;
    if (!count || count >= total * 0.95) continue;
    if ([...seen].some(s => s.contains(e) && s.querySelectorAll(pick).length === count)) continue;
    const s = css(e);
    if (!s) continue;
    seen.add(e);
    out.push({css: s, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', name: (e.getAttribute('aria-label') || '').slice(0, 40),
              interactive: count, main: e.matches('main,[role=main]'),
              inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth});
  }
  out.sort((a, b) => (b.main - a.main) || (b.inViewport - a.inViewport) || (a.interactive - b.interactive));
  return out.slice(0, 5);
})()"""


def _artifact_dir():
    from . import scratch
    return scratch.subdir('shots')


_SUFFIX={'png':'.png','jpeg':'.jpg','webp':'.webp'}


def _image_options(p):
    """校验截图 format/quality/out/overwrite，返回 (format, quality)。"""
    fmt=p.get('format','png')
    if fmt not in _SUFFIX: raise BrowserUseError('format 只能是 png/jpeg/webp',2)
    quality=p.get('quality')
    if quality is not None:
        if fmt=='png': raise BrowserUseError('png 不支持 quality',2)
        integer(quality,'quality',0,100)
    boolean(p.get('overwrite',False),'overwrite')
    out=p.get('out')
    if out is not None:
        suffix=Path(string(out,'out',empty=True)).suffix.lower()
        known={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp'}
        if suffix in known and known[suffix]!=fmt: raise BrowserUseError(f'out 扩展名 {suffix} 与 format={fmt} 不一致',2)
    return fmt,quality


def _image_size(raw):
    """从 PNG/JPEG/WebP 文件头读实际像素尺寸；无法识别返回 None。"""
    if raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw)>=24: return struct.unpack('>II',raw[16:24])
    if raw.startswith(b'\xff\xd8'):
        i=2
        while i+9<len(raw):
            if raw[i]!=0xFF: return None
            marker=raw[i+1]; i+=2
            if marker==0xFF: i-=1; continue
            if marker in (0xD8,0x01) or 0xD0<=marker<=0xD7: continue
            length=int.from_bytes(raw[i:i+2],'big')
            if 0xC0<=marker<=0xCF and marker not in (0xC4,0xC8,0xCC):
                return int.from_bytes(raw[i+5:i+7],'big'),int.from_bytes(raw[i+3:i+5],'big')
            i+=length
        return None
    if raw[:4]==b'RIFF' and raw[8:12]==b'WEBP' and len(raw)>=30:
        chunk=raw[12:16]
        if chunk==b'VP8X': return int.from_bytes(raw[24:27],'little')+1,int.from_bytes(raw[27:30],'little')+1
        if chunk==b'VP8 ': return int.from_bytes(raw[26:28],'little')&0x3fff,int.from_bytes(raw[28:30],'little')&0x3fff
        if chunk==b'VP8L':
            bits=int.from_bytes(raw[21:25],'little')
            return (bits&0x3fff)+1,((bits>>14)&0x3fff)+1
    return None


def _save_image(raw,out,overwrite,fmt,prefix):
    """写 600 新文件；默认放进 700 私有目录，已有文件只在 overwrite 时覆盖。"""
    if out is None: path=_artifact_dir()/(prefix+'-'+uuid.uuid4().hex+_SUFFIX[fmt])
    else:
        path=Path(string(out,'out',empty=True)).expanduser().absolute()
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    flags=os.O_WRONLY|os.O_CREAT|getattr(os,'O_NOFOLLOW',0)|(os.O_TRUNC if overwrite else os.O_EXCL)
    try: fd=os.open(path,flags,0o600)
    except FileExistsError as exc: raise BrowserUseError('截图路径已存在；需显式 overwrite=True',6) from exc
    with os.fdopen(fd,'wb') as output:
        os.fchmod(output.fileno(),0o600)
        output.write(raw)
    return path


def _build_keys():
    keys={}
    def add(name,key,code,keycode,text=None,location=0,shifted=None):
        keys[name]={'key':key,'code':code,'keyCode':keycode,'text':text,'location':location,'shifted':shifted}
    for c in 'abcdefghijklmnopqrstuvwxyz':
        add(c,c,'Key'+c.upper(),ord(c.upper()),c,shifted=c.upper())
        add(c.upper(),c.upper(),'Key'+c.upper(),ord(c.upper()),c.upper())
    for d,s in zip('0123456789',')!@#$%^&*('):
        add(d,d,'Digit'+d,48+int(d),d,shifted=s)
        add(s,s,'Digit'+d,48+int(d),s)
    for plain,shift,code,keycode in ((';',':','Semicolon',186),('=','+','Equal',187),(',','<','Comma',188),('-','_','Minus',189),('.','>','Period',190),('/','?','Slash',191),('`','~','Backquote',192),('[','{','BracketLeft',219),('\\','|','Backslash',220),(']','}','BracketRight',221),("'",'"','Quote',222)):
        add(plain,plain,code,keycode,plain,shifted=shift)
        add(shift,shift,code,keycode,shift)
    add(' ',' ','Space',32,' '); add('Space',' ','Space',32,' ')
    for name,keycode,text in (('Enter',13,'\r'),('Tab',9,None),('Backspace',8,None),('Escape',27,None),('Delete',46,None),('Insert',45,None),('Home',36,None),('End',35,None),('PageUp',33,None),('PageDown',34,None),('ArrowLeft',37,None),('ArrowUp',38,None),('ArrowRight',39,None),('ArrowDown',40,None),('ContextMenu',93,None),('CapsLock',20,None),('NumLock',144,None),('ScrollLock',145,None),('Pause',19,None),('PrintScreen',44,None)):
        add(name,name,name,keycode,text)
    for n in range(1,25): add(f'F{n}',f'F{n}',f'F{n}',111+n)
    for name,keycode in (('Shift',16),('Control',17),('Alt',18),('Meta',91)):
        add(name,name,name+'Left',keycode,location=1)
        add(name+'Left',name,name+'Left',keycode,location=1)
        add(name+'Right',name,name+'Right',92 if name=='Meta' else keycode,location=2)
    for n in range(10): add(f'Numpad{n}',str(n),f'Numpad{n}',96+n,str(n),location=3)
    for name,key,keycode in (('NumpadMultiply','*',106),('NumpadAdd','+',107),('NumpadSubtract','-',109),('NumpadDecimal','.',110),('NumpadDivide','/',111)):
        add(name,key,name,keycode,key,location=3)
    add('NumpadEnter','Enter','NumpadEnter',13,'\r',location=3)
    for alias,name in (('Return','Enter'),('Esc','Escape'),('Del','Delete'),('Up','ArrowUp'),('Down','ArrowDown'),('Left','ArrowLeft'),('Right','ArrowRight')):
        keys[alias]=keys[name]
    for name,info in list(keys.items()):
        if len(name)==1 and info.get('shifted') and info['code'] not in keys: keys[info['code']]=info
    return keys


_KEYS=_build_keys()
_KEYS_FOLDED={name.lower():name for name in _KEYS if len(name)>1}
_MODIFIERS={'control':'Control','ctrl':'Control','shift':'Shift','alt':'Alt','option':'Alt','opt':'Alt','meta':'Meta','cmd':'Meta','command':'Meta'}
_MOD_BITS={'Alt':1,'Control':2,'Meta':4,'Shift':8}


def _key_info(name):
    """按 Puppeteer/W3C 键名或单字符返回键描述；多字符名不区分大小写。"""
    if not isinstance(name,str) or not name: raise BrowserUseError('键名需要非空字符串',2)
    if name in _KEYS: return dict(_KEYS[name])
    if len(name)>1 and name.lower() in _KEYS_FOLDED: return dict(_KEYS[_KEYS_FOLDED[name.lower()]])
    if len(name)==1 and name.isprintable(): return {'key':name,'code':'','keyCode':0,'text':name,'location':0,'shifted':None}
    raise BrowserUseError(f'不支持按键 {name}',2)


def _combo(keys):
    """解析 "Control+Shift+K"、"Control++"；返回 (修饰键列表, 主键描述)。"""
    text=string(keys,'keys')
    if text=='+': head,key='', '+'
    elif text.endswith('++'): head,key=text[:-2],'+'
    else:
        parts=text.split('+'); head,key='+'.join(parts[:-1]),parts[-1]
    mods=[]
    if head or text.startswith('+') and text!='+':
        for part in head.split('+'):
            canon=_MODIFIERS.get(part.lower())
            if canon is None: raise BrowserUseError(f'不支持组合键修饰符 {part!r}',2)
            if canon in mods: raise BrowserUseError(f'修饰键 {part} 重复',2)
            mods.append(canon)
    return mods,_key_info(key)


class _DialogPending(BrowserUseError):
    def __init__(self,dialog,data=None):
        super().__init__('输入触发了页面对话框；后续输入未发送',1,outcome='dialog_open',data=dict(data or {},dialog=dialog))


def _dialog_summary(dialog):
    return {k:dialog.get(k) for k in ('type','message','url','frameId')} if dialog else None


def _brief(element):
    """把元素描述写成一眼能认出的短文字，例如 textbox「标题」#title。"""
    if not element:
        return '（未知元素）'
    text = element.get('role') or element.get('tag') or '元素'
    name = element.get('name') or element.get('label') or element.get('text') or element.get('placeholder')
    if name:
        text += '「' + str(name)[:30] + '」'
    if element.get('id'):
        text += '#' + element['id']
    elif element.get('tag') and element.get('role') and element['tag'] != element['role']:
        text += '<' + element['tag'] + '>'
    if element.get('idx') is not None:
        text += f'（编号 {element["idx"]}）'
    return text


def _similar(query, items, fields, limit=5):
    """按包含关系和编辑相似度挑出最接近 query 的几项。"""
    import difflib
    wanted = re.sub(r'\s+', '', str(query).casefold())
    if not wanted:
        return []
    scored = []
    for position, item in enumerate(items[:5000]):
        best = 0.0
        for name in fields:
            value = re.sub(r'\s+', '', str(item.get(name) or '').casefold())[:200]
            if len(value) < 2 and value != wanted:
                continue
            if value == wanted:
                score = 1.0
            elif wanted in value or value in wanted:
                score = 0.7 + 0.3 * min(len(value), len(wanted)) / max(len(value), len(wanted))
            elif min(len(value), len(wanted)) >= 3:
                score = difflib.SequenceMatcher(None, wanted, value).ratio()
            else:
                score = 0.0
            best = max(best, score)
        if best >= 0.5:
            scored.append((-best, position, item))
    scored.sort(key=lambda entry: entry[:2])
    return [item for _, _, item in scored[:limit]]


def _ax_level(node, lookup):
    """无障碍节点在树里的层数。"""
    seen = set()
    count = 0
    while node.get('parentId') in lookup and node['parentId'] not in seen:
        seen.add(node['parentId'])
        count += 1
        node = lookup[node['parentId']]
    return count


_SELECTOR = {'idx','id','label','snapshot'}
_TARGET = _SELECTOR|{'selector'}
_PARAMS = {
    'snap': {'shot','diff','all','max','depth','out','shrink','overwrite','within','interactive_only','include_urls','ax_properties'},
    'click': _TARGET|{'at','count','button','coord','position'},
    'type': _TARGET|{'text','allow_newline','position'},
    'key': _TARGET|{'keys','key'}, 'set': _SELECTOR|{'value'},
    'act': _SELECTOR|{'action'}, 'scroll': _SELECTOR|{'direction','pages'},
    'drag': {'start','end','coord'}, 'selecttext': _SELECTOR|{'text'},
    'read': _SELECTOR|{'selected'},
    'wait': {'label','text','expression','gone','timeout','selector','state','url','load','any_text'},
    'shot': {'out','shrink','overwrite','full_page','fullPage','format','quality'},
    'goto': {'url','timeout','before_unload'}, 'reload': {'ignore_cache','timeout','before_unload'},
    'back': {'timeout','before_unload'}, 'forward': {'timeout','before_unload'},
    'eval': {'expression','script','await_promise'}, 'init_add': {'source','script'},
    'init_remove': {'identifier','id'}, 'upload': _SELECTOR|{'files'},
    'dialog': {'accept','text','prompt_text'},
    'viewport': {'width','height','device_scale_factor','mobile','reset'},
    'download': {'action','guid','timeout','path'}, 'popups': set(),
    'page_info': set(), 'page_text': {'max_chars','frame'}, 'frames': set(),
    'key_down': {'key'}, 'key_up': {'key'},
    'type_keys': _TARGET|{'text','delay_ms','allow_newline','position'},
    'edit': _TARGET|{'command'},
    'mouse_move': {'x','y','steps'}, 'mouse_down': {'x','y','button','click_count'}, 'mouse_up': {'x','y','button','click_count'},
    'wheel': {'dx','dy','x','y'},
    'fill_form': {'items'},
    'upload_via_chooser': _TARGET|{'files','timeout'},
}
_INPUT_ACTIONS=('click','type','key','set','act','scroll','drag','selecttext','upload','type_keys','key_down','key_up','edit','mouse_move','mouse_down','mouse_up','wheel','fill_form','upload_via_chooser')
_INTERACTIVE_ROLES={'textbox','searchbox','slider','spinbutton','listbox','menuitemcheckbox','menuitemradio','treeitem','switch','checkbox','radio','combobox'}
_BUTTON_BITS={'left':1,'right':2,'middle':4}
_EDIT_COMMANDS={'select_all':('a','selectAll'),'copy':('c','copy'),'cut':('x','cut'),'paste':('v','paste'),'undo':('z','undo'),'redo':('z','redo')}
_CLIPBOARD_COMMANDS=('copy','cut','paste')
_CLICK_POSITIONS=('center','top-left')
_TYPE_POSITIONS=('cursor','start','end')
_SNAP_MAX=300
_LOADS=('domcontentloaded','load','networkidle')
_STATES=('attached','detached','visible','hidden')


def _files(files):
    if not isinstance(files,list) or not files or len(files)>100: raise BrowserUseError('files 需要 1~100 个路径的列表',2)
    paths=[str(Path(string(f,'file',empty=True)).expanduser().resolve()) for f in files]
    if any(not Path(f).is_file() for f in paths): raise BrowserUseError('上传文件不存在或不是普通文件',3)
    return paths


def _target_fields(p):
    if p.get('selector') is not None:
        from .elements import parse_selector
        if any(p.get(k) is not None for k in ('idx','id','label')): raise BrowserUseError('selector 不能和 idx / id / label 混用',2)
        parse_selector(p['selector'])


def _xy(p,required):
    if required or 'x' in p or 'y' in p:
        if 'x' not in p or 'y' not in p: raise BrowserUseError('x 与 y 需要同时给出',2)
        number(p['x'],'x',-1e6,1e6); number(p['y'],'y',-1e6,1e6)


def _validate(action,p):
    """在任何 CDP 调用前校验字段类型和取值；不修改调用方参数。"""
    _target_fields(p)
    if action=='snap':
        if 'max' in p: positive(p['max'],'max',integer=True)
        if 'depth' in p and p['depth'] is not None: positive(p['depth'],'depth',integer=True)
        if p.get('max',_SNAP_MAX)>10000 or (p.get('depth') or 25)>100: raise BrowserUseError('max 上限 10000，depth 上限 100',2)
        if 'shrink' in p: positive(p['shrink'],'shrink',integer=True,zero=True)
        if p.get('within') is not None and (not isinstance(p['within'],str) or not p['within']): raise BrowserUseError('within 需要非空 CSS 字符串',2)
        for key in ('interactive_only','include_urls','ax_properties'):
            if key in p: boolean(p[key],key)
        if p.get('interactive_only') and p.get('all'): raise BrowserUseError('interactive_only 与 all 不能同时为 true',2)
        if p.get('shot'): _image_options({k:v for k,v in p.items() if k in ('out','overwrite')})
    elif action=='click':
        if 'count' in p: positive(p['count'],'count',integer=True)
        if p.get('count',1)>3: raise BrowserUseError('count 只支持 1 到 3',2)
        if p.get('button','left') not in ('left','right','middle'): raise BrowserUseError('button 只能是 left/right/middle',2)
        if p.get('at') is not None:
            if any(p.get(k) is not None for k in ('idx','id','label','selector')): raise BrowserUseError('at 不能和元素选择器混用',2)
            PageDriver._point(p['at'])
        if p.get('position') is not None:
            choice(p['position'],'position',_CLICK_POSITIONS)
            if p.get('at') is not None and p['position']!='center':
                raise BrowserUseError('position 只用于按元素点击；at 已经给了确切坐标',2)
    elif action in ('type','type_keys'):
        text=string(p.get('text'),'text',empty=True)
        if 'allow_newline' in p: boolean(p['allow_newline'],'allow_newline')
        if p.get('position') is not None:
            choice(p['position'],'position',_TYPE_POSITIONS)
        if action=='type_keys':
            if not text or len(text)>10000: raise BrowserUseError('type_keys 的 text 需要 1~10000 个字符',2)
            if 'delay_ms' in p: integer(p['delay_ms'],'delay_ms',0,1000)
        if ('\n' in text or '\r' in text) and not p.get('allow_newline',False): raise BrowserUseError('输入换行需要 allow_newline=True，避免意外发送',6)
    elif action=='key':
        if ('keys' in p)==('key' in p): raise BrowserUseError('key 需要且只需要 keys 或 key',2)
        _combo(p.get('keys',p.get('key')))
    elif action in ('key_down','key_up'):
        _key_info(p.get('key'))
    elif action=='edit':
        if p.get('command') not in _EDIT_COMMANDS: raise BrowserUseError('command 只能是 copy/cut/paste/select_all/undo/redo',2)
    elif action=='mouse_move':
        _xy(p,True)
        if 'steps' in p: integer(p['steps'],'steps',1,240)
    elif action in ('mouse_down','mouse_up'):
        _xy(p,False)
        if p.get('button','left') not in _BUTTON_BITS: raise BrowserUseError('button 只能是 left/middle/right',2)
        if 'click_count' in p: integer(p['click_count'],'click_count',1,3)
    elif action=='wheel':
        _xy(p,False)
        if 'dx' not in p and 'dy' not in p: raise BrowserUseError('wheel 需要 dx 或 dy',2)
        for key in ('dx','dy'):
            if key in p: number(p[key],key,-100000,100000)
    elif action=='wait':
        kinds=[k for k in ('label','text','expression','selector','url','load','any_text') if p.get(k) is not None]
        if len(kinds)!=1: raise BrowserUseError('wait 需要且只需要 label/text/expression/selector/url/load/any_text 之一',2)
        kind=kinds[0]
        if 'timeout' in p: seconds(p['timeout'],'timeout',600)
        if 'gone' in p:
            boolean(p['gone'],'gone')
            if p['gone'] and kind in ('selector','load','any_text'): raise BrowserUseError(f'{kind} 等待不接受 gone；selector 用 state=detached/hidden',2)
        if 'state' in p and kind!='selector': raise BrowserUseError('state 只用于 selector 等待',2)
        if kind=='selector':
            from .elements import parse_selector
            parse_selector(p['selector'])
            if p.get('state','visible') not in _STATES: raise BrowserUseError('state 只能是 attached/detached/visible/hidden',2)
        elif kind=='load':
            if p['load'] not in _LOADS: raise BrowserUseError('load 只能是 domcontentloaded/load/networkidle',2)
        elif kind=='any_text':
            texts=p['any_text']
            if not isinstance(texts,list) or not 1<=len(texts)<=100 or any(not isinstance(t,str) or not t for t in texts): raise BrowserUseError('any_text 需要 1~100 个非空字符串',2)
        elif kind=='url':
            if not isinstance(p['url'],str) or not p['url']: raise BrowserUseError('url 需要非空通配字符串',2)
        else: string(p[kind],kind,empty=True)
    elif action=='shot':
        _image_options(p)
        if 'shrink' in p: positive(p['shrink'],'shrink',integer=True,zero=True)
    elif action in ('goto','reload','back','forward'):
        if action=='goto' and (not isinstance(p.get('url'),str) or not p['url']): raise BrowserUseError('goto 需要 url 字符串',2)
        if 'timeout' in p: seconds(p['timeout'],'timeout',120)
        if p.get('before_unload','report') not in ('report','accept','dismiss'): raise BrowserUseError('before_unload 只能是 report/accept/dismiss',2)
        if 'ignore_cache' in p: boolean(p['ignore_cache'],'ignore_cache')
    elif action=='page_text':
        if 'max_chars' in p: integer(p['max_chars'],'max_chars',1,1000000)
        if p.get('frame') is not None and not isinstance(p['frame'],str): raise BrowserUseError('frame 需要 frame ID 字符串',2)
    elif action=='upload_via_chooser':
        _files(p.get('files'))
        if 'timeout' in p: seconds(p['timeout'],'timeout',30)
        if not any(p.get(k) is not None for k in ('idx','id','label','selector')): raise BrowserUseError('upload_via_chooser 需要 selector 或 idx+snapshot',2)
    elif action=='fill_form':
        items=p.get('items')
        if not isinstance(items,list) or not 1<=len(items)<=200: raise BrowserUseError('items 需要 1~200 项的列表',2)
        from .elements import parse_selector
        for index,item in enumerate(items):
            where=f'items[{index}]'
            if not isinstance(item,dict): raise BrowserUseError(where+' 需要对象',2)
            unknown=set(item)-{'selector','value','kind','by'}
            if unknown: raise BrowserUseError(where+' 含未知字段：'+', '.join(sorted(map(str,unknown))),2)
            parse_selector(item.get('selector'))
            kind=item.get('kind'); value=item.get('value')
            if kind is not None and kind not in ('text','select','check','uncheck'): raise BrowserUseError(where+'.kind 只能是 text/select/check/uncheck',2)
            if 'by' in item and (item['by'] not in ('value','label') or kind not in ('select',None)): raise BrowserUseError(where+'.by 只用于 select，取 value/label',2)
            if kind in ('check','uncheck'):
                if 'value' in item: raise BrowserUseError(where+' 的 check/uncheck 不接受 value',2)
            elif kind=='text':
                string(value,where+'.value',empty=True)
            elif kind=='select':
                if not (isinstance(value,str) or isinstance(value,list) and value and all(isinstance(v,str) for v in value) and len(set(value))==len(value)): raise BrowserUseError(where+'.value 需要字符串或不重复字符串列表',2)
            elif not isinstance(value,(str,bool)) and not (isinstance(value,list) and value and all(isinstance(v,str) for v in value)): raise BrowserUseError(where+'.value 需要字符串、布尔值或字符串列表',2)
            if isinstance(value,str) and ('\n' in value or '\r' in value): raise BrowserUseError(where+' 含换行；批量填表不发送换行',6)
    elif action=='viewport':
        pass


class PageDriver:
    def __init__(self,cdp,target_id,session_id):
        self.cdp,self.target_id,self.session_id=cdp,target_id,session_id
        self.network=None
        self.browser_context_id=None
        self._downloads={}
        self._popups={}
        self._closed=False
        self._destroyed=False
        self._lock=threading.RLock()
        self._events=queue.Queue(maxsize=5000)
        self._event_loss=0
        self._sessions_lock=threading.RLock()
        self._sessions={session_id:target_id}
        self._event_sessions={session_id}
        self._event_downloads={}
        self._initialized=set()
        self._frames_cache={}
        self._refs={}
        self._token=None
        self._public_token=None
        self._epoch=0
        self._group=None
        self._previous=[]
        self._scripts={}
        self._dialog=None
        self._lifecycle={}
        self._lifecycle_sessions=set()
        self._drag_data=None
        self._choosers=[]
        self._chooser_sessions=set()
        self._held_keys={}
        self._held_buttons={}
        self._pointer=(0.0,0.0)
        self._locator=None
        self._cleanup_errors=[]
        self._unsubscribers=[]
        for name in ('Target.attachedToTarget','Target.detachedFromTarget','Target.targetDestroyed','Inspector.detached','Page.frameNavigated','Page.frameDetached','Page.javascriptDialogOpening','Page.javascriptDialogClosed','Browser.downloadWillBegin','Browser.downloadProgress','Target.targetCreated','Target.targetInfoChanged','Page.lifecycleEvent','Input.dragIntercepted','Page.fileChooserOpened'):
            self._unsubscribers.append(cdp.on(name,lambda p,s,name=name:self._event(name,p,s)))
        try: self._initialize(session_id)
        except BaseException:
            self.close()
            raise

    def _event(self,name,params,sid):
        with self._sessions_lock:
            if name=='Target.targetDestroyed':
                relevant=params.get('targetId')==self.target_id
            elif name in ('Target.targetCreated','Target.targetInfoChanged'):
                relevant=params.get('targetInfo',{}).get('openerId')==self.target_id
            elif name=='Browser.downloadWillBegin':
                relevant=params.get('frameId') in self._frames_cache or sid in self._event_sessions
                if relevant:
                    self._event_downloads[params['guid']]=None
                    while len(self._event_downloads)>100: self._event_downloads.pop(next(iter(self._event_downloads)))
            elif name=='Browser.downloadProgress':
                relevant=params.get('guid') in self._event_downloads or params.get('guid') in self._downloads
            else:
                relevant=sid in self._event_sessions
            if not relevant: return
            # 子会话事件可能在下次动作出队之前到达，归属须在接收 attached 时登记。
            if name=='Target.attachedToTarget' and params.get('targetInfo',{}).get('type')=='iframe':
                self._event_sessions.add(params['sessionId'])
            elif name=='Target.detachedFromTarget':
                self._event_sessions.discard(params.get('sessionId'))
            try: self._events.put_nowait((name,params,sid))
            except queue.Full: self._event_loss+=1

    @property
    def sessions(self):
        with self._sessions_lock: return dict(self._sessions)

    @property
    def session_ids(self):
        with self._sessions_lock: return set(self._sessions)

    def call(self,method,params=None,timeout=20,*,session_id=None):
        return self.cdp.call(method,params,session_id=session_id or self.session_id,timeout=timeout)

    def _call(self,sid,method,params=None,timeout=20):
        return self.cdp.call(method,params,session_id=sid,timeout=timeout)

    def _invalidate(self):
        self._epoch+=1
        self._token=None
        self._refs={}

    def _initialize(self,sid):
        if sid in self._initialized: return
        for domain in ('Page','Runtime','DOM','Accessibility'): self._call(sid,domain+'.enable')
        self._call(sid,'Input.setIgnoreInputEvents',{'ignore':False})
        self._call(sid,'Emulation.setFocusEmulationEnabled',{'enabled':True})
        self._call(sid,'Target.setAutoAttach',{'autoAttach':True,'waitForDebuggerOnStart':False,'flatten':True})
        for item in self._scripts.values():
            result=self._call(sid,'Page.addScriptToEvaluateOnNewDocument',{'source':item['source']})
            item['sessions'][sid]=result['identifier']
        self._initialized.add(sid)

    def _drain(self):
        while True:
            try: name,p,sid=self._events.get_nowait()
            except queue.Empty: break
            if name=='Target.targetDestroyed' and p.get('targetId')==self.target_id: self._destroyed=True
            if name=='Browser.downloadWillBegin' and p.get('frameId') in self._frames_cache:
                self._downloads[p['guid']]=dict(p,state='inProgress',receivedBytes=0,totalBytes=0)
                while len(self._downloads)>100: self._downloads.pop(next(iter(self._downloads)))
            elif name=='Browser.downloadProgress' and p.get('guid') in self._downloads:
                self._downloads[p['guid']].update(p)
            elif name in ('Target.targetCreated','Target.targetInfoChanged'):
                info=p.get('targetInfo',{})
                if info.get('openerId')==self.target_id:
                    self._popups[info['targetId']]=info
                    while len(self._popups)>100: self._popups.pop(next(iter(self._popups)))
            if sid not in self._sessions: continue
            if name=='Target.attachedToTarget' and p.get('targetInfo',{}).get('type')=='iframe':
                child=p['sessionId']
                with self._sessions_lock: self._sessions[child]=p['targetInfo']['targetId']
                try: self._initialize(child)
                except BrowserUseError as exc:
                    # 密码填充等扩展会插入小窗又立刻撤掉；子窗已不在时只丢掉它，不让整页动作失败。
                    if not gone(exc): raise
                    with self._sessions_lock:
                        self._sessions.pop(child,None)
                        self._event_sessions.discard(child)
                    self._initialized.discard(child)
                self._invalidate()
            elif name=='Target.detachedFromTarget':
                child=p.get('sessionId')
                if child==self.session_id: self._destroyed=True
                with self._sessions_lock: self._sessions.pop(child,None)
                self._initialized.discard(child)
                self._invalidate()
            elif name=='Inspector.detached':
                if sid==self.session_id: self._destroyed=True
                self._invalidate()
            elif name in ('Page.frameNavigated','Page.frameDetached'): self._invalidate()
            elif name=='Page.javascriptDialogOpening': self._dialog=dict(p,sessionId=sid)
            elif name=='Page.javascriptDialogClosed': self._dialog=None
            elif name=='Page.lifecycleEvent':
                record=self._lifecycle.get(p.get('frameId'))
                if record is None or record['loaderId']!=p.get('loaderId') or p.get('name')=='init':
                    record=self._lifecycle[p.get('frameId')]={'loaderId':p.get('loaderId'),'events':set()}
                    while len(self._lifecycle)>200: self._lifecycle.pop(next(iter(self._lifecycle)))
                record['events'].add(p.get('name'))
            elif name=='Input.dragIntercepted' and sid==self.session_id: self._drag_data=p.get('data')
            elif name=='Page.fileChooserOpened':
                self._choosers.append(dict(p,sessionId=sid))
                del self._choosers[:-20]

    def _target_check(self):
        self._drain()
        if self._event_loss:
            self._invalidate()
            raise BrowserUseError('网页事件队列已溢出；不能保证引用和下载记录完整，请重新绑定',5,data={'lostEvents':self._event_loss})
        if self._closed or self._destroyed: raise BrowserUseError('页面已关闭或绑定已释放；不能换成其他页面',4)
        try: self.cdp.call('Target.getTargetInfo',{'targetId':self.target_id})
        except BrowserUseError as exc:
            if exc.outcome=='unknown' or exc.code==5: raise
            self._destroyed=True
            raise BrowserUseError('固定页面目标已不存在',4) from exc

    def _frames(self):
        frames={}; missing=[]
        for sid in tuple(self._sessions):
            try:
                tree=self._call(sid,'Page.getFrameTree')['frameTree']
            except BrowserUseError as exc:
                if sid!=self.session_id and 'Session with given id not found' in str(exc):
                    with self._sessions_lock: self._sessions.pop(sid,None)
                    self._initialized.discard(sid)
                    self._invalidate()
                    continue
                raise
            pending=[tree]
            while pending:
                item=pending.pop(0); frame=item['frame']; fid=frame['id']
                if fid in self._sessions.values() and self._sessions.get(sid)!=fid:
                    pending.extend(item.get('childFrames',[])); continue
                try: context=self._call(sid,'Page.createIsolatedWorld',{'frameId':fid,'worldName':'browser-use-private'})['executionContextId']
                except BrowserUseError as exc:
                    missing.append((fid,str(exc))); continue
                obj=self._call(sid,'Runtime.evaluate',{'expression':'document','contextId':context,'returnByValue':False,'objectGroup':'browser-use-documents'})
                if obj.get('exceptionDetails') or not obj.get('result',{}).get('objectId'): raise BrowserUseError(f'无法读取 frame {fid} 的文档身份',4)
                oid=obj['result']['objectId']
                try:
                    document=self._call(sid,'DOM.describeNode',{'objectId':oid})['node']['backendNodeId']
                except BrowserUseError as exc:
                    if 'Cannot find context' in str(exc) or 'Could not find object' in str(exc):
                        raise BrowserUseError('导航期间文档身份已失效；只重新读取，不重发动作',4,data={'frames':[(fid,str(exc))]}) from exc
                    raise
                finally:
                    try: self._call(sid,'Runtime.releaseObject',{'objectId':oid})
                    except BrowserUseError as exc:
                        if not stale(exc): raise
                frames[fid]={'session':sid,'context':context,'document':document,'loader':frame.get('loaderId'),'parent':frame.get('parentId'),'url':frame.get('url',''),'name':frame.get('name',''),'securityOrigin':frame.get('securityOrigin','')}
                pending.extend(item.get('childFrames',[]))
        unresolved=[(fid,reason) for fid,reason in missing if fid not in frames]
        if unresolved: raise BrowserUseError('iframe 调试会话不可用；未静默忽略该 frame',5,data={'frames':unresolved})
        old={f:(v['session'],v['document'],v['loader']) for f,v in self._frames_cache.items()}
        new={f:(v['session'],v['document'],v['loader']) for f,v in frames.items()}
        if old and old!=new: self._invalidate()
        self._frames_cache=frames
        return frames

    def check(self):
        with self._lock:
            self._target_check()
            deadline=time.monotonic()+.3
            while True:
                try: self._frames(); break
                except BrowserUseError as exc:
                    if not exc.data.get('frames') or time.monotonic()>=deadline: raise
                    time.sleep(.01)
                    self._target_check()
            return self._epoch

    @staticmethod
    def _result(result):
        if result.get('exceptionDetails'):
            detail=result['exceptionDetails']; message=detail.get('exception',{}).get('description') or detail.get('text','网页 JavaScript 异常')
            raise BrowserUseError(message,1,data={'exceptionDetails':detail})
        obj=result.get('result',{})
        if obj.get('subtype')=='error': raise BrowserUseError(obj.get('description','网页 JavaScript 异常'),1)
        if 'unserializableValue' in obj: raise BrowserUseError('网页结果不是 JSON 兼容值',2)
        return obj.get('value')

    def _eval(self,expression,frame=None,await_promise=True,timeout=20):
        frame=frame or next(iter(self._frames_cache.values()))
        return self._result(self._call(frame['session'],'Runtime.evaluate',{'expression':expression,'contextId':frame['context'],'awaitPromise':await_promise,'returnByValue':True},timeout))

    def evaluate(self,expression,await_promise=True):
        with self._lock:
            self.check()
            return self._result(self.call('Runtime.evaluate',{'expression':string(expression,'expression',empty=True),'awaitPromise':await_promise,'returnByValue':True}))

    def _function(self,ref,function,args=(),*,timeout=20):
        params={'objectId':ref['object'],'functionDeclaration':function,'arguments':[{'value':a} for a in args],'returnByValue':True,'awaitPromise':True}
        return self._result(self._call(ref['session'],'Runtime.callFunctionOn',params,timeout))

    def _resolve(self,backend,fid):
        frame=self._frames_cache[fid]
        params={'backendNodeId':backend,'executionContextId':frame['context']}
        if self._group is not None: params['objectGroup']=self._group
        result=self._call(frame['session'],'DOM.resolveNode',params)
        oid=result.get('object',{}).get('objectId')
        if not oid: raise BrowserUseError('节点引用已失效，请重新 snap',4)
        return {'backend':backend,'frame':fid,'session':frame['session'],'document':frame['document'],'object':oid}

    def enrich(self,ref,meta):
        """补充根页面 CSS 坐标和父 frame 遮挡；局部与根可见性分别保留。"""
        meta=dict(meta)
        meta['coordinateSpace']='frame viewport CSS pixels'
        meta['rootBounds']=None
        meta['rootOffscreen']=None
        meta['rootOccluded']=None
        if not meta.get('bounds') or not meta.get('visible'): return meta
        quads=self._call(ref['session'],'DOM.getContentQuads',{'backendNodeId':ref['backend']}).get('quads',[])
        if not quads: return meta
        q=quads[0]
        corners=[self._root_geometry(ref['session'],q[i],q[i+1]) for i in range(0,8,2)]
        xs=[c[0] for c in corners];ys=[c[1] for c in corners]
        meta['rootBounds']={'x':min(xs),'y':min(ys),'width':max(xs)-min(xs),'height':max(ys)-min(ys)}
        viewport=self.call('Page.getLayoutMetrics').get('cssLayoutViewport',{})
        meta['rootOffscreen']=max(xs)<=0 or max(ys)<=0 or min(xs)>=viewport.get('clientWidth',0) or min(ys)>=viewport.get('clientHeight',0)
        meta['rootOccluded']=meta.get('occluded',False)
        fid=ref['frame']
        r=meta['bounds'];px,py=r['x']+r['width']/2,r['y']+r['height']/2
        while self._frames_cache.get(fid,{}).get('parent'):
            frame=self._frames_cache[fid];parent=self._frames_cache[frame['parent']]
            owner=self._call(parent['session'],'DOM.getFrameOwner',{'frameId':fid})
            owner_ref=self._resolve(owner['backendNodeId'],frame['parent'])
            try:
                point=self._function(owner_ref,r"""function(x,y){const r=this.getBoundingClientRect(),w=this.ownerDocument.defaultView,s=w.getComputedStyle(this);if(s.transform!=='none')return {unsupported:true};const px=r.x+this.clientLeft+x,py=r.y+this.clientTop+y;const hit=this.getRootNode().elementFromPoint?.(px,py)||this.ownerDocument.elementFromPoint(px,py);return {x:px,y:py,offscreen:px<0||py<0||px>=w.innerWidth||py>=w.innerHeight,occluded:hit!==this}}""",(px,py))
            finally: self._call(parent['session'],'Runtime.releaseObject',{'objectId':owner_ref['object']})
            if point.get('unsupported'):
                meta['rootOccluded']=None
                meta['coordinateLimitation']='transformed iframe ancestor visibility unverified'
                break
            if point['offscreen']: meta['rootOffscreen']=True
            if point['occluded'] and not point['offscreen']: meta['rootOccluded']=True
            px,py=point['x'],point['y'];fid=frame['parent']
        return meta

    def _root_geometry(self,sid,x,y):
        while sid!=self.session_id:
            fid=self._sessions[sid];frame=self._frames_cache.get(fid)
            if not frame or not frame.get('parent'): raise BrowserUseError('无法定位跨进程 iframe 的父文档',5)
            parent=self._frames_cache[frame['parent']]
            owner=self._call(parent['session'],'DOM.getFrameOwner',{'frameId':fid})
            q=self._call(parent['session'],'DOM.getBoxModel',{'backendNodeId':owner['backendNodeId']})['model']['content']
            if abs(q[0]+q[4]-q[2]-q[6])>.5 or abs(q[1]+q[5]-q[3]-q[7])>.5: raise BrowserUseError('透视 iframe 根坐标尚不支持',5)
            viewport=self._call(sid,'Page.getLayoutMetrics').get('cssLayoutViewport',{})
            w,h=viewport.get('clientWidth'),viewport.get('clientHeight')
            if not w or not h: raise BrowserUseError('iframe 视口大小不可用',5)
            x,y=q[0]+(q[2]-q[0])*x/w+(q[6]-q[0])*y/h,q[1]+(q[3]-q[1])*x/w+(q[7]-q[1])*y/h
            sid=parent['session']
        return x,y

    def _service(self):
        if self._locator is None:
            from .elements import ElementService
            self._locator=ElementService(self,private=True)
        return self._locator

    def _has_target(self,p):
        return any(p.get(k) is not None for k in ('idx','id','label','selector'))

    def _ref(self,p,*,purpose=None):
        if p.get('selector') is not None:
            if any(p.get(k) is not None for k in ('idx','id','label')): raise BrowserUseError('selector 不能和 idx / id / label 混用',2)
            self.check()
            return self._service().locate(p['selector'])
        self.check()
        selectors=[k for k in ('idx','id','label') if p.get(k) is not None]
        if len(selectors)!=1: raise BrowserUseError('元素动作需要且只需要 idx / id / label / selector',2)
        if selectors[0]=='idx':
            idx=positive(p['idx'],'idx',integer=True)
            if not p.get('snapshot') or p['snapshot']!=self._token: raise BrowserUseError('快照凭证已过期或缺失，请重新 snap',4)
            ref=self._refs.get(idx)
            if ref is None: raise BrowserUseError('该编号不在快照中',3)
        else:
            name=selectors[0]; text=string(p[name],name,empty=True)
            snap=self._snap({'max':10000,'depth':100,'all':True})
            if snap['truncated']: raise BrowserUseError(f'页面元素超过取态上限（10000 个或 100 层），无法确认 {name} 唯一；改用 selector（在整页 DOM 里查唯一）',3,outcome='not_sent',data={'truncated':True})
            hits=[e for e in snap['elements'] if e.get(name)==text]
            if purpose=='click':
                hits=[e for e in hits if 'Press' in e['actions'] or 'SetValue' in e['actions'] or e['role'] in ('generic','group') and e['id']]
            elif purpose in ('type','set'):
                hits=[e for e in hits if 'SetValue' in e['actions']]
            if len(hits)>1: raise BrowserUseError(f'{name} 精确匹配到 {len(hits)} 个元素；拒绝猜测',3)
            if not hits: self._no_match(name,text,snap['elements'],purpose)
            ref=self._refs[hits[0]['idx']]
        frame=self._frames_cache.get(ref['frame'])
        if not frame or frame['document']!=ref['document']: raise BrowserUseError('元素所属文档已变化，请重新 snap',4)
        try: meta=self._function(ref,_META)
        except BrowserUseError as exc:
            if exc.outcome=='unknown': raise
            raise BrowserUseError('元素引用已失效，请重新 snap',4) from exc
        if not meta or not meta['connected'] or (meta['tag'],meta['id'])!=ref['identity']: raise BrowserUseError('元素已移除或身份变化，请重新 snap',4)
        return ref,meta

    def _no_match(self, name, text, elements, purpose):
        """id/label 一个都没匹配到：报错并列出最像的几个元素，编号写成 id 时直接点明。"""
        usable = elements
        if purpose == 'click':
            usable = [e for e in elements if 'Press' in e['actions'] or 'SetValue' in e['actions'] or e['id']]
        elif purpose in ('type', 'set'):
            usable = [e for e in elements if 'SetValue' in e['actions']]
        fields = ('id', 'label') if name == 'id' else ('label', 'id', 'value')
        near = _similar(text, usable, fields) or _similar(text, elements, fields)
        candidates = [{'idx': e['idx'], 'role': e['role'], 'label': e['label'][:40], 'id': e['id']} for e in near]
        message = f'{name}={text!r} 精确匹配到 0 个元素；拒绝猜测'
        data = {'candidates': candidates}
        if candidates:
            data['snapshot'] = self._token
        if name == 'id' and text.strip().isdigit():
            message += f'。id 是网页元素的 id 属性，不是 snap 里的编号；按编号操作请用 idx={text.strip()}（并带上 snapshot）'
        if candidates:
            message += '。相近的元素：' + '；'.join(_brief(c) for c in candidates) + '（编号属于 data.snapshot 这次取态）'
        elif purpose == 'click' and elements:
            message += '。页面上没有相近的可点击元素，先 snap 看一下'
        raise BrowserUseError(message, 3, data=data)

    def _snap(self,p):
        self.check()
        maximum=positive(p.get('max',_SNAP_MAX),'max',integer=True); depth=positive(p.get('depth',25),'depth',integer=True)
        if maximum>10000 or depth>100: raise BrowserUseError('max 上限 10000，depth 上限 100',2)
        if self._group:
            for sid in tuple(self._sessions): self._call(sid,'Runtime.releaseObjectGroup',{'objectGroup':self._group})
        self._group='browser-use-snapshot-'+uuid.uuid4().hex; self._token=uuid.uuid4().hex; self._refs={}; start_epoch=self._epoch
        container=None; frames=self._frames_cache
        if p.get('within') is not None:
            main=self._main_frame()
            found=self._call(main['session'],'Runtime.evaluate',{'expression':'(s=>{const a=document.querySelectorAll(s);return a.length===1?a[0]:a.length})(%s)'%json.dumps(p['within']),'contextId':main['context'],'returnByValue':False,'objectGroup':self._group})
            if found.get('exceptionDetails'): raise BrowserUseError('within 不是合法 CSS：'+str(found['exceptionDetails'].get('exception',{}).get('description','')),2)
            if found['result'].get('type')!='object': raise BrowserUseError(f'within 容器必须唯一，实际 {found["result"].get("value")} 个',3,data={'count':found['result'].get('value')})
            container=found['result']['objectId']
            fid=next(f for f,v in frames.items() if v is main)
            frames={fid:main}
        candidates = []
        lookups = {}
        over_depth = 0
        for fid,frame in frames.items():
            try: nodes=self._call(frame['session'],'Accessibility.getFullAXTree',{'frameId':fid})['nodes']
            except BrowserUseError as exc:
                # iframe 在读完框架列表后换了进程或导航；取态只读，按「页面已变化」交给上层短暂重读。
                if 'Frame with the given frameId is not found' in str(exc) or 'No frame' in str(exc):
                    raise BrowserUseError('取态期间框架已变化，请重新 snap',4,data={'frame':fid}) from exc
                raise
            lookup={n['nodeId']:n for n in nodes}
            lookups[fid] = lookup
            for node in nodes:
                if node.get('ignored') or not node.get('backendDOMNodeId'): continue
                if _ax_level(node, lookup) > depth:
                    over_depth += 1
                    continue
                candidates.append((fid, node))
        order = list(range(len(candidates)))
        prioritized = False
        if len(candidates) > maximum:
            # 装不下时先留视口里看得见的元素，再按页面顺序补；否则长侧栏会把右侧主内容整个挤掉。
            visible = self._viewport_nodes(frames)
            if visible:
                prioritized = True
                first = [i for i in order if (candidates[i][0], candidates[i][1]['backendDOMNodeId']) in visible]
                order = first + [i for i in order if (candidates[i][0], candidates[i][1]['backendDOMNodeId']) not in visible]
        kept = []
        examined = 0
        for position in order:
            if len(kept) >= maximum: break
            examined += 1
            fid, node = candidates[position]
            built = self._snap_element(fid, node, p, container)
            if built is not None:
                kept.append((position, built[0], built[1]))
        kept.sort(key=lambda item: item[0])
        indexes = {}
        for number, (position, element, ref) in enumerate(kept, 1):
            fid, node = candidates[position]
            element['idx'] = number
            indexes[(fid, node['nodeId'])] = number
        elements = []
        for position, element, ref in kept:
            fid, node = candidates[position]
            lookup = lookups[fid]
            parent = node.get('parentId'); seen = set()
            while parent in lookup and (fid, parent) not in indexes and parent not in seen:
                seen.add(parent); parent = lookup[parent].get('parentId')
            element['parent'] = indexes.get((fid, parent))
            self._refs[element['idx']] = ref
            elements.append(element)
        skipped = len(candidates) - examined
        truncated = over_depth > 0 or skipped > 0
        self.check()
        if self._epoch!=start_epoch: raise BrowserUseError('取态期间页面导航，请重新 snap',4)
        result={'ok':True,'mode':'snap','snapshot':self._token,'elements':elements,'shot':None,'screenshot':{},'truncated':truncated,'timedOut':False}
        if truncated:
            result['truncation'] = self._truncation(maximum, depth, len(kept), examined, skipped, over_depth, prioritized, container is not None)
        if container is not None: result['within']={'css':p['within'],'framesIncluded':'main document only'}
        if p.get('diff'):
            signature=lambda e:json.dumps({k:v for k,v in e.items() if k not in ('idx','bounds','parent')},sort_keys=True,ensure_ascii=False)
            from collections import defaultdict
            old=defaultdict(list); new=defaultdict(list)
            for e in self._previous: old[signature(e)].append(e)
            for e in elements: new[signature(e)].append(e)
            added=[]; removed=[]
            for key in old.keys()|new.keys():
                added.extend(new[key][len(old[key]):]); removed.extend(old[key][len(new[key]):])
            result.update(mode='diff',changed=bool(added or removed),added=added,removed=removed)
        self._previous=elements
        if p.get('shot'):
            shot=self._shot(p); result['shot']=shot['path']; result['screenshot']=shot['screenshot']
        return result

    def _snap_element(self, fid, node, p, container):
        """把一个无障碍节点做成快照元素；不该列出时返回 None。返回 (元素, 引用)，idx 和 parent 由调用方补。"""
        try:
            ref=self._resolve(node['backendDOMNodeId'],fid)
        except BrowserUseError as exc:
            # 读完无障碍树之后 iframe 换了文档；和框架变化一样交给上层短暂重读。
            if exc.outcome=='unknown' or 'does not belong to the document' not in str(exc): raise
            raise BrowserUseError('取态期间文档已变化，请重新 snap',4,data={'frame':fid}) from exc
        if container is not None:
            inside=self._result(self._call(ref['session'],'Runtime.callFunctionOn',{'objectId':ref['object'],'functionDeclaration':'function(c){return this instanceof Node&&c.contains(this)}','arguments':[{'objectId':container}],'returnByValue':True}))
            if not inside: return None
        meta=self._function(ref,_META)
        if not meta: raise BrowserUseError('取态期间文档或节点已变化，请重新 snap',4)
        if not meta['connected']:
            # ::before/::after 伪元素没有 isConnected、tagName 和几何信息，跳过它；真元素被移除时 tagName 还在，照常报错。
            if not meta['tag']: return None
            raise BrowserUseError('取态期间文档或节点已变化，请重新 snap',4)
        meta=self.enrich(ref,meta)
        role=node.get('role',{}).get('value','generic')
        actions=['ScrollToVisible'] if meta['bounds'] else []
        if role in ('button','link','checkbox','radio','menuitem','tab','switch','combobox','option'): actions.append('Press')
        if meta['editable']: actions.append('SetValue')
        if not p.get('all') and not node.get('name',{}).get('value') and not node.get('value',{}).get('value') and not meta['value'] and not meta['editable'] and 'Press' not in actions:
            return None
        if p.get('interactive_only') and 'Press' not in actions and 'SetValue' not in actions and role not in _INTERACTIVE_ROLES:
            return None
        props={a['name']:a.get('value',{}).get('value') for a in node.get('properties',[])}
        element={'idx':None,'role':role,'label':str(node.get('name',{}).get('value','')),'id':meta['id'],'value':str(node.get('value',{}).get('value',meta['value'])),'enabled':meta['enabled'] and not props.get('disabled',False),'actions':actions,'parent':None,'frame':fid,'bounds':meta['bounds']}
        for key in ('visible','offscreen','occluded','editable','scrollable','scrollDirections','scrollAncestor','coordinateSpace','rootBounds','rootOffscreen','rootOccluded'):
            element[key]=meta.get(key)
        for key in ('checked','selected','expanded','required'):
            if key in props: element[key]=props[key]
        if p.get('include_urls') and (role=='link' or meta['tag']=='A'):
            element['url']=self._function(ref,"function(){const a=this.closest?.('a[href],area[href]');return a?a.href:null}")
        if p.get('ax_properties'):
            element['axProperties']=props
            if node.get('description',{}).get('value'): element['description']=node['description']['value']
        ref['identity']=(meta['tag'],meta['id'])
        return element, ref

    def _viewport_nodes(self, frames):
        """主文档里此刻落在视口内的节点 {(frame, backendNodeId)}；取不到时返回空集，取态退回纯页面顺序。"""
        main = next((fid for fid, frame in frames.items() if frame['session'] == self.session_id and not frame.get('parent')), None)
        if main is None:
            return set()
        try:
            snapshot = self._call(self.session_id, 'DOMSnapshot.captureSnapshot', {'computedStyles': []})
            viewport = self.call('Page.getLayoutMetrics').get('cssLayoutViewport', {})
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
            return set()
        width, height = viewport.get('clientWidth') or 0, viewport.get('clientHeight') or 0
        strings = snapshot.get('strings', [])
        visible = set()
        for document in snapshot.get('documents', []):
            frame_index = document.get('frameId')
            if not isinstance(frame_index, int) or frame_index >= len(strings) or strings[frame_index] != main:
                continue
            backend = document.get('nodes', {}).get('backendNodeId', [])
            layout = document.get('layout', {})
            left, top = document.get('scrollOffsetX', 0), document.get('scrollOffsetY', 0)
            for index, (x, y, w, h) in zip(layout.get('nodeIndex', []), layout.get('bounds', [])):
                if w <= 0 or h <= 0 or index >= len(backend):
                    continue
                if x - left < width and y - top < height and x + w - left > 0 and y + h - top > 0:
                    visible.add((main, backend[index]))
        return visible

    def _truncation(self, maximum, depth, kept, examined, skipped, over_depth, prioritized, scoped):
        """取态被截断时说明撞到哪个上限、大约漏了多少、怎么补。"""
        limits = []
        if skipped:
            limits.append('max')
        if over_depth:
            limits.append('depth')
        missing = round(skipped * kept / examined) if examined else skipped
        info = {'limits': limits, 'max': maximum, 'depth': depth, 'skippedNodes': skipped, 'estimatedMissing': missing,
                'overDepthNodes': over_depth, 'kept': 'viewport-first' if prioritized else 'page-order'}
        advice = []
        if skipped:
            suggested = min(10000, max(maximum * 2, ((kept + missing) * 6 // 5 // 50 + 1) * 50))
            info['suggestedMax'] = suggested
            advice.append(f'元素数撞到 max={maximum}，后面还有约 {missing} 个没列出')
            advice.append('先保留了视口里看得见的元素，再按页面顺序补' if prioritized else '按页面顺序保留了前面的元素')
            advice.append(f'要看全可用 max={suggested}')
        if over_depth:
            info['suggestedDepth'] = min(100, depth * 2)
            advice.append(f'有 {over_depth} 个节点比 depth={depth} 层更深，没列出；可用 depth={info["suggestedDepth"]}')
        if not scoped:
            try:
                containers = self._eval(_CONTAINERS, self._main_frame())
                if not isinstance(containers, list):
                    containers = []
            except BrowserUseError as exc:
                if exc.outcome == 'unknown': raise
                containers = []
            if containers:
                info['containers'] = containers
                advice.append('或用 within 只看一个区域，例如 within=' + json.dumps(containers[0]['css'], ensure_ascii=False))
        info['hint'] = '；'.join(advice)
        return info

    @staticmethod
    def _point(value):
        if not isinstance(value,(tuple,list)) or len(value)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in value): raise BrowserUseError('坐标需要两个有限数字',2)
        return value

    def _click(self,p,*,fixed_ref=None):
        if p.get('coord'): raise BrowserUseError('browser-use 不移动系统鼠标；coord=True 不支持',2)
        count=positive(p.get('count',1),'count',integer=True)
        if count>3: raise BrowserUseError('count 只支持 1 到 3',2)
        button=p.get('button','left')
        if button not in ('left','right','middle'): raise BrowserUseError('button 只能是 left/right/middle',2)
        sid=self.session_id
        ref=None
        point=None
        if p.get('at') is not None:
            if self._has_target(p): raise BrowserUseError('at 不能和元素选择器混用',2)
            self.check(); x,y=self._point(p['at'])
        else:
            ref,meta=fixed_ref if fixed_ref is not None else self._ref(p,purpose='click')
            if not meta['enabled']: raise BrowserUseError('元素不可用',1)
            sid=ref['session']; self._call(sid,'DOM.scrollIntoViewIfNeeded',{'backendNodeId':ref['backend']})
            point=self._click_point(ref,p.get('position') or 'center')
            x,y=self._root_point(ref['session'],point['x'],point['y'])
            sid=self.session_id
        buttons={'left':1,'right':2,'middle':4}[button]
        for number in range(1,count+1):
            for kind in ('mousePressed','mouseReleased'):
                try:
                    self._call(sid,'Input.dispatchMouseEvent',{'type':kind,'x':x,'y':y,'button':button,'buttons':buttons if kind=='mousePressed' else 0,'clickCount':number},timeout=2)
                except BrowserUseError as exc:
                    self._drain()
                    if exc.outcome=='unknown' and self._dialog:
                        return {'ok':True,'via':'cdp','trusted':True,'dialogPending':True,'outcome':'dialog_open'}
                    raise
        result={'ok':True,'via':'cdp','trusted':True}
        if point is not None:
            result['point']=point
        if ref is not None:
            result.update(self._click_focus(ref))
        return result

    def _click_point(self, ref, position):
        """在元素看得见的部分里挑一个确实点得到它（或它里面元素）的点，返回 {x, y, position, retried}。

        坐标是元素所在 frame 的视口坐标；首选点被挡住时换几个点再试，全都不行才报错并说明挡住它的是谁。
        """
        found = self._function(ref, _CLICK_POINTS, (position,))
        if found.get('empty'):
            raise BrowserUseError('元素没有可点击区域', 1)
        quads = self._call(ref['session'], 'DOM.getContentQuads', {'backendNodeId': ref['backend']}).get('quads', [])
        if not quads:
            raise BrowserUseError('元素没有可点击的内容区域', 1)
        rect = found['rect']
        quad = quads[0]
        # DOM.getContentQuads 和 getBoundingClientRect 都是这个 frame 的视口坐标；两者差一个 transform 时以 quad 为准。
        dx = min(quad[0::2]) - rect['x']
        dy = min(quad[1::2]) - rect['y']
        for index, candidate in enumerate(found['points']):
            if not candidate['hit']:
                continue
            point = {'x': candidate['x'] + dx, 'y': candidate['y'] + dy, 'position': candidate['name']}
            if index:
                point['retried'] = [item['name'] for item in found['points'][:index]]
                point['note'] = f'{found["points"][0]["name"]} 那个点被挡住，改点在元素的 {candidate["name"]}'
            return point
        target = self._observe(ref)
        blocker = found.get('blocker') or {}
        if blocker.get('outside') or not found.get('visible'):
            where = '元素在视口或滚动区域外，看不到它' if not found.get('visible') else '元素位置在视口外'
            if found.get('clippedBy'):
                where += f'（被 {_brief(found["clippedBy"])} 的滚动区域裁掉）'
            message = f'{_brief(target and target["element"])} 不能点击：{where}；先 scroll 到它所在的区域再点'
        else:
            relation = {'ancestor': '它的外层元素', 'unrelated': '与它无关的元素'}.get(blocker.get('relation'), '别的元素')
            classes = '.'.join(blocker.get('classes') or [])
            name = f'<{blocker.get("tag")}' + (f' id="{blocker["id"]}"' if blocker.get('id') else '') + (f' class="{classes}"' if classes else '') + '>'
            if blocker.get('text'):
                name += f'「{blocker["text"]}」'
            message = f'{_brief(target and target["element"])} 被遮挡：试了 {len(found["points"])} 个点都点到 {name}（{relation}）；拒绝点击别的元素'
        raise BrowserUseError(message, 1, data={'target': target and target['element'], 'blocker': blocker or None,
                                        'tried': [{k: v for k, v in item.items() if k in ('name', 'x', 'y', 'hit')} for item in found['points']],
                                        'visible': found.get('visible'), 'clippedBy': found.get('clippedBy')})

    def _click_focus(self, ref):
        """点完之后焦点在哪个元素、和被点的元素是什么关系。"""
        try:
            relation = self._function(ref, _FOCUS_RELATION)
            focused = self._observe(self._active_ref())
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
            return {'focused': None}
        result = {'focused': focused and focused['element'], 'focusedText': _brief(focused and focused['element']),
                  'focusRelation': relation, 'focusInTarget': relation in ('self', 'descendant', 'editing-host')}
        if focused and focused.get('kind') in ('input', 'textarea', 'contenteditable'):
            result['caret'] = self._caret(self._active_ref())
        return result


    def _root_point(self,sid,x,y):
        while sid!=self.session_id:
            fid=self._sessions[sid]
            frame=self._frames_cache.get(fid)
            if not frame or not frame.get('parent'): raise BrowserUseError('无法定位跨进程 iframe 的父文档',5)
            parent=self._frames_cache.get(frame['parent'])
            if not parent: raise BrowserUseError('跨进程 iframe 的父文档不可用',5)
            owner=self._call(parent['session'],'DOM.getFrameOwner',{'frameId':fid})
            model=self._call(parent['session'],'DOM.getBoxModel',{'backendNodeId':owner['backendNodeId']})['model']
            q=model['content']
            if abs(q[0]+q[4]-q[2]-q[6])>.5 or abs(q[1]+q[5]-q[3]-q[7])>.5: raise BrowserUseError('透视 iframe 输入坐标尚不支持',5)
            metrics=self._call(sid,'Page.getLayoutMetrics').get('cssLayoutViewport',{})
            w,h=metrics.get('clientWidth'),metrics.get('clientHeight')
            if not w or not h: raise BrowserUseError('跨进程 iframe 视口大小不可用',5)
            x,y=q[0]+(q[2]-q[0])*x/w+(q[6]-q[0])*y/h,q[1]+(q[3]-q[1])*x/w+(q[7]-q[1])*y/h
            owner_ref=self._resolve(owner['backendNodeId'],frame['parent'])
            clear=self._function(owner_ref,'function(x,y){const hit=this.ownerDocument.elementFromPoint(x,y);return hit===this}',(x,y))
            if not clear: raise BrowserUseError('跨进程 iframe 被父页面遮挡；拒绝点击别的元素',1)
            sid=parent['session']
        return x,y

    @staticmethod
    def _key_event(info,modifiers,kind,*,commands=None,auto_repeat=False):
        """生成 Input.dispatchKeyEvent 参数；有可打印文本且无 Control/Alt/Meta 时带 text。"""
        key,text=info['key'],info.get('text')
        if modifiers&8 and info.get('shifted'): key=text=info['shifted']
        args={'key':key,'code':info['code'],'windowsVirtualKeyCode':info['keyCode'],'nativeVirtualKeyCode':info['keyCode'],'modifiers':modifiers,'location':info['location']}
        if kind=='down':
            if text is not None and not modifiers&7:
                args.update(type='keyDown',text=text,unmodifiedText=info.get('text'))
            else: args['type']='rawKeyDown'
            if auto_repeat: args['autoRepeat']=True
            if commands: args['commands']=commands
        else: args['type']='keyUp'
        return args

    def _held_modifiers(self):
        bits=0
        for info in self._held_keys.values():
            bits|=_MOD_BITS.get(info['key'],0)
        return bits

    def _send_keys(self,sid,events,*,delay=0,data=None):
        """逐个发送键盘事件；中途失败或弹窗时报告已发送数量，不重发。"""
        for number,args in enumerate(events):
            if number and delay: time.sleep(delay)
            try: self._call(sid,'Input.dispatchKeyEvent',args,timeout=5)
            except BrowserUseError as exc:
                self._drain()
                extra=dict(data or {},sentEvents=number,totalEvents=len(events),failedEvent=args.get('key'))
                if self._dialog: raise _DialogPending(_dialog_summary(self._dialog),extra) from exc
                raise BrowserUseError(str(exc),exc.code,outcome=exc.outcome or 'unknown',data=dict(exc.data,**extra)) from exc
            if args['type']!='keyUp' and (number+1)%20==0:
                self._drain()
                if self._dialog: raise _DialogPending(_dialog_summary(self._dialog),dict(data or {},sentEvents=number+1,totalEvents=len(events)))

    # ---- 动作落点：输入落到哪个元素、动作前后的值 ----

    def _active_ref(self):
        """当前拿着焦点的元素引用（主文档里穿过 shadow DOM 和同进程 iframe）。"""
        frame = self._main_frame()
        fid = next(f for f, v in self._frames_cache.items() if v is frame)
        found = self._call(frame['session'], 'Runtime.evaluate', {'expression': _ACTIVE, 'contextId': frame['context'], 'returnByValue': False})
        oid = found.get('result', {}).get('objectId')
        if not oid:
            return None
        try:
            node = self._call(frame['session'], 'DOM.describeNode', {'objectId': oid})['node']
        finally:
            self._call(frame['session'], 'Runtime.releaseObject', {'objectId': oid})
        owner = fid
        if node.get('frameId') and node['frameId'] in self._frames_cache:
            owner = node['frameId']
        try:
            return self._resolve(node['backendNodeId'], owner)
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
            return None

    def _observe(self, ref):
        """读元素的描述和当前值；元素已失效时返回 None。"""
        if ref is None:
            return None
        try:
            info = self._function(ref, _DESCRIBE, (_VALUE_LIMIT,))
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
            return None
        if not info:
            return None
        # 只给调用方手里那份快照的编号；id/label 定位时内部取的那份快照，调用方拿不到凭证。
        idx = None
        if self._token is not None and self._token == self._public_token:
            idx = next((number for number, item in self._refs.items()
                        if item.get('backend') == ref['backend'] and item.get('frame') == ref['frame']), None)
        if idx is not None:
            info['element']['idx'] = idx
        info['element']['frame'] = ref['frame']
        return info

    @staticmethod
    def _landing(before, after):
        """把动作前后两次读数合成返回里的 target/before/after 字段。"""
        seen = after or before
        if seen is None:
            return {'target': None}
        result = {'target': seen['element'], 'targetText': _brief(seen['element'])}
        if seen.get('kind', 'none') == 'none':
            return result
        if seen.get('secret'):
            result['redacted'] = True
        for name, item in (('before', before), ('after', after)):
            if item is None or 'length' not in item:
                continue
            result[name] = item['value']
            result[name + 'Length'] = item['length']
            if item.get('truncated'):
                result[name + 'Truncated'] = True
        if before is not None and after is not None and 'digest' in before and 'digest' in after:
            result['changed'] = (before['digest'], before['length']) != (after['digest'], after['length'])
        return result

    def _focus_ref(self, ref, meta=None, position=None):
        """把输入焦点放进 ref：可聚焦就 DOM.focus；在富文本里的段落等不可聚焦元素，聚焦整个编辑区并把光标放进它。

        返回实际接收输入的元素引用和处理方式（'focus' 或 'editing-host'）。
        """
        try:
            self._call(ref['session'], 'DOM.focus', {'backendNodeId': ref['backend']})
            self._place(ref, position)
            return ref, 'focus'
        except BrowserUseError as exc:
            if exc.outcome == 'unknown' or 'not focusable' not in str(exc): raise
            failure = exc
        host_object = self._call(ref['session'], 'Runtime.callFunctionOn', {
            'objectId': ref['object'], 'functionDeclaration': _EDIT_HOST, 'returnByValue': False,
            **({'objectGroup': self._group} if self._group else {})})
        host_id = host_object.get('result', {}).get('objectId')
        if host_id:
            backend = self._call(ref['session'], 'DOM.describeNode', {'objectId': host_id})['node']['backendNodeId']
            host = self._resolve(backend, ref['frame'])
            self._call(host['session'], 'DOM.focus', {'backendNodeId': host['backend']})
            self._function(ref, _PLACE_CARET, (position if position in ('start', 'end') else 'start',))
            return host, 'editing-host'
        self._refuse_input(ref, '不能获得输入焦点（它不是输入框，也不在可编辑区域里）', failure)

    def _place(self, ref, position):
        """按 position 摆光标；cursor 表示不动。"""
        if position in (None, 'cursor') or ref is None:
            return
        if not self._function(ref, _PLACE_CARET, (position,)):
            raise BrowserUseError(f'{_brief((self._observe(ref) or {}).get("element"))} 不支持设置光标位置', 1)

    def _caret(self, ref):
        if ref is None:
            return None
        try:
            return self._function(ref, _CARET)
        except BrowserUseError as exc:
            if exc.outcome == 'unknown': raise
            return None

    def _focus_target(self,p,fixed_ref=None):
        """有元素定位时聚焦它（富文本里的段落聚焦整个编辑区）；没有定位时用当前焦点。返回 (会话, 接收输入的元素, 处理方式)。"""
        if fixed_ref is not None and not isinstance(fixed_ref, tuple):
            fixed_ref = (fixed_ref, None)
        return self._input_target(p, fixed_ref)

    def _input_target(self, p, fixed_ref=None, *, require_editable=False):
        """按定位参数准备输入目标、聚焦并按 position 摆光标；没给定位时用当前焦点。返回 (会话, 接收输入的元素引用, 处理方式)。"""
        position = p.get('position')
        if fixed_ref is None and not self._has_target(p):
            self.check()
            ref = self._active_ref()
            self._place(ref, position)
            return self.session_id, ref, 'current-focus'
        ref, meta = fixed_ref if fixed_ref is not None else self._ref(p, purpose='type' if require_editable else None)
        if meta is not None and require_editable and (not meta['editable'] or not meta['enabled']):
            self._refuse_input(ref, '不可用（disabled）' if meta['editable'] else '不是可输入的元素')
        ref, how = self._focus_ref(ref, meta, position)
        return ref['session'], ref, how

    def _refuse_input(self, ref, reason, failure=None):
        """报「这个元素不能输入」，并给出离它最近的可输入元素。"""
        target = self._observe(ref)
        alternative = self._function(ref, _FOCUS_ALTERNATIVE)
        message = f'{_brief(target and target["element"])} {reason}'
        if alternative:
            where = '外层' if alternative['relation'] == 'ancestor' else '里面'
            message += f'；它{where}可输入的是 {_brief(alternative)}，请改为定位到那个元素'
        else:
            message += '；先 snap 找可输入的元素（actions 含 SetValue），或先 click 让页面打开编辑框'
        data = {'target': target and target['element'], 'alternative': alternative}
        if failure is not None:
            data['cdp'] = failure.data.get('cdp')
            raise BrowserUseError(message, 1, data=data) from failure
        raise BrowserUseError(message, 1, data=data)

    def _with_landing(self, ref, how, before, result):
        """动作之后再读一次落点，把落点、前后值并进 result。"""
        after = self._observe(ref)
        result.update(self._landing(before, after))
        result['focus'] = how
        if how == 'current-focus' and after is not None:
            result['note'] = '没给定位，输入发给了当前焦点所在的 ' + _brief(after['element'])
        return result

    def _insert(self, p, fixed_ref=None):
        """一次性插入整段文本（Input.insertText），返回落点和前后值。"""
        text = string(p.get('text'), 'text', empty=True)
        if ('\n' in text or '\r' in text) and not p.get('allow_newline', False):
            raise BrowserUseError('输入换行需要 allow_newline=True，避免意外发送', 6)
        sid, ref, how = self._input_target(p, fixed_ref, require_editable=True)
        before = self._observe(ref)
        self._call(sid, 'Input.insertText', {'text': text})
        return self._with_landing(ref, how, before, {'ok': True, 'via': 'cdp'})

    def _key(self,p,*,fixed_ref=None):
        mods,info=_combo(p.get('keys',p.get('key')))
        sid,ref,how=self._focus_target(p,fixed_ref)
        before=self._observe(ref)
        base=self._held_modifiers(); bits=base; events=[]
        for name in mods:
            if base&_MOD_BITS[name]: continue
            bits|=_MOD_BITS[name]
            events.append(self._key_event(_KEYS[name],bits,'down'))
        commands=['selectAll'] if info['key'] in ('a','A') and bits&6 and not bits&9 else None
        events.append(self._key_event(info,bits,'down',commands=commands))
        events.append(self._key_event(info,bits,'up'))
        for name in reversed(mods):
            if base&_MOD_BITS[name]: continue
            bits&=~_MOD_BITS[name]
            events.append(self._key_event(_KEYS[name],bits,'up'))
        self._send_keys(sid,events)
        result=self._with_landing(ref,how,before,{'ok':True,'key':info['key'],'modifiers':mods,'via':'cdp','trusted':True})
        if how=='editing-host':
            result['caret']=self._caret(ref)
        return result

    def _key_hold(self,action,p):
        info=_key_info(p.get('key'))
        name=info['key']
        self.check()
        if action=='key_down':
            repeat=name in self._held_keys
            self._held_keys[name]=info
            # 先记账再发送：结果未知时 close 仍会补发松开，避免页面以为键一直按着。
            self._send_keys(self.session_id,[self._key_event(info,self._held_modifiers(),'down',auto_repeat=repeat)])
            return {'ok':True,'key':name,'held':sorted(self._held_keys),'autoRepeat':repeat,'via':'cdp','trusted':True}
        was=self._held_keys.pop(name,None) is not None
        bits=self._held_modifiers()
        self._send_keys(self.session_id,[self._key_event(info,bits,'up')])
        return {'ok':True,'key':name,'wasHeld':was,'held':sorted(self._held_keys),'via':'cdp','trusted':True}

    def _type_keys(self,p,*,fixed_ref=None):
        text=p['text']; delay=p.get('delay_ms',0)/1000
        sid,ref,how=self._focus_target(p,fixed_ref)
        before=self._observe(ref)
        events=[];bits=self._held_modifiers()
        for char in text:
            if char=='\n' or char=='\r': info=dict(_KEYS['Enter'])
            elif char=='\t': info=dict(_KEYS['Tab'])
            elif char in _KEYS: info=dict(_KEYS[char])
            else: info={'key':char,'code':'','keyCode':0,'text':char,'location':0,'shifted':None}
            events.append(self._key_event(info,bits,'down'))
            events.append(self._key_event(info,bits,'up'))
        self._send_keys(sid,events,delay=delay/2 if delay else 0,data={'characters':len(text)})
        return self._with_landing(ref,how,before,{'ok':True,'characters':len(text),'events':len(events),'via':'cdp','trusted':True})

    def _headless(self):
        try: agent=self.cdp.call('Browser.getVersion').get('userAgent','')
        except BrowserUseError as exc:
            if exc.outcome=='unknown': raise
            return False
        return 'HeadlessChrome' in agent

    def _edit(self,p,*,fixed_ref=None):
        command=p['command']; letter,name=_EDIT_COMMANDS[command]
        clipboard=None
        if command in _CLIPBOARD_COMMANDS:
            # 只有 headless Chrome 的剪贴板在进程内；有界面的浏览器会读写系统剪贴板，这里不做。
            if not self._headless(): raise BrowserUseError('copy/cut/paste 在有界面浏览器会读写系统剪贴板；只在 headless 独立 Chrome 支持',5)
            clipboard='headless-private'
        sid,ref,how=self._focus_target(p,fixed_ref)
        before=self._observe(ref)
        mod='Meta' if sys.platform=='darwin' else 'Control'
        # 撤销和重做走浏览器自己的编辑历史（与用户按 ⌘Z / ⇧⌘Z 相同），不是改 DOM 值，页面的输入事件照常触发。
        extra=['Shift'] if command=='redo' else []
        bits=self._held_modifiers()|_MOD_BITS[mod]
        events=[self._key_event(_KEYS[mod],bits,'down')]
        for name_ in extra:
            bits|=_MOD_BITS[name_]
            events.append(self._key_event(_KEYS[name_],bits,'down'))
        info=dict(_KEYS[letter])
        events+=[self._key_event(info,bits,'down',commands=[name]),self._key_event(info,bits,'up')]
        for name_ in reversed(extra):
            bits&=~_MOD_BITS[name_]
            events.append(self._key_event(_KEYS[name_],bits,'up'))
        events.append(self._key_event(_KEYS[mod],bits&~_MOD_BITS[mod],'up'))
        self._send_keys(sid,events)
        return self._with_landing(ref,how,before,{'ok':True,'command':command,'editingCommand':name,'clipboard':clipboard,'via':'cdp','trusted':True})


    def _mouse_event(self,kind,x,y,*,button='none',click_count=0,extra=None):
        params={'type':kind,'x':x,'y':y,'button':button,'buttons':sum(_BUTTON_BITS[b] for b in self._held_buttons),'clickCount':click_count,'modifiers':self._held_modifiers()}
        if extra: params.update(extra)
        try: self._call(self.session_id,'Input.dispatchMouseEvent',params,timeout=5)
        except BrowserUseError as exc:
            self._drain()
            if self._dialog: raise _DialogPending(_dialog_summary(self._dialog),{'event':kind}) from exc
            raise

    def _mouse(self,action,p):
        self.check()
        if action=='mouse_move':
            x,y=p['x'],p['y']; steps=p.get('steps',1); sx,sy=self._pointer
            button=next(iter(self._held_buttons),'none')
            for i in range(1,steps+1):
                px,py=sx+(x-sx)*i/steps,sy+(y-sy)*i/steps
                self._mouse_event('mouseMoved',px,py,button=button)
                self._pointer=(px,py)
            return {'ok':True,'x':x,'y':y,'steps':steps,'buttons':sorted(self._held_buttons),'via':'cdp','trusted':True}
        if action=='wheel':
            x,y=p.get('x',self._pointer[0]),p.get('y',self._pointer[1])
            self._mouse_event('mouseWheel',x,y,extra={'deltaX':p.get('dx',0.0),'deltaY':p.get('dy',0.0)})
            self._pointer=(x,y)
            return {'ok':True,'x':x,'y':y,'dx':p.get('dx',0.0),'dy':p.get('dy',0.0),'via':'cdp','trusted':True}
        button=p.get('button','left'); count=p.get('click_count',1)
        x,y=p.get('x',self._pointer[0]),p.get('y',self._pointer[1])
        if action=='mouse_down':
            if button in self._held_buttons: raise BrowserUseError(f'{button} 键已按下；先 mouse_up',1)
            self._held_buttons[button]=True
            self._mouse_event('mousePressed',x,y,button=button,click_count=count)
        else:
            self._held_buttons.pop(button,None)
            self._mouse_event('mouseReleased',x,y,button=button,click_count=count)
        self._pointer=(x,y)
        return {'ok':True,'x':x,'y':y,'button':button,'buttons':sorted(self._held_buttons),'via':'cdp','trusted':True}

    def _shot(self,p):
        self.check(); shrink=positive(p.get('shrink',1400),'shrink',integer=True,zero=True)
        fmt,quality=_image_options(p)
        metrics=self.call('Page.getLayoutMetrics'); viewport=metrics.get('cssVisualViewport',metrics.get('visualViewport',{})); content=metrics.get('cssContentSize',metrics.get('contentSize',{}))
        full=bool(p.get('full_page',p.get('fullPage',False)))
        rect=content if full else {'x':viewport.get('pageX',0),'y':viewport.get('pageY',0),'width':viewport.get('clientWidth',0),'height':viewport.get('clientHeight',0)}
        w,h=rect['width'],rect['height']
        if w<=0 or h<=0: raise BrowserUseError('页面没有可截图区域',1)
        dpr=self._eval('devicePixelRatio') or 1
        scale=min(1,shrink/(max(w,h)*dpr)) if shrink else 1
        args={'format':fmt,'fromSurface':True,'captureBeyondViewport':True,'clip':dict(rect,scale=scale)}
        if quality is not None: args['quality']=quality
        raw=base64.b64decode(self.call('Page.captureScreenshot',args)['data'],validate=True)
        size=_image_size(raw)
        path=_save_image(raw,p.get('out'),p.get('overwrite',False),fmt,'browser-use-shot')
        width,height=size or (round(w*scale*dpr),round(h*scale*dpr))
        return {'ok':True,'path':str(path),'screenshot':{'width':width,'height':height,'format':fmt,'quality':quality,'fullPage':full,'bytes':len(raw),'scaled':scale<1,'devicePixelRatio':dpr,'sizeSource':'file' if size else 'estimate'}}

    def _main_frame(self):
        frame=next((f for f in self._frames_cache.values() if f['session']==self.session_id and not f.get('parent')),None)
        if frame is None: raise BrowserUseError('主页面文档不可用',4)
        return frame

    def _enable_lifecycle(self):
        if self.session_id in self._lifecycle_sessions: return
        self._lifecycle_sessions.add(self.session_id)
        self.call('Page.setLifecycleEventsEnabled',{'enabled':True})

    def _wait(self,p):
        timeout=positive(p.get('timeout',10),'timeout')
        deadline=time.monotonic()+timeout
        kind=next(k for k in ('label','text','expression','selector','url','load','any_text') if p.get(k) is not None)
        if kind=='load' and p['load']=='networkidle': self._enable_lifecycle()
        while True:
            self.check()
            remaining=max(.01,deadline-time.monotonic())
            extra={}
            if kind=='expression':
                found=bool(self._result(self.call('Runtime.evaluate',{'expression':p['expression'],'returnByValue':True,'awaitPromise':True},timeout=remaining)))
            elif kind in ('label','text'):
                needle=json.dumps(p[kind],ensure_ascii=False)
                found=any(self._eval(f'(document.body?.innerText||document.documentElement?.textContent||"").includes({needle})',f,timeout=remaining) for f in self._frames_cache.values())
            elif kind=='any_text':
                texts=self._page_texts(remaining)
                hit=next(((i,t,fid) for i,t in enumerate(p['any_text']) for fid,body in texts if t in body),None)
                found=hit is not None
                if found: extra={'matched':hit[1],'index':hit[0],'frame':hit[2]}
            elif kind=='selector':
                state=p.get('state','visible'); probe=self._service().probe(p['selector'])
                if state in ('visible','hidden') and probe['visible'] is None:
                    raise BrowserUseError(f'selector 匹配到 {probe["count"]} 个元素；可见性等待需要唯一或 nth',3,data={'count':probe['count']})
                found={'attached':probe['present'],'detached':not probe['present'],'visible':probe['visible'] is True,'hidden':probe['visible'] is False}[state]
                extra={'state':state,'count':probe['count']}
            elif kind=='url':
                frame=self.call('Page.getFrameTree',timeout=remaining)['frameTree']['frame']
                url=frame.get('url','')+frame.get('urlFragment','')
                found=fnmatch.fnmatchcase(url,p['url'])
                extra={'url':url}
            else:
                found,extra=self._load_state(p['load'],remaining)
            if found!=bool(p.get('gone',False)): return {'ok':True,'found':found,'condition':kind,**extra}
            remaining=deadline-time.monotonic()
            if remaining<=0: raise BrowserUseError('等待网页条件超时',4,outcome='not_sent',data=dict(extra,condition=kind))
            time.sleep(min(.05,remaining))

    def _page_texts(self,timeout):
        expression='(document.body?.innerText||document.documentElement?.textContent||"")'
        return [(fid,self._eval(expression,f,timeout=timeout)) for fid,f in self._frames_cache.items()]

    def _load_state(self,load,timeout):
        frame=self.call('Page.getFrameTree',timeout=timeout)['frameTree']['frame']
        loader=frame.get('loaderId')
        if load=='networkidle':
            self._drain()
            record=self._lifecycle.get(frame['id'])
            events=record['events'] if record and record['loaderId']==loader else set()
            return 'networkIdle' in events,{'loaderId':loader,'lifecycle':sorted(events)}
        state=self._eval('document.readyState',self._main_frame(),timeout=timeout)
        found=state=='complete' if load=='load' else state in ('interactive','complete')
        return found,{'loaderId':loader,'readyState':state}

    def _before_unload(self,policy,data):
        """处理离页确认：report 不替用户选择并停止；accept/dismiss 按显式参数处理。"""
        dialog=self._dialog
        if policy=='report':
            raise BrowserUseError('页面弹出离页确认；未替用户选择，导航暂停',1,outcome='dialog_open',data=dict(data,dialog=_dialog_summary(dialog),hint='用 dialog 动作处理，或重新导航时显式传 before_unload=accept/dismiss'))
        self._call(dialog['sessionId'],'Page.handleJavaScriptDialog',{'accept':policy=='accept'})
        self._dialog=None
        return 'accepted' if policy=='accept' else 'dismissed'

    def _navigate_command(self,method,params,timeout,policy):
        """导航命令在后台线程等待：离页确认会阻塞 Page.navigate 的回执。"""
        box={}; done=threading.Event()
        def run():
            try: box['result']=self.call(method,params,timeout=timeout+5)
            except BaseException as exc: box['error']=exc
            finally: done.set()
        threading.Thread(target=run,name='browser-use-navigate',daemon=True).start()
        deadline=time.monotonic()+timeout+5; handled=None
        while not done.wait(.02):
            self._drain()
            if self._dialog and self._dialog.get('type')=='beforeunload' and handled is None:
                handled=self._before_unload(policy,{'command':method})
            if time.monotonic()>deadline: raise BrowserUseError(f'{method} 等待超时；执行结果未知，未自动重试',4,outcome='unknown')
        if 'error' in box: raise box['error']
        return box['result'],handled

    def _navigation_ready(self,expected_loader,old_loader,expected_url,timeout,*,same_document=False,policy='report'):
        start=time.monotonic();deadline=start+timeout
        last_reason='document_loading'; handled_late=None
        while time.monotonic()<deadline:
            self._target_check()
            if self._dialog:
                if self._dialog.get('type')=='beforeunload':
                    handled=self._before_unload(policy,{'command':'navigation'})
                    if handled=='dismissed': return {'settled':round(time.monotonic()-start,4),'loading':False,'stable':True,'navigated':False,'beforeUnload':handled}
                    handled_late=handled
                    continue
                return {'settled':round(time.monotonic()-start,4),'loading':True,'stable':False,'settleReason':'dialog'}
            try:
                # 只读探测用短超时：离页确认可能在 Page.reload 回执之后才弹出，并卡住页面侧命令。
                remaining=max(.01,min(.5,deadline-time.monotonic()))
                frame=self.call('Page.getFrameTree',timeout=remaining)['frameTree']['frame']
                loader=frame.get('loaderId')
                belongs=loader==expected_loader if expected_loader else (frame.get('url')==expected_url if same_document else loader!=old_loader)
                # 离页确认打开时页面脚本暂停；只在新文档已提交后短时读取，避免卡满整个超时。
                state=self._result(self.call('Runtime.evaluate',{'expression':'document.readyState','returnByValue':True},timeout=max(.01,min(1,deadline-time.monotonic())))) if belongs else None
                if belongs and state in ('interactive','complete'):
                    self._drain()
                    return {'settled':round(time.monotonic()-start,4),'loading':False,'stable':True,'readyState':state,**({'beforeUnload':handled_late} if handled_late else {})}
            except BrowserUseError as exc:
                if exc.code not in (1,4): raise
                last_reason=str(exc)
            remaining=deadline-time.monotonic()
            if remaining>0: time.sleep(min(.02,remaining))
        return {'settled':round(time.monotonic()-start,4),'loading':True,'stable':False,'settleReason':last_reason,**({'beforeUnload':handled_late} if handled_late else {})}

    def _navigate(self,action,p):
        timeout=seconds(p.get('timeout',5),'timeout',120); policy=p.get('before_unload','report')
        self._drain()
        if self._dialog: raise BrowserUseError('页面有待处理对话框；先用 dialog 动作处理，未发送导航',1,outcome='not_sent',data={'dialog':_dialog_summary(self._dialog)})
        old_frame=self.call('Page.getFrameTree')['frameTree']['frame']
        expected_url=p.get('url') if action=='goto' else None
        if action=='goto': method,params='Page.navigate',{'url':p['url']}
        elif action=='reload': method,params='Page.reload',{'ignoreCache':bool(p.get('ignore_cache',False))}
        else:
            history=self.call('Page.getNavigationHistory'); index=history['currentIndex']+(-1 if action=='back' else 1)
            if not 0<=index<len(history['entries']): raise BrowserUseError('没有可用的历史页面',3)
            expected_url=history['entries'][index]['url']
            method,params='Page.navigateToHistoryEntry',{'entryId':history['entries'][index]['id']}
        result,handled=self._navigate_command(method,params,timeout,policy)
        extra={'beforeUnload':handled} if handled else {}
        if handled=='dismissed':
            return {'ok':True,'navigated':False,'beforeUnload':handled,'loading':False,'stable':True,'settled':0,**({'errorText':result['errorText']} if result.get('errorText') else {})}
        if result.get('errorText'): raise BrowserUseError(result['errorText'],1,data=extra)
        self._invalidate()
        if result.get('isDownload'): return {'ok':True,**result,**extra,'loading':False,'stable':False,'settled':0,'settleReason':'download'}
        readiness=self._navigation_ready(result.get('loaderId'),old_frame.get('loaderId'),expected_url,timeout,same_document=action=='goto' and not result.get('loaderId'),policy=policy)
        return {'ok':True,**result,**extra,**readiness}

    def _page_info(self):
        self.check(); self._drain()
        frame=self.call('Page.getFrameTree')['frameTree']['frame']
        info={'ok':True,'url':frame.get('url','')+frame.get('urlFragment',''),'frameId':frame['id'],'loaderId':frame.get('loaderId'),'targetId':self.target_id,'dialogPending':_dialog_summary(self._dialog)}
        if self._dialog:
            info.update(title=None,readyState=None,viewport=None,warning='页面对话框未处理，脚本暂停，未读取标题和视口')
            return info
        data=self._eval("({url:location.href,title:document.title,readyState:document.readyState,viewport:{innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY,visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop}:null}})",self._main_frame())
        info.update(data)
        return info

    def _page_text(self,p):
        self.check()
        maximum=p.get('max_chars',20000)
        frame=self._main_frame() if p.get('frame') is None else self._frames_cache.get(p['frame'])
        if frame is None: raise BrowserUseError('指定 frame 已不存在',4)
        data=self._eval("""(m=>{const t=document.body?.innerText??document.documentElement?.innerText??'';let n=Math.min(m,t.length);const c=t.charCodeAt(n-1);if(n<t.length&&c>=0xD800&&c<=0xDBFF)n--;return {text:t.slice(0,n),length:t.length}})(%d)"""%maximum,frame)
        return {'ok':True,'text':data['text'],'length':data['length'],'returned':len(data['text']),'truncated':data['length']>len(data['text']),'lengthUnit':'utf16','frame':next(fid for fid,f in self._frames_cache.items() if f is frame)}

    def _frames_info(self):
        self.check()
        frames=[]
        for fid,f in self._frames_cache.items():
            oopif=f['session']!=self.session_id
            frames.append({'frameId':fid,'parentId':f.get('parent'),'url':f.get('url',''),'name':f.get('name',''),'securityOrigin':f.get('securityOrigin',''),'loaderId':f.get('loader'),'sessionId':f['session'],'oopif':oopif,'targetId':self._sessions.get(f['session']) if oopif else self.target_id})
        return {'ok':True,'frames':frames,'count':len(frames)}

    def _upload_via_chooser(self,p):
        paths=_files(p['files'])
        timeout=p.get('timeout',5)
        ref,meta=self._ref(p,purpose='click')
        if not meta['enabled']: raise BrowserUseError('元素不可用',1)
        sessions=[self.session_id]+([ref['session']] if ref['session']!=self.session_id else [])
        self._drain(); self._choosers.clear()
        errors=[]
        try:
            for sid in sessions:
                self._chooser_sessions.add(sid)
                self._call(sid,'Page.setInterceptFileChooserDialog',{'enabled':True})
            clicked=self._click({},fixed_ref=(ref,meta))
            if clicked.get('dialogPending'): raise BrowserUseError('点击后弹出页面对话框；未填入文件',1,outcome='dialog_open',data={'dialog':_dialog_summary(self._dialog)})
            deadline=time.monotonic()+timeout
            while True:
                self._drain()
                if self._choosers: break
                if time.monotonic()>=deadline: raise BrowserUseError('可信点击后未打开文件选择器；未重放点击',1,outcome='unknown',data={'timeout':timeout})
                time.sleep(.02)
            chooser=self._choosers.pop(0)
            if chooser.get('mode')=='selectSingle' and len(paths)>1: raise BrowserUseError('文件选择器只接受单个文件；未填入',2,data={'mode':chooser['mode']})
            if 'backendNodeId' not in chooser: raise BrowserUseError('文件选择器没有关联 input 节点',5)
            self._call(chooser['sessionId'],'DOM.setFileInputFiles',{'backendNodeId':chooser['backendNodeId'],'files':paths})
            return {'ok':True,'files':[Path(f).name for f in paths],'count':len(paths),'mode':chooser.get('mode'),'frameId':chooser.get('frameId'),'via':'cdp','trusted':True}
        finally:
            for sid in sessions:
                try:
                    self._call(sid,'Page.setInterceptFileChooserDialog',{'enabled':False},timeout=2)
                    self._chooser_sessions.discard(sid)
                except BrowserUseError as exc: errors.append({'sessionId':sid,'error':str(exc)})
            if errors: self._cleanup_errors.extend(errors)

    def _fill_form(self,p):
        service=self._service(); results=[]
        for index,item in enumerate(p['items']):
            try:
                self.check()
                ref,meta=service.locate(item['selector'])
                if not meta['enabled']: raise BrowserUseError('元素不可用',1)
                kind=item.get('kind') or service.infer_kind(ref,item)
                before=self._observe(ref)
                result=service.form_item(ref,meta,kind,item)
                landing=self._landing(before,self._observe(ref))
            except BrowserUseError as exc:
                raise BrowserUseError(f'fill_form 第 {index} 项失败：{exc}',exc.code,outcome=exc.outcome,data={'results':results,'stoppedAt':index,'error':str(exc),'errorData':exc.data}) from exc
            detail={k:v for k,v in result.items() if k not in ('ok','kind')}
            if 'kind' in result: detail['element']=result['kind']
            results.append({'index':index,'kind':kind,**landing,**detail})
        return {'ok':True,'results':results,'completed':len(results),'stoppedAt':None}

    def dispatch(self,action,params=None):
        with self._lock:
            result=self._dispatch(action,params)
            if action in _INPUT_ACTIONS:
                start=time.monotonic()
                self._drain()
                if self._dialog:
                    result.update(stable=False,settleReason='dialog')
                else:
                    try:
                        stable=self._result(self.call('Runtime.evaluate',{'expression':"new Promise(resolve=>{let timer;const done=()=>{observer.disconnect();resolve(true)};const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(done,80)});observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});timer=setTimeout(done,80);setTimeout(()=>{observer.disconnect();resolve(false)},350)})",'awaitPromise':True,'returnByValue':True},timeout=.5))
                        result['stable']=bool(stable)
                    except BrowserUseError as exc:
                        result.update(stable=False,settleReason=str(exc))
                result['settled']=round(time.monotonic()-start,4)
            return result

    def _dispatch(self,action,params=None):
        p={} if params is None else params
        if not isinstance(p,dict): raise BrowserUseError('params 需要对象',2)
        if action not in _PARAMS: raise BrowserUseError(f'不支持网页动作 {action}',2)
        unknown=set(p)-_PARAMS[action]
        if unknown: raise BrowserUseError('不支持的网页参数：'+', '.join(sorted(map(str,unknown))),2)
        _validate(action,p)
        with self._lock:
            if action=='snap':
                deadline=time.monotonic()+.5
                while True:
                    try:
                        result = self._snap(p)
                        self._public_token = self._token
                        return result
                    except BrowserUseError as exc:
                        if exc.code!=4 or exc.outcome=='unknown' or time.monotonic()>=deadline: raise
                        time.sleep(.02)
            if action=='click': return self._click(p)
            if action=='key': return self._key(p)
            if action in ('key_down','key_up'): return self._key_hold(action,p)
            if action=='type_keys': return self._type_keys(p)
            if action=='edit': return self._edit(p)
            if action in ('mouse_move','mouse_down','mouse_up','wheel'): return self._mouse(action,p)
            if action=='wait': return self._wait(p)
            if action=='shot': return self._shot(p)
            if action=='page_info': return self._page_info()
            if action=='page_text': return self._page_text(p)
            if action=='frames': return self._frames_info()
            if action=='fill_form': return self._fill_form(p)
            if action=='upload_via_chooser': return self._upload_via_chooser(p)
            if action in ('goto','reload','back','forward'): return self._navigate(action,p)
            if action=='eval': return {'ok':True,'value':self.evaluate(p.get('expression',p.get('script')),p.get('await_promise',True))}
            if action=='popups':
                self._target_check()
                targets=self.cdp.call('Target.getTargets').get('targetInfos',[])
                for info in targets:
                    if info.get('openerId')==self.target_id: self._popups[info['targetId']]=info
                return {'ok':True,'popups':list(self._popups.values())}
            if action=='download':
                self._target_check()
                operation=p.get('action','list')
                if operation=='directory':
                    if not self.browser_context_id: raise BrowserUseError('下载目录只能设置在私有浏览器 context；共享浏览器不支持页面级目录',5)
                    path=Path(string(p.get('path'),'path',empty=True)).expanduser().absolute()
                    path.mkdir(parents=True,exist_ok=True)
                    self.cdp.call('Browser.setDownloadBehavior',{'behavior':'allow','downloadPath':str(path),'browserContextId':self.browser_context_id,'eventsEnabled':True})
                    self._download_events_enabled=True
                    return {'ok':True,'path':str(path)}
                if operation=='list': return {'ok':True,'downloads':list(self._downloads.values()),'eventsEnabled':bool(getattr(self,'_download_events_enabled',False))}
                if operation!='wait': raise BrowserUseError('download action 只能是 directory/list/wait',2)
                guid=string(p.get('guid'),'guid',empty=True); deadline=time.monotonic()+positive(p.get('timeout',20),'timeout')
                while True:
                    self._target_check(); item=self._downloads.get(guid)
                    if item and item.get('state') in ('completed','canceled'):
                        if item['state']=='canceled': raise BrowserUseError('下载已取消',1,data={'download':item})
                        return {'ok':True,'download':item}
                    remaining=deadline-time.monotonic()
                    if remaining<=0: raise BrowserUseError('等待下载终态超时；未重试下载',4,outcome='unknown',data={'download':item or {'guid':guid}})
                    time.sleep(min(.05,remaining))
            if action=='dialog':
                self._target_check()
                boolean(p.get('accept'),'dialog accept')
                if not self._dialog: raise BrowserUseError('页面没有待处理对话框',3)
                args={'accept':p['accept']}
                if 'prompt_text' in p or 'text' in p: args['promptText']=string(p.get('prompt_text',p.get('text')),'prompt_text',empty=True)
                self._call(self._dialog['sessionId'],'Page.handleJavaScriptDialog',args); self._dialog=None
                return {'ok':True}
            self.check()
            if action=='type':
                return self._insert(p)
            if action=='scroll' and not any(p.get(k) is not None for k in ('idx','id','label')):
                direction=p.get('direction','down')
                if direction not in ('up','down','left','right'): raise BrowserUseError('direction 只能是 up/down/left/right',2)
                pages=positive(p.get('pages',1),'pages')
                frame=next((f for f in self._frames_cache.values() if f['session']==self.session_id and not f.get('parent')),None)
                if frame is None: raise BrowserUseError('主页面文档不可用，不能改为滚动其他 frame',4)
                offsets=self._eval("""(()=>{const e=document.scrollingElement;if(!e)throw Error('页面没有scrollingElement');const d=%s,p=%s,h=d==='left'||d==='right';e.scrollBy({left:h?(d==='left'?-1:1)*e.clientWidth*p:0,top:h?0:(d==='up'?-1:1)*e.clientHeight*p,behavior:'instant'});return {x:e.scrollLeft,y:e.scrollTop}})()"""%(json.dumps(direction),json.dumps(pages)),frame)
                return {'ok':True,'scope':'page','scroll':offsets}
            if action in ('set','act','scroll','read','selecttext','upload'):
                ref,meta=self._ref(p,purpose=action)
                if action=='read':
                    source='function(){if(/^(INPUT|TEXTAREA)$/.test(this.tagName))return this.value.slice(this.selectionStart||0,this.selectionEnd||0);return this.ownerDocument.getSelection()?.toString()||""}' if p.get('selected') else 'function(){return String(this.value??this.innerText??this.textContent??"")}'
                    return {'ok':True,'text':self._function(ref,source)}
                if action=='set':
                    value=string(p.get('value'),'value',empty=True)
                    if not meta['editable'] or not meta['enabled']: raise BrowserUseError('元素不支持赋值',1)
                    before=self._observe(ref)
                    self._function(ref,"""function(v){if(this.isContentEditable)this.textContent=v;else{let p=this,d;while(p&&!d){d=Object.getOwnPropertyDescriptor(p,'value');p=Object.getPrototypeOf(p)}if(!d?.set)throw Error('value 不可写');d.set.call(this,v)}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}""",(value,))
                    return {'ok':True,**self._landing(before,self._observe(ref))}
                elif action=='act':
                    name=string(p.get('action'),'action',empty=True).removeprefix('AX')
                    if name=='Press': return self._click(p)
                    if name!='ScrollToVisible': raise BrowserUseError(f'网页未实现动作 {name}',2)
                    self._call(ref['session'],'DOM.scrollIntoViewIfNeeded',{'backendNodeId':ref['backend']})
                elif action=='scroll':
                    direction=p.get('direction','down')
                    if direction not in ('up','down','left','right'): raise BrowserUseError('direction 只能是 up/down/left/right',2)
                    pages=positive(p.get('pages',1),'pages')
                    self._function(ref,"""function(d,p){let e=this;while(e&&!(e.scrollHeight>e.clientHeight||e.scrollWidth>e.clientWidth))e=e.parentElement;e=e||this.ownerDocument.scrollingElement;const h=d==='left'||d==='right';e.scrollBy({left:h?(d==='left'?-1:1)*e.clientWidth*p:0,top:h?0:(d==='up'?-1:1)*e.clientHeight*p,behavior:'instant'});}""",(direction,pages))
                elif action=='upload':
                    paths=_files(p.get('files'))
                    if meta['tag']!='INPUT' or not self._function(ref,'function(){return this.type==="file"}'): raise BrowserUseError('upload 需要 file input 元素',2)
                    self._call(ref['session'],'DOM.setFileInputFiles',{'backendNodeId':ref['backend'],'files':paths})
                elif action=='selecttext':
                    selected=self._function(ref,"""function(t){if(/^(INPUT|TEXTAREA)$/.test(this.tagName)){const i=this.value.indexOf(t);if(i<0)return false;this.focus();this.setSelectionRange(i,i+t.length);return true}const w=this.ownerDocument.createTreeWalker(this,NodeFilter.SHOW_TEXT);let n,s='',nodes=[];while(n=w.nextNode()){nodes.push([n,s.length]);s+=n.textContent}const i=s.indexOf(t);if(i<0||!t.length)return false;const r=this.ownerDocument.createRange();let start=false;for(const[n,o]of nodes){if(!start&&i>=o&&i<o+n.length){r.setStart(n,i-o);start=true}if(i+t.length>o&&i+t.length<=o+n.length){r.setEnd(n,i+t.length-o);break}}const sel=this.ownerDocument.getSelection();sel.removeAllRanges();sel.addRange(r);return true}""",(string(p.get('text'),'text',empty=True),))
                    if not selected: raise BrowserUseError('元素中找不到指定文本',3)
                return {'ok':True}
            if action=='init_add':
                source=string(p.get('source',p.get('script')),'source',empty=True); identifier=uuid.uuid4().hex; item={'source':source,'sessions':{}}
                for sid in self._sessions: item['sessions'][sid]=self._call(sid,'Page.addScriptToEvaluateOnNewDocument',{'source':source})['identifier']
                self._scripts[identifier]=item
                return {'ok':True,'identifier':identifier}
            if action=='init_remove':
                identifier=string(p.get('identifier',p.get('id')),'identifier',empty=True); item=self._scripts.get(identifier)
                if not item: raise BrowserUseError('初始化脚本不存在或不属于此绑定',3)
                for sid,script in item['sessions'].items():
                    if sid in self._sessions: self._call(sid,'Page.removeScriptToEvaluateOnNewDocument',{'identifier':script})
                del self._scripts[identifier]; return {'ok':True}
            if action=='viewport':
                if p.get('reset'): self.call('Emulation.clearDeviceMetricsOverride'); return {'ok':True}
                width=positive(p.get('width'),'width',integer=True); height=positive(p.get('height'),'height',integer=True); scale=positive(p.get('device_scale_factor',1),'device_scale_factor')
                self.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':scale,'mobile':bool(p.get('mobile',False))})
                return {'ok':True,'width':width,'height':height}
            if action=='drag':
                if p.get('coord'): raise BrowserUseError('browser-use 不支持移动系统鼠标',2)
                start,end=self._point(p.get('start')),self._point(p.get('end'))
                self.call('Input.dispatchMouseEvent',{'type':'mousePressed','x':start[0],'y':start[1],'button':'left','buttons':1,'clickCount':1})
                for i in range(1,11): self.call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':start[0]+(end[0]-start[0])*i/10,'y':start[1]+(end[1]-start[1])*i/10,'button':'left','buttons':1})
                self.call('Input.dispatchMouseEvent',{'type':'mouseReleased','x':end[0],'y':end[1],'button':'left','buttons':0,'clickCount':1})
                return {'ok':True}
            raise BrowserUseError(f'不支持网页动作 {action}',2)


    def close(self):
        with self._lock:
            if self._closed: return
            self._closed=True; self._invalidate()
            for unsubscribe in self._unsubscribers: unsubscribe()
            self._unsubscribers.clear()
            sessions=self.session_ids
            network=self.network
            locator=self._locator; self._locator=None
        errors=list(self._cleanup_errors)
        if locator is not None:
            locator.close(); errors.extend(locator.close_errors)
        if self.session_id in sessions:
            # 本绑定按下未松开的键和鼠标键在断开前松开，避免页面停在按住状态。
            for name,info in list(self._held_keys.items()):
                try: self._call(self.session_id,'Input.dispatchKeyEvent',self._key_event(info,0,'up'),timeout=2)
                except BrowserUseError as exc:
                    if not gone(exc): errors.append({'domain':'input','key':name,'error':str(exc)})
            for button in list(self._held_buttons):
                try: self._call(self.session_id,'Input.dispatchMouseEvent',{'type':'mouseReleased','x':self._pointer[0],'y':self._pointer[1],'button':button,'buttons':0,'clickCount':1},timeout=2)
                except BrowserUseError as exc:
                    if not gone(exc): errors.append({'domain':'input','button':button,'error':str(exc)})
            self._held_keys.clear(); self._held_buttons.clear()
        for sid in sessions:
            try:
                self._call(sid,'Emulation.setFocusEmulationEnabled',{'enabled':False},timeout=2)
                if self._group: self._call(sid,'Runtime.releaseObjectGroup',{'objectGroup':self._group},timeout=2)
                for item in self._scripts.values():
                    if sid in item['sessions']: self._call(sid,'Page.removeScriptToEvaluateOnNewDocument',{'identifier':item['sessions'][sid]},timeout=2)
                if sid in self._lifecycle_sessions: self._call(sid,'Page.setLifecycleEventsEnabled',{'enabled':False},timeout=2)
                if sid in self._chooser_sessions: self._call(sid,'Page.setInterceptFileChooserDialog',{'enabled':False},timeout=2)
            except BrowserUseError as exc:
                if not gone(exc): errors.append({'sessionId':sid,'error':str(exc)})
        if network is not None: network.close()
        detach_order=[sid for sid in reversed(list(self.sessions)) if sid!=self.session_id]+[self.session_id]
        for sid in detach_order:
            try:
                self._call(sid,'Target.setAutoAttach',{'autoAttach':False,'waitForDebuggerOnStart':False,'flatten':True},timeout=2)
            except BrowserUseError as exc:
                if not gone(exc): errors.append({'sessionId':sid,'error':str(exc)})
        self.close_errors=errors
