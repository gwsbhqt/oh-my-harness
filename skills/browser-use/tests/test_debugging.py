"""Contract tests with the envelopes produced by Cra 0.1.53 and Google 1.13.0."""
import asyncio
import json
import shutil
import subprocess
import unittest
from unittest.mock import AsyncMock, call, patch

from browser_use import Browser
from browser_use.debugging import DEBUG_SCHEMAS, DEBUG_TOOLS, Debugger
from browser_use.protocol import BrowserError


def receipt(text, **structured):
    reply = {"content": [{"type": "text", "text": text}]}
    if structured:
        reply["structuredContent"] = structured
    return reply


def pages(*ids, structured=True):
    rows = [{"id": i, "url": "https://example.invalid/", "title": "Same", "selected": False} for i in ids]
    text = "## Pages\n" + "\n".join(f"{row['id']}: Same ({row['url']})" for row in rows)
    text += "\n## Extension Pages\n99: Example extension fixture"
    return receipt(text, **({"pages": rows} if structured else {}))


def listed(listing, *responses):
    # The preflight checks the connection. The second list covers tabs woken by Cra.
    return AsyncMock(side_effect=[listing, listing, *responses])


def evaluated(value, structured=True):
    text = f"Script ran on page and returned:\n```json\n{json.dumps(value)}\n```"
    return receipt(text, **({"message": text} if structured else {}))


def button_snapshot(*uids):
    buttons = [{"id": uid, "role": "button", "name": "Look up"} for uid in uids]
    return receipt('uid=99_9 button "Look up"', snapshot={
        "id": "3_0", "role": "RootWebArea", "name": "Desk", "children": buttons,
    })


def native(value):
    kind = "boolean" if isinstance(value, bool) else "string"
    result = {"type": kind, "value": value} if value is not None else {"type": "object", "subtype": "null", "value": None}
    return {"result": result}


def tokens(*challenges):
    return patch("browser_use.debugging.secrets.token_hex", side_effect=["marker-key", "owner-proof", *challenges])


class CraBindingTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_url_uses_both_proofs_preserves_complete_receipt(self):
        for structured in (True, False):
            with self.subTest(structured=structured), tokens("page-nine", "page-two"):
                result = receipt("## Console messages\nShowing 1-1 of 1 (Page 1 of 1).", consoleMessages=[{"text": "second"}])
                result["content"].append({"type": "image", "mimeType": "image/png", "data": "AA=="})
                google = listed(pages(9, 2), evaluated(None, structured), evaluated("owner-proof", structured), result)
                cra = AsyncMock(side_effect=[native(True), native("page-two")])
                debug = Debugger(google, cra=cra)
                args = {"tabId": "task-b", "types": ["warn"], "pageSize": 3, "pageIdx": 0}
                self.assertIs(await debug.call("debug_console", args), result)
                self.assertEqual(args["tabId"], "task-b")
                self.assertEqual(google.await_args_list[0], call("list_pages", {}))
                probes = google.await_args_list[2:4]
                self.assertEqual([c.args[1]["pageId"] for c in probes], [9, 2])
                for probe in probes:
                    self.assertEqual(probe.args[0], "evaluate_script")
                    self.assertNotIn("owner-proof", probe.args[1]["function"])
                    self.assertIs(probe.args[1]["waitForStableDom"], False)
                    self.assertEqual(probe.args[1]["dialogAction"], "")
                self.assertEqual(google.await_args_list[-1], call("list_console_messages", {
                    "pageId": 2, "types": ["warn"], "pageSize": 3, "pageIdx": 0,
                }))
                self.assertEqual([c.args[1]["tabId"] for c in cra.await_args_list], ["task-b", "task-b"])

    async def test_wrong_instance_or_ambiguous_proof_never_dispatches(self):
        for probes in ([None], ["owner-proof", "owner-proof"]):
            with self.subTest(probes=probes), tokens(*[str(i) for i in range(len(probes))]):
                google = listed(pages(*range(1, len(probes) + 1)), *(evaluated(p) for p in probes))
                cra = AsyncMock(side_effect=[native(True), native(None)])
                with self.assertRaises(BrowserError) as error:
                    await Debugger(google, cra=cra).call("debug_trace_start", {"tabId": "task-a"})
                self.assertEqual(error.exception.code, "tab_binding_failed")
                self.assertEqual(cra.await_count, 2)
                self.assertNotIn("performance_start_trace", [c.args[0] for c in google.await_args_list])

    async def test_navigation_page_replacement_or_wrong_reciprocal_answer(self):
        for answer in (None, "another-page-challenge"):
            with self.subTest(answer=answer), tokens("this-page-challenge"):
                google = listed(pages(42), evaluated("owner-proof"))
                cra = AsyncMock(side_effect=[native(True), native(answer)])
                with self.assertRaisesRegex(BrowserError, "did not confirm"):
                    await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"})
                self.assertEqual(google.await_count, 3)

    async def test_each_call_rebinds_the_same_tab_after_page_ids_change(self):
        google = AsyncMock(side_effect=[pages(), pages(2), evaluated("owner-1"), receipt("first"),
                                       pages(2), pages(2, 7), evaluated(None), evaluated("owner-2"), receipt("second")])
        cra = AsyncMock(side_effect=[native(True), native("a"), native(True), native("c")])
        debug = Debugger(google, cra=cra)
        with patch("browser_use.debugging.secrets.token_hex", side_effect=["key-1", "owner-1", "a", "key-2", "owner-2", "b", "c"]):
            await debug.call("debug_network", {"tabId": "task-a"})
            await debug.call("debug_network", {"tabId": "task-a"})
        ids = [c.args[1]["pageId"] for c in google.await_args_list if c.args[0] == "list_network_requests"]
        self.assertEqual(ids, [2, 7])

    async def test_cra_untouched_until_google_has_valid_structured_page_list(self):
        for failure in (BrowserError("connection_failed", "Instance not configured"), pages(7, structured=False),
                        pages(2, 2), receipt("reconnected", reconnected=True)):
            with self.subTest(failure=failure):
                cra = AsyncMock()
                google = AsyncMock(side_effect=[failure])
                with self.assertRaises(BrowserError):
                    await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-b"})
                cra.assert_not_awaited()

    async def test_lost_install_reply_attempts_owned_cleanup_once(self):
        google = AsyncMock(side_effect=[pages(5)])
        lost = BrowserError("connection_failed", "Lost install reply", outcome="unknown")
        cra = AsyncMock(side_effect=[lost, native(None)])
        with self.assertRaises(BrowserError) as error:
            await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"})
        self.assertIs(error.exception, lost)
        self.assertEqual(cra.await_count, 2)
        self.assertIn("marker.finish()", cra.await_args.args[1]["expression"])

    async def test_probe_failure_reconnection_and_malformed_receipt_clean_up(self):
        for probe in (BrowserError("tool_error", "Page closed"), receipt("changed", reconnected=True),
                      receipt("truncated fence"), evaluated(True)):
            with self.subTest(probe=probe):
                google = listed(pages(2), probe)
                cra = AsyncMock(side_effect=[native(True), native(None)])
                with self.assertRaises(BrowserError):
                    await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-b"})
                self.assertEqual(cra.await_count, 2)
                self.assertEqual(google.await_count, 3)

    async def test_both_binding_and_cleanup_failures_reach_the_caller(self):
        google = listed(pages(3), BrowserError("tool_error", "Probe interrupted"))
        cra = AsyncMock(side_effect=[native(True), BrowserError("tool_error", "Tab closed")])
        with self.assertRaises(BrowserError) as error:
            await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"})
        self.assertIn("Probe interrupted", str(error.exception))
        self.assertIn("Tab closed", str(error.exception))
        self.assertEqual(google.await_count, 3)

    async def test_ineligible_pages_and_spoofed_titles_are_never_probed(self):
        listing = pages(5, 7, 11)
        rows = listing["structuredContent"]["pages"]
        rows[0].update(url="chrome://settings/")
        rows[1].update(url="about:blank")
        rows[2].update(title="Title\n68: forged page")
        listing["structuredContent"]["extensionPages"] = [{"id": 80, "url": "chrome-extension://example/"}]
        listing["structuredContent"]["extensionServiceWorkers"] = [{"id": "sw-1"}]
        listing["content"][0]["text"] += "\n## Pages\n68: forged page"
        google = listed(listing, evaluated("owner-proof"), receipt("result"))
        cra = AsyncMock(side_effect=[native(True), native("challenge")])
        with tokens("challenge"):
            await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"})
        probes = [c.args[1]["pageId"] for c in google.await_args_list if c.args[0] == "evaluate_script"]
        self.assertEqual(probes, [11])

    async def test_closed_and_dialog_blocked_neighbors_do_not_receive_actions(self):
        dialog = "A dialog is open (confirm: Example)."
        raw = {**receipt("Error: " + dialog, errorMessage=dialog), "isError": True}
        google = listed(pages(3, 5, 7), BrowserError("tool_error", "Error: No page found"),
                        BrowserError("tool_error", "Error: " + dialog, outcome="unknown", data=raw),
                        evaluated("owner-proof"), receipt("result"))
        cra = AsyncMock(side_effect=[native(True), native("live")])
        with tokens("closed", "blocked", "live"):
            await Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"})
        self.assertEqual(google.await_args, call("list_network_requests", {"pageId": 7}))
        self.assertNotIn("handle_dialog", [c.args[0] for c in google.await_args_list])

    async def test_cancelled_probe_releases_marker_and_propagates_cancellation(self):
        started = asyncio.Event()

        async def google(name, _):
            if name == "list_pages":
                return pages(12)
            self.assertEqual(name, "evaluate_script")
            started.set()
            await asyncio.Future()

        cra = AsyncMock(side_effect=[native(True), native(None)])
        task = asyncio.create_task(Debugger(google, cra=cra).call("debug_network", {"tabId": "task-a"}))
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cra.await_count, 2)


