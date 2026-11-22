"""Live acceptance with dedicated browser profiles and a synthetic loopback site.

Set BROWSER_USE_LIVE_CHROME to a Chrome executable, BROWSER_USE_LIVE_CRA to
an official Cra executable, and BROWSER_USE_LIVE_GOOGLE to the installed
chrome-devtools-mcp executable. Each selected backend gets a fresh profile;
leaving both browser variables unset skips these tests. From the skill root:

    PYTHONPATH=src python -m unittest discover -s tests -p test_browser_live.py -v
"""

from __future__ import annotations

import asyncio
import base64
from contextlib import AsyncExitStack, contextmanager
import errno
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit


HTML = """<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Parcel lookup</title>
<style>
button { width: 90px; }
form button { box-sizing: border-box; width: __WIDTH__px; height: 36px; }
body { position: relative; min-height: 1650px; }
body::after { content: ''; position: absolute; left: 0; bottom: 0; width: 60px; height: 30px; background: #257; }
body.received::after { background: #fd3; }
</style>
<h1>Parcel lookup</h1><p>Desk __DESK__</p>
<form><label>Parcel name <input name="parcel" autocomplete="off"></label>
<button>Look up</button></form><output aria-live="polite"></output>
<button id="samples">Load samples</button><output id="sample-result"></output>
<script>
let sampleCount = 0;
document.querySelector('#samples').onclick = async function loadSamples() {
  const sequence = ++sampleCount;
  const reply = await fetch('/fixture/items');
  const data = await reply.json();
  const result = reply.ok ? (data.items.join(',') || 'empty') : `HTTP ${reply.status}`;
  document.querySelector('#sample-result').textContent = `Sample ${sequence}: ${result}`;
  if (!reply.ok) console.error('Sample lookup failed', reply.status);
};
const form = document.querySelector('form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const parcel = form.elements.parcel.value;
  const reply = await fetch('/lookup/' + encodeURIComponent(parcel), {
    method: 'POST', body: '__DESK__'
  });
  const receipt = await reply.text();
  window.fixtureReceipt = receipt;
  document.querySelector('output').textContent = receipt;
  console.info(receipt);
  document.body.classList.add('received');
  performance.mark(receipt);
  const oldButton = form.querySelector('button');
  oldButton.replaceWith(oldButton.cloneNode(true));
});
</script></html>"""


@contextmanager
def parcel_site():
    desks = []
    submissions = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, body, content_type):
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/fixture/items":
                self.reply(b'{"items":["original"]}', "application/json")
                return
            if self.path != "/parcels":
                self.send_error(404)
                return
            with lock:
                desk = str(len(desks) + 1)
                desks.append(desk)
            page = HTML.replace("__DESK__", desk).replace("__WIDTH__", str(120 + int(desk)))
            self.reply(page.encode(), "text/html")

        def do_POST(self):
            match = re.fullmatch(r"/lookup/([a-z-]+)", self.path)
            if not match:
                self.send_error(400)
                return
            desk = self.rfile.read(int(self.headers["Content-Length"])).decode()
            parcel = match[1]
            with lock:
                submissions.append((desk, parcel))
            self.reply(f"Receipt {parcel} at desk {desk}".encode(), "text/plain")

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/parcels", submissions
        finally:
            server.shutdown()
            worker.join()


