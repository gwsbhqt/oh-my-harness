"""只使用独立 fixture，不连接日常浏览器。"""
import asyncio
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import browser_control
from browser_control.client import Client, validate_context
from browser_control.server import source_fingerprint




class ExtendedApiTests(unittest.IsolatedAsyncioTestCase):
    def login_fixture(self):
        page = browser_control.page("p", session="s", browser="Arc", host="local")
        page.page_info = unittest.mock.AsyncMock(side_effect=[{"url": "https://fixture/login"},
                                                             {"url": "https://fixture/home", "title": "home"}])
        page.click = unittest.mock.AsyncMock()
        window = {"id": 12, "pid": 34, "startedAt": 56.0, "bundleId": "company.thebrowser.Browser"}
        cu = unittest.mock.Mock()
        cu.windows = unittest.mock.AsyncMock(return_value={"windows": [window | {"isFrontmost": True, "isFocused": True}]})
        cu.autofill = unittest.mock.AsyncMock(return_value={"clicked": "fixture-account"})
        cu.ComputerControlError = RuntimeError
        return page, window, cu

    async def test_login_requires_window_before_touching_page(self):
        page = browser_control.page("p", session="s", host="local")
        page.page_info = unittest.mock.AsyncMock()
        page.click = unittest.mock.AsyncMock()
        with self.assertRaises(browser_control.BrowserControlError):
            await browser_control.login(page)
        page.page_info.assert_not_called()
        page.click.assert_not_called()

    async def test_login_passes_explicit_window_to_native_autofill(self):
        page, window, cu = self.login_fixture()
        with patch.object(browser_control.deps, "computer_control", return_value=cu):
            result = await browser_control.login(page, native_window=window)
        self.assertTrue(result["loggedIn"])
        cu.autofill.assert_awaited_once_with("Arc", account=None, host="local", window=window)

    async def test_login_rejects_background_before_touching_page(self):
        page, window, cu = self.login_fixture()
        cu.windows.return_value = {"windows": [window | {"isFrontmost": False, "isFocused": True}]}
        with patch.object(browser_control.deps, "computer_control", return_value=cu):
            with self.assertRaises(browser_control.BrowserControlError) as raised:
                await browser_control.login(page, native_window=window)
        self.assertEqual(raised.exception.code, 4)
        self.assertEqual(raised.exception.outcome, "not_sent")
        page.click.assert_not_called()
        page.page_info.assert_not_called()

    async def test_login_preserves_native_unknown_without_replay(self):
        class NativeFailure(Exception):
            code, outcome, data = 4, "unknown", {"stage": "input"}
        page, window, cu = self.login_fixture()
        cu.ComputerControlError = NativeFailure
        cu.autofill.side_effect = NativeFailure("focus changed after input")
        with patch.object(browser_control.deps, "computer_control", return_value=cu):
            with self.assertRaises(browser_control.BrowserControlError) as raised:
                await browser_control.login(page, native_window=window)
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertEqual(raised.exception.data, {"stage": "input"})
        cu.autofill.assert_awaited_once()
        self.assertEqual(page.page_info.await_count, 1)

    async def test_shared_window_never_restarts_or_clones_and_window_stays_page_scoped(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params, context))
            return {"targetId": "task-page", "owned": True, "mode": "attach"}
        with patch.object(browser_control, "_rpc", rpc):
            page = await browser_control.open_window(browser="Arc", host="local", session="task",
                                                 source_target="human-page")
            await page.window()
        self.assertEqual(calls[0][0], "tab_new")
        self.assertEqual({key: calls[0][1][key] for key in ("mode", "restart", "fallback", "new_window", "source_target")},
                         {"mode": "attach", "restart": "never", "fallback": "never",
                          "new_window": True, "source_target": "human-page"})
        self.assertEqual(calls[1][0], "tab_window")
        self.assertEqual(calls[1][2]["target"], "task-page")
        self.assertEqual(calls[1][2]["session"], "task")
        self.assertEqual(calls[1][2]["browser"], "Arc")


    async def test_recover_bypasses_bind_and_invalidates_snapshot(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, context))
            return {"owned": True, "recovered": True}
        with patch.object(browser_control, "_rpc", rpc):
            page = browser_control.page("original", browser="Chrome", host="local", session="mine")
            page.snapshot = "stale"
            self.assertTrue((await page.recover())["recovered"])
            self.assertIsNone(page.snapshot)
            self.assertTrue(page._bound)
            self.assertTrue(page.owned)
        self.assertEqual([c[0] for c in calls], ["tab_recover"])
        self.assertEqual(calls[0][1]["target"], "original")

    async def test_diff_mode_and_chrome_creation_options(self):
        async def rpc(action, params=None, **kwargs):
            if action == "tab_new":
                self.assertEqual(params["lane"], {"env":"test"})
                self.assertEqual(params["executable"], "/fixture/Chrome")
                self.assertFalse(params["headed"])
                return {"targetId":"new"}
            if action == "page_snap":
                return {"mode":"snap", "snapshot":"s", "elements":[]}
            return {}
        with patch.object(browser_control, "_rpc", rpc):
            page = await browser_control.open_page(browser="Chrome", lane="test", executable="/fixture/Chrome")
            self.assertIsInstance(await page.snap(diff=True), browser_control.Snap)
            self.assertEqual(page.browser, "Chrome")

    async def test_lane_status_without_page_and_warning_on_value_functions(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params, context))
            if action == "page_read":
                return {"text": "正文", "laneWarning": {"text": "泳道请求头没有按 browser-control 设的值发出去", "mismatches": []}}
            return {"pages": []}
        with patch.object(browser_control, "_rpc", rpc):
            self.assertEqual(await browser_control.lane_status(session="mine"), {"pages": []})
            self.assertNotIn("target", calls[-1][2])
            page = browser_control.page("exact", session="mine")
            page._bound = True
            page.snapshot = "s"
            with self.assertWarns(browser_control.LaneWarning):
                self.assertEqual(await page.read(1), "正文")
        self.assertEqual(sum(c[0] == "lane_status" for c in calls), 1)

    async def test_download_and_network_namespace(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params, context))
            return {}
        with patch.object(browser_control, "_rpc", rpc):
            page = browser_control.page("exact")
            await page.download(action="wait", guid="g", timeout=12)
            await page.popups()
            await page.network.request("request-1", body=True)
            await page.network.unroute("route-1")
            await page.lane.set("test")
        self.assertEqual(calls[-1][1], {"env":"test"})
        self.assertEqual(calls[-2][1], {"routeId":"route-1"})
        self.assertEqual(calls[-3][1], {"id":"request-1", "body":True})
        self.assertEqual(calls[1][2]["timeout"], 17)


