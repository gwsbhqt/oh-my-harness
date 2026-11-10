"""BROWSER_CONTROL_LANDING_LIVE=1：独立临时 Chrome 重演「标题被误输入」事故，验收落点、插入位置、撤销、点击换点、截断说明和候选提示。"""
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import unittest
import urllib.request

from browser_control.cdp import CDP
from browser_control.driver import PageDriver
from browser_control.errors import BrowserControlError
from test_input_live import until

INCIDENT = r"""<!doctype html><html><head><meta charset="utf-8"><title>事故夹具</title><style>
body{margin:0;font:15px sans-serif} main{padding:16px 16px 80px}
#title{width:400px;font-size:18px} #editor{min-height:640px;border:1px solid #999;padding:8px;margin-top:12px}
#editor p{margin:0 0 110px} .bar{position:fixed;left:0;right:0;bottom:0;height:56px;background:#eef}
</style></head><body><main id="content">
<input id="title" aria-label="标题" value="每日晨报">
<div id="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="提示词"><p id="p1">第一段：你是一个晨报助手。</p><p id="p2">第二段：汇总昨日要闻。</p><p id="p3">第三段：按板块分类。</p><p id="p4">第四段：每条附来源链接。</p><p id="p5">第五段：控制在五百字内。</p><ul><li>要点一</li><li>要点二</li></ul></div>
</main><div class="bar"><button id="save">保存</button></div>
<div id="shost"></div>
<script>document.getElementById('shost').attachShadow({mode:'open'}).innerHTML='<div id="sedit" contenteditable="true" aria-label="影子编辑器" style="min-height:120px"><p>影子一段</p><p>影子二段</p></div>';</script>
</body></html>"""

NAV = ("<!doctype html><meta charset=utf-8><title>导航夹具</title><style>body{display:flex;margin:0}nav{width:240px;height:100vh;overflow:auto}"
       "main{flex:1;padding:16px}</style><body><nav aria-label=会话列表><ul>"
       + "".join(f'<li><a href="#n{i}">会话 {i} 的标题</a></li>' for i in range(200))
       + "</ul></nav><main id=content><h1>自动化列表</h1>"
       + "".join(f"<div role=row><span>{name}</span><button>编辑</button></div>" for name in ("每日晨报", "周报汇总", "日程提醒"))
       + "</main></body>")


