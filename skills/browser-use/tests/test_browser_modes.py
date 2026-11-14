"""浏览器运行方式与扩展策略；不启动真实 Chrome，不读取真实用户资料。"""
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from test_engine_safety import engine, FakeCDP, FakeProcess


class ModeCDP(FakeCDP):
    def call(self, method, params=None, **kwargs):
        if method == "Target.getTargets":
            return {"targetInfos": []}
        if method == "Browser.close":
            return {}
        if method == "Browser.getVersion":
            return {"product": "Chrome/fixture"}
        if method == "SystemInfo.getProcessInfo":
            return {"processInfo": [{"type": "browser", "id": 12345}]}
        return super().call(method, params, **kwargs)


class ModeProcess(FakeProcess):
    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class BrowserModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="browser-use-modes-")
        self.addCleanup(self.temp.cleanup)
        self.ledger = Mock()
        self.ledger.path = Path(self.temp.name) / "resources.json"
        self.ledger.list.return_value = []
        self.ledger.prune.return_value = []
        self.core = engine.Engine(ledger=self.ledger)
        self.addCleanup(self.core.close)
        self.flags = []
        self.processes = []
        self.spawned = False

    def spawn(self, flags, **kwargs):
        self.spawned = True
        self.flags.append(flags)
        profile = next(v.split("=", 1)[1] for v in flags if v.startswith("--user-data-dir="))
        Path(profile, "DevToolsActivePort").write_text("54321\n/devtools/browser/fixture\n")
        process = ModeProcess()
        self.processes.append(process)
        return process

    def patches(self):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(engine.subprocess, "Popen", side_effect=self.spawn))
        stack.enter_context(patch.object(engine, "discover", return_value="ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111"))
        stack.enter_context(patch.object(engine, "CDP", side_effect=ModeCDP))
        return stack

    def up(self, **params):
        return self.core.dispatch({"action": "up", "session": "modes", "browser": "Chrome", "params": params})

    def test_controlled_attach_fixture_uses_endpoint_without_launching(self):
        with self.patches(), patch.dict(os.environ, {"BROWSER_USE_TEST_CHROME_ENDPOINT": "http://127.0.0.1:9222"}):
            up = self.up(mode="attach", fallback="never", restart="never")
        self.assertTrue(up["ok"], up)
        self.assertFalse(self.spawned)
        record = self.core.browsers[("Chrome", "modes")]
        self.assertIsNone(record["process"])
        self.assertIsNone(record["context_id"])
        self.assertEqual(record["mode"], "attach")

    def test_new_window_uses_existing_profile_and_never_private_context(self):
        cdp = Mock()
        cdp.call.return_value = {"targetInfos": [
            {"type": "page", "targetId": "human", "browserContextId": "daily-profile"}]}
        params = self.core._new_target_params({"mode": "attach", "cdp": cdp}, {"new_window": True})
        self.assertEqual(params, {"url": "about:blank", "background": True,
                                  "newWindow": True, "browserContextId": "daily-profile"})
        cdp.call.assert_called_once_with("Target.getTargets")

    def test_multiple_profiles_need_exact_source_and_missing_source_is_rejected(self):
        cdp = Mock()
        cdp.call.return_value = {"targetInfos": [
            {"type": "page", "targetId": "human", "browserContextId": "daily"},
            {"type": "page", "targetId": "other", "browserContextId": "other-profile"}]}
        browser = {"mode": "attach", "cdp": cdp}
        with self.assertRaises(engine.BrowserUseError) as error:
            self.core._new_target_params(browser, {"new_window": True})
        self.assertEqual(error.exception.code, 6)
        params = self.core._new_target_params(browser, {"new_window": True, "source_target": "human"})
        self.assertEqual(params["browserContextId"], "daily")
        with self.assertRaises(engine.BrowserUseError) as error:
            self.core._new_target_params(browser, {"new_window": True, "source_target": "closed"})
        self.assertEqual(error.exception.code, 4)
        self.assertTrue(all(call.args[0] == "Target.getTargets" for call in cdp.call.call_args_list))

    def test_explicit_source_is_honored_in_an_owned_instance(self):
        cdp = Mock()
        cdp.call.return_value = {"targetInfos": [{"type": "page", "targetId": "source", "browserContextId": "selected"}]}
        create = self.core._new_target_params({"mode": "isolated", "context_id": "default-private", "cdp": cdp},
                                               {"new_window": True, "source_target": "source"})
        self.assertEqual(create["browserContextId"], "selected")

    def test_default_context_and_independent_mode_remain_distinct(self):
        cdp = Mock()
        cdp.call.return_value = {"targetInfos": [{"type": "page", "targetId": "human"}]}
        self.assertNotIn("browserContextId", self.core._new_target_params(
            {"mode": "attach", "cdp": cdp}, {"new_window": True}))
        self.assertEqual(self.core._new_target_params({"mode": "isolated", "context_id": "private"}, {}),
                         {"url": "about:blank", "background": True, "browserContextId": "private"})
        with self.assertRaises(engine.BrowserUseError):
            self.core._new_target_params({}, {"new_window": "true"})

    def test_attach_scope_uses_held_attach_record_without_probing_chrome(self):
        self.core.browsers[("Chrome", "held")] = {"mode": "attach", "scope": "attach-scope"}
        probed = []
        def probe(kind):
            probed.append(kind.name)
            raise OSError("没开远程调试")
        with patch.object(self.core, "_attach_connection", side_effect=probe):
            self.assertEqual(self.core._attach_scopes(), {"attach-scope"})
        self.assertNotIn("Chrome", probed)
        self.core.browsers.clear()

    def test_release_cleans_externally_exited_browser_without_reconnecting(self):
        with self.patches():
            up = self.up(mode="isolated", profile="exited", executable="/bin/bash")
            self.assertTrue(up["ok"], up)
            record = self.core.browsers[("Chrome", "modes")]
            record["process"].returncode = 0
            record["cdp"].closed = True
            self.ledger.list.return_value = []
            self.core.bindings[("Chrome", "already-closed")] = {
                "browser": "Chrome", "owner": "modes", "targetId": "already-closed", "owned": True,
                "lock": threading.RLock(), "driver": Mock(close_errors=[{"error": "旧调试会话已断开"}]),
                "network": Mock(close_errors=[])}
            with patch.object(record["cdp"], "call", side_effect=AssertionError("退出后不应再发调试请求")):
                released = self.core.dispatch({"action": "release", "session": "modes", "browser": "Chrome"})
            self.assertTrue(released["ok"], released)
            self.assertEqual(released["result"]["closedExternally"], ["already-closed"])
            self.assertNotIn(("Chrome", "modes"), self.core.browsers)
            self.assertTrue(record["log"].closed)

    def test_disconnected_live_browser_still_requires_explicit_recovery(self):
        with self.patches():
            self.up(mode="isolated", executable="/bin/bash")
            record = self.core.browsers[("Chrome", "modes")]
            record["cdp"].closed = True
            released = self.core.dispatch({"action": "release", "session": "modes", "browser": "Chrome"})
            self.assertFalse(released["ok"], released)
            self.assertTrue(released["data"]["recoveryRequired"])
            self.assertIn(("Chrome", "modes"), self.core.browsers)
            record["cdp"].closed = False

    def test_temporary_isolated_disables_extensions(self):
        with self.patches():
            reply = self.up(mode="isolated", executable="/bin/bash")
        self.assertTrue(reply["ok"], reply)
        self.assertIn("--disable-extensions", self.flags[0])
        self.assertEqual(reply["result"]["mode"], "isolated")
        self.assertIn("--disable-features=AutomationControlled", self.flags[0])

    def test_persistent_isolated_keeps_extensions(self):
        with self.patches():
            reply = self.up(mode="isolated", profile="work", executable="/bin/bash")
        self.assertTrue(reply["ok"], reply)
        self.assertNotIn("--disable-extensions", self.flags[0])
        self.assertEqual(self.core.browsers[("Chrome", "modes")]["profileName"], "work")

    def test_first_arc_attach_keeps_owned_pages_for_release_after_disconnect(self):
        self.core.ledger = None
        real_ledger = engine.ResourceLedger(Path(self.temp.name).resolve() / "arc-resources.json")
        cdp = ModeCDP("fixture")
        targets = [{"targetId": "owned-fixture", "type": "page"},
                   {"targetId": "user-fixture", "type": "page"}]
        closed = []
        original_call = cdp.call
        def call(method, params=None, **kwargs):
            if method == "Target.getTargets":
                return {"targetInfos": list(targets)}
            if method == "Target.closeTarget":
                target = params["targetId"]
                targets[:] = [row for row in targets if row["targetId"] != target]
                closed.append(target)
                return {"success": True}
            return original_call(method, params, **kwargs)
        cdp.call = call
        with patch.object(engine, "ResourceLedger", return_value=real_ledger), \
                patch.object(self.core, "_connect_attach", return_value=(cdp, "http://127.0.0.1:9222",
                    "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111")):
            request = {"browser": "Arc", "session": "arc-first", "params": {}}
            up = self.core.dispatch(request | {"action": "up"})
            self.assertTrue(up["ok"], up)
            self.assertIs(self.core.ledger, real_ledger)
            scope = self.core.browsers[("Arc", "arc-first")]["scope"]
            real_ledger.record(scope, "arc-first", "owned-fixture", True, "Arc")
            disconnected = self.core.dispatch(request | {"action": "disconnect"})
            self.assertTrue(disconnected["ok"], disconnected)
            self.assertEqual(len(real_ledger.list(scope, "arc-first")), 1)
            released = self.core.dispatch(request | {"action": "release"})
            self.assertTrue(released["ok"], released)
            self.assertEqual(closed, ["owned-fixture"])
            self.assertEqual(targets, [{"targetId": "user-fixture", "type": "page"}])
            self.assertEqual(real_ledger.list(scope, "arc-first"), [])

    def test_attach_never_launches_or_closes_browser_process(self):
        with patch.object(engine.subprocess, "Popen", side_effect=AssertionError("attach 不应启动 Chrome")),                 patch.object(self.core, "_connect_attach", return_value=(ModeCDP("fixture"), "http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111")),                 patch.object(engine, "CDP", side_effect=ModeCDP):
            reply = self.up(mode="attach")
            self.assertTrue(reply["ok"], reply)
            self.assertFalse(reply["result"]["owned"])
            self.assertTrue(self.core.idle())
            released = self.core.dispatch({"action": "release", "session": "modes", "browser": "Chrome"})
        self.assertTrue(released["ok"], released)
        self.assertFalse(self.spawned)

    def test_clone_copies_profile_and_keeps_extensions(self):
        root = Path(self.temp.name) / "daily"
        (root / "Default" / "Extensions" / "fixture").mkdir(parents=True)
        (root / "Default" / "Preferences").write_text("{}")
        (root / "Default" / "Cookies").write_text("fixture-cookie")
        (root / "Default" / "Extensions" / "fixture" / "manifest.json").write_text("{}")
        (root / "Local State").write_text("{}")
        with self.patches(), patch.object(self.core, "_data_root", return_value=root):
            reply = self.up(mode="clone", profile="Default", executable="/bin/bash")
            self.assertTrue(reply["ok"], reply)
            record = self.core.browsers[("Chrome", "modes")]
            cloned = Path(record["profile"])
            self.assertNotEqual(cloned, root / "Default")
            self.assertEqual((cloned / "Default" / "Cookies").read_text(), "fixture-cookie")
            self.assertTrue((cloned / "Default" / "Extensions" / "fixture" / "manifest.json").is_file())
            self.assertNotIn("--disable-extensions", self.flags[0])
            self.assertEqual((root / "Default" / "Cookies").read_text(), "fixture-cookie")

    def test_clone_blocked_by_macos_points_to_full_disk_access(self):
        root = Path(self.temp.name) / "protected"
        (root / "Default").mkdir(parents=True)
        (root / "Default" / "Preferences").write_text("{}")
        (root / "Local State").write_text("{}")
        made = []
        real_mkdtemp = engine.tempfile.mkdtemp
        def mkdtemp(**options):
            made.append(Path(real_mkdtemp(**options)))
            return str(made[-1])
        with self.patches(), patch.object(self.core, "_data_root", return_value=root), \
                patch.object(engine.tempfile, "mkdtemp", side_effect=mkdtemp), \
                patch.object(engine.shutil, "copy2", side_effect=PermissionError(1, "Operation not permitted")):
            reply = self.up(mode="clone", profile="Default", executable="/bin/bash")
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], 5)
        self.assertIn("完全磁盘访问权限", reply["error"])
        clones = [path for path in made if path.name.startswith("clone-")]
        self.assertEqual(len(clones), 1)
        self.assertFalse(clones[0].exists())
        self.assertFalse(self.spawned)

    def test_attach_reports_cu_approved_authorization(self):
        def connect(kind, session):
            self.core._attach_auto_approved[kind.name] = True
            return ModeCDP("fixture"), "http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111"
        with patch.object(self.core, "_connect_attach", side_effect=connect) as connect_calls:
            reply = self.up(mode="attach", fallback="never")
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["result"]["authorizationAutoApproved"])

    def test_attach_is_a_single_connection_across_sessions(self):
        connections = []
        def connect(kind, session):
            connection = ModeCDP("fixture")
            connections.append(connection)
            return connection, "http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111"
        with patch.object(self.core, "_connect_attach", side_effect=connect) as connect_calls:
            for session in ("attach-a", "attach-b"):
                reply = self.core.dispatch({"action": "up", "session": session, "browser": "Chrome", "params": {"mode": "attach"}})
                self.assertTrue(reply["ok"], reply)
            self.assertEqual(connect_calls.call_count, 1)
            released = self.core.dispatch({"action": "release", "session": "attach-a", "browser": "Chrome"})
            self.assertTrue(released["ok"], released)
            self.assertFalse(connections[0].closed)
            status = self.core.dispatch({"action": "status", "session": "attach-b", "browser": "Chrome"})
            self.assertTrue(status["result"]["connected"])
            self.assertTrue(self.core.keep_shared_alive())
            self.core.close()
            self.assertTrue(connections[0].closed)

    def test_attach_connection_failure_falls_back_to_clone_without_restart(self):
        root = Path(self.temp.name) / "daily-fallback"
        (root / "Default").mkdir(parents=True)
        (root / "Default" / "Preferences").write_text("{}")
        with self.patches(), patch.object(self.core, "_data_root", return_value=root),                 patch.object(self.core, "_restart_browser") as restart,                 patch.object(self.core, "_connect_attach", side_effect=OSError("authorization timeout")):
            reply = self.up(mode="attach", executable="/bin/bash")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["mode"], "clone")
        self.assertEqual(reply["result"]["fallbackFrom"], "attach")
        restart.assert_not_called()

    def test_attach_restarts_once_only_when_debug_was_configured(self):
        root = Path(self.temp.name) / "configured"
        root.mkdir()
        (root / "DevToolsActivePort").write_text("9222\n/devtools/browser/fixture\n")
        process = type("Process", (), {"stdout": "Wed Nov  4 14:19:30 2026\n"})()
        with patch.object(self.core, "_data_root", return_value=root),                 patch.object(self.core, "_restart_browser") as restart,                 patch.object(engine, "discover", side_effect=OSError("no HTTP discovery")),                 patch.object(self.core, "_connect_attach", side_effect=[OSError("stale"), (ModeCDP("fixture"), "http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111")]),                 patch.object(engine.subprocess, "run", return_value=process):
            reply = self.up(mode="attach", fallback="never")
        self.assertTrue(reply["ok"], reply)
        restart.assert_called_once_with(engine.BROWSERS["Chrome"])
        self.assertTrue(reply["result"]["browserRestarted"])

    def test_attach_does_not_restart_when_debug_was_never_enabled(self):
        with patch.object(self.core, "_data_root", return_value=Path(self.temp.name) / "new"),                 patch.object(self.core, "_restart_browser") as restart,                 patch.object(engine, "discover", side_effect=OSError("disabled")), \
                patch.object(self.core, "_connect_attach", side_effect=OSError("disabled")):
            reply = self.up(mode="attach", fallback="never")
        self.assertEqual(reply["code"], 5)
        restart.assert_not_called()

    def test_invalid_modes_and_attach_overrides_fail_closed(self):
        invalid = self.up(mode="other")
        self.assertEqual(invalid["code"], 2)
        attach_profile = self.up(mode="attach", profile="Default")
        self.assertEqual(attach_profile["code"], 2)
        self.assertFalse(self.spawned)