class ExtendedClientTests(unittest.TestCase):
    def fixture(self, responder):
        return ClientTests.fixture(self, responder)
    def test_response_timeout_does_not_replay(self):
        # 超时预算里还包括版本核对和连接，留够时间让请求一定发出；服务端一直不回，直到客户端放弃。
        received, release = threading.Event(), threading.Event()
        def responder(conn, data):
            received.set()
            release.wait(5)
        client, calls = self.fixture(responder)
        self.addCleanup(release.set)
        with self.assertRaises(browser_control.BrowserControlError) as raised:
            client.call("page_click", {"id":"x"}, target="exact", timeout=.5)
        release.set()
        self.assertTrue(received.is_set())
        self.assertEqual(raised.exception.code, 4)
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertEqual(len(calls), 1)

    def test_custom_directory_permissions_not_mutated(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o755)
            with self.assertRaises(browser_control.BrowserControlError) as raised:
                Client(Path(directory)/"rpc.sock", autostart=False).call("status")
            self.assertEqual(raised.exception.code, 5)
            self.assertEqual(os.stat(directory).st_mode & 0o777, 0o755)

    def test_invalid_socket_path_not_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"rpc.sock"
            path.write_text("fixture")
            with self.assertRaises(browser_control.BrowserControlError):
                Client(path, autostart=False).call("status")
            self.assertEqual(path.read_text(), "fixture")