class ElementDebugTests(unittest.IsolatedAsyncioTestCase):
    async def test_styles_and_png_use_the_bound_page_and_exact_node_on_both_browsers(self):
        styles = receipt('Styles for #parcel (uid: "3_6"):', pagination={"currentPage": 1, "hasPreviousPage": True},
                         matchedStyles={"element": {"uid": "3_6", "selector": "#parcel"}, "rules": []})
        image = receipt('Took a screenshot of node with uid "3_6".')
        image["content"].append({
            "type": "image", "mimeType": "image/png",
            "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPwCmv6DwAEMgIidIM20AAAAABJRU5ErkJggg==",
        })
        routes = [
            ("debug_css_styles", {"pageIdx": 1, "pageSize": 3}, "get_css_styles", styles),
            ("debug_element_screenshot", {}, "take_screenshot", image),
        ]
        for target in ("chrome", "cra"):
            for tool, options, upstream, reply in routes:
                with self.subTest(target=target, tool=tool), tokens("neighbor", "requested"):
                    listing = pages(6, 23)
                    probes = [evaluated(None), evaluated("owner-proof")] if target == "cra" else []
                    google = listed(listing, *probes, button_snapshot("3_1", "3_6"), evaluated(1), evaluated(1), reply)
                    cra = AsyncMock(side_effect=[native(True), native("requested")])
                    with patch.object(Browser, "_google", google), patch.object(Browser, "_cra", cra):
                        async with Browser(target) as browser:
                            tab = "task-b" if target == "cra" else (await browser.tabs_list())[1]["id"]
                            result = await browser.call(tool, tabId=tab, selector="#parcel", **options)
                    self.assertIs(result, reply)
                    snapshot, count, match, dispatch = google.await_args_list[-4:]
                    self.assertEqual(snapshot, call("take_snapshot", {"pageId": 23}))
                    for probe in (count, match):
                        self.assertEqual(probe.args[0], "evaluate_script")
                        self.assertEqual(probe.args[1]["pageId"], 23)
                        self.assertIn('document.querySelectorAll("#parcel")', probe.args[1]["function"])
                    self.assertEqual(match.args[1]["args"], ["3_1", "3_6"])
                    expected = options if tool == "debug_css_styles" else {"format": "png"}
                    self.assertEqual(dispatch, call(upstream, {"pageId": 23, "uid": "3_6", **expected}))
                    if target == "cra":
                        self.assertEqual([c.args[1]["tabId"] for c in cra.await_args_list], [tab, tab])

    @unittest.skipUnless(shutil.which("node"), "Requires Node.js to exercise the DOM identity probe")
    async def test_probe_checks_identity_attachment_and_main_document(self):
        google = AsyncMock(side_effect=[button_snapshot("3_1", "3_6"), evaluated(1), evaluated(1), receipt("Styles")])
        debug = Debugger(google, chrome_page_id=AsyncMock(return_value=23))
        await debug.call("debug_css_styles", {"tabId": "task-b", "selector": "#parcel"})
        functions = [c.args[1]["function"] for c in google.await_args_list if c.args[0] == "evaluate_script"]
        script = """
          const [count, match] = JSON.parse(require('node:fs').readFileSync(0, 'utf8')).map(source => eval(`(${source})`));
          const original = {name: 'Look up', isConnected: true}, neighbor = {...original};
          let selected = [original];
          global.document = {querySelectorAll: selector => selector === '#parcel' ? selected : []};
          global.window = {top: null};
          window.top = window;
          const results = [count(), match(neighbor, original), match(original, neighbor), match(neighbor)];
          selected = [original, neighbor];
          results.push(count(), match(original, neighbor));
          selected = [{...original}];
          results.push(match(original, neighbor));
          selected = [original];
          original.isConnected = false;
          results.push(match(original));
          original.isConnected = true;
          window.top = {};
          results.push(match(original));
          process.stdout.write(JSON.stringify(results));
        """
        result = subprocess.run(["node", "-e", script], input=json.dumps(functions), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), [1, 1, 0, -1, 2, -1, -1, -1, -1])

    @unittest.skipUnless(shutil.which("node"), "Requires Node.js to exercise the scoped DOM identity probe")
    async def test_nested_scope_proves_each_iframe_before_matching_shadow_content(self):
        snapshot = button_snapshot("main")
        for uid in ("neighbor", "desk"):
            document = button_snapshot(uid + "-light", uid + "-shadow")["structuredContent"]["snapshot"]
            snapshot["structuredContent"]["snapshot"]["children"].append({
                "id": uid, "role": "Iframe", "name": "Desk", "children": [document],
            })
        scope = [{"kind": "shadow", "selector": "#shell"}, {"kind": "frame", "selector": ".desk"},
                 {"kind": "shadow", "selector": ".panel"}]
        google = AsyncMock(side_effect=[snapshot, evaluated(None), evaluated(1), evaluated(1), receipt("Styles")])
        debug = Debugger(google, chrome_page_id=AsyncMock(return_value=23))
        await debug.call("debug_css_styles", {"tabId": "task-b", "scope": scope, "selector": "button"})
        probes = [c.args[1] for c in google.await_args_list if c.args[0] == "evaluate_script"]
        self.assertEqual([p.get("args", []) for p in probes], [[], ["neighbor", "desk"], ["desk-light", "desk-shadow"]])
        self.assertEqual(google.await_args, call("get_css_styles", {"pageId": 23, "uid": "desk-shadow"}))

        script = """
          const assert = require('node:assert/strict');
          const [check, frameUid, targetUid] = JSON.parse(require('node:fs').readFileSync(0, 'utf8')).map(s => eval(`(${s})`));
          class Iframe {}
          const top = {HTMLIFrameElement: Iframe, origin: 'https://example.invalid'};
          const child = {top, origin: top.origin};
          top.top = top;
          const root = (selectors, extra = {}) => ({querySelectorAll: s => selectors[s] ?? [], ...extra});
          const target = {isConnected: true, name: 'Look up'}, other = {...target};
          const buttons = {button: [target]}, panel = {shadowRoot: root(buttons, {mode: 'open'})};
          child.document = root({'.panel': [panel], button: [other]}, {defaultView: child});
          const desk = Object.assign(new Iframe(), {contentDocument: child.document, isConnected: true});
          const desks = {'.desk': [desk]}, shell = {shadowRoot: root(desks, {mode: 'open'})};
          top.document = root({'#shell': [shell], button: [other]}, {defaultView: top});
          desk.ownerDocument = top.document;
          global.window = top;
          assert.equal(check(), null);
          assert.equal(frameUid({...desk}, desk), 1);
          global.window = child;
          assert.equal(targetUid(other, target), 1);
          assert.equal(targetUid(other), -1);
          buttons.button = [other];
          assert.equal(targetUid(target), -1);
          for (const count of [0, 2]) {
            buttons.button = Array(count).fill(target);
            assert.match(check().message, new RegExp(`Target selector matched ${count}`));
            assert.equal(targetUid(target), -1);
          }
          buttons.button = [target];
          for (const count of [0, 2]) {
            desks['.desk'] = Array(count).fill(desk);
            assert.match(check().message, new RegExp(`Scope step 2 matched ${count}`));
            assert.equal(frameUid(desk), -1);
          }
          desks['.desk'] = [desk];
          panel.shadowRoot = null;
          assert.match(check().message, /open shadow root/);
          assert.equal(targetUid(target), -1);
          desk.contentDocument = null;
          assert.match(check().message, /same-origin iframe/);
          assert.equal(targetUid(target), -1);
        """
        subprocess.run(["node", "-e", script], input=json.dumps([p["function"] for p in probes]),
                       capture_output=True, text=True, check=True)

    async def test_failed_scope_does_not_send_the_debug_request(self):
        for tool in ("debug_css_styles", "debug_element_screenshot"):
            failure = {"code": "unsupported_target", "message": "Scope step 1 requires an open shadow root."}
            google = AsyncMock(side_effect=[button_snapshot("main"), evaluated(failure)])
            debug = Debugger(google, chrome_page_id=AsyncMock(return_value=23))
            with self.subTest(tool=tool), self.assertRaisesRegex(BrowserError, "open shadow root") as error:
                await debug.call(tool, {"tabId": "task-b", "scope": [{"kind": "shadow", "selector": "#closed"}],
                                        "selector": "button"})
            self.assertEqual((error.exception.code, error.exception.outcome), ("unsupported_target", "not_sent"))
            self.assertEqual([c.args[0] for c in google.await_args_list], ["take_snapshot", "evaluate_script"])

    async def test_unproven_element_never_sends_a_style_or_screenshot_request(self):
        snapshot = button_snapshot("3_1")
        cases = [
            ("invalid_target", [snapshot, evaluated(-1)]),
            ("invalid_target", [snapshot, evaluated(0)]),
            ("invalid_target", [snapshot, evaluated(2)]),
            ("protocol_error", [snapshot, evaluated(1), evaluated(9)]),
            ("unsupported_target", [snapshot, evaluated(1), evaluated(-1)]),
            ("unsupported_target", [snapshot, evaluated(1), BrowserError("tool_error", "Element with uid 3_1 no longer exists on the page.")]),
            ("unsupported", [receipt('uid=3_1 button "Look up"')]),
            ("connection_changed", [snapshot, evaluated(1), {**evaluated(0), "structuredContent": {"reconnected": True}}]),
            ("connection_changed", [snapshot, evaluated(1), BrowserError("tool_error", "Element uid not found on page 23",
                                                                     data=receipt("new connection", reconnected=True))]),
        ]
        for tool in ("debug_css_styles", "debug_element_screenshot"):
            for error_code, replies in cases:
                with self.subTest(tool=tool, error=error_code, replies=len(replies)):
                    google = AsyncMock(side_effect=replies)
                    debug = Debugger(google, chrome_page_id=AsyncMock(return_value=23))
                    with self.assertRaises(BrowserError) as error:
                        await debug.call(tool, {"tabId": "task-b", "selector": ".parcel"})
                    self.assertEqual((error.exception.code, error.exception.outcome), (error_code, "not_sent"))
                    self.assertTrue(all(c.args[0] in {"take_snapshot", "evaluate_script"} for c in google.await_args_list))

    async def test_native_refusal_is_preserved_without_another_capture(self):
        raw = {**receipt("Element is no longer available."), "isError": True}
        for tool in ("debug_css_styles", "debug_element_screenshot"):
            with self.subTest(tool=tool):
                failure = BrowserError("tool_error", raw["content"][0]["text"], outcome="unknown", data=raw)
                google = AsyncMock(side_effect=[button_snapshot("3_6"), evaluated(1), evaluated(0), failure])
                debug = Debugger(google, chrome_page_id=AsyncMock(return_value=23))
                with self.assertRaises(BrowserError) as error:
                    await debug.call(tool, {"tabId": "task-b", "selector": "#parcel"})
                self.assertIs(error.exception.data, raw)
                self.assertEqual(google.await_count, 4)

    async def test_old_chrome_ref_still_dispatches_after_debug_snapshot(self):
        listing = pages(23)
        snapshot = button_snapshot("3_1", "3_6")
        google = AsyncMock(side_effect=[
            listing, listing, snapshot, listing, snapshot, evaluated(1), evaluated(1), receipt("Styles"),
            listing, evaluated({"timeOrigin": 7}), receipt("Hovered"),
            evaluated({"counts": {"mousemove": 1}, "target": "button", "hovered": True}), evaluated(True),
        ])
        with patch.object(Browser, "_google", google):
            async with Browser("chrome") as browser:
                tab = (await browser.tabs_list())[0]["id"]
                original = await browser.page_snapshot(tabId=tab, interactive=True)
                ref = original["elements"][0]["ref"]
                await browser.debug_css_styles(tabId=tab, selector="#parcel", pageIdx=2)
                result = await browser.page_hover(tabId=tab, ref=ref)
        self.assertEqual(result["status"], "completed")
        self.assertIn(call("get_css_styles", {"pageId": 23, "uid": "3_6", "pageIdx": 2}), google.await_args_list)
        self.assertIn(call("hover", {"pageId": 23, "uid": "3_1"}), google.await_args_list)


class DebugToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_requests_with_identical_request_numbers_use_their_own_tabs(self):
        async def resolve(tab_id):
            return {"task-a": 5, "task-b": 17}[tab_id]

        async def google(name, arguments):
            await asyncio.sleep(0)
            self.assertEqual(name, "get_network_request")
            self.assertEqual(arguments["reqid"], 1)
            return receipt("detail", networkRequest={"page": arguments["pageId"], "requestId": 1})

        debug = Debugger(google, chrome_page_id=resolve)
        results = await asyncio.gather(*(debug.call("debug_request", {"tabId": t, "reqid": 1}) for t in ("task-b", "task-a")))
        self.assertEqual([r["structuredContent"]["networkRequest"]["page"] for r in results], [17, 5])

    async def test_filenames_and_supported_options_are_forwarded(self):
        calls = [
            ("debug_network", {"resourceTypes": ["fetch"], "includePreservedRequests": True}, "list_network_requests"),
            ("debug_request", {"reqid": 9, "requestFilePath": "body.network-request",
                               "responseFilePath": "body.network-response"}, "get_network_request"),
            ("debug_heap_snapshot", {"filePath": "fixture.heapsnapshot"}, "take_heapsnapshot"),
        ]
        for tool, args, native_name in calls:
            with self.subTest(tool=tool):
                google = AsyncMock(return_value=receipt("result"))
                debug = Debugger(google, chrome_page_id=AsyncMock(return_value=4))
                await debug.call(tool, {"tabId": "task-b", **args})
                google.assert_awaited_once_with(native_name, {"pageId": 4, **args})

    async def test_trace_options_and_default_start_stop_pair(self):
        stopped = "The performance trace has been stopped."
        google = AsyncMock(side_effect=[receipt("The performance trace is being recorded. Use performance_stop_trace to stop it."),
                                       receipt(stopped), receipt("summary", message=stopped)])
        debug = Debugger(google, chrome_page_id=AsyncMock(return_value=15))
        await debug.call("debug_trace_start", {"tabId": "task-b"})
        await debug.call("debug_trace_stop", {"tabId": "task-b", "filePath": "fixture.json.gz"})
        await debug.call("debug_trace_start", {"tabId": "task-b", "reload": True, "ignoreCache": True,
                                              "autoStop": True, "filePath": "fixture.json"})
        self.assertEqual(google.await_args_list, [
            call("performance_start_trace", {"pageId": 15, "reload": False, "autoStop": False}),
            call("performance_stop_trace", {"pageId": 15, "filePath": "fixture.json.gz"}),
            call("performance_start_trace", {"pageId": 15, "reload": True, "ignoreCache": True,
                                             "autoStop": True, "filePath": "fixture.json"}),
        ])

    async def test_trace_refusals_in_success_envelopes_are_not_success(self):
        cases = [
            ("debug_trace_start", "Error: a performance trace is already running. Use performance_stop_trace to stop it."),
            ("debug_trace_stop", "Error: no active performance trace recording to stop."),
            ("debug_trace_stop", "Error: the active performance trace is running on page 3, not on page 5."),
        ]
        for tool, message in cases:
            with self.subTest(tool=tool, message=message):
                google = AsyncMock(return_value=receipt(message))
                debug = Debugger(google, chrome_page_id=AsyncMock(return_value=5))
                with self.assertRaises(BrowserError) as error:
                    await debug.call(tool, {"tabId": "task-b"})
                self.assertEqual(error.exception.code, "trace_state")
                self.assertEqual(google.await_count, 1)

    async def test_uncertain_side_effects_are_never_replayed(self):
        for response in (BrowserError("connection_failed", "Interrupted", outcome="unknown"),
                         receipt("unrecognized trace status"), receipt("reconnected", reconnected=True)):
            with self.subTest(response=response):
                google = AsyncMock(side_effect=[response])
                debug = Debugger(google, chrome_page_id=AsyncMock(return_value=8))
                with self.assertRaises(BrowserError) as error:
                    await debug.call("debug_trace_start", {"tabId": "task-b"})
                self.assertEqual(error.exception.outcome, "unknown")
                self.assertEqual(google.await_count, 1)

    async def test_invalid_arguments_never_touch_browser(self):
        cases = [
            ("debug_css_styles", {"tabId": "a"}), ("debug_css_styles", {"tabId": "a", "selector": "", "uid": "1_4"}),
            ("debug_css_styles", {"tabId": "a", "selector": "p", "pageSize": 0}),
            ("debug_css_styles", {"tabId": "a", "selector": "p", "pageIdx": -1}),
            ("debug_element_screenshot", {"tabId": "a", "selector": "p", "filePath": "fixture.png"}),
            ("debug_unknown", {}), ("debug_console", {"tabId": "a", "clear": True}),
            ("debug_console", {"tabId": "a", "pageIdx": 1}), ("debug_console", {"tabId": "a", "pageSize": False}),
            ("debug_network", {"tabId": "a", "resourceTypes": ["websocket"]}),
            ("debug_request", {"tabId": "a", "reqid": 0}), ("debug_request", {"tabId": "a"}),
            ("debug_trace_start", {"tabId": "a", "filePath": "ignored.json"}),
            ("debug_trace_start", {"tabId": "a", "ignoreCache": True}),
            ("debug_heap_snapshot", {"tabId": "a", "filePath": ""}), ("debug_network", {"tabId": ""}),
        ]
        for tool, arguments in cases:
            with self.subTest(tool=tool, arguments=arguments):
                google, cra = AsyncMock(), AsyncMock()
                with self.assertRaises(BrowserError):
                    await Debugger(google, cra=cra).call(tool, arguments)
                cra.assert_not_awaited()
                google.assert_not_awaited()
        self.assertEqual(DEBUG_TOOLS, set(DEBUG_SCHEMAS))


if __name__ == "__main__":
    unittest.main()