class ArcModeTests(unittest.TestCase):
    setUp = BrowserModeTests.setUp
    spawn = BrowserModeTests.spawn

    def up(self, **params):
        return self.core.dispatch({"action": "up", "session": "arc", "browser": "Arc", "params": params})

    def attached(self, kind, session):
        return ModeCDP(kind.name), "http://127.0.0.1:9333", "ws://127.0.0.1:9333/devtools/browser/22222222-2222-2222-2222-222222222222"

    def test_arc_defaults_to_attach_without_launching(self):
        with patch.object(engine.subprocess, "Popen", side_effect=AssertionError("Arc 不应自启浏览器")), \
                patch.object(self.core, "_connect_attach", side_effect=self.attached) as connect:
            reply = self.up()
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["mode"], "attach")
        self.assertEqual(reply["result"]["browser"], "Arc")
        self.assertEqual(connect.call_args.args[0], engine.BROWSERS["Arc"])

    def test_arc_rejects_isolated_and_clone(self):
        for mode in ("isolated", "clone"):
            reply = self.up(mode=mode, executable="/bin/bash")
            self.assertEqual(reply["code"], 2, reply)
            self.assertIn("browser='Chrome'", reply["error"])
        reply = self.up(mode="attach", fallback="clone")
        self.assertEqual(reply["code"], 2, reply)
        self.assertFalse(self.spawned)

    def test_arc_attach_failure_neither_clones_nor_restarts(self):
        root = Path(self.temp.name) / "arc-configured"
        root.mkdir()
        (root / "DevToolsActivePort").write_text("9333\n/devtools/browser/fixture\n")
        with patch.object(self.core, "_data_root", return_value=root), \
                patch.object(self.core, "_restart_browser") as restart, \
                patch.object(engine.subprocess, "Popen", side_effect=AssertionError("Arc 不应自启浏览器")), \
                patch.object(self.core, "_connect_attach", side_effect=OSError("authorization timeout")):
            reply = self.up()
        self.assertFalse(reply["ok"], reply)
        self.assertEqual(reply["code"], 5)
        self.assertIn("Arc", reply["error"])
        restart.assert_not_called()

    def test_arc_without_remote_debugging_does_not_guess_a_port(self):
        with patch.object(self.core, "_data_root", return_value=Path(self.temp.name) / "arc-new"), \
                patch.object(engine, "discover", side_effect=AssertionError("不该去猜端口")):
            with self.assertRaises(engine.BrowserUseError) as raised:
                self.core._attach_endpoint(engine.BROWSERS["Arc"])
        self.assertIn("重新打开更新后的本地 Arc", str(raised.exception))
        chrome = self.core._attach_endpoint.__func__
        with patch.object(self.core, "_data_root", return_value=Path(self.temp.name) / "chrome-new"):
            self.assertEqual(chrome(self.core, engine.BROWSERS["Chrome"]), "http://127.0.0.1:9222")

    def test_chrome_and_arc_keep_separate_attach_connections(self):
        connections = {}
        def connect(kind, session):
            connections[kind.name] = ModeCDP(kind.name)
            return connections[kind.name], "http://127.0.0.1:9333", f"ws://127.0.0.1:9333/devtools/browser/{'1' if kind.name == 'Chrome' else '2'}" + "1111111-1111-1111-1111-111111111111"
        with patch.object(self.core, "_connect_attach", side_effect=connect):
            for browser in ("Chrome", "Arc"):
                reply = self.core.dispatch({"action": "up", "session": "both", "browser": browser, "params": {"mode": "attach", "fallback": "never"}})
                self.assertTrue(reply["ok"], reply)
            self.assertEqual(set(self.core._attach_shared), {"Chrome", "Arc"})
            self.assertEqual(self.core._attach_scopes(), {"11111111-1111-1111-1111-111111111111", "21111111-1111-1111-1111-111111111111"})
            connections["Arc"].closed = True
            self.assertTrue(self.core.attach_lost())
            self.assertEqual(self.core._attach_lost(), {"Arc"})
            self.assertTrue(self.core.keep_shared_alive())
            self.assertTrue(self.core.has_live_browser())
            connections["Chrome"].closed = True
            self.assertFalse(self.core.has_live_browser())

    def test_arc_rejection_reports_observed_failure(self):
        from browser_use.errors import BrowserUseError
        with patch.object(self.core, "_connect_attach", side_effect=BrowserUseError("连不上浏览器：server rejected WebSocket connection: HTTP 403", 5)):
            reply = self.up()
        self.assertEqual(reply["code"], 5, reply)
        self.assertIn("HTTP 403", reply["error"])
        self.assertNotIn("不会弹", reply["error"])

    def test_attach_checks_real_process_instead_of_trusting_port(self):
        with patch.object(engine.sys, "platform", "darwin"):
            for name, command in (("Arc", "/tmp/example-home/Applications/Arc.app/Contents/MacOS/ArcBinary --flag"),
                                  ("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag")):
                with patch.object(engine.subprocess, "run", return_value=Mock(stdout=command)):
                    self.core._verify_attach_browser(engine.BROWSERS[name], ModeCDP("fixture"))
                    other = "Chrome" if name == "Arc" else "Arc"
                    with self.assertRaises(engine.BrowserUseError) as raised:
                        self.core._verify_attach_browser(engine.BROWSERS[other], ModeCDP("fixture"))
                    self.assertEqual(raised.exception.code, 6)

    def test_arc_rejects_launch_options_even_when_fallback_is_omitted(self):
        for params in ({"executable": "/bin/bash"}, {"headed": True}):
            reply = self.up(**params)
            self.assertEqual(reply["code"], 2, reply)

    def test_unknown_browser_is_rejected(self):
        reply = self.core.dispatch({"action": "up", "session": "x", "browser": "Safari", "params": {}})
        self.assertEqual(reply["code"], 2)
        from browser_use.client import validate_context
        from browser_use.errors import BrowserUseError
        self.assertEqual(validate_context("x", "Arc", "local")[1], "Arc")
        with self.assertRaises(BrowserUseError):
            validate_context("x", "Safari", "local")


