"""Input contract checks and optional real Chrome tests on a private loopback fixture."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock

from browser_use.input_actions import INPUT_TOOLS, _changes, _files, _requests, perform, redacted_url
from browser_use.protocol import BrowserError


def response(data, text=""):
    return {"content": [{"type": "text", "text": text}], "structuredContent": data}


class InputContract(unittest.IsolatedAsyncioTestCase):
    async def test_options_refused_before_any_backend_call(self):
        cases = [
            ("page_click", {"ref": "e-a", "button": "right"}),
            ("page_click", {"ref": "e-a", "modifiers": "Control"}),
            ("page_click", {"ref": "e-a", "clickCount": 3}),
            ("page_click", {"ref": "e-a", "selector": "#a"}),
            ("page_click", {"x": 2}), ("page_click", {}),
            ("page_hover", {"x": 2, "y": 8}),
            ("page_fill", {"ref": "e-a", "humanize": True, "text": "x"}),
            ("page_type", {"text": "a\x00b"}),
            ("page_press", {"key": "a", "modifiers": "Shift+Shift"}),
            ("page_press", {"key": "Control+a"}),
            ("page_select", {"ref": "e-a", "value": "a", "label": "b"}),
            ("page_scroll", {"dy": 50}),
        ]
        for name, args in cases:
            with self.subTest(name=name, args=args):
                self.assertIn(name, INPUT_TOOLS)
                control = AsyncMock()
                with self.assertRaises(BrowserError) as caught:
                    await perform(control, name, {"tabId": "tab", **args})
                self.assertEqual(caught.exception.outcome, "not_sent")
                control.page_id.assert_not_awaited()
                control.google.assert_not_awaited()

    async def test_focus_redirect_stops_after_single_click(self):
        control = AsyncMock()
        control.page_id.return_value = 7
        control.uid_for.return_value = "1_4"
        control.google.return_value = response({"message": "Successfully clicked on the element"})
        control.evaluate.side_effect = [
            {"timeOrigin": 42, "focused": False},
            {"code": "input_landing", "error": "Keyboard focus moved away from the original target."},
            True,
        ]
        with self.assertRaises(BrowserError) as caught:
            await perform(control, "page_type", {"tabId": "tab", "ref": "e-a", "text": "sample", "changes": False})
        self.assertEqual((caught.exception.code, caught.exception.outcome), ("input_landing", "unknown"))
        control.google.assert_awaited_once_with("click", {"pageId": 7, "uid": "1_4"})
        control.snapshot.assert_not_awaited()

    async def test_uncertain_write_is_never_replayed(self):
        control = AsyncMock()
        control.page_id.return_value = 3
        control.uid_for.return_value = "2_1"
        control.evaluate.side_effect = [{"timeOrigin": 42, "focused": True}, True]
        control.google.side_effect = BrowserError("connection_failed", "Disconnected during click", outcome="unknown")
        with self.assertRaises(BrowserError) as caught:
            await perform(control, "page_click", {"tabId": "t", "ref": "r", "changes": False})
        self.assertEqual(caught.exception.outcome, "unknown")
        control.google.assert_awaited_once_with("click", {"pageId": 3, "uid": "2_1", "dblClick": False})

    async def test_missing_refs_are_never_retargeted(self):
        control = AsyncMock()
        control.uid_for.side_effect = BrowserError("stale_ref", "Take a fresh snapshot.")
        with self.assertRaisesRegex(BrowserError, "snapshot"):
            await perform(control, "page_click", {"tabId": "t", "ref": "old"})
        control.snapshot.assert_not_awaited()
        control.google.assert_not_awaited()

    async def test_changes_compare_request_ids_and_redact_urls(self):
        control = AsyncMock()
        before = {"title": "Survey", "document": "doc", "elements": [{"ref": "a", "role": "checkbox", "name": "News", "checked": False}]}
        after = {"title": "Result", "document": "doc", "elements": [
            {"ref": "a", "role": "checkbox", "name": "News", "checked": True},
            {"ref": "b", "role": "button", "name": "Finish"},
        ]}
        control.snapshot.return_value = after
        url = "https://example.invalid/save?token=fixture-secret&view=compact#result"
        def item(i, method="POST", status="200"):
            return {"requestId": i, "url": url, "method": method, "status": status}
        control.google.side_effect = [response({"networkRequests": [item(1)]}),
                                      response({"networkRequests": [item(1), item(2), item(3, "GET")]})]
        previous = await _requests(control, 1)
        changes = await _changes(control, 1, before, previous, [])
        self.assertEqual(changes["network"], [{"method": "POST", "status": "200", "url": "https://example.invalid/save?token=…&view=compact"}])
        self.assertEqual(changes["title"], {"from": "Survey", "to": "Result"})
        self.assertEqual(changes["added"], ['button "Finish" b'])
        self.assertIn("checked=false", changes["changed"][0])
        self.assertNotIn("fixture-secret", str(changes))

    async def test_partial_observation_does_not_invent_additions_or_requests(self):
        control = AsyncMock()
        control.snapshot.return_value = {"elements": [{"ref": "b", "name": "Next", "role": "button"}]}
        control.google.return_value = response({"networkRequests": [], "pagination": {"hasNextPage": True}})
        changes = await _changes(control, 1, {"elements": [], "truncated": True}, None, [])
        self.assertNotIn("added", changes)
        self.assertNotIn("network", changes)
        self.assertTrue(changes["incomplete"])
        control.google.return_value = response({}, "## Network requests\nNo requests found.")
        self.assertEqual(await _requests(control, 1), {})
        control.google.return_value = response({}, "Unrecognized network result")
        with self.assertRaises(BrowserError):
            await _requests(control, 1)

    def test_upload_path_boundary_and_url_redaction(self):
        control = type("Local", (), {"local_files": False})()
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "sample.txt"
            sample.write_text("sample", encoding="utf-8")
            link = Path(tmp) / "link.txt"
            link.symlink_to(sample)
            with self.assertRaises(BrowserError):
                _files(control, [str(sample)])
            control.local_files = True
            self.assertEqual(_files(control, [str(sample)]), [{"name": "sample.txt", "size": 6}])
            for invalid in (link, Path(tmp), Path("sample.txt")):
                with self.assertRaises(BrowserError):
                    _files(control, [str(invalid)])
        self.assertEqual(redacted_url("https://guest:sample@example.invalid/a12345678901234567890?key=sample#private"),
                         "https://example.invalid/…?key=…")


_PAGE = b'''<!doctype html><html lang=en><meta charset=utf-8><title>Input fixture</title>
<label>Memo <input id=memo value=xy></label><textarea aria-label=Notes id=notes></textarea>
<label>Route <select id=route><option value=a>North</option><option value=b>South</option></select></label>
<label>Sample files <input id=files type=file multiple></label>
<button id=source draggable=true>Parcel</button><button id=dest>Tray</button>
<button id=save>Save</button><input id=trap aria-label=Redirect><input id=other aria-label=Other>
<input id=mid aria-label="Midway"><button id=twice>Count</button><p role=status id=status></p>
<script>
const el = id => document.getElementById(id);
el('trap').onfocus = () => el('other').focus();
el('mid').oninput = () => el('other').focus();
el('source').ondragstart = e => e.dataTransfer.setData('text/plain', 'sample');
el('dest').ondragover = e => e.preventDefault();
el('dest').ondrop = e => { e.preventDefault(); el('status').textContent = e.dataTransfer.getData('text/plain'); };
el('twice').ondblclick = () => el('status').textContent = 'double';
el('save').onclick = async () => {
  await fetch('/record?token=fixture-secret', {method: 'POST',body: 'example'});
  document.title = 'Saved';
  el('save').replaceWith(Object.assign(document.createElement('button'), {id:'save',textContent:'Saved'}));
};
</script></html>'''


@contextmanager
def input_site():
    posts = []

    class Site(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(_PAGE)

        def do_POST(self):
            posts.append(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Site) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/", posts
        finally:
            server.shutdown()
            thread.join()


class ChromeInputLive(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("BROWSER_USE_LIVE_CHROME"), "Set BROWSER_USE_LIVE_CHROME for the dedicated Chrome fixture")
    def test_native_inputs_and_changes(self):
        from test_browser_live import dedicated_browser
        google = os.environ["BROWSER_USE_LIVE_GOOGLE"]
        with tempfile.TemporaryDirectory() as temp, input_site() as (url, posts):
            directory = Path(temp)
            with dedicated_browser("chrome", os.environ["BROWSER_USE_LIVE_CHROME"], directory) as (endpoint, _):
                asyncio.run(self.check_inputs(endpoint, google, directory, url, posts))

    async def check_inputs(self, endpoint, google, directory, url, posts):
        from browser_use import Browser
        from browser_use.mcp_client import google_command
        command = [*google_command(endpoint, executable=google), f"--workspace={directory}"]
        async with Browser("chrome", endpoint=endpoint, google_command=command, local_files=True) as browser:
            tab = (await browser.tab_open(url=url))["tabId"]
            try:
                await browser.page_wait(tabId=tab, selector="#memo")

                async def value(expression):
                    return (await browser.page_evaluate(tabId=tab, expression=expression))["result"]["value"]

                async def input_(name, **args):
                    return await browser.call(name, tabId=tab, changes=False, **args)

                await input_("page_type", selector="#memo", text="z")
                await input_("page_press", selector="#memo", key="Home")
                await input_("page_type", text="[")
                self.assertEqual(await value("document.querySelector('#memo').value"), "[xyz")
                await input_("page_fill", selector="#notes", text="North\nSouth")
                self.assertEqual(await value("document.querySelector('#notes').value"), "North\nSouth")
                await input_("page_fill", selector="#notes", text="")
                self.assertEqual(await value("document.querySelector('#notes').value"), "")

                with self.assertRaises(BrowserError) as redirected:
                    await input_("page_type", selector="#trap", text="private fixture")
                self.assertEqual(redirected.exception.outcome, "unknown")
                self.assertEqual(await value("document.querySelector('#other').value"), "")
                with self.assertRaises(BrowserError):
                    await input_("page_type", selector="#mid", text="abc")
                self.assertEqual(await value("document.querySelector('#mid').value"), "a")
                self.assertEqual(await value("document.querySelector('#other').value"), "")
                await browser.page_hover(tabId=tab, selector="#twice")
                await input_("page_click", selector="#twice", clickCount=2)
                self.assertEqual(await value("document.querySelector('#status').textContent"), "double")

                shot = await browser.page_screenshot(tabId=tab)
                image = json.loads(shot["content"][-1]["text"])
                box = await value("(() => { const r = document.querySelector('#twice').getBoundingClientRect(); return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]; })()")
                at = await input_("page_click", x=box[0] * image["width"], y=box[1] * image["height"])
                self.assertEqual(at["target"]["tag"], "BUTTON")
                self.assertGreater(at["trustedEvents"].get("click", 0), 0)

                await input_("page_select", selector="#route", label=" south ")
                self.assertEqual(await value("document.querySelector('#route').value"), "b")
                await input_("page_select", selector="#route", value="a")
                self.assertEqual(await value("document.querySelector('#route').value"), "a")
                await input_("page_drag", selector="#source", targetSelector="#dest")
                self.assertEqual(await value("document.querySelector('#status').textContent"), "sample")

                samples = [directory / "first.txt", directory / "second.txt"]
                for i, sample in enumerate(samples):
                    sample.write_text(f"parcel {i}", encoding="utf-8")
                selected = await input_("page_upload", selector="#files", paths=list(map(str, samples)))
                self.assertEqual([f["name"] for f in selected["files"]], [p.name for p in samples])
                self.assertEqual(await value("Promise.all(Array.from(document.querySelector('#files').files, f => f.text()))"),
                                 ["parcel 0", "parcel 1"])

                snapshot = await browser.page_snapshot(tabId=tab)
                ref = next(e["ref"] for e in snapshot["elements"] if e.get("role") == "button" and e.get("name") == "Save")
                saved = await browser.page_click(tabId=tab, ref=ref)
                self.assertEqual(posts, [b"example"])
                changes = saved["changes"]
                self.assertIn({"method": "POST", "url": url + "record?token=…", "status": "204"}, changes["network"])
                self.assertEqual(changes["title"], {"from": "Input fixture", "to": "Saved"})
                self.assertTrue(any('button "Saved"' in line for line in changes["added"]))
                self.assertTrue(any(ref in line for line in changes["removed"]))
                with self.assertRaises(BrowserError):
                    await input_("page_click", ref=ref)
                self.assertEqual(posts, [b"example"])
            finally:
                await browser.tab_close(tabId=tab)


if __name__ == "__main__":
    unittest.main()
