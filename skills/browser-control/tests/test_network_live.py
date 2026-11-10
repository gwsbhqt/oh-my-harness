"""BROWSER_CONTROL_NETWORK_LIVE=1: 独立临时 Chrome + loopback HTTP/WebSocket，不碰用户流量。"""
import base64
import contextlib
import gzip
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from browser_control.cdp import CDP
from browser_control.driver import PageDriver
from browser_control.network import NetworkRecorder


def until(observe, description, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        result = observe()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise AssertionError("等待超时：" + description)
        threading.Event().wait(0.025)


CONSOLE_PAGE = """<!doctype html><title>console fixture</title><script>
function emit(){console.log('first', {a: 1, nested: {b: 2}, list: [1, 2, 3]});
console.warn('careful', 42);console.info('information');console.debug('details');
console.error('broken', new Error('boom'));}
emit();setTimeout(()=>{throw new TypeError('thrown later')},0);</script><body>console</body>"""


class LocalHTTP:
    def __init__(self):
        self.rows = []
        self.lock = threading.Lock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.do_GET()

            def do_GET(self):
                path = urlsplit(self.path).path
                data = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
                row = {"path": self.path, "method": self.command, "body": data,
                       "headers": {k.lower(): v for k, v in self.headers.items()}}
                with fixture.lock:
                    fixture.rows.append(row)
                    count = sum(r["path"] == self.path for r in fixture.rows)
                kind = "application/json; charset=utf-8"
                extra = []
                body = json.dumps({"keep": {"server": "real", "nested": [1, 2]}, "change": "old",
                                   "remove": "gone", "echo": row, "count": count}, ensure_ascii=False).encode()
                if path == "/":
                    kind = "text/html; charset=utf-8"
                    body = b"<!doctype html><title>network local fixture</title><body>local only</body>"
                elif path == "/text":
                    kind = "text/plain; charset=utf-8"
                    body = "original 中文 old unchanged".encode()
                elif path == "/invalid":
                    body = b"this is not JSON"
                elif path == "/binary":
                    kind = "application/octet-stream"
                    body = b"\x00\xff\x10"
                elif path == "/sw.js":
                    kind = "application/javascript"
                    body = b"self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sw-data')e.respondWith(new Response('from-worker',{headers:{'Content-Type':'text/plain'}}))})"
                elif path == "/sw-data":
                    kind = "text/plain"
                    body = b"from-http"
                elif path == "/gzip":
                    body = gzip.compress(body)
                    extra.append(("Content-Encoding", "gzip"))
                status = 200
                if path.startswith("/status/"):
                    status = int(path.rsplit("/", 1)[1])
                elif path == "/console":
                    kind = "text/html; charset=utf-8"
                    body = CONSOLE_PAGE.encode()
                elif path.startswith("/basic"):
                    expected = "Basic " + base64.b64encode(b"fixture-user:right-pass").decode()
                    if self.headers.get("Authorization") != expected:
                        status = 401
                        extra.append(("WWW-Authenticate", 'Basic realm="browser-control-fixture"'))
                        body = b"denied"
                        kind = "text/plain"
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("X-Original", "keep-real-header")
                self.send_header("X-Remove", "remove-me")
                self.send_header("Cache-Control", "max-age=3600" if path == "/cache" else "no-store")
                self.send_header("Content-Length", str(len(body)))
                for name, value in extra:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def matching(self, path):
        with self.lock:
            return [dict(r) for r in self.rows if r["path"] == path]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        if self.thread.is_alive():
            raise AssertionError("HTTP fixture 未停止")


@unittest.skipUnless(os.environ.get("BROWSER_CONTROL_NETWORK_LIVE") == "1", "需显式 BROWSER_CONTROL_NETWORK_LIVE=1 启动独立 Chrome")
class NetworkLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="browser-control-network-live-")
        cls.addClassCleanup(cls.cleanup_temp)
        cls.output = tempfile.TemporaryFile()
        cls.addClassCleanup(cls.output.close)
        cls.process = subprocess.Popen([
            os.environ.get("BROWSER_CONTROL_TEST_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            "--disable-component-update", "--disable-sync", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--user-data-dir=" + cls.temp.name, "about:blank",
        ], stdout=cls.output, stderr=cls.output, start_new_session=True)
        cls.addClassCleanup(cls.stop_browser)
        port_file = Path(cls.temp.name) / "DevToolsActivePort"
        def endpoint():
            if cls.process.poll() is not None:
                cls.output.seek(0)
                raise AssertionError("Chrome 提前退出：" + str(cls.process.returncode) + cls.output.read().decode(errors="replace"))
            if port_file.is_file():
                data = port_file.read_text().splitlines()
                if len(data) >= 2:
                    return "http://127.0.0.1:" + data[0]
        cls.endpoint = until(endpoint, "独立 Chrome DevToolsActivePort")
        with urllib.request.urlopen(cls.endpoint + "/json/version", timeout=3) as response:
            version = json.load(response)
        cls.cdp = CDP(version["webSocketDebuggerUrl"])
        cls.addClassCleanup(cls.cdp.close)
        print("NETWORK_CHROME " + version["Browser"])
        cls.http = LocalHTTP()
        cls.addClassCleanup(cls.http.close)

    @classmethod
    def cleanup_temp(cls):
        path = Path(cls.temp.name)
        cls.temp.cleanup()
        if path.exists():
            raise AssertionError("Chrome 临时目录未清理")
        print("NETWORK_TEMP_CLEANED true")

    @classmethod
    def stop_browser(cls):
        if cls.process.poll() is None:
            with contextlib.suppress(Exception):
                with urllib.request.urlopen(cls.endpoint + "/json/version", timeout=2) as response:
                    close_cdp = CDP(json.load(response)["webSocketDebuggerUrl"])
                try:
                    close_cdp.call("Browser.close", timeout=3)
                finally:
                    close_cdp.close()
        try:
            cls.process.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(cls.process.pid, signal.SIGTERM)
            cls.process.wait(10)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(cls.process.pid, signal.SIGKILL)
        print("NETWORK_CHROME_EXIT " + str(cls.process.returncode))
        if cls.process.returncode != 0:
            raise AssertionError("Chrome 退出非 0：" + str(cls.process.returncode))

    def setUp(self):
        self.target = self.cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.addCleanup(lambda: self.cdp.call("Target.closeTarget", {"targetId": self.target}))
        sid = self.cdp.call("Target.attachToTarget", {"targetId": self.target, "flatten": True})["sessionId"]
        self.driver = PageDriver(self.cdp, self.target, sid)
        self.addCleanup(self.driver.close)
        self.network = NetworkRecorder(self.driver)
        self.driver.network = self.network
        self.driver.dispatch("goto", {"url": self.http.base + "/"})

    def fetch(self, path, options=None):
        script = "fetch(" + json.dumps(path) + "," + json.dumps(options or {}) + ").then(async r=>({status:r.status,headers:Object.fromEntries(r.headers),text:await r.text()}))"
        return self.driver.evaluate(script)

    def test_actual_request_url_method_post_body_headers_and_remove(self):
        self.network.dispatch("route", {"url": self.http.base + "/rewrite", "method": "GET", "rewrite": {
            "url": self.http.base + "/echo", "method": "POST", "postData": "真实中文正文",
            "headers": {"X-Added": "new", "Content-Type": "text/plain;charset=utf-8"}, "removeHeaders": ["X-Remove"]}})
        result = self.fetch("/rewrite", {"headers": {"X-Remove": "secret-fixture", "X-Keep": "yes"}})
        row = json.loads(result["text"])["echo"]
        self.assertEqual(row["path"], "/echo")
        self.assertEqual(row["method"], "POST")
        self.assertEqual(row["body"], "真实中文正文")
        self.assertEqual(row["headers"]["x-added"], "new")
        self.assertEqual(row["headers"]["x-keep"], "yes")
        self.assertNotIn("x-remove", row["headers"])
        self.assertEqual(self.http.matching("/rewrite"), [])
        self.assertEqual(len(self.http.matching("/echo")), 1)
        print("NETWORK_HTTP_REWRITE " + json.dumps(row, ensure_ascii=False))

    def test_actual_response_json_original_preserved_and_gzip(self):
        for path in ("/json", "/gzip"):
            with self.subTest(path=path):
                rule = self.network.dispatch("route", {"url": self.http.base + path, "action": "response_transform", "transform": {
                    "json": {"set": {"/change": "new", "/added": "追加"}, "remove": ["/remove"]},
                    "status": 202, "headers": {"X-Added": "changed"}, "removeHeaders": ["X-Remove"]}})
                result = self.fetch(path)
                body = json.loads(result["text"])
                self.assertEqual(body["keep"], {"server": "real", "nested": [1, 2]})
                self.assertEqual(body["echo"]["path"], path)
                self.assertEqual(body["change"], "new")
                self.assertEqual(body["added"], "追加")
                self.assertNotIn("remove", body)
                self.assertEqual(result["status"], 202)
                self.assertEqual(result["headers"]["x-original"], "keep-real-header")
                self.assertEqual(result["headers"]["x-added"], "changed")
                self.assertNotIn("x-remove", result["headers"])
                self.assertNotIn("content-encoding", result["headers"])
                self.assertEqual(int(result["headers"]["content-length"]), len(result["text"].encode()))
                self.assertEqual(len(self.http.matching(path)), 1)
                print("NETWORK_RESPONSE_ORIGINAL " + json.dumps({"path": path, "body": body, "status": result["status"]}, ensure_ascii=False))
                self.network.dispatch("unroute", {"routeId": rule["routeId"]})

    def test_actual_response_text_and_failure_does_not_deadlock(self):
        self.network.dispatch("route", {"url": self.http.base + "/text", "action": "response_transform", "transform": {
            "text": {"replace": [{"from": "old", "to": "new"}]}}})
        result = self.fetch("/text")
        self.assertEqual(result["text"], "original 中文 new unchanged")
        self.network.dispatch("unroute")
        for path in ("/invalid", "/binary"):
            self.network.dispatch("route", {"url": self.http.base + path, "action": "response_transform", "transform": {"json": {"set": {"/x": 1}}}})
            result = self.driver.evaluate("fetch(" + json.dumps(path) + ").then(()=>({unexpected:true})).catch(e=>({failed:true,error:String(e)}))")
            self.assertTrue(result["failed"])
            self.assertEqual(self.network.dispatch("requests")["pendingPauses"], 0)
            errors = self.network.dispatch("errors")["errors"]
            self.assertTrue(any(e.get("terminalAttempt") == "Fetch.failRequest" and e["outcome"] == "terminated" for e in errors))
            self.assertEqual(self.fetch("/after-failure")["status"], 200)
            self.assertEqual(len(self.http.matching(path)), 1)
            print("NETWORK_FAILURE_TERMINATED " + path)

    def test_file_override_new_document_and_binary(self):
        source = Path(self.temp.name) / "override.html"
        source.write_text("<!doctype html><title>local override</title><script>window.overrideMarker='真实文件'</script><body>overridden</body>")
        rule = self.network.dispatch("override", {"url": self.http.base + "/override", "file": str(source),
                                                "headers": {"Content-Type": "text/html;charset=utf-8"}})
        source.write_text("changed after registration")
        self.driver.dispatch("goto", {"url": self.http.base + "/override"})
        self.assertEqual(self.driver.evaluate("window.overrideMarker"), "真实文件")
        self.assertEqual(self.driver.evaluate("document.title"), "local override")
        self.assertEqual(self.http.matching("/override"), [])
        self.network.dispatch("unoverride", {"routeId": rule["routeId"]})
        self.assertEqual(self.fetch("/override")["status"], 200)
        self.assertEqual(len(self.http.matching("/override")), 1)
        binary = Path(self.temp.name) / "override.bin"
        binary.write_bytes(b"\x00\xff\x01")
        self.network.dispatch("override", {"url": self.http.base + "/file-binary", "file": str(binary),
                                           "headers": {"Content-Type": "application/octet-stream"}})
        value = self.driver.evaluate("fetch('/file-binary').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)))")
        self.assertEqual(value, [0, 255, 1])
        print("NETWORK_FILE_OVERRIDE snapshot document+binary")

    def test_request_post_data_real_cdp_supplement(self):
        self.driver.call("Network.enable", {"maxPostDataSize": 1})
        body = "本地正文" * 100
        result = self.fetch("/post-data", {"method": "POST", "body": body})
        self.assertEqual(json.loads(result["text"])["echo"]["body"], body)
        row = until(lambda: next((r for r in self.network.dispatch("requests", {"filter": "/post-data"})["requests"] if r["finished"]), None), "POST 记录")
        self.assertTrue(row["hasPostData"])
        self.assertIsNone(row["postData"], "fixture 必须真实制造 CDP 事件正文省略")
        detail = self.network.dispatch("request_body", {"id": row["id"]})["request"]
        self.assertTrue(detail["postDataAvailable"])
        self.assertEqual(detail["postData"], body)
        self.assertEqual(len(self.http.matching("/post-data")), 1)
        print("NETWORK_POSTDATA_SUPPLEMENT " + str(len(body.encode())))

    def test_cache_and_service_worker_page_scope(self):
        self.fetch("/cache")
        self.fetch("/cache")
        baseline = len(self.http.matching("/cache"))
        self.assertEqual(baseline, 1)
        self.network.dispatch("cache", {"disabled": True})
        self.fetch("/cache")
        self.fetch("/cache")
        self.assertEqual(len(self.http.matching("/cache")), baseline + 2)
        self.driver.evaluate("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)")
        until(lambda: self.driver.evaluate("!!navigator.serviceWorker.controller"), "本地 SW 控制页面")
        self.assertEqual(self.fetch("/sw-data")["text"], "from-worker")
        self.network.dispatch("service_worker", {"bypass": True})
        self.assertEqual(self.fetch("/sw-data")["text"], "from-http")
        self.network.dispatch("service_worker", {"bypass": False})
        self.assertEqual(self.fetch("/sw-data")["text"], "from-worker")
        self.assertFalse(self.network.dispatch("controls")["priorStateKnown"])
        self.driver.evaluate("navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))")
        print("NETWORK_PAGE_CONTROLS cache=true SW=true priorStateKnown=false")

    def test_page_controls_do_not_affect_other_target(self):
        target = self.cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.addCleanup(lambda: self.cdp.call("Target.closeTarget", {"targetId": target}))
        sid = self.cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        other = PageDriver(self.cdp, target, sid)
        self.addCleanup(other.close)
        other.dispatch("goto", {"url": self.http.base + "/"})
        other.evaluate("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>true)")
        until(lambda: other.evaluate("!!navigator.serviceWorker.controller"), "第二页受本地 SW 控制")
        until(lambda: self.driver.evaluate("!!navigator.serviceWorker.controller"), "第一页受本地 SW 控制")
        self.network.dispatch("service_worker", {"bypass": True})
        self.assertEqual(self.fetch("/sw-data")["text"], "from-http")
        self.assertEqual(other.evaluate("fetch('/sw-data').then(r=>r.text())"), "from-worker")
        other.evaluate("navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))")
        self.fetch("/cache?scope=two-pages")
        self.network.dispatch("cache", {"disabled": True})
        self.fetch("/cache?scope=two-pages")
        before = len(self.http.matching("/cache?scope=two-pages"))
        other.evaluate("fetch('/cache?scope=two-pages').then(r=>r.text())")
        self.assertEqual(len(self.http.matching("/cache?scope=two-pages")), before)
        print("NETWORK_TWO_TARGET_SCOPE SW and cache unaffected on other target")

    def test_real_websocket_bidirectional_frames(self):

        from websockets.sync.server import serve
        def echo(connection):
            for message in connection:
                connection.send("echo:" + message if isinstance(message, str) else bytes([9]) + message)
        server = serve(echo, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown()
            thread.join(5)
            self.assertFalse(thread.is_alive(), "WebSocket fixture 未停止")
        self.addCleanup(stop)
        url = "ws://127.0.0.1:" + str(server.socket.getsockname()[1])
        script = "new Promise((resolve,reject)=>{const s=new WebSocket(" + json.dumps(url) + ");s.binaryType='arraybuffer';s.onopen=()=>s.send('真实帧');s.onmessage=e=>{if(typeof e.data==='string'){window.wsText=e.data;s.send(new Uint8Array([0,255,1]))}else{s.close();resolve({text:window.wsText,binary:Array.from(new Uint8Array(e.data))})}};s.onerror=reject})"
        self.assertEqual(self.driver.evaluate(script), {"text": "echo:真实帧", "binary": [9, 0, 255, 1]})
        result = until(lambda: (r if len(r["frames"]) >= 4 and any(c["closed"] for c in r["connections"]) else None)
                       if (r := self.network.dispatch("ws_frames")) else None, "双向帧与关闭事件")
        frames = result["frames"]
        self.assertTrue(any(f["direction"] == "sent" and f["payloadData"] == "真实帧" for f in frames))
        self.assertTrue(any(f["direction"] == "received" and f["payloadData"] == "echo:真实帧" for f in frames))
        self.assertTrue(all(f["opcode"] in (1, 2) and f["timestamp"] > 0 for f in frames))
        received = next(f for f in frames if f["opcode"] == 2 and f["direction"] == "received")
        self.assertEqual(base64.b64decode(received["payloadData"]), bytes([9, 0, 255, 1]))
        self.assertEqual(received["payloadBytes"], 4)
        self.assertFalse(result["coverage"]["complete"])
        print("NETWORK_WEBSOCKET_FRAMES " + json.dumps(frames, ensure_ascii=False))


class _ChromeFixture:
    setUpClass = NetworkLiveTests.__dict__["setUpClass"]
    cleanup_temp = NetworkLiveTests.__dict__["cleanup_temp"]
    stop_browser = NetworkLiveTests.__dict__["stop_browser"]
    fetch = NetworkLiveTests.fetch

    def setUp(self):
        NetworkLiveTests.setUp(self)


@unittest.skipUnless(os.environ.get("BROWSER_CONTROL_NETWORK_LIVE") == "1", "需显式 BROWSER_CONTROL_NETWORK_LIVE=1 启动独立 Chrome")
class NetworkPhase3LiveTests(_ChromeFixture, unittest.TestCase):
    """控制台、筛选分页、正文落盘、HAR 模式、请求头与 Basic 认证，全部对照本地服务器实际收到的内容。"""

    def setUp(self):
        super().setUp()
        self.driver.browser_owned = True
        self.private = Path(tempfile.mkdtemp(prefix="browser-control-network-artifacts-"))
        os.chmod(self.private, 0o700)
        self.addCleanup(lambda: [p.unlink() for p in self.private.iterdir()] and None or self.private.rmdir())

    def wait_finished(self, needle):
        return until(lambda: next((r for r in self.network.dispatch("requests", {"filter": needle})["requests"]
                                   if r["finished"]), None), "请求完成：" + needle)

    def test_console_ids_detail_expansion_pages_and_navigation(self):
        self.driver.dispatch("goto", {"url": self.http.base + "/console"})
        result = until(lambda: (r if len(r["console"]) >= 5 and self.network.dispatch("errors", {"types": ["exception"]})["errors"] else None)
                       if (r := self.network.dispatch("console", {"include_previous_navigations": False})) else None, "控制台消息")
        messages = result["console"]
        self.assertEqual([m["type"] for m in messages[:5]], ["log", "warning", "info", "debug", "error"])
        first = messages[0]
        self.assertRegex(first["id"], r"^msg-[0-9]+$")
        self.assertTrue(first["url"].endswith("/console"))
        self.assertIsInstance(first["lineNumber"], int)
        self.assertEqual(first["args"][1]["preview"]["properties"][0]["name"], "a")
        self.assertNotIn("objectId", json.dumps(result))
        detail = self.network.dispatch("console_message", {"id": first["id"]})["message"]
        expanded = detail["argsDetail"][1]
        self.assertTrue(expanded["expanded"])
        props = {p["name"]: p for p in expanded["properties"]}
        self.assertEqual(props["a"]["value"]["value"], 1)
        self.assertEqual(props["nested"]["value"]["type"], "object")
        self.assertEqual(detail["argsDetail"][0]["reason"], "primitive_or_no_object")
        self.assertEqual(detail["stackTrace"]["callFrames"][0]["functionName"], "emit")
        exception = self.network.dispatch("errors", {"types": ["exception"]})["errors"][-1]
        self.assertIn("thrown later", exception["text"])
        exception_detail = self.network.dispatch("console_message", {"id": exception["id"]})["message"]
        self.assertTrue(exception_detail["exceptionDetail"]["expanded"])
        warn = self.network.dispatch("console", {"types": ["warn"]})["console"]
        self.assertEqual([m["text"] for m in warn], ["careful 42"])
        page = self.network.dispatch("console", {"page_size": 2})
        rest = self.network.dispatch("console", {"after": page["nextCursor"], "page_size": 100})
        self.assertEqual([m["id"] for m in page["console"] + rest["console"]],
                         [m["id"] for m in self.network.dispatch("console")["console"]])
        navigation = result["navigation"]
        self.driver.dispatch("goto", {"url": self.http.base + "/"})
        stale = self.network.dispatch("console_message", {"id": first["id"]})["message"]["argsDetail"][1]
        self.assertFalse(stale["expanded"])
        self.assertEqual(stale["reason"], "object_unavailable")
        everything = self.network.dispatch("console")["console"]
        self.assertTrue(any(m["navigation"] == navigation for m in everything))
        self.assertEqual(self.network.dispatch("console", {"include_previous_navigations": False})["console"], [])
        print("NETWORK_CONSOLE_DETAIL " + json.dumps({"id": first["id"], "properties": sorted(props), "stale": stale["reason"]}))

    def test_requests_filters_pages_and_navigation(self):
        for path in ("/status/204", "/status/404", "/status/503", "/json"):
            self.fetch(path)
        self.wait_finished("/json")
        ids = lambda params: [urlsplit(r["url"]).path for r in self.network.dispatch("requests", params)["requests"]]
        self.assertEqual(ids({"status": "4xx"}), ["/status/404"])
        self.assertEqual(ids({"status": "500-599"}), ["/status/503"])
        self.assertEqual(ids({"status": 204}), ["/status/204"])
        self.assertEqual(ids({"resource_types": ["document"]}), ["/"])
        self.assertEqual(ids({"resource_types": ["FETCH"]}), ["/status/204", "/status/404", "/status/503", "/json"])
        first = self.network.dispatch("requests", {"page_size": 2})
        second = self.network.dispatch("requests", {"after": first["nextCursor"], "page_size": 2})
        third = self.network.dispatch("requests", {"page": 3, "page_size": 2})
        everything = [r["id"] for r in self.network.dispatch("requests")["requests"]]
        self.assertEqual([r["id"] for r in first["requests"] + second["requests"]], everything[:4])
        self.assertEqual([r["id"] for r in third["requests"]], everything[4:6])
        self.assertEqual(third["pages"], -(-len(everything) // 2))
        before = self.network.dispatch("requests")["navigation"]
        self.driver.dispatch("goto", {"url": self.http.base + "/?second"})
        current = self.network.dispatch("requests", {"include_previous_navigations": False})
        self.assertEqual(current["navigation"], before + 1)
        self.assertEqual(urlsplit(current["requests"][0]["url"]).query, "second")
        self.assertEqual(current["requests"][0]["type"], "Document")
        self.assertTrue(all(r["navigation"] == current["navigation"] for r in current["requests"]))
        self.assertFalse(any(urlsplit(r["url"]).path.startswith("/status/") for r in current["requests"]))
        print("NETWORK_REQUEST_FILTERS ok navigation=" + str(current["navigation"]))

    def test_save_body_and_post_data_bytes_match(self):
        self.driver.evaluate("fetch('/binary').then(r=>r.arrayBuffer()).then(b=>b.byteLength)")
        row = self.wait_finished("/binary")
        target = self.private / "binary.bin"
        artifact = self.network.dispatch("request", {"id": row["id"], "save_body": str(target)})["artifacts"][0]
        self.assertEqual(target.read_bytes(), b"\x00\xff\x10")
        self.assertEqual((artifact["bytes"], artifact["mimeType"]), (3, "application/octet-stream"))
        self.assertEqual(oct(target.stat().st_mode & 0o777), "0o600")
        body = "正文 bytes " * 50
        self.fetch("/post-save", {"method": "POST", "body": body})
        row = self.wait_finished("/post-save")
        saved = self.network.dispatch("request", {"id": row["id"], "save_post_data": str(self.private / "post.bin"),
                                                  "save_body": str(self.private / "reply.json")})["artifacts"]
        self.assertEqual((self.private / "post.bin").read_bytes(), self.http.matching("/post-save")[0]["body"].encode())
        self.assertEqual(json.loads((self.private / "reply.json").read_bytes())["echo"]["body"], body)
        with self.assertRaises(Exception) as error:
            self.network.dispatch("request", {"id": row["id"], "save_body": str(target)})
        self.assertEqual(error.exception.code, 6)
        self.assertEqual(target.read_bytes(), b"\x00\xff\x10")
        self.assertEqual(len(self.http.matching("/post-save")), 1)
        print("NETWORK_SAVE_BODY " + json.dumps([{k: a[k] for k in ("kind", "bytes", "sha256")} for a in saved]))

    def test_har_content_none_text_all(self):
        results = {}
        for mode in ("none", "text", "all"):
            self.network.dispatch("clear")
            self.network.dispatch("har_start", {"content": mode})
            self.fetch("/text?" + mode)
            self.driver.evaluate("fetch('/binary?%s').then(r=>r.arrayBuffer()).then(b=>b.byteLength)" % mode)
            self.wait_finished("/binary?" + mode)
            self.wait_finished("/text?" + mode)
            entries = self.network.dispatch("har_stop")["har"]["log"]["entries"]
            results[mode] = {urlsplit(e["request"]["url"]).path: e["response"]["content"] for e in entries}
        self.assertTrue(all("text" not in c for c in results["none"].values()))
        self.assertEqual(results["text"]["/text"]["text"], "original 中文 old unchanged")
        self.assertNotIn("text", results["text"]["/binary"])
        self.assertEqual(results["all"]["/text"]["text"], "original 中文 old unchanged")
        self.assertEqual(base64.b64decode(results["all"]["/binary"]["text"]), b"\x00\xff\x10")
        self.assertEqual(results["all"]["/binary"]["encoding"], "base64")
        print("NETWORK_HAR_MODES none/text/all verified")

    def test_page_headers_reach_server_and_are_revoked_on_close(self):
        self.network.dispatch("headers_set", {"headers": {"X-Browser-Control-Page": "page-value", "Authorization": "Bearer fixture-token"}})
        state = self.network.dispatch("headers_get")
        self.assertEqual(state["pageHeaders"]["Authorization"], "[REDACTED]")
        self.driver.dispatch("goto", {"url": self.http.base + "/?headers-doc"})
        self.fetch("/echo-page")
        self.assertEqual(self.http.matching("/?headers-doc")[0]["headers"]["x-browser-control-page"], "page-value")
        self.assertEqual(self.http.matching("/echo-page")[0]["headers"]["authorization"], "Bearer fixture-token")
        self.network.dispatch("headers_clear", {"names": ["authorization"]})
        self.fetch("/echo-cleared")
        row = self.http.matching("/echo-cleared")[0]["headers"]
        self.assertEqual(row["x-browser-control-page"], "page-value")
        # 同一临时资料若已通过 Basic 认证，浏览器会自带缓存的 Authorization；这里只核对页面头已撤下。
        self.assertNotEqual(row.get("authorization"), "Bearer fixture-token")
        self.network.close()
        self.assertEqual(self.network.close_errors, [])
        self.fetch("/echo-after-close")
        self.assertNotIn("x-browser-control-page", self.http.matching("/echo-after-close")[0]["headers"])
        print("NETWORK_PAGE_HEADERS server saw then revoked")

    def test_origin_headers_only_for_that_origin(self):
        other = self.http.base.replace("127.0.0.1", "localhost")
        self.network.dispatch("headers_set", {"headers": {"X-Browser-Control-Origin": "only-localhost"}, "origin": other})
        self.network.dispatch("route", {"url": "*/routed", "action": "continue", "headers": {"X-Browser-Control-Route": "r"}})
        self.fetch(other + "/origin-match", {"mode": "no-cors"})
        self.fetch("/origin-miss")
        self.fetch(other + "/routed", {"mode": "no-cors"})
        self.assertEqual(self.http.matching("/origin-match")[0]["headers"]["x-browser-control-origin"], "only-localhost")
        self.assertNotIn("x-browser-control-origin", self.http.matching("/origin-miss")[0]["headers"])
        routed = self.http.matching("/routed")[0]["headers"]
        self.assertEqual((routed["x-browser-control-origin"], routed["x-browser-control-route"]), ("only-localhost", "r"))
        self.network.dispatch("headers_clear", {"origin": other})
        self.fetch(other + "/origin-cleared", {"mode": "no-cors"})
        self.assertNotIn("x-browser-control-origin", self.http.matching("/origin-cleared")[0]["headers"])
        print("NETWORK_ORIGIN_HEADERS scoped")

    def test_basic_auth_401_then_success_and_rejection_not_retried(self):
        # 无凭据时无头 Chrome 会停在登录质询上，所以基线 401 直接向本地服务器核对。
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(self.http.base + "/basic-none", timeout=3)
        self.assertEqual(denied.exception.code, 401)
        denied.exception.close()
        self.network.dispatch("auth_set", {"username": "fixture-user", "password": "wrong-pass", "origin": self.http.base})
        self.assertEqual(self.fetch("/basic-wrong")["status"], 401)
        wrong = self.http.matching("/basic-wrong")
        self.assertEqual(len(wrong), 2, "错误密码只应提交一次")
        state = self.network.dispatch("headers_get")["auth"][0]
        self.assertEqual((state["provided"], state["rejected"]), (1, 1))
        self.network.dispatch("auth_set", {"username": "fixture-user", "password": "right-pass", "origin": self.http.base})
        result = self.fetch("/basic-right")
        self.assertEqual(result["status"], 200)
        statuses = [r["headers"].get("authorization") is not None for r in self.http.matching("/basic-right")]
        self.assertEqual(statuses, [False, True])
        dumped = json.dumps([self.network.dispatch(a, p) for a, p in (("headers_get", {"raw": True}), ("requests", {"raw": True}),
                                                                         ("errors", {}), ("controls", {}))], ensure_ascii=False)
        self.assertNotIn("right-pass", dumped)
        self.assertNotIn(base64.b64encode(b"fixture-user:right-pass").decode(), dumped)
        self.network.dispatch("route", {"url": "*/mocked", "body": "mocked"})
        self.assertEqual(self.fetch("/mocked")["text"], "mocked")
        self.network.dispatch("auth_clear")
        self.assertEqual(self.network.dispatch("headers_get")["auth"], [])
        self.fetch("/basic-after-clear")
        cached = self.http.matching("/basic-after-clear")[0]["headers"].get("authorization")
        print("NETWORK_BASIC_AUTH 401->200 wrong-once browserCacheAfterClear=" + str(cached is not None))


if __name__ == "__main__":
    unittest.main()