class ChromeExecutableTests(unittest.TestCase):
    def test_prefers_installed_chrome_then_newest_testing_build(self):
        from browser_use import browsers
        with tempfile.TemporaryDirectory() as home:
            for version in ("mac_arm-150.0.1.2", "mac_arm-157.0.8103.38", "mac_arm-99.0.1.1"):
                app = Path(home, ".cache/chrome-for-testing/chrome", version, "chrome-mac-arm64",
                           "Google Chrome for Testing.app/Contents/MacOS")
                app.mkdir(parents=True)
                (app / "Google Chrome for Testing").write_text("")
            with patch.dict(os.environ, {"HOME": home}), patch.object(browsers, "_INSTALLED", ()):
                self.assertIn("mac_arm-157.0.8103.38", browsers.chrome_executable())
            installed = Path(home, "Chrome")
            installed.write_text("")
            with patch.dict(os.environ, {"HOME": home}), patch.object(browsers, "_INSTALLED", (str(installed),)):
                self.assertEqual(browsers.chrome_executable(), str(installed))


class BrowserModeApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_python_and_cli_preserve_mode_and_profile(self):
        import browser_use
        calls = []
        async def rpc(action, params=None, **context):
            calls.append((action, params))
            if action == "tab_find":
                return {"targetId": "borrowed", "owned": False, "mode": "attach"}
            return {"targetId": "owned", "owned": True, "mode": params.get("mode", "isolated")}
        with patch.object(browser_use, "_rpc", side_effect=rpc):
            attached = await browser_use.find_tab("mail", mode="attach")
            self.assertEqual(attached.mode, "attach")
            cloned = await browser_use.open_page("about:blank", mode="clone", profile="Default")
            self.assertEqual(cloned.mode, "clone")
        self.assertEqual(calls[0][1], {"query": "mail", "mode": "attach"})
        self.assertEqual(calls[1][1]["profile"], "Default")

        from browser_use.commands import execute
        client = type("Client", (), {"calls": [], "acall": None})()
        async def acall(action, params=None, **context):
            client.calls.append((action, params))
            return {"targetId": "cli", "owned": True, "mode": "attach"}
        client.acall = acall
        await execute(["--session", "modes", "--mode", "attach", "tab", "find", "mail"], client=client)
        self.assertEqual(client.calls[-1][1], {"mode": "attach", "query": "mail"})

if __name__ == "__main__":
    unittest.main()