class StartupTests(unittest.TestCase):
    def test_concurrent_clients_start_exactly_one_service(self):
        import concurrent.futures
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"rpc.sock"
            calls, processes, errors = [], [], []
            ready = threading.Event()
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            def launch(*args, **kwargs):
                processes.append(args)
                listener.bind(str(path))
                listener.listen()
                ready.set()
                class Process:
                    def poll(self):
                        return None
                return Process()
            def serve():
                ready.wait(2)
                while len(calls) < 2:
                    try:
                        with listener.accept()[0] as conn:
                            line = conn.makefile("rb").readline()
                            if not line:
                                continue
                            data = json.loads(line)
                            if data.get("action") == "service":
                                conn.sendall((json.dumps({"ok": True, "result": {"fingerprint": source_fingerprint(), "pid": 1, "startedAt": 0, "draining": False, "holdings": []}}) + "\n").encode())
                                continue
                            calls.append(data)
                            conn.sendall(b'{"ok":true,"result":{"ready":true}}\n')
                    except OSError as exc:
                        errors.append(str(exc))
            with patch("browser_control.client.subprocess.Popen", launch), patch.object(Path, "is_file", return_value=True):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(Client(path).call, "status") for _ in range(2)]
                    worker = threading.Thread(target=serve)
                    worker.start()
                    try:
                        self.assertEqual([f.result(timeout=2) for f in futures], [{"ready":True}]*2)
                    finally:
                        worker.join(timeout=2)
                        listener.close()
            self.assertEqual(len(processes), 1)
            self.assertEqual(len(calls), 2)
            self.assertEqual(errors, [])
            self.assertFalse(worker.is_alive())


class StateTests(unittest.TestCase):
    def test_import_internal_driver_preserves_public_page_factory(self):
        import importlib
        factory = browser_control.page
        driver = importlib.import_module("browser_control.driver")
        self.assertTrue(hasattr(driver, "PageDriver"))
        self.assertIs(browser_control.page, factory)
        self.assertTrue(callable(browser_control.page))
        self.assertEqual(browser_control.page("exact").target_id, "exact")

    def test_snap_queries_tree_and_diff(self):
        snap = browser_control.Snap(dict(snapshot="s", elements=[
            dict(idx=1, role="group", label="", parent=2),
            dict(idx=2, role="button", label="提交", id="send", value=None, parent=1, actions=["Press"]),
            dict(idx=3, role="textbox", label="搜索", value="hello", parent=2)]))
        self.assertEqual(snap.one(id="send")["idx"], 2)
        self.assertEqual(snap.find(role="AXButton", action="AXPress")[0]["idx"], 2)
        self.assertEqual(snap.find(contains="hello")[0]["idx"], 3)
        self.assertEqual(snap.children(2)[1]["idx"], 3)
        self.assertIn("提交", snap.tree())  # cycle does not hang
        self.assertIn("#send", snap.table())
        self.assertFalse(browser_control.Diff(dict(changed=False)))
        with self.assertRaises(LookupError):
            snap.one(label="missing")
        for flag in ("truncated", "timedOut"):
            partial = browser_control.Snap(dict(snapshot="s", elements=[dict(idx=1, role="button", label="提交", id="send")], **{flag: True}))
            self.assertEqual(len(partial.find(id="send")), 1)
            with self.assertRaises(LookupError):
                partial.one(id="send")

    def test_context_refuses_remote_and_shared_default(self):
        with patch.dict(os.environ, {"DSH_SESSION_ID": "", "BROWSER_CONTROL_CONTEXT_ID": ""}):
            self.assertTrue(validate_context(host="local")[0].startswith("py_"))
        with patch("browser_control.client.routing") as route:
            route.return_value.resolve_target.return_value = "remote-fixture"
            self.assertEqual(validate_context(host="remote-fixture")[2], "remote-fixture")
        for args in (dict(browser="Firefox"), dict(session="bad space")):
            with self.assertRaises(browser_control.BrowserControlError):
                validate_context(**args)


class GeneratedPageParamsTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_page_params_match_driver_schema(self):
        from browser_control.driver import _PARAMS
        seen = set()
        async def rpc(action, params=None, **context):
            if action.startswith("page_"):
                name = action.removeprefix("page_")
                self.assertFalse(set(params) - _PARAMS[name], (name, params))
                self.assertFalse(any(v is None for v in params.values()))
                seen.add(name)
            return {"mode":"snap", "snapshot":"token", "elements":[], "path":"fixture.png"}
        with patch.object(browser_control, "_rpc", rpc):
            page = browser_control.page("fixture")
            await page.snap(depth=2, within="#main", interactive_only=True, include_urls=True, ax_properties=True)
            await page.click(0)
            await page.click(selector={"text": "提交"})
            await page.type_text("text", allow_newline=True, id="input")
            await page.key("Return", selector={"css": "#q"})
            await page.type_keys("abc", delay_ms=5, selector={"css": "#q"})
            await page.key_down("Shift")
            await page.key_up("Shift")
            await page.edit("select_all", selector={"css": "#q"})
            await page.mouse_move(1, 2, steps=3)
            await page.mouse_down(1, 2, button="right", click_count=2)
            await page.mouse_up()
            await page.wheel(dy=100, x=1, y=2)
            await page.page_info()
            await page.page_text(max_chars=10, frame="F")
            await page.frames()
            await page.fill_form([{"selector": {"css": "#q"}, "value": "x"}])
            await page.upload_via_chooser(["fixture.txt"], selector={"css": "#pick"}, timeout=3)
            await page.set_value(0, "value")
            await page.act(0, "Press")
            await page.scroll(0)
            await page.drag((0, 0), (1, 1))
            await page.selecttext(0, "text")
            await page.read(0)
            await page.wait(label="ready")
            await page.wait(selector={"css": "#x"}, state="hidden", timeout=2)
            await page.wait(any_text=["好", "坏"])
            await page.wait(url="*/done")
            await page.wait(load="networkidle")
            await page.shot(full_page=True, overwrite=True, format="jpeg", quality=80)
            await page.evaluate("1")
            await page.init_add("window.x=1")
            await page.init_remove("script")
            await page.upload(0, ["fixture.txt"])
            await page.dialog()
            await page.viewport(100, 100, scale=2)
            await page.download()
            await page.popups()
            await page.goto("about:blank", timeout=5, before_unload="accept")
            await page.reload(bypass_cache=True, before_unload="dismiss")
            await page.back(timeout=5)
            await page.forward()
            with self.assertRaises(browser_control.BrowserControlError):
                await page.click(0, selector={"css": "#x"})
        self.assertEqual(seen, set(_PARAMS))

    async def test_internal_commands_preserve_public_cli_function(self):
        import importlib
        factory = browser_control.cli
        importlib.import_module("browser_control.commands")
        importlib.import_module("browser_control.entrypoint")
        self.assertIs(browser_control.cli, factory)
        self.assertTrue(callable(browser_control.cli))
        self.assertTrue((await browser_control.cli("version"))["ok"])

    async def test_python_cli_refuses_serve_before_start(self):
        with patch("browser_control.client.subprocess.Popen") as spawn:
            with self.assertRaises(browser_control.BrowserControlError) as raised:
                await browser_control.cli("serve")
            self.assertEqual(raised.exception.code, 2)
            self.assertIn("scripts/browser-control serve", str(raised.exception))
            spawn.assert_not_called()