@contextmanager
def dedicated_browser(backend, executable, directory):
    profile = directory / "profile"
    profile.mkdir()
    args = [executable, "--remote-debugging-port=0", "--disable-background-networking",
            "--no-first-run", "--no-default-browser-check", "--use-mock-keychain"]
    env = os.environ.copy()
    command_file = directory / "commands"
    native_socket = profile / "mcp.sock"
    port_file = (profile / "Chromium" if backend == "cra" else profile) / "DevToolsActivePort"
    cra_command = None
    if backend == "cra":
        # Cra's upstream live tests use these launch-only settings and a short socket path.
        with (Path(executable).resolve().parents[1] / "Info.plist").open("rb") as info:
            version = plistlib.load(info)["CFBundleShortVersionString"]
        if version != "0.1.53":
            raise ValueError(f"Expected Cra 0.1.53 for this suite, received {version}")
        settings = {"hasSeenImportPrompt": True, "toolbarDefaultMigrated": True}
        (profile / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
        command_file.touch()
        env.update(CRA_DATA_DIR=str(profile), CRA_TEST_BACKGROUND="1",
                   CRA_COMMAND_FILE=str(command_file), CRA_AGENT_CONFIG_HOME=str(directory))
        args.extend(["-mcpEnabled", "YES", "-mcpApprovesAgents", "YES",
                     "-mcpAllowsScripts", "YES"])
        cra_command = [executable, "--mcp", str(native_socket)]
    else:
        args.extend(["--headless", "--disable-extensions", "--disable-sync",
                     f"--user-data-dir={profile}", "about:blank"])

    with (directory / "startup.log").open("wb") as log:
        process = subprocess.Popen(args, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"{backend} exited during startup ({process.returncode})")
                if port_file.is_file() and (backend != "cra" or native_socket.is_socket()):
                    lines = port_file.read_text(encoding="ascii").splitlines()
                    if len(lines) == 2 and lines[0].isdigit():
                        break
                time.sleep(0.1)
            else:
                raise TimeoutError(f"{backend} did not expose its test debugging endpoint")
            yield f"http://127.0.0.1:{int(lines[0])}", cra_command
        finally:
            if process.poll() is None:
                if backend == "cra":
                    with command_file.open("a", encoding="utf-8") as stream:
                        stream.write("cra://debug?quit=1\n")
                else:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise RuntimeError(f"{backend} required a forced shutdown")


class LiveAcceptance(unittest.TestCase):
    def test_chrome(self):
        self.run_backend("chrome")

    def test_cra(self):
        self.run_backend("cra")

    def run_backend(self, backend):
        setting = f"BROWSER_USE_LIVE_{backend.upper()}"
        executable = os.environ.get(setting)
        if not executable:
            self.skipTest(f"Set {setting} to run this backend with a temporary profile")
        google = os.environ.get("BROWSER_USE_LIVE_GOOGLE")
        self.assertTrue(google, "Set BROWSER_USE_LIVE_GOOGLE to chrome-devtools-mcp 1.13.0")
        from browser_use.mcp_client import google_command

        # Native Cra's Unix socket has a 104-byte path limit on macOS.
        temp_parent = "/tmp" if backend == "cra" else None
        with tempfile.TemporaryDirectory(prefix="bu-live-", dir=temp_parent) as tmp:
            directory = Path(tmp)
            with dedicated_browser(backend, executable, directory) as (endpoint, cra_argv):
                google_argv = [*google_command(endpoint, executable=google), f"--workspace={directory}"]
                with parcel_site() as (url, submissions):
                    asyncio.run(self.check_session(backend, endpoint, cra_argv, google_argv,
                                                   directory, url, submissions))
            with socket.socket() as probe:
                probe.settimeout(1)
                self.assertEqual(probe.connect_ex(("127.0.0.1", urlsplit(endpoint).port)),
                                 errno.ECONNREFUSED)
            if backend == "cra":
                self.assertFalse((directory / "profile" / "mcp.sock").exists())

    async def element_ref(self, browser, tab, role, name):
        snapshot = await browser.page_snapshot(tabId=tab)
        self.assertFalse(snapshot["truncated"])
        matches = [e["ref"] for e in snapshot["elements"]
                   if e.get("role") == role and e.get("name") == name]
        self.assertEqual(len(matches), 1, (role, name, matches))
        return matches[0]

    async def check_test_responses(self, browser, first, second, url):
        api = url.removesuffix("/parcels") + "/fixture/items"

        async def load(tab, expected):
            button = await self.element_ref(browser, tab, "button", "Load samples")
            await browser.page_click(tabId=tab, ref=button)
            await browser.page_wait(tabId=tab, text=expected)

        for status, body, expected in [(200, {"items": []}, "Sample 1: empty"),
                                       (500, {"error": "fixture"}, "Sample 3: HTTP 500")]:
            result = await browser.debug_mock_json(tabId=first, url=api, json=body, status=status)
            self.assertEqual(result["structuredContent"]["hits"], 0)
            try:
                await load(first, expected)
                observed = (await browser.debug_mock_status(tabId=first))["structuredContent"]
                self.assertEqual([observed[k] for k in ("hits", "errors", "served")], [1, 0, 1])
                if status == 200:
                    await load(second, "Sample 1: original")
            finally:
                await browser.debug_mock_clear(tabId=first)
            if status == 200:
                await load(first, "Sample 2: original")
        await load(first, "Sample 4: original")
        errors = await browser.debug_console(tabId=first, types=["error"])
        error = next(m for m in errors["structuredContent"]["consoleMessages"] if "Sample lookup failed" in m["text"])
        detail = (await browser.debug_console_message(tabId=first, msgid=error["id"]))["structuredContent"]["consoleMessage"]
        self.assertIn("loadSamples", detail["stackTrace"])

        localhost_url = url.replace("127.0.0.1", "localhost")
        temporary = (await browser.tab_open(url=localhost_url))["tabId"]
        try:
            await browser.page_wait(tabId=temporary, text="Parcel lookup")
            localhost_api = localhost_url.removesuffix("/parcels") + "/fixture/items"
            await browser.debug_mock_json(tabId=temporary, url=localhost_api, json={"items": []})
            await load(temporary, "Sample 1: empty")
            await browser.page_navigate(tabId=temporary, url=url)
            await browser.page_wait(tabId=temporary, text="Parcel lookup")
            for action in (browser.debug_mock_status, browser.debug_mock_clear):
                self.assertEqual((await action(tabId=temporary))["structuredContent"]["state"], "absent")
            await load(temporary, "Sample 1: original")
        finally:
            await browser.tab_close(tabId=temporary)

    async def check_session(self, backend, endpoint, cra_argv, google_argv, directory, url, submissions):
        from browser_use import Browser, BrowserError

        async with Browser(backend, endpoint=endpoint, cra_command=cra_argv,
                           google_command=google_argv) as browser:
            before = {t["id"] for t in await browser.tabs_list()}
            tabs = []
            desks = {}
            parcels = ("amber-fox", "violet-hare")
            receipts = {}
            async with AsyncExitStack() as owned:
                for parcel in parcels:
                    tab = (await browser.tab_open(url=url))["tabId"]
                    owned.push_async_callback(browser.tab_close, tabId=tab)
                    self.assertNotIn(tab, before | set(tabs))
                    tabs.append(tab)
                    await browser.page_wait(tabId=tab, text="Parcel lookup")
                    page = await browser.page_read(tabId=tab)
                    desk = re.search(r"\bDesk (\d+)\b", page["text"])
                    self.assertIsNotNone(desk, page["text"])
                    desks[tab] = desk[1]
                    receipts[tab] = f"Receipt {parcel} at desk {desk[1]}"
                self.assertNotEqual(desks[tabs[0]], desks[tabs[1]])
                rows = {t["id"]: t for t in await browser.tabs_list()}
                self.assertEqual([rows[t]["url"] for t in tabs], [url, url])
                self.assertEqual([rows[t]["title"] for t in tabs], ["Parcel lookup"] * 2)

                for tab, parcel in zip(tabs, parcels):
                    box = await self.element_ref(browser, tab, "textbox", "Parcel name")
                    await browser.debug_network(tabId=tab)
                    await browser.debug_console(tabId=tab)
                    expected_width = 120 + int(desks[tab])
                    styles = await browser.debug_css_styles(tabId=tab, selector="form button")
                    rules = styles["structuredContent"]["matchedStyles"]["rules"]
                    widths = {(rule["source"], prop["value"], prop["status"])
                              for rule in rules if rule.get("source", "").startswith("parcels:")
                              for prop in rule["properties"] if prop["name"] == "width"}
                    self.assertEqual(widths, {("parcels:4", "90px", "overloaded"),
                                              ("parcels:5", f"{expected_width}px", "active")})
                    image = await browser.debug_element_screenshot(tabId=tab, selector="form button")
                    blocks = [b for b in image["content"] if b.get("type") == "image"]
                    self.assertEqual(len(blocks), 1)
                    self.assertEqual(blocks[0]["mimeType"], "image/png")
                    png = base64.b64decode(blocks[0]["data"], validate=True)
                    self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
                    width, height = struct.unpack(">II", png[16:24])
                    self.assertGreater(height, 0)
                    self.assertAlmostEqual(width / height, expected_width / 36, places=2)
                    await browser.page_fill(tabId=tab, ref=box, text=parcel)

                first, second = tabs
                await self.check_test_responses(browser, first, second, url)
                baseline = directory / "before.png"
                before_image = await browser.debug_full_page_screenshot(tabId=first, filePath=str(baseline))
                self.assertGreater(before_image["structuredContent"]["height"], 1600)
                self.assertEqual(before_image["structuredContent"]["path"], str(baseline))
                button = await self.element_ref(browser, first, "button", "Look up")
                trace = directory / "parcel-trace.json.gz"
                await browser.debug_trace_start(tabId=first)
                try:
                    await browser.page_click(tabId=first, ref=button)
                    await browser.page_wait(tabId=first, text=receipts[first])
                finally:
                    await browser.debug_trace_stop(tabId=first, filePath=str(trace))
                with gzip.open(trace, "rt", encoding="utf-8") as trace_file:
                    events = json.load(trace_file)["traceEvents"]
                self.assertTrue(any(event.get("name") == receipts[first] for event in events))

                updated, difference = directory / "after.png", directory / "difference.png"
                await browser.debug_full_page_screenshot(tabId=first, filePath=str(updated))
                change = await browser.compare_screenshots(baseline=str(baseline), current=str(updated),
                                                           output=str(difference))
                self.assertGreater(change["changedPixels"], 0)
                self.assertGreater(change["bounds"]["y"] + change["bounds"]["height"], 1600)
                self.assertTrue(difference.is_file())
                with self.assertRaises(BrowserError) as existing:
                    await browser.debug_full_page_screenshot(tabId=first, filePath=str(baseline))
                self.assertEqual(existing.exception.code, "output_exists")

                # A successful lookup replaced the button with an identical new node.
                with self.assertRaises(BrowserError):
                    await browser.page_click(tabId=first, ref=button)
                fresh = await self.element_ref(browser, first, "button", "Look up")
                self.assertNotEqual(fresh, button)
                second_button = await self.element_ref(browser, second, "button", "Look up")
                await browser.page_click(tabId=second, ref=second_button)
                await browser.page_wait(tabId=second, text=receipts[second])

                for index, tab in enumerate(tabs):
                    receipt, other = receipts[tab], receipts[tabs[1 - index]]
                    text = (await browser.page_read(tabId=tab))["text"]
                    self.assertIn(receipt, text)
                    self.assertNotIn(other, text)
                    log = (await browser.debug_console(tabId=tab))["structuredContent"]
                    messages = [m["text"] for m in log["consoleMessages"]]
                    self.assertIn(receipt, messages)
                    self.assertNotIn(other, messages)
                    msgid = next(m["id"] for m in log["consoleMessages"] if m["text"] == receipt)
                    message = await browser.debug_console_message(tabId=tab, msgid=msgid)
                    self.assertEqual(message["structuredContent"]["consoleMessage"]["text"], receipt)
                    network = (await browser.debug_network(tabId=tab))["structuredContent"]
                    queries = [r for r in network["networkRequests"] if r["method"] == "POST"]
                    expected_url = url.removesuffix("/parcels") + "/lookup/" + parcels[index]
                    self.assertEqual([r["url"] for r in queries], [expected_url])
                    self.assertEqual(queries[0]["status"], "200")
                    result = await browser.debug_request(tabId=tab, reqid=queries[0]["requestId"])
                    detail = result["structuredContent"]["networkRequest"]
                    self.assertEqual(detail["url"], expected_url)
                    self.assertEqual(detail["requestBody"], desks[tab])
                    self.assertEqual(detail["responseBody"], receipt)

                heap = directory / "parcel.heapsnapshot"
                await browser.debug_heap_snapshot(tabId=second, filePath=str(heap))
                with heap.open(encoding="utf-8") as heap_file:
                    snapshot = json.load(heap_file)
                self.assertTrue(snapshot["nodes"])
                self.assertIn(receipts[second], snapshot["strings"])
                self.assertNotIn(receipts[first], snapshot["strings"])
                self.assertCountEqual(submissions, [(desks[t], p) for t, p in zip(tabs, parcels)])

            after = {t["id"] for t in await browser.tabs_list()}
            self.assertTrue(before <= after)
            self.assertTrue(set(tabs).isdisjoint(after))

        with self.assertRaises(BrowserError) as closed:
            await browser.tabs_list()
        self.assertEqual(closed.exception.code, "session_closed")


if __name__ == "__main__":
    unittest.main()
