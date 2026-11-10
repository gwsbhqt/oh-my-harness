"""BROWSER_CONTROL_LANE_LIVE=1：泳道真实验收。测试自己启动独立 Chrome 和隔离 browser-control 服务，本地 HTTP 夹具记录每个请求实际收到的头。

BROWSER_CONTROL_LANE_LIVE=1 PYTHONPATH=src:tests python3 -m unittest tests.test_lane_live -v
Chrome 默认用 Playwright 下载的 Chrome for Testing（品牌 Chrome 不再允许命令行加载扩展），可用 BROWSER_CONTROL_TEST_CHROME 指定。
冲突场景给测试 Chrome 加载 tests/fixtures/header-rewrite-extension：把 x-tt-env 改成 ppe_b、删掉 force-workbench，
模拟「浏览器里有别的东西改了这个头」；browser-control 代码不知道它存在，只通过 BROWSER_CONTROL_TEST_CHROME_ENDPOINT 连上测试启动的 Chrome。
"""
import asyncio
import glob
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from browser_control.client import Client

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = Path(__file__).parent / "fixtures" / "header-rewrite-extension"
LANE = {"force-workbench": "1", "x-tt-env": "ppe_a"}
WATCHED = ("x-tt-env", "force-workbench")


def chrome_path():
    if os.environ.get("BROWSER_CONTROL_TEST_CHROME"):
        return os.environ["BROWSER_CONTROL_TEST_CHROME"]
    found = sorted(glob.glob(os.path.expanduser(
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")))
    return found[-1] if found else None


class Recorder:
    """两个本地来源（127.0.0.1 与 localhost 不同端口）记录收到的每个请求的方法、路径和泳道头。"""

    def __init__(self):
        self.rows = []
        self.lock = threading.Lock()
        self.servers = [self._serve(name) for name in ("A", "B")]
        self.a = "http://127.0.0.1:%d" % self.servers[0].server_port
        self.b = "http://localhost:%d" % self.servers[1].server_port

    def _serve(self, name):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def record(self):
                row = {"server": name, "method": self.command, "path": self.path}
                row.update({header: self.headers.get(header) for header in WATCHED})
                with fixture.lock:
                    fixture.rows.append(row)

            def reply(self, body, kind="text/html; charset=utf-8", cache="no-store", status=200, extra=()):
                body = body.encode() if isinstance(body, str) else body
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", cache)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                for key, value in extra:
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.record()
                self.reply(b"", "text/plain")

            def do_POST(self):
                self.record()
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.reply("ok", "text/plain")

            def do_GET(self):
                self.record()
                path = self.path.split("?")[0]
                if path == "/page":
                    self.reply("<title>lane</title><iframe src='/frame'></iframe><script>fetch('/api/in-page')</script>")
                elif path == "/frame":
                    self.reply("<script>fetch('/api/in-frame')</script>")
                elif path == "/cached.js":
                    self.reply("window.cachedLoaded=(window.cachedLoaded||0)+1", "text/javascript", cache="max-age=3600")
                elif path == "/redirect":
                    self.reply(b"", status=302, extra=(("Location", "/api/after-redirect"),))
                elif path == "/sw-page":
                    self.reply("<title>sw</title><script>navigator.serviceWorker.register('/sw.js')"
                               ".then(()=>navigator.serviceWorker.ready).then(()=>document.title='ready')</script>")
                elif path == "/sw.js":
                    self.reply("self.addEventListener('install',e=>self.skipWaiting());"
                               "self.addEventListener('activate',e=>e.waitUntil(clients.claim()));"
                               "self.addEventListener('fetch',e=>{if(e.request.url.includes('/api/through-sw'))e.respondWith(fetch(e.request))});"
                               "fetch('/api/sw-own');", "text/javascript")
                else:
                    self.reply(json.dumps({"path": path}), "application/json")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    def take(self):
        with self.lock:
            rows, self.rows = self.rows, []
        return rows

    def close(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()


@unittest.skipUnless(os.environ.get("BROWSER_CONTROL_LANE_LIVE") == "1", "需显式 BROWSER_CONTROL_LANE_LIVE=1 启动独立 Chrome 和隔离 browser-control 服务")
class LaneLive(unittest.IsolatedAsyncioTestCase):
    session = "lane_live"

    async def asyncSetUp(self):
        chrome = chrome_path()
        if not chrome or not Path(chrome).is_file():
            self.skipTest("没有找到测试 Chrome；设 BROWSER_CONTROL_TEST_CHROME")
        self.temp = tempfile.TemporaryDirectory(prefix="browser-control-lane-live-")
        self.root = Path(self.temp.name).resolve()
        self.http = Recorder()
        self.chrome = None
        self.service = None
        self.addAsyncCleanup(self.cleanup)
        self.chrome_binary = chrome

    def start_chrome(self, *, extension):
        profile = self.root / ("chrome-ext" if extension else "chrome")
        args = [self.chrome_binary, "--headless=new", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", "--disable-component-update", "--disable-sync",
                "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + str(profile)]
        if extension:
            # Chrome 会在扩展目录里写规则缓存，复制一份到临时目录再加载，免得弄脏仓库。
            copy = self.root / "extension"
            shutil.copytree(EXTENSION, copy)
            args.append("--load-extension=" + str(copy))
        args.append("about:blank")
        self.chrome = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        port_file = profile / "DevToolsActivePort"
        deadline = time.monotonic() + 20
        while not (port_file.is_file() and len(port_file.read_text().splitlines()) >= 2):
            if self.chrome.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("测试 Chrome 没有起来")
            time.sleep(0.05)
        endpoint = "http://127.0.0.1:" + port_file.read_text().splitlines()[0]
        if extension:
            deadline = time.monotonic() + 10
            while not any(t.get("type") == "service_worker" and "chrome-extension://" in t.get("url", "")
                          for t in json.load(urllib.request.urlopen(endpoint + "/json/list"))):
                if time.monotonic() > deadline:
                    raise RuntimeError("夹具扩展没有加载")
                time.sleep(0.1)
        return endpoint

    async def start_service(self, endpoint):
        state, cache = self.root / "state", self.root / "cache"
        (cache / "browser-control").mkdir(parents=True)
        venv = Path.home() / ".cache" / "browser-control" / "venv"
        if venv.is_dir():
            (cache / "browser-control" / "venv").symlink_to(venv)
        self.socket = self.root / "sock" / "daemon.sock"
        self.socket.parent.mkdir(mode=0o700)
        self.env = {**os.environ, "XDG_STATE_HOME": str(state), "XDG_CACHE_HOME": str(cache), "BROWSER_CONTROL_CONTEXT_ID": "",
                    "DSH_SESSION_ID": "", "BROWSER_CONTROL_TEST_CHROME_ENDPOINT": endpoint, "PYTHONPATH": str(ROOT / "src")}
        self.log = tempfile.TemporaryFile()
        self.service = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "browser-control"), "serve", "--socket", str(self.socket)],
                                        env=self.env, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 10
        while not self.socket.exists():
            if self.service.poll() is not None or time.monotonic() > deadline:
                self.log.seek(0)
                raise RuntimeError("隔离 browser-control 服务没起来：" + self.log.read().decode(errors="replace"))
            await asyncio.sleep(0.05)
        self.client = Client(str(self.socket), autostart=False)

    async def cleanup(self):
        try:
            if self.service is not None:
                try:
                    await self.client.acall("release", session=self.session, browser="Chrome")
                except Exception:
                    pass
                self.service.terminate()
                await asyncio.to_thread(self.service.wait, 10)
                self.log.close()
        finally:
            if self.chrome is not None and self.chrome.poll() is None:
                os.killpg(self.chrome.pid, signal.SIGTERM)
                await asyncio.to_thread(self.chrome.wait, 10)
            self.http.close()
            self.temp.cleanup()

    async def call(self, action, params=None, target=None):
        return await self.client.acall(action, params, target=target, session=self.session, browser="Chrome")

    async def cli(self, *args, json_mode=True):
        command = [sys.executable, str(ROOT / "scripts" / "browser-control"), "--socket", str(self.socket), "--session", self.session,
                   "--browser", "Chrome", *(["--json"] if json_mode else []), *args]
        proc = await asyncio.create_subprocess_exec(*command, env=self.env, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate()
        return proc.returncode, out.decode(), err.decode()

    async def settle(self, tab, seconds=0.6):
        await asyncio.sleep(seconds)
        return await self.call("page_eval", {"expression": "1"}, tab)

    def report(self, title, value):
        print("\n=== " + title + "\n" + json.dumps(value, ensure_ascii=False, indent=1))

    async def test_lane_without_and_with_conflicting_extension(self):
        endpoint = self.start_chrome(extension=False)
        await self.start_service(endpoint)
        a, b = self.http.a, self.http.b

        # 1. 新开页带泳道：首个文档请求、iframe、页内 fetch、跳转后都带上；没有警告；统计全部一致。
        code, out, err = await self.cli("tab", "new", a + "/page", "--lane", json.dumps(LANE))
        self.assertEqual(code, 0, (out, err))
        created = json.loads(out)
        tab = created["targetId"]
        self.assertEqual(created["lane"], {"headers": LANE})
        await self.settle(tab)
        await self.call("page_eval", {"expression": "fetch('/redirect').then(r=>r.status)"}, tab)
        await self.call("page_goto", {"url": a + "/api/after-goto"}, tab)
        first = await self.settle(tab)
        rows = self.http.take()
        self.report("1 服务器收到的头（无扩展）", rows)
        paths = {row["path"] for row in rows}
        for path in ("/page", "/frame", "/api/in-page", "/api/in-frame", "/redirect", "/api/after-redirect", "/api/after-goto"):
            self.assertIn(path, paths)
        for row in rows:
            if row["path"] != "/favicon.ico":
                self.assertEqual((row["x-tt-env"], row["force-workbench"]), ("ppe_a", "1"), row)
        self.assertNotIn("laneWarning", first)
        state = await self.call("lane_get", {}, tab)
        self.report("1 lane get", state["check"])
        self.assertEqual(state["check"]["mismatched"], 0)
        self.assertEqual(state["check"]["requests"], state["check"]["matched"])
        self.assertGreaterEqual(state["check"]["requests"], 7)

        # 2. 跨域预检、service worker、命中缓存、data:/blob:、beacon 都不误报。
        await self.call("page_eval", {"expression": f"fetch('{b}/api/cors',{{method:'POST',body:'x'}}).then(r=>r.status)"}, tab)
        await self.call("page_eval", {"expression": "fetch('data:text/plain,hi').then(r=>r.text())"}, tab)
        await self.call("page_eval", {"expression": "fetch(URL.createObjectURL(new Blob(['x']))).then(r=>r.text())"}, tab)
        await self.call("page_eval", {"expression": "navigator.sendBeacon('/api/beacon','x')"}, tab)
        load = "new Promise(r=>{const s=document.createElement('script');s.src='/cached.js';s.onload=()=>r(window.cachedLoaded);document.head.append(s)})"
        await self.call("page_eval", {"expression": load}, tab)
        await self.call("page_eval", {"expression": load}, tab)
        await self.call("page_goto", {"url": a + "/sw-page"}, tab)
        await self.call("page_wait", {"expression": "document.title==='ready'", "timeout": 10}, tab)
        await self.call("page_reload", {}, tab)
        controlled = await self.call("page_eval", {"expression": "navigator.serviceWorker.ready.then(()=>!!navigator.serviceWorker.controller)"}, tab)
        await self.call("page_eval", {"expression": "fetch('/api/through-sw').then(r=>r.status)"}, tab)
        second = await self.settle(tab, 1.0)
        rows = self.http.take()
        self.report("2 服务器收到的头（预检、SW、缓存）", rows)
        self.assertTrue(controlled["value"], "service worker 没有接管页面，场景不成立")
        preflight = [row for row in rows if row["method"] == "OPTIONS"]
        self.assertTrue(preflight, "没有触发跨域预检，场景不成立")
        self.assertEqual(sum(row["path"] == "/cached.js" for row in rows), 1, "第二次应命中缓存不上线")
        self.assertTrue(any(row["path"] == "/api/sw-own" and row["x-tt-env"] is None for row in rows),
                        "service worker 自己的请求本来就不带页面附加头")
        self.assertNotIn("laneWarning", second)
        state = await self.call("lane_get", {}, tab)
        self.report("2 lane get", state["check"])
        self.assertEqual(state["check"]["mismatched"], 0)

        # 5. lane 和 headers-set 同名时报错提示。
        code, out, err = await self.cli("network", tab, "headers-set", "--headers", '{"X-TT-Env":"other"}')
        self.report("5 headers-set 同名", json.loads(out))
        self.assertEqual(code, 6)
        self.assertIn("lane", json.loads(out)["error"])
        code, out, err = await self.cli("network", tab, "headers-set", "--headers", '{"x-debug":"1"}')
        self.assertEqual(code, 0, out)
        code, out, err = await self.cli("lane", tab, "set", "--headers", '{"x-debug":"2"}')
        self.report("5 lane set 同名", json.loads(out))
        self.assertEqual(code, 6)
        self.assertIn("headers-clear", json.loads(out)["error"])

        code, out, err = await self.cli("release")
        self.assertEqual(code, 0, out)

        # 4. release 后同一页面再发请求不带泳道头：页面由测试自己开，browser-control 只借用，release 不关它。
        from browser_control.cdp import CDP, discover
        raw = CDP(discover(endpoint))
        try:
            borrowed = raw.call("Target.createTarget", {"url": a + "/api/borrowed-open"})["targetId"]
            await asyncio.sleep(0.5)
            await self.call("tab_bind", target=borrowed)
            code, out, err = await self.cli("lane", borrowed, "set", json.dumps(LANE))
            self.assertEqual(code, 0, out)
            self.report("4 对已打开页面设泳道的返回", json.loads(out))
            self.assertIn("刷新页面", json.loads(out)["note"])
            await self.call("page_eval", {"expression": "fetch('/api/before-release').then(r=>r.status)"}, borrowed)
            code, out, err = await self.cli("release")
            self.assertEqual(code, 0, out)
            self.assertIn(borrowed, [t["targetId"] for t in raw.call("Target.getTargets")["targetInfos"]], "借用页不该被关")
            sid = raw.call("Target.attachToTarget", {"targetId": borrowed, "flatten": True})["sessionId"]
            raw.call("Runtime.evaluate", {"expression": "fetch('/api/after-release').then(r=>r.status)", "awaitPromise": True}, session_id=sid)
            raw.call("Target.closeTarget", {"targetId": borrowed})
        finally:
            raw.close()
        rows = self.http.take()
        self.report("4 release 前后服务器收到的头（同一页面）", rows)
        heads = {r["path"]: (r["x-tt-env"], r["force-workbench"]) for r in rows}
        self.assertEqual(heads["/api/before-release"], ("ppe_a", "1"))
        self.assertEqual(heads["/api/after-release"], (None, None))

    async def test_conflicting_extension_warns(self):
        endpoint = self.start_chrome(extension=True)
        await self.start_service(endpoint)
        a = self.http.a

        # 3. 别的东西把 x-tt-env 改成 ppe_b、删掉 force-workbench：服务器收到的是改后的值，下一次页面动作带警告。
        created = await self.call("tab_new", {"url": a + "/page", "lane": {"headers": LANE}})
        tab = created["targetId"]
        await asyncio.sleep(0.8)
        rows = self.http.take()
        self.report("3 服务器收到的头（有改头扩展）", rows)
        page_rows = [r for r in rows if r["path"] == "/page"]
        self.assertEqual([(r["x-tt-env"], r["force-workbench"]) for r in page_rows], [("ppe_b", None)])
        action = await self.call("page_eval", {"expression": "1"}, tab)
        warning = action.get("laneWarning")
        self.report("3 下一次页面动作里的警告", warning)
        self.assertIsNotNone(warning)
        rows_by_header = {row["header"]: row for row in warning["mismatches"]}
        self.assertEqual((rows_by_header["x-tt-env"]["expected"], rows_by_header["x-tt-env"]["actual"]), ("ppe_a", "ppe_b"))
        self.assertIsNone(rows_by_header["force-workbench"]["actual"])
        self.assertTrue(rows_by_header["x-tt-env"]["sampleUrl"].startswith(a))
        for phrase in ("设的是 ppe_a，实际是 ppe_b", "force-workbench 设的是 1，实际没有带上", "关掉修改这个请求头的插件",
                       "force-workbench=1，x-tt-env=ppe_a"):
            self.assertIn(phrase, warning["text"])
        quiet = await self.call("page_eval", {"expression": "1"}, tab)
        self.assertNotIn("laneWarning", quiet, "数量没变时不该再提醒")

        code, out, err = await self.cli("eval", tab, "--", "fetch('/api/more').then(r=>r.status)", json_mode=False)
        self.report("3 命令行文本输出", {"stdout": out, "stderr": err})
        self.assertEqual(code, 0, err)
        self.assertIn("browser-control 警告：泳道请求头没有按 browser-control 设的值发出去", err)
        await asyncio.sleep(0.3)
        code, out, err = await self.cli("lane", "status")
        status = json.loads(out)
        self.report("3 lane status", status)
        check = status["pages"][0]["check"]
        self.assertGreater(check["mismatched"], 0)
        self.assertEqual(check["matched"], 0)


if __name__ == "__main__":
    unittest.main()