class ReleaseTests(unittest.IsolatedAsyncioTestCase):

    async def test_explicit_browser_releases_only_one(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append(context["browser"])
            return {}
        with patch.object(browser_control, "_rpc", rpc):
            result = await browser_control.release(browser="Chrome")
        self.assertEqual(calls, ["Chrome"])
        self.assertEqual(set(result["browsers"]), {"Chrome"})

    async def test_close_cancellation_not_wrapped_or_continued(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append(context["browser"])
            raise asyncio.CancelledError()
        with patch.object(browser_control, "_rpc", rpc):
            with self.assertRaises(asyncio.CancelledError):
                await browser_control.release()
        self.assertEqual(calls, ["Chrome"])

    async def test_type_newline_permission_passed_to_driver(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params))
            return {}
        with patch.object(browser_control, "_rpc", rpc):
            await browser_control.page("exact").type_text("first\nsecond", allow_newline=True, id="text")
        self.assertEqual(calls[-1], ("page_type", {"text":"first\nsecond", "allow_newline":True, "id":"text"}))


class PageTests(unittest.IsolatedAsyncioTestCase):
    async def test_module_calls_keep_arc_page_browser(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append(context["browser"])
            return {"elements": []}
        with patch.object(browser_control, "_rpc", rpc):
            page = browser_control.page("arc-page", browser="Arc", session="arc", host="local")
            await browser_control.snap(page)
            await browser_control.page_info(page)
            with self.assertRaises(browser_control.BrowserControlError):
                await browser_control.snap(page, browser="Chrome")
        self.assertTrue(calls)
        self.assertEqual(set(calls), {"Arc"})

    async def test_snapshot_serialization_and_fixed_target(self):
        calls, concurrent = [], 0
        async def rpc(action, params=None, **context):
            nonlocal concurrent
            concurrent += 1
            self.assertEqual(concurrent, 1)
            await asyncio.sleep(.001)
            concurrent -= 1
            calls.append((action, params, context))
            return dict(snapshot="token", elements=[]) if action == "page_snap" else dict(owned=False)
        with patch.object(browser_control, "_rpc", rpc):
            page = browser_control.page("exact")
            with self.assertRaises(browser_control.BrowserControlError):
                await page.click(1)
            await asyncio.gather(page.snap(), page.snap())
            await page.click(1)
            self.assertEqual(calls[-1][1]["snapshot"], "token")
            self.assertTrue(all(c[2]["target"] == "exact" for c in calls))
            self.assertEqual(sum(c[0] == "tab_bind" for c in calls), 1)
            with self.assertRaises(browser_control.BrowserControlError):
                await page.click(id="x", host="local")
            await page.goto("about:blank")
            self.assertIsNone(page.snapshot)
            await page.close()
            self.assertFalse(calls[-1][1]["authorized"])
            with self.assertRaises(browser_control.BrowserControlError):
                await page.snap()

    async def test_cancel_is_not_wrapped(self):
        async def rpc(*args, **kwargs):
            raise asyncio.CancelledError()
        with patch.object(browser_control, "_rpc", rpc):
            with self.assertRaises(asyncio.CancelledError):
                await browser_control.page("exact").snap()

    async def test_open_and_release_session(self):
        calls = []
        async def rpc(action, params=None, **kwargs):
            calls.append((action, params, kwargs))
            return dict(targetId="new", owned=True)
        with patch.object(browser_control, "_rpc", rpc):
            page = await browser_control.open_page("https://example.invalid", lane="test", init_script="window.x=1")
            self.assertTrue(page.owned)
            self.assertTrue(page._bound)
            result = await browser_control.release()
            self.assertEqual([c[2]["browser"] for c in calls[1:]], ["Chrome", "Arc"])
            self.assertEqual(set(result["browsers"]), {"Chrome", "Arc"})
            self.assertEqual(calls[-1][0], "release")
            self.assertEqual(calls[0][2]["session"], calls[-1][2].get("session") or browser_control.DEFAULT_SESSION)


class ClientTests(unittest.TestCase):
    def fixture(self, responder):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "rpc.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        listener.listen()
        self.addCleanup(listener.close)
        calls = []
        def serve():
            while True:
                with listener.accept()[0] as conn:
                    with conn.makefile("rb") as stream:
                        data = json.loads(stream.readline())
                    if data.get("action") == "service":
                        conn.sendall((json.dumps({"ok": True, "result": {"fingerprint": source_fingerprint(), "pid": 1, "startedAt": 0, "draining": False, "holdings": []}}) + "\n").encode())
                        continue
                    calls.append(data)
                    responder(conn, data)
                    return
        worker = threading.Thread(target=serve)
        worker.start()
        self.addCleanup(lambda: worker.join(timeout=1))
        return Client(path, autostart=False), calls

    def test_success_and_session(self):
        client, calls = self.fixture(lambda conn, data: conn.sendall(b'{"ok":true,"result":{"text":"hello"}}\n'))
        self.assertEqual(client.call("page_read", dict(idx=2), target="exact"), dict(text="hello"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["target"], "exact")

    def test_disconnect_does_not_replay(self):
        client, calls = self.fixture(lambda conn, data: None)
        with self.assertRaises(browser_control.BrowserControlError) as raised:
            client.call("page_click", dict(id="x"), target="exact")
        self.assertEqual(raised.exception.outcome, "unknown")
        self.assertEqual(len(calls), 1)

    def test_error_data_preserved(self):
        client, _ = self.fixture(lambda conn, data: conn.sendall(b'{"ok":false,"error":"stale","code":4,"data":{"epoch":2}}\n'))
        with self.assertRaises(browser_control.BrowserControlError) as raised:
            client.call("page_click", target="exact")
        self.assertEqual(raised.exception.code, 4)
        self.assertEqual(raised.exception.data, dict(epoch=2))

    def test_nan_rejected_before_connect(self):
        with self.assertRaises(browser_control.BrowserControlError) as raised:
            Client(autostart=False).call("page_click", dict(value=float("nan")))
        self.assertEqual(raised.exception.code, 2)


class ServiceNamespaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_page_service_namespaces_route_by_prefix(self):
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params, context))
            return {"owned": True} if action == "tab_bind" else {"ok": True}
        page = browser_control.page("exact", session="mine")
        page._rpc = rpc
        await page.state.cookies_get(raw=False)
        await page.inspect.css(selector={"css": "h1"})
        await page.output.shot_if_changed(key="main", timeout=120)
        self.assertEqual([c[0] for c in calls], ["tab_bind", "state_cookies_get", "inspect_css", "output_shot_if_changed"])
        self.assertEqual(calls[-1][2]["timeout"], 125)
        self.assertEqual(calls[1][2]["target"], "exact")
        with self.assertRaises(AttributeError):
            page.state._private


class VersionRecheckTests(unittest.TestCase):
    def test_same_client_notices_source_change(self):
        client = Client(Path(tempfile.mkdtemp()) / "rpc.sock", autostart=False)
        seen = []
        state = {"service": "fp-1", "local": "fp-1"}
        def service(op="info", **kwargs):
            seen.append(op)
            return {"supported": True, "fingerprint": state["service"], "pid": 1, "startedAt": 0, "draining": op == "drain", "holdings": []}
        with patch("browser_control.client.source_fingerprint", side_effect=lambda: state["local"]), patch.object(client, "service", side_effect=service):
            client._check_version(); client._check_version()
            self.assertEqual(seen, ["info"], "指纹一致时不重复查询服务")
            state["local"] = "fp-2"
            client._check_version()
            self.assertEqual(seen, ["info", "info", "drain"], "同一个客户端在源码变化后要重新核对并请求排空")