@unittest.skipUnless(os.environ.get("BROWSER_CONTROL_LANDING_LIVE") == "1", "需显式 BROWSER_CONTROL_LANDING_LIVE=1 启动独立 Chrome")
class LandingLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="browser-control-landing-live-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.process = subprocess.Popen([
            os.environ.get("BROWSER_CONTROL_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            "--disable-component-update", "--disable-sync", "--use-mock-keychain", "--password-store=basic", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--user-data-dir=" + cls.temp.name, "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        cls.addClassCleanup(cls.stop_browser)
        port_file = Path(cls.temp.name) / "DevToolsActivePort"

        def endpoint():
            if cls.process.poll() is not None:
                raise AssertionError("Chrome 提前退出")
            if port_file.is_file() and len(port_file.read_text().splitlines()) >= 2:
                return "http://127.0.0.1:" + port_file.read_text().splitlines()[0]
        url = until(endpoint, "DevToolsActivePort", 15)
        with urllib.request.urlopen(url + "/json/version", timeout=3) as response:
            cls.cdp = CDP(json.load(response)["webSocketDebuggerUrl"])
        cls.addClassCleanup(cls.cdp.close)

    @classmethod
    def stop_browser(cls):
        if cls.process.poll() is None:
            with contextlib.suppress(BrowserControlError):
                cls.cdp.call("Browser.close", timeout=3)
        try:
            cls.process.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(cls.process.pid, signal.SIGTERM)
            cls.process.wait(10)

    def setUp(self):
        target = self.cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.addCleanup(lambda: self.cdp.call("Target.closeTarget", {"targetId": target}))
        session = self.cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        self.driver = PageDriver(self.cdp, target, session)
        self.addCleanup(self.driver.close)
        self.driver.dispatch("viewport", {"width": 1280, "height": 900})

    def load(self, html):
        self.driver.dispatch("eval", {"expression": "document.open();document.write(%r);document.close()" % html})

    def value(self, css):
        return self.driver.evaluate("(e=>e.value??e.innerText)(document.querySelector(%r))" % css)

    def test_shared_connection_keeps_other_pages_events_out(self):
        self.load(INCIDENT)
        self.driver._target_check()
        epoch = self.driver._epoch
        target = self.cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.addCleanup(lambda: self.cdp.call("Target.closeTarget", {"targetId": target}))
        session = self.cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        other = PageDriver(self.cdp, target, session)
        self.addCleanup(other.close)
        navigated = threading.Event()
        unsubscribe = self.cdp.on("Page.frameNavigated", lambda params, sid: navigated.set() if sid == session else None)
        self.addCleanup(unsubscribe)
        for i in range(8):
            other.dispatch("goto", {"url": "data:text/html,<title>Other</title><p>" + str(i) + "</p>"})
        self.assertTrue(navigated.wait(5), "没有收到另一个页面的真实导航事件")
        self.driver._target_check()
        self.assertEqual(self.driver._epoch, epoch)
        self.assertEqual(self.driver._event_loss, 0)
        typed = self.driver.dispatch("type", {"id": "title", "text": "保留", "position": "end"})
        self.assertEqual(typed["after"], "每日晨报保留")

    def test_incident_replay(self):
        self.load(INCIDENT)
        clicked = self.driver.dispatch("click", {"id": "title"})
        self.assertTrue(clicked["focusInTarget"])
        self.driver.dispatch("edit", {"command": "select_all"})
        typed = self.driver.dispatch("type", {"text": "自动化每日晨报"})
        self.assertEqual((typed["target"]["id"], typed["before"], typed["after"]), ("title", "每日晨报", "自动化每日晨报"))

        editor = self.driver.dispatch("click", {"id": "editor"})
        self.assertEqual((editor["focusRelation"], editor["focusInTarget"]), ("self", True))

        html = self.driver.evaluate("document.querySelector('#editor').innerHTML")
        inserted = self.driver.dispatch("type", {"text": "这是来自自动化任务，", "id": "editor", "position": "start"})
        self.assertTrue(inserted["after"].startswith("这是来自自动化任务，第一段"))
        self.assertEqual(self.driver.evaluate("document.querySelector('#editor').innerHTML"), html.replace("第一段", "这是来自自动化任务，第一段", 1))
        self.assertEqual(self.value("#title"), "自动化每日晨报")

        self.driver.dispatch("click", {"id": "title"})
        stray = self.driver.dispatch("type", {"text": "【误输入】"})
        self.assertEqual((stray["target"]["id"], stray["focus"]), ("title", "current-focus"))
        self.assertEqual((stray["before"], stray["after"]), ("自动化每日晨报", "自动化每日晨报【误输入】"))
        undone = self.driver.dispatch("edit", {"command": "undo"})
        self.assertEqual(undone["after"], "自动化每日晨报")
        self.assertEqual(self.value("#title"), "自动化每日晨报")

        snap = self.driver.dispatch("snap", {"all": True})
        p3 = next(e["idx"] for e in snap["elements"] if e["id"] == "p3")
        home = self.driver.dispatch("key", {"keys": "Home", "idx": p3, "snapshot": snap["snapshot"]})
        self.assertEqual((home["focus"], home["target"]["id"], home["caret"]["element"]["id"]), ("editing-host", "editor", "p3"))

    def test_undo_restores_contenteditable_and_redo_reapplies(self):
        self.load(INCIDENT)
        before = self.value("#editor")
        self.driver.dispatch("type", {"text": "XYZ", "id": "editor", "position": "end"})
        self.assertEqual(self.driver.dispatch("edit", {"command": "undo", "id": "editor"})["after"], before)
        self.assertTrue(self.driver.dispatch("edit", {"command": "redo", "id": "editor"})["after"].endswith("XYZ"))

    def test_shadow_editor_and_plain_paragraph(self):
        self.load(INCIDENT)
        typed = self.driver.dispatch("type", {"text": "尾巴", "selector": {"css": "#sedit", "shadow": ["#shost"]}, "position": "end"})
        self.assertTrue(typed["after"].endswith("影子二段尾巴"))
        self.driver.evaluate("document.querySelector('main').insertAdjacentHTML('afterbegin','<p id=plainp>普通段落</p>')")
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch("key", {"keys": "Home", "selector": {"id": "plainp"}})
        self.assertIn("不能获得输入焦点", str(raised.exception))

    def test_click_retries_inside_scroll_panel_and_names_overlay(self):
        self.load(INCIDENT.replace("<main id=\"content\">", "<main id=\"content\" style=\"height:300px;overflow:auto;padding-bottom:0\">")
                  .replace("</main>", "</main><div style=\"height:400px\">面板下方</div>"))
        clicked = self.driver.dispatch("click", {"id": "editor"})
        self.assertEqual(clicked["point"]["retried"], ["center"])
        self.assertTrue(clicked["focusInTarget"])
        self.driver.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=mask class=overlay style=\"position:fixed;inset:0\">加载中</div>')")
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch("click", {"id": "editor"})
        self.assertEqual(raised.exception.data["blocker"]["id"], "mask")
        self.load(INCIDENT)
        top_left = self.driver.dispatch("click", {"id": "editor", "position": "top-left"})
        self.assertEqual(top_left["caret"]["element"]["id"], "p1")

    def test_truncated_snapshot_keeps_main_content_and_suggests_within(self):
        self.load(NAV)
        snap = self.driver.dispatch("snap", {"max": 120})
        self.assertTrue(snap["truncated"])
        self.assertIn("编辑", [e["label"] for e in snap["elements"]])
        self.assertEqual([e["idx"] for e in snap["elements"]], list(range(1, 121)))
        info = snap["truncation"]
        self.assertEqual(info["limits"], ["max"])
        scoped = self.driver.dispatch("snap", {"max": 120, "within": info["containers"][0]["css"]})
        self.assertFalse(scoped["truncated"])
        self.assertEqual(sum(e["role"] == "button" and e["label"] == "编辑" for e in scoped["elements"]), 3)

    def test_zero_match_lists_candidates(self):
        self.load(INCIDENT)
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch("click", {"id": "12"})
        self.assertIn("idx=12", str(raised.exception))
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch("click", {"label": "保 存"})
        self.assertEqual(raised.exception.data["candidates"][0]["id"], "save")
        with self.assertRaises(BrowserControlError) as raised:
            self.driver.dispatch("click", {"selector": {"text": "保存按钮"}})
        self.assertEqual(raised.exception.data["candidates"][0]["id"], "save")

