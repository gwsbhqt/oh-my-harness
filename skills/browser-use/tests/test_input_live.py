"""BROWSER_USE_INPUT_LIVE=1：独立临时 Chrome + 本地 HTTP 夹具，验收页面层定位、表单、键鼠、等待、导航与上传。"""
import contextlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from browser_use.cdp import CDP
from browser_use.driver import PageDriver
from browser_use.elements import ElementService
from browser_use.errors import BrowserUseError

PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>输入夹具</title><style>
body{margin:12px;font:14px sans-serif}#drag{width:90px;height:40px;background:#c33;color:#fff}#drop{width:160px;height:70px;background:#36c;color:#fff;margin:8px 0}
#pad{width:200px;height:120px;background:#eee;overflow:auto}#pad>div{height:600px}#plain{width:90px;height:40px;background:#9c9}
</style></head><body>
<div id="form-area">
<p id="greet">你好 世界</p>
<button id="save1">保存</button><button id="save2">保存</button><button id="save3">保存</button>
<span id="hello">Hello World</span>
<input id="name" placeholder="请输入姓名">
<img id="logo" alt="公司标志" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<button id="close" title="关闭对话框">×</button>
<textarea id="notes" placeholder="备注">旧备注</textarea>
<div id="rich" contenteditable="true">旧<b>富</b>文本</div>
<input id="limited" maxlength="3" placeholder="限长">
<select id="city"><option value="hz">杭州</option><option value="sh">上海</option><option value="bj" disabled>北京</option></select>
<select id="tags" multiple><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option></select>
<label><input id="agree" type="checkbox" checked>同意</label>
<div id="sw" role="switch" aria-checked="false" tabindex="0" style="width:60px;height:24px;background:#ccc">开关</div>
<div id="dead" role="checkbox" aria-checked="false" tabindex="0" style="width:60px;height:24px;background:#fcc">坏框</div>
<div id="r1" role="radio" aria-checked="false" tabindex="0" style="width:60px;height:24px;background:#cfc">单选</div>
<a id="link" href="/second?from=link">第二页链接</a>
</div>
<input id="keys" placeholder="键盘">
<div id="drag" draggable="true">拖我</div><div id="drop">放这里</div><div id="plain">普通块</div>
<div id="pad"><div>滚动区</div></div>
<button id="pick">选择文件</button><input id="file" type="file" multiple style="display:none">
<button id="pick1">选一个</button><input id="file1" type="file" style="display:none">
<button id="late-btn">延迟出现</button>
<button id="nav">改网址</button>
<iframe id="same" srcdoc="<button id='inner'>框内按钮</button>" style="width:200px;height:60px"></iframe>
<iframe id="cross" style="width:200px;height:60px"></iframe>
<script>
window.log=[];window.dropped=[];window.files=[];window.mouse=[];
const sw=document.getElementById('sw');sw.addEventListener('click',e=>{if(e.isTrusted)sw.setAttribute('aria-checked',sw.getAttribute('aria-checked')==='true'?'false':'true')});
const r1=document.getElementById('r1');r1.addEventListener('click',()=>r1.setAttribute('aria-checked','true'));
const keys=document.getElementById('keys');
for(const t of ['keydown','keypress','keyup'])keys.addEventListener(t,e=>log.push({t,key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,trusted:e.isTrusted}));
document.addEventListener('keydown',e=>{if(e.target===document.body)log.push({t:'doc',key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,trusted:e.isTrusted})});
document.getElementById('drag').addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','拖动数据'));
const drop=document.getElementById('drop');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();dropped.push({data:e.dataTransfer.getData('text/plain'),trusted:e.isTrusted})});
const pad=document.getElementById('pad');
for(const t of ['mousedown','mouseup','mousemove','wheel','contextmenu'])pad.addEventListener(t,e=>mouse.push({t,button:e.button,buttons:e.buttons,trusted:e.isTrusted,x:e.clientX,y:e.clientY,dy:e.deltaY||0}),{passive:t!=='contextmenu'});
pad.addEventListener('contextmenu',e=>e.preventDefault());
document.getElementById('pick').onclick=()=>document.getElementById('file').click();
document.getElementById('pick1').onclick=()=>document.getElementById('file1').click();
document.getElementById('file').onchange=e=>files.push(...Array.from(e.target.files).map(f=>f.name));
document.getElementById('late-btn').onclick=()=>setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='迟到的按钮';document.body.append(b);document.getElementById('greet').style.display='none';const s=document.createElement('p');s.textContent='状态：完成';document.body.append(s)},300);
document.getElementById('nav').onclick=()=>setTimeout(()=>history.pushState({},'','/done?step=2'),300);
window.addEventListener('beforeunload',e=>{if(window.guard){e.preventDefault();e.returnValue=''}});
document.getElementById('cross').src='http://localhost:'+location.port+'/frame';
</script></body></html>"""

FRAME = """<!doctype html><meta charset="utf-8"><body><button id="cross-btn">跨域按钮</button><input id="cross-input" placeholder="跨域输入"></body>"""
IDLE = """<!doctype html><meta charset="utf-8"><title>idle</title><body>idle<script>fetch('/slow').then(r=>r.text()).then(t=>document.body.dataset.slow=t)</script></body>"""


class Fixture:
    def __init__(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                path = urlsplit(self.path).path
                kind = "text/html; charset=utf-8"
                if path == "/frame":
                    body = FRAME
                elif path == "/idle":
                    body = IDLE
                elif path == "/slow":
                    time.sleep(0.8)
                    body, kind = "slow-done", "text/plain"
                elif path in ("/second", "/done"):
                    body = "<!doctype html><meta charset=utf-8><title>第二页</title><body>第二页内容</body>"
                else:
                    body = PAGE
                data = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

        class Server(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                # 测试换页时浏览器会中断仍在等待的 /slow 请求；只忽略这种断开。
                if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
                    super().handle_error(request, client_address)

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def until(observe, description, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        value = observe()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError("等待超时：" + description)
        time.sleep(0.03)


@unittest.skipUnless(os.environ.get("BROWSER_USE_INPUT_LIVE") == "1", "需显式 BROWSER_USE_INPUT_LIVE=1 启动独立 Chrome")
class InputLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="browser-use-input-live-")
        cls.addClassCleanup(cls.cleanup_temp)
        cls.output = tempfile.TemporaryFile()
        cls.addClassCleanup(cls.output.close)
        cls.process = subprocess.Popen([
            os.environ.get("BROWSER_USE_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            "--disable-component-update", "--disable-sync", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--user-data-dir=" + cls.temp.name, "about:blank",
        ], stdout=cls.output, stderr=cls.output, start_new_session=True)
        cls.addClassCleanup(cls.stop_browser)
        port_file = Path(cls.temp.name) / "DevToolsActivePort"

        def endpoint():
            if cls.process.poll() is not None:
                cls.output.seek(0)
                raise AssertionError("Chrome 提前退出：" + cls.output.read().decode(errors="replace"))
            if port_file.is_file():
                lines = port_file.read_text().splitlines()
                if len(lines) >= 2:
                    return "http://127.0.0.1:" + lines[0]
        cls.endpoint = until(endpoint, "DevToolsActivePort", 15)
        with urllib.request.urlopen(cls.endpoint + "/json/version", timeout=3) as response:
            version = json.load(response)
        cls.cdp = CDP(version["webSocketDebuggerUrl"])
        cls.addClassCleanup(cls.cdp.close)
        print("INPUT_CHROME " + version["Browser"])
        cls.http = Fixture()
        cls.addClassCleanup(cls.http.close)

    @classmethod
    def cleanup_temp(cls):
        path = Path(cls.temp.name)
        cls.temp.cleanup()
        if path.exists():
            raise AssertionError("Chrome 临时目录未清理")

    @classmethod
    def stop_browser(cls):
        if cls.process.poll() is None:
            with contextlib.suppress(BrowserUseError):
                cls.cdp.call("Browser.close", timeout=3)
        try:
            cls.process.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(cls.process.pid, signal.SIGTERM)
            cls.process.wait(10)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(cls.process.pid, signal.SIGKILL)
        print("INPUT_CHROME_EXIT " + str(cls.process.returncode))

    def setUp(self):
        self.target = self.cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.addCleanup(lambda: self.cdp.call("Target.closeTarget", {"targetId": self.target}))
        sid = self.cdp.call("Target.attachToTarget", {"targetId": self.target, "flatten": True})["sessionId"]
        self.driver = PageDriver(self.cdp, self.target, sid)
        self.addCleanup(self.close_driver)
        self.service = ElementService(self.driver)
        self.addCleanup(self.close_service)
        self.page("/")

    def close_driver(self):
        self.driver.close()
        self.assertEqual(self.driver.close_errors, [])

    def close_service(self):
        self.service.close()
        self.assertEqual(self.service.close_errors, [])

    def page(self, path):
        self.driver.dispatch("goto", {"url": self.http.base + path})
        self.driver.dispatch("wait", {"load": "load"})

    def js(self, expression):
        return self.driver.evaluate(expression)

    def resolve(self, **selector):
        return self.service.dispatch("resolve", {"selector": selector})

    def act(self, action, handle, **params):
        return self.service.dispatch(action, {"handle": handle, **params})

    def code(self, code, call, *args, **kwargs):
        with self.assertRaises(BrowserUseError) as raised:
            call(*args, **kwargs)
        self.assertEqual(raised.exception.code, code, str(raised.exception))
        return raised.exception

    # 1 语义定位
    def test_semantic_locators(self):
        self.assertEqual(self.resolve(text="你好 世界")["metadata"]["id"], "greet")
        self.assertEqual(self.resolve(placeholder="请输入姓名")["metadata"]["id"], "name")
        self.assertEqual(self.resolve(alt="公司标志")["metadata"]["id"], "logo")
        self.assertEqual(self.resolve(title="关闭对话框")["metadata"]["id"], "close")
        self.assertEqual(self.resolve(text="hello world", ignore_case=True)["metadata"]["id"], "hello")
        self.assertEqual(self.resolve(text="World", match="contains")["metadata"]["id"], "hello")
        self.code(3, self.resolve, **{"text": "hello world"})
        error = self.code(3, self.resolve, **{"text": "保存"})
        self.assertEqual(error.data["count"], 3)
        self.assertEqual(self.resolve(text="保存", nth=0)["metadata"]["id"], "save1")
        self.assertEqual(self.resolve(text="保存", nth=-1)["metadata"]["id"], "save3")
        self.assertEqual(self.resolve(css="button", nth=1, within="#form-area")["metadata"]["id"], "save2")
        self.code(3, self.resolve, **{"text": "保存", "nth": 5})
        listed = self.service.dispatch("list", {"selector": {"text": "保存"}, "limit": 2})
        self.assertEqual((listed["count"], len(listed["elements"]), listed["truncated"]), (3, 2, True))
        self.assertEqual(self.resolve(title="关闭对话框", within="#form-area")["metadata"]["id"], "close")
        self.driver.dispatch("click", {"selector": {"text": "保存", "nth": -1}})
        self.driver.dispatch("type", {"selector": {"placeholder": "请输入姓名"}, "text": "语义输入"})
        self.assertEqual(self.js("document.querySelector('#name').value"), "语义输入")
        self.code(2, self.driver.dispatch, "click", {"selector": {"text": "保存"}, "id": "save1"})

    # 2 表单
    def test_fill_and_form(self):
        name = self.resolve(id="name")["handle"]
        self.js("document.querySelector('#name').value='旧值'")
        self.assertEqual(self.act("fill", name, value="新值")["value"], "新值")
        self.assertEqual(self.act("fill", name, value="")["value"], "")
        notes = self.resolve(id="notes")["handle"]
        self.assertEqual(self.act("fill", notes, value="第一行\n第二行", allow_newline=True)["value"], "第一行\n第二行")
        self.code(6, self.act, "fill", notes, value="a\nb")
        rich = self.resolve(id="rich")["handle"]
        result = self.act("fill", rich, value="富文本新内容")
        self.assertEqual((result["kind"], result["value"]), ("contenteditable", "富文本新内容"))
        limited = self.resolve(id="limited")["handle"]
        error = self.code(1, self.act, "fill", limited, value="12345")
        self.assertEqual(error.data["value"], "123")
        city = self.resolve(id="city")["handle"]
        self.assertEqual(self.act("select", city, label="上海")["values"], ["sh"])
        self.code(1, self.act, "select", city, label="北京")
        tags = self.resolve(id="tags")["handle"]
        self.assertEqual(self.act("select", tags, labels=["甲", "丙"])["values"], ["a", "c"])
        self.assertEqual(self.act("select", tags, values=["b"])["values"], ["b"])
        agree = self.resolve(id="agree")["handle"]
        self.assertFalse(self.act("uncheck", agree)["checked"])
        self.assertFalse(self.act("uncheck", agree)["changed"])
        sw = self.resolve(id="sw")["handle"]
        result = self.act("check", sw)
        self.assertEqual((result["kind"], result["role"], result["ariaChecked"]), ("aria", "switch", "true"))
        self.assertEqual(self.act("uncheck", sw)["ariaChecked"], "false")
        dead = self.resolve(id="dead")["handle"]
        error = self.code(1, self.act, "check", dead)
        self.assertEqual(error.data["after"], "false")
        self.assertEqual(self.act("check", self.resolve(id="r1")["handle"])["ariaChecked"], "true")
        form = self.driver.dispatch("fill_form", {"items": [
            {"selector": {"placeholder": "请输入姓名"}, "value": "表单姓名"},
            {"selector": {"id": "city"}, "value": "杭州", "by": "label"},
            {"selector": {"id": "agree"}, "value": True},
            {"selector": {"id": "sw"}, "kind": "check"},
        ]})
        self.assertEqual([r["kind"] for r in form["results"]], ["text", "select", "check", "check"])
        self.assertEqual(self.js("[document.getElementById('name').value,city.value,agree.checked,sw.getAttribute('aria-checked')]"), ["表单姓名", "hz", True, "true"])
        error = self.code(1, self.driver.dispatch, "fill_form", {"items": [
            {"selector": {"placeholder": "请输入姓名"}, "value": "第二次"},
            {"selector": {"id": "dead"}, "kind": "check"},
            {"selector": {"id": "notes"}, "value": "不应写入"},
        ]})
        self.assertEqual(error.data["stoppedAt"], 1)
        self.assertEqual(len(error.data["results"]), 1)
        self.assertEqual(self.js("notes.value"), "第一行\n第二行")
        self.code(3, self.driver.dispatch, "fill_form", {"items": [{"selector": {"placeholder": "不存在"}, "value": "x"}]})

    # 3 键盘
    def test_keyboard(self):
        self.driver.dispatch("click", {"id": "keys"})
        self.js("log.length=0")
        typed = self.driver.dispatch("type_keys", {"selector": {"id": "keys"}, "text": "aB1!", "delay_ms": 5})
        self.assertEqual(typed["events"], 8)
        self.assertEqual(self.js("keys.value"), "aB1!")
        self.assertEqual(self.js("log.filter(e=>e.t==='keypress').map(e=>e.key).join('')"), "aB1!")
        self.assertTrue(self.js("log.every(e=>e.trusted)"))
        self.js("log.length=0")
        self.driver.dispatch("key", {"keys": "Control+Shift+K"})
        self.assertTrue(self.js("log.some(e=>e.t==='keydown'&&e.key==='K'&&e.ctrl&&e.shift)"))
        self.driver.dispatch("key", {"keys": "Control++"})
        self.assertTrue(self.js("log.some(e=>e.t==='keydown'&&e.key==='+'&&e.ctrl)"))
        for name in ("F1", "F12", "F24", "ArrowUp", "Insert", "PageDown", "ContextMenu", "Numpad5", "Escape"):
            self.js("log.length=0")
            self.driver.dispatch("key", {"keys": "Alt+" + name})
            self.assertTrue(self.js(f"log.some(e=>e.t==='keydown'&&e.alt&&(e.key==={json.dumps(name)}||e.code==={json.dumps(name)}))"), name)
        self.code(2, self.driver.dispatch, "key", {"keys": "Hyper+K"})
        self.code(2, self.driver.dispatch, "key", {"keys": "F25"})
        self.js("log.length=0;keys.value=''")
        self.driver.dispatch("key_down", {"key": "Shift"})
        self.driver.dispatch("key", {"keys": "a"})
        self.driver.dispatch("key_up", {"key": "Shift"})
        self.assertEqual(self.js("keys.value"), "A")
        self.assertTrue(self.js("log.some(e=>e.t==='keyup'&&e.key==='Shift')"))
        self.js("keys.value='复制内容'")
        self.driver.dispatch("edit", {"selector": {"id": "keys"}, "command": "select_all"})
        self.driver.dispatch("edit", {"command": "copy"})
        self.driver.dispatch("edit", {"selector": {"id": "name"}, "command": "paste"})
        self.assertEqual(self.js("document.querySelector('#name').value"), "复制内容")
        self.driver.dispatch("edit", {"selector": {"id": "keys"}, "command": "select_all"})
        self.driver.dispatch("edit", {"command": "cut"})
        self.assertEqual(self.js("keys.value"), "")
        self.code(2, self.driver.dispatch, "type_keys", {"text": "a", "delay_ms": 1001})

    # 4 鼠标与拖放
    def test_mouse_wheel_and_drag(self):
        self.js("pad.scrollIntoView({block:'center'})")
        box = self.js("(()=>{const r=pad.getBoundingClientRect();return [r.x+20,r.y+20]})()")
        self.driver.dispatch("mouse_move", {"x": box[0], "y": box[1], "steps": 5})
        self.driver.dispatch("mouse_down", {"button": "right"})
        self.driver.dispatch("mouse_up", {"button": "right"})
        self.driver.dispatch("wheel", {"dy": 200})
        until(lambda: self.js("pad.scrollTop") > 0, "滚轮滚动")
        events = self.js("mouse")
        self.assertTrue(any(e["t"] == "mousedown" and e["button"] == 2 and e["trusted"] for e in events))
        self.assertTrue(any(e["t"] == "wheel" and e["dy"] == 200 for e in events))
        self.assertGreaterEqual(sum(e["t"] == "mousemove" for e in events), 1)
        self.driver.dispatch("mouse_down", {"x": box[0], "y": box[1], "button": "middle"})
        self.code(1, self.driver.dispatch, "mouse_down", {"button": "middle"})
        self.driver.dispatch("mouse_up", {"button": "middle"})
        self.code(2, self.driver.dispatch, "mouse_move", {"x": 1, "y": 1, "steps": 241})
        drag = self.resolve(id="drag")["handle"]
        result = self.act("drag_to", drag, target_selector={"text": "放这里"})
        self.assertEqual((result["mode"], result["dropVerified"]), ("html5", True))
        self.assertEqual(self.js("dropped"), [{"data": "拖动数据", "trusted": True}])
        plain = self.resolve(id="plain")["handle"]
        error = self.code(1, self.act, "drag_to", plain, target=self.resolve(id="drop")["handle"], mode="html5")
        self.assertIn("draggable", str(error))
        self.assertFalse(self.act("drag_to", plain, target=self.resolve(id="drop")["handle"])["dropVerified"])
        self.js("drop.ondrop=null;document.getElementById('drop').replaceWith(document.getElementById('drop').cloneNode(true))")
        error = self.code(1, self.act, "drag_to", drag, target_selector={"id": "drop"})
        self.assertEqual(error.outcome, "unknown")
        self.assertEqual(len(self.js("dropped")), 1)
        self.driver.dispatch("drag", {"start": [1, 1], "end": [5, 5]})

    # 5 等待
    def test_waits(self):
        self.driver.dispatch("click", {"id": "late-btn"})
        result = self.driver.dispatch("wait", {"selector": {"id": "late"}, "state": "visible", "timeout": 5})
        self.assertEqual((result["found"], result["count"]), (True, 1))
        self.driver.dispatch("wait", {"selector": {"id": "greet"}, "state": "hidden", "timeout": 5})
        self.driver.dispatch("wait", {"selector": {"id": "missing"}, "state": "detached", "timeout": 1})
        self.driver.dispatch("wait", {"selector": {"text": "保存"}, "state": "attached", "timeout": 1})
        self.code(3, self.driver.dispatch, "wait", {"selector": {"text": "保存"}, "state": "visible", "timeout": 1})
        found = self.driver.dispatch("wait", {"any_text": ["没有这段", "状态：完成"], "timeout": 5})
        self.assertEqual((found["matched"], found["index"]), ("状态：完成", 1))
        self.driver.dispatch("click", {"id": "nav"})
        url = self.driver.dispatch("wait", {"url": "*/done?step=*", "timeout": 5})
        self.assertTrue(url["url"].endswith("/done?step=2"))
        timeout = self.code(4, self.driver.dispatch, "wait", {"url": "*/never", "timeout": 0.2})
        self.assertEqual(timeout.outcome, "not_sent")
        self.driver.dispatch("wait", {"label": "你好", "gone": True, "timeout": 2})
        self.driver.dispatch("wait", {"expression": "document.readyState==='complete'"})
        self.driver.dispatch("goto", {"url": self.http.base + "/idle", "timeout": 10})
        self.driver.dispatch("wait", {"load": "domcontentloaded", "timeout": 5})
        idle = self.driver.dispatch("wait", {"load": "networkidle", "timeout": 10})
        self.assertIn("networkIdle", idle["lifecycle"])
        self.assertEqual(self.js("document.body.dataset.slow"), "slow-done")

    # 6 页面信息 + 8 frame 列表
    def test_page_info_text_frames(self):
        until(lambda: any(f["oopif"] for f in self.driver.dispatch("frames")["frames"]), "跨进程 iframe 接入")
        info = self.driver.dispatch("page_info")
        self.assertEqual((info["title"], info["readyState"]), ("输入夹具", "complete"))
        self.assertTrue(info["url"].startswith(self.http.base))
        for key in ("innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY"):
            self.assertIn(key, info["viewport"])
        self.assertTrue(info["loaderId"])
        text = self.driver.dispatch("page_text", {})
        self.assertIn("你好 世界", text["text"])
        self.assertFalse(text["truncated"])
        short = self.driver.dispatch("page_text", {"max_chars": 5})
        self.assertEqual((len(short["text"]), short["truncated"], short["length"]), (5, True, text["length"]))
        frames = self.driver.dispatch("frames")["frames"]
        main = [f for f in frames if not f["parentId"]]
        self.assertEqual(len(main), 1)
        cross = next(f for f in frames if f["oopif"])
        self.assertTrue(cross["url"].startswith("http://localhost:"))
        self.assertEqual(cross["parentId"], main[0]["frameId"])
        self.assertNotEqual(cross["sessionId"], self.driver.session_id)
        same = next(f for f in frames if f["parentId"] and not f["oopif"])
        self.assertEqual(same["url"], "about:srcdoc")
        inner = self.driver.dispatch("page_text", {"frame": cross["frameId"]})
        self.assertIn("跨域按钮", inner["text"])
        handle = self.service.dispatch("resolve", {"selector": {"placeholder": "跨域输入", "frame": cross["frameId"]}})["handle"]
        self.assertEqual(self.act("fill", handle, value="跨进程填写")["value"], "跨进程填写")

    # 7 元素脚本
    def test_element_evaluate(self):
        handle = self.resolve(id="greet")["handle"]
        result = self.act("evaluate", handle, function="function(a,b){return {text:this.textContent,sum:a+b}}", args=[2, 3])
        self.assertEqual(result["value"], {"text": "你好 世界", "sum": 5})
        self.assertEqual(self.act("evaluate", handle, function="async function(){return this.id}")["value"], "greet")
        error = self.code(1, self.act, "evaluate", handle, function="function(){throw new Error('元素脚本炸了')}")
        self.assertIn("元素脚本炸了", str(error))
        self.code(1, self.act, "evaluate", handle, function="function(){return NaN}")
        self.code(2, self.act, "evaluate", handle, function="function(){}", args={"a": 1})

    # 9 取态选项
    def test_snap_options(self):
        full = self.driver.dispatch("snap", {"max": 500})
        scoped = self.driver.dispatch("snap", {"max": 500, "within": "#form-area"})
        self.assertLess(len(scoped["elements"]), len(full["elements"]))
        self.assertIn("truncated", scoped)
        ids = {e["id"] for e in scoped["elements"]}
        self.assertIn("save1", ids)
        self.assertNotIn("keys", ids)
        interactive = self.driver.dispatch("snap", {"max": 500, "interactive_only": True})
        self.assertTrue(all("Press" in e["actions"] or "SetValue" in e["actions"] or e["role"] in ("switch", "checkbox", "radio") for e in interactive["elements"]))
        self.assertNotIn("greet", {e["id"] for e in interactive["elements"]})
        self.assertIn("sw", {e["id"] for e in interactive["elements"]})
        urls = self.driver.dispatch("snap", {"max": 500, "include_urls": True, "ax_properties": True})
        link = next(e for e in urls["elements"] if e["id"] == "link")
        self.assertEqual(link["url"], self.http.base + "/second?from=link")
        switch = next(e for e in urls["elements"] if e["id"] == "sw")
        self.assertIn("checked", switch["axProperties"])
        self.code(3, self.driver.dispatch, "snap", {"within": "button"})
        self.code(2, self.driver.dispatch, "snap", {"within": "##bad"})

    # 10 导航
    def test_navigation_before_unload(self):
        self.driver.dispatch("click", {"id": "keys"})
        self.js("window.guard=true")
        error = self.code(1, self.driver.dispatch, "goto", {"url": self.http.base + "/second", "timeout": 5})
        self.assertEqual(error.outcome, "dialog_open")
        self.assertEqual(error.data["dialog"]["type"], "beforeunload")
        self.driver.dispatch("dialog", {"accept": False})
        self.assertEqual(self.js("document.title"), "输入夹具")
        dismissed = self.driver.dispatch("goto", {"url": self.http.base + "/second", "before_unload": "dismiss", "timeout": 5})
        self.assertFalse(dismissed["navigated"])
        self.assertEqual(self.js("document.title"), "输入夹具")
        accepted = self.driver.dispatch("goto", {"url": self.http.base + "/second", "before_unload": "accept", "timeout": 5})
        self.assertEqual(accepted["beforeUnload"], "accepted")
        self.assertEqual(self.js("document.title"), "第二页")
        self.driver.dispatch("back", {"timeout": 5})
        self.driver.dispatch("click", {"id": "keys"})
        self.js("window.guard=true")
        error = self.code(1, self.driver.dispatch, "reload", {"timeout": 5})
        self.assertEqual(error.outcome, "dialog_open")
        self.driver.dispatch("dialog", {"accept": False})
        self.driver.dispatch("reload", {"before_unload": "accept", "timeout": 5})
        self.assertFalse(self.js("!!window.guard"))
        self.driver.dispatch("forward", {"timeout": 5})
        self.assertEqual(self.js("document.title"), "第二页")
        self.code(2, self.driver.dispatch, "goto", {"url": self.http.base, "timeout": 121})

    # 11 文件选择器上传
    def test_upload_via_chooser(self):
        first = Path(self.temp.name) / "选择1.txt"
        second = Path(self.temp.name) / "选择2.txt"
        first.write_text("1")
        second.write_text("2")
        result = self.driver.dispatch("upload_via_chooser", {"selector": {"text": "选择文件"}, "files": [str(first), str(second)]})
        self.assertEqual((result["count"], result["mode"]), (2, "selectMultiple"))
        until(lambda: self.js("files.length") == 2, "change 事件")
        self.assertEqual(self.js("files"), ["选择1.txt", "选择2.txt"])
        self.code(2, self.driver.dispatch, "upload_via_chooser", {"selector": {"id": "pick1"}, "files": [str(first), str(second)]})
        self.assertEqual(self.js("document.querySelector('#file1').files.length"), 0)
        error = self.code(1, self.driver.dispatch, "upload_via_chooser", {"selector": {"id": "save1"}, "files": [str(first)], "timeout": 0.5})
        self.assertEqual(error.outcome, "unknown")
        self.code(3, self.driver.dispatch, "upload_via_chooser", {"selector": {"id": "pick"}, "files": [self.temp.name]})
        self.driver.dispatch("click", {"id": "pick1"})

    # 12 截图格式
    def test_screenshot_formats(self):
        directory = Path(self.temp.name) / "shots"
        page_png = self.driver.dispatch("shot", {"shrink": 0, "out": str(directory / "page.png")})
        self.assertEqual(stat.S_IMODE(Path(page_png["path"]).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        info = self.driver.dispatch("page_info")
        dpr = info["viewport"]["devicePixelRatio"]
        self.assertEqual(page_png["screenshot"]["width"], round(info["viewport"]["innerWidth"] * dpr))
        self.assertFalse(page_png["screenshot"]["scaled"])
        jpeg = self.driver.dispatch("shot", {"format": "jpeg", "quality": 40, "shrink": 300})
        self.assertTrue(Path(jpeg["path"]).read_bytes().startswith(b"\xff\xd8"))
        self.assertEqual(jpeg["screenshot"]["format"], "jpeg")
        self.assertLessEqual(max(jpeg["screenshot"]["width"], jpeg["screenshot"]["height"]), 300)
        self.assertEqual(stat.S_IMODE(Path(jpeg["path"]).parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(Path(jpeg["path"]).stat().st_mode), 0o600)
        webp = self.act("screenshot", self.resolve(id="drop")["handle"], format="webp", quality=80, shrink=0)
        self.assertEqual(webp["screenshot"]["format"], "webp")
        self.assertEqual(webp["screenshot"]["sizeSource"], "file")
        self.assertEqual(webp["screenshot"]["width"], round(160 * dpr))
        self.assertTrue(Path(webp["path"]).read_bytes()[8:12] == b"WEBP")
        self.code(6, self.driver.dispatch, "shot", {"out": page_png["path"]})
        self.code(2, self.driver.dispatch, "shot", {"format": "png", "quality": 50})
        self.code(2, self.driver.dispatch, "shot", {"format": "gif"})
        self.code(2, self.driver.dispatch, "shot", {"format": "jpeg", "out": str(directory / "x.png")})


if __name__ == "__main__":
    unittest.main()
