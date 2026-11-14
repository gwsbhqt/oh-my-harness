import contextlib
import io
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from browser_use.commands import build_parser, execute, main
from browser_use.errors import BrowserUseError
from browser_use.server import source_fingerprint


class FakeClient:
    def __init__(self):
        self.calls = []
    async def acall(self, action, params=None, **kwargs):
        self.calls.append((action, params, kwargs))
        return dict(elements=[], snapshot="s") if action == "page_snap" else dict(text="ok")




class CliTests(unittest.IsolatedAsyncioTestCase):
    async def test_safe_separator_keeps_option_text(self):
        client = FakeClient()
        result = await execute(["--session", "cli-test", "type", "exact", "--json", "--", "--json"], client=client)
        self.assertTrue(result["ok"])
        self.assertEqual(client.calls[-1][1], dict(text="--json", allow_newline=False))
        self.assertEqual(client.calls[-1][2]["target"], "exact")

    async def test_options_before_and_after_command(self):
        client = FakeClient()
        await execute(["--session","mine","--browser","Chrome","snap","exact","--json"], client=client)
        self.assertEqual(client.calls[-1][2]["session"], "mine")
        self.assertEqual(client.calls[-1][2]["browser"], "Chrome")
        await execute(["snap","exact","--session","other","--browser","Chrome"], client=client)
        self.assertEqual(client.calls[-1][2]["session"], "other")

    async def test_refuse_implicit_target_and_snapshot(self):
        for args in (["--session", "mine", "snap"], ["--session", "mine", "click", "exact", "1"]):
            client = FakeClient()
            with self.assertRaises(BrowserUseError):
                await execute(args, client=client)
            self.assertFalse(any(c[0].startswith("page_") for c in client.calls))

    async def test_snapshot_for_numbered_actions(self):
        client = FakeClient()
        await execute(["--session","cli-test","click","exact","2","--snapshot","token"], client=client)
        self.assertEqual(client.calls[-1][1]["snapshot"], "token")

    async def test_tab_binding_and_close_authorization(self):
        client = FakeClient()
        await execute(["--session","mine","tab","new","https://example.invalid","--lane","test","--init-script","window.x=1"], client=client)
        self.assertEqual(client.calls[-1][0], "tab_new")
        self.assertEqual(client.calls[-1][1]["lane"], {"env": "test"})
        await execute(["--session","mine","tab","new","https://example.invalid","--lane",'{"force-workbench":"1","x-tt-env":"ppe_a"}'], client=client)
        self.assertEqual(client.calls[-1][1]["lane"], {"headers": {"force-workbench": "1", "x-tt-env": "ppe_a"}}, "整段请求头不能被当成 env")
        await execute(["--session","cli-test","tab","close","exact","--authorized"], client=client)
        self.assertTrue(client.calls[-1][1]["authorized"])

    async def test_network_and_lane_routing(self):
        client = FakeClient()
        await execute(["--session","cli-test","network","exact","request","req-1","--body","--raw"], client=client)
        self.assertEqual(client.calls[-1][0], "network_request")
        self.assertEqual(client.calls[-1][1]["id"], "req-1")
        await execute(["--session","cli-test","lane","exact","set","test"], client=client)
        self.assertEqual(client.calls[-1][1], {"env": "test"})
        await execute(["--session","cli-test","lane","exact","set",'{"force-workbench":"1"}'], client=client)
        self.assertEqual(client.calls[-1][1], {"headers": {"force-workbench": "1"}})
        await execute(["--session","cli-test","lane","exact","set","--headers",'{"force-workbench":"1"}'], client=client)
        self.assertEqual(client.calls[-1][1], {"headers": {"force-workbench": "1"}})
        await execute(["--session","cli-test","lane","exact","clear"], client=client)
        self.assertEqual((client.calls[-1][0], client.calls[-1][1]), ("lane_clear", {}))
        await execute(["--session","mine","lane","status"], client=client)
        self.assertEqual(client.calls[-1][0], "lane_status")
        self.assertIsNone(client.calls[-1][2]["target"])
        for argv in (["lane","exact","get","x"], ["lane","exact","clear","--headers",'{"a":"b"}'], ["lane","exact","global-get"]):
            with self.assertRaises(BrowserUseError, msg=argv):
                await execute(["--session", "cli-test", *argv], client=client)




class ExtendedCliTests(unittest.IsolatedAsyncioTestCase):
    async def test_release_and_disconnect_cover_every_browser(self):
        for action in ("release", "disconnect"):
            client = FakeClient()
            result = await execute(["--session", "mine", action], client=client)
            self.assertEqual([c[2]["browser"] for c in client.calls], ["Chrome", "Arc"])
            self.assertTrue(all(c[0] == action and c[2]["target"] is None for c in client.calls))
            self.assertEqual(set(result["browsers"]), {"Chrome", "Arc"})
            for browser in ("Chrome",):
                client.calls.clear()
                result = await execute(["--session", "mine", "--browser", browser, action], client=client)
                self.assertEqual([c[2]["browser"] for c in client.calls], [browser])
                self.assertEqual(set(result["browsers"]), {browser})

    async def test_other_commands_default_to_chrome(self):
        client = FakeClient()
        await execute(["--session", "mine", "status"], client=client)
        await execute(["--session", "mine", "snap", "exact"], client=client)
        self.assertTrue(client.calls)
        self.assertEqual({c[2]["browser"] for c in client.calls}, {"Chrome"})

    async def test_snap_screenshots_only_with_shot_flag(self):
        client = FakeClient()
        await execute(["--session", "cli-test", "snap", "exact"], client=client)
        self.assertIs(client.calls[-1][1]["shot"], False)
        await execute(["--session", "cli-test", "snap", "exact", "--shot"], client=client)
        self.assertIs(client.calls[-1][1]["shot"], True)

    async def test_removed_options_are_rejected(self):
        for args in (["--session", "cli-test", "snap", "exact", "--no-shot"], ["--session", "mine", "release", "--all-browsers"]):
            client = FakeClient()
            with self.assertRaises(BrowserUseError) as raised:
                await execute(args, client=client)
            self.assertEqual(raised.exception.code, 2)
            self.assertEqual(client.calls, [])


    async def test_tab_option_without_positional_target_and_safe_text(self):
        client = FakeClient()
        await execute(["--session","cli-test","--tab","exact","type","--json","--","-H laptop --json"], client=client)
        self.assertEqual(client.calls[-1][1], {"text":"-H laptop --json", "allow_newline":False})
        self.assertEqual(client.calls[-1][2]["target"], "exact")

    async def test_page_cli_params_match_driver_schema(self):
        from browser_use.driver import _PARAMS
        class StrictClient(FakeClient):
            async def acall(self, action, params=None, **context):
                if action.startswith("page_"):
                    unknown = set(params or {}) - _PARAMS[action.removeprefix("page_")]
                    if unknown:
                        raise BrowserUseError(f"unexpected: {unknown}", 2)
                return await super().acall(action, params, **context)
        client = StrictClient()
        operations = [["snap"], ["click", "--id", "button"], ["type", "text"], ["key", "Return"],
                      ["set", "0", "value", "--snapshot", "t"], ["act", "0", "Press", "--snapshot", "t"],
                      ["scroll"], ["drag", "0,0", "1,1"], ["selecttext", "0", "text", "--snapshot", "t"],
                      ["read", "0", "--snapshot", "t"], ["wait", "--label", "ready"],
                      ["shot", "--full-page", "--overwrite"], ["goto", "about:blank"], ["reload", "--bypass-cache"],
                      ["back"], ["forward"], ["eval", "1"], ["init", "add", "window.x=1"],
                      ["init", "remove", "s"], ["upload", "0", "fixture.txt", "--snapshot", "t"],
                      ["dialog"], ["viewport", "100", "100", "--scale", "2"], ["download"], ["popups"]]
        for command in operations:
            await execute(["--session", "cli-test", "--tab", "exact", *command], client=client)

    async def test_network_cli_matches_strict_core_fields(self):
        from browser_use.network import _PARAMS
        class StrictClient(FakeClient):
            async def acall(self, action, params=None, **context):
                if action.startswith("network_"):
                    operation = action.removeprefix("network_")
                    unknown = set(params or {}) - _PARAMS[operation]
                    if unknown:
                        raise BrowserUseError(f"unexpected: {unknown}", 2)
                return await super().acall(action, params, **context)
        client = StrictClient()
        for arguments in (["requests", "--status", "599"], ["clear"], ["console"], ["errors"],
                          ["har-start"], ["har-stop"], ["unroute", "route-1"], ["route", "*api*", "--action", "block"]):
            await execute(["--session", "cli-test", "network", "exact", *arguments], client=client)

    async def test_har_output_stays_local_for_path_and_option(self):
        import tempfile
        from pathlib import Path
        class HarClient(FakeClient):
            async def acall(self, action, params=None, **context):
                self.calls.append((action, params, context))
                return {"har": {"log": {"version": "1.2", "entries": []}}} if action == "network_har_stop" else {}
        with tempfile.TemporaryDirectory() as directory:
            for arguments, name in (([], "pos.har"), (["--out"], "opt.har")):
                client = HarClient()
                path = Path(directory)/name
                args = ["--session", "cli-test", "network", "exact", "har-stop", *arguments, str(path)]
                result = await execute(args, client=client)
                self.assertEqual(client.calls[-1][1], {})
                self.assertEqual(result["path"], str(path))
                self.assertEqual(json.loads(path.read_text())["log"]["entries"], [])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    async def test_har_stop_keeps_recording_when_output_cannot_be_created(self):
        import tempfile
        from pathlib import Path
        class FailingClient(FakeClient):
            async def acall(self, action, params=None, **context):
                self.calls.append((action, params, context))
                if action == "network_har_stop":
                    raise BrowserUseError("服务端失败", 5)
                return {}
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "old.har"
            existing.write_text("old")
            client = FakeClient()
            with self.assertRaises(FileExistsError):
                await execute(["--session", "cli-test", "network", "exact", "har-stop", str(existing)], client=client)
            self.assertNotIn("network_har_stop", [c[0] for c in client.calls])
            self.assertEqual(existing.read_text(), "old")
            fresh = Path(directory) / "new.har"
            with self.assertRaises(BrowserUseError):
                await execute(["--session", "cli-test", "network", "exact", "har-stop", str(fresh)], client=FailingClient())
            self.assertFalse(fresh.exists())

    async def test_network_requests_status_is_sent_as_strict_filter(self):
        client = FakeClient()
        await execute(["--session", "cli-test", "network", "exact", "requests", "--status", "599"], client=client)
        self.assertEqual(client.calls[-1][0], "network_requests")
        self.assertEqual(client.calls[-1][1], {"status": 599})
        with self.assertRaises(BrowserUseError):
            await execute(["--session", "cli-test", "network", "exact", "route", "*api*", "--status", "599"], client=client)

    async def test_network_route_and_unroute_use_actual_core_keys(self):
        client = FakeClient()
        await execute(["--session","cli-test","network","exact","route","*analytics*","--action","block"], client=client)
        self.assertEqual(client.calls[-1][1]["action"], "abort")
        self.assertNotIn("body", client.calls[-1][1])
        await execute(["--session","cli-test","network","exact","unroute","route-1"], client=client)
        self.assertEqual(client.calls[-1][1]["routeId"], "route-1")
        await execute(["--session","cli-test","network","exact","route","*api*","--action","fulfill","--status-code","201","--response-body","hello"], client=client)
        self.assertEqual(client.calls[-1][1]["status"], 201)
        self.assertEqual(client.calls[-1][1]["body"], "hello")

    async def test_download_timeout(self):
        client = FakeClient()
        await execute(["--session","cli-test","download","exact","wait","--guid","g","--timeout","80"], client=client)
        self.assertEqual(client.calls[-1][0], "page_download")
        self.assertEqual(client.calls[-1][2]["timeout"], 85)






class ProcessCliTests(unittest.TestCase):
    @staticmethod
    def _run_type_command(*session_args):
        import os
        from pathlib import Path
        import socket
        import subprocess
        import sys
        import tempfile
        import threading

        calls = []
        stop = threading.Event()
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            path = Path(directory) / "rpc.sock"
            listener.bind(str(path))
            listener.listen()
            # The subprocess can exit before connecting. Closing the socket from
            # this thread does not reliably wake a blocking accept on Linux.
            listener.settimeout(0.1)

            def serve():
                while not stop.is_set():
                    try:
                        conn, _ = listener.accept()
                    except TimeoutError:
                        continue
                    with conn, conn.makefile("rb") as request_stream:
                        conn.settimeout(5)
                        request = json.loads(request_stream.readline())
                        calls.append(request)
                        if request["action"] == "service":
                            result = {"fingerprint": source_fingerprint(), "pid": 1, "startedAt": 0,
                                      "draining": False, "holdings": []}
                            conn.sendall((json.dumps({"ok": True, "result": result}) + "\n").encode())
                        else:
                            conn.sendall(b'{"ok":true,"result":{"delivered":true}}\n')

            env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src"))
            env.pop("BROWSER_USE_CONTEXT_ID", None)
            env.pop("DSH_SESSION_ID", None)
            with ThreadPoolExecutor(max_workers=1) as pool:
                worker = pool.submit(serve)
                try:
                    proc = subprocess.run(
                        [sys.executable, "-m", "browser_use.commands", "--local", "--socket", str(path),
                         *session_args, "type", "exact", "--json", "--", "--json"],
                        capture_output=True, text=True, env=env, timeout=5,
                    )
                finally:
                    stop.set()
                    worker.result()
        return proc, calls

    def test_separate_process_prints_one_json_and_safe_text(self):
        proc, calls = self._run_type_command("--session", "cli-test")
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertEqual(proc.stderr, "")
        self.assertEqual(len(proc.stdout.splitlines()), 1)
        self.assertTrue(json.loads(proc.stdout)["delivered"])
        self.assertEqual([call["action"] for call in calls if call["action"] != "service"], ["tab_bind", "page_type"])
        self.assertEqual(calls[-1]["params"], {"text": "--json", "allow_newline": False})

    def test_separate_process_without_scope_exits_before_rpc(self):
        proc, calls = self._run_type_command()
        self.assertEqual(proc.returncode, 2, proc.stderr or proc.stdout)
        self.assertEqual(proc.stderr, "")
        error = json.loads(proc.stdout)
        self.assertEqual(error["code"], 2)
        self.assertIn("没有任务 scope", error["error"])
        self.assertEqual(calls, [])


class FingerprintTests(unittest.TestCase):
    def test_shared_code_change_changes_fingerprint(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            own, shared = Path(tmp, "browser-use"), Path(tmp, "agentkit")
            own.mkdir(); shared.mkdir()
            (own / "a.py").write_text("x = 1\n")
            (shared / "sample.py").write_text("y = 1\n")
            before = source_fingerprint((own, shared))
            (shared / "sample.py").write_text("y = 2\n")
            self.assertNotEqual(before, source_fingerprint((own, shared)))

    def test_default_covers_shared_agentkit(self):
        from browser_use.server import SHARED_ROOT
        self.assertTrue((SHARED_ROOT / "deps.py").is_file())


class MainTests(unittest.TestCase):
    def test_json_usage_error(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(["--json", "invalid"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["code"], 2)
        self.assertEqual(err.getvalue(), "")

    def test_help_and_missing_dependency(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("install", output.getvalue())
        for cmd in ("snap","click","network","lane","tab","upload","init"):
            self.assertIn("usage:", build_parser()._subparsers._group_actions[0].choices[cmd].format_help())

    def test_install_not_implicit(self):
        with patch("browser_use.commands.install") as install:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["version","--json"]), 0)
            install.assert_not_called()

    def test_install_drains_service_started_without_dependency(self):
        from browser_use import commands
        done = type("Done", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        with patch.object(commands.venv, "EnvBuilder"), patch.object(commands.subprocess, "run", return_value=done), \
                patch.object(commands, "prepare_socket_directory"), patch.object(commands, "Client") as client:
            client.return_value.service.return_value = {"supported": True, "draining": True}
            self.assertEqual(commands.install()["service"], "draining")
            client.assert_called_with(autostart=False)
            client.return_value.service.assert_called_with("drain")
            client.return_value.service.side_effect = BrowserUseError("browser-use 服务未运行", 5)
            self.assertEqual(commands.install()["service"], "not running")

class Phase3CliTests(unittest.IsolatedAsyncioTestCase):
    async def test_snap_after_action_and_rejection_before_send(self):
        client = FakeClient()
        result = await execute(["--session","mine","click","exact","--id","go","--snap"], client=client)
        self.assertEqual([c[0] for c in client.calls], ["tab_bind","page_click","page_snap"])
        self.assertFalse(client.calls[-1][1]["shot"])
        self.assertEqual(result["snap"]["snapshot"], "s")
        client = FakeClient()
        with self.assertRaises(BrowserUseError) as raised:
            await execute(["--session","mine","tab","list","--snap"], client=client)
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(client.calls, [])

    async def test_batch_stops_on_first_error_and_reports_position(self):
        client = FakeClient()
        original = client.acall
        async def acall(action, params=None, **kwargs):
            if action == "page_click":
                raise BrowserUseError("不存在", 3)
            return await original(action, params, **kwargs)
        client.acall = acall
        script = json.dumps([["goto","exact","https://example.invalid"],["click","exact","--id","x"],["key","exact","Enter"]])
        with patch("sys.stdin", io.StringIO(script)):
            result = await execute(["--session","mine","batch"], client=client)
        self.assertFalse(result["ok"])
        self.assertEqual(result["completed"], 2)
        self.assertEqual(result["stoppedAt"], 1)
        self.assertEqual(result["code"], 3)
        self.assertNotIn("page_key", [c[0] for c in client.calls])
        self.assertTrue(all(c[2]["session"] == "mine" for c in client.calls))

    async def test_batch_continue_and_input_validation(self):
        client = FakeClient()
        script = json.dumps([["key","exact","Tab"],["key","exact","Enter"]])
        with patch("sys.stdin", io.StringIO(script)):
            result = await execute(["--session","mine","batch","--continue-on-error"], client=client)
        self.assertTrue(result["ok"])
        self.assertEqual(result["completed"], 2)
        for bad in ("{}", "[]", '[["batch"]]', '[[1]]', "not json"):
            with patch("sys.stdin", io.StringIO(bad)):
                with self.assertRaises(BrowserUseError) as raised:
                    await execute(["--session","mine","batch"], client=FakeClient())
                self.assertEqual(raised.exception.code, 2)

    async def test_launch_options_reach_tab_new(self):
        client = FakeClient()
        await execute(["--session","mine","--browser","Chrome","tab","new","https://example.invalid","--profile","work",
                       "--proxy","http://127.0.0.1:8080","--lang","zh-CN","--ignore-https-errors","--window-size","800,600"], client=client)
        launch = client.calls[-1][1]["launch"]
        self.assertEqual(launch, {"proxy":"http://127.0.0.1:8080","lang":"zh-CN","ignore_https_errors":True,"window_size":[800,600]})
        self.assertEqual(client.calls[-1][1]["profile"], "work")


class LaunchOptionTests(unittest.TestCase):
    def test_launch_validation_and_flags(self):
        from browser_use.engine import Engine
        ok = Engine._launch_options({"launch": {"proxy":"socks5://127.0.0.1:1080","ignore_https_errors":False,"lang":"en-US","window_size":[1280,720]}})
        self.assertNotIn("ignore_https_errors", ok)
        self.assertEqual(Engine._launch_flags(ok), ["--proxy-server=socks5://127.0.0.1:1080","--lang=en-US","--accept-lang=en-US","--window-size=1280,720"])
        for bad in ({"profile":"../x"}, {"proxy":"file:///x"}, {"lang":"zh CN"}, {"window_size":[1,2]}, {"unknown":1}, {"user_agent":"a\nb"}):
            with self.assertRaises(BrowserUseError):
                Engine._launch_options({"launch": bad})


class DomainCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_recover_routes_without_bind_or_page_action(self):
        client = FakeClient()
        await execute(["--session", "mine", "tab", "recover", "original"], client=client)
        self.assertEqual([c[0] for c in client.calls], ["tab_recover"])

    async def test_service_commands_bind_and_route(self):
        client = FakeClient()
        await execute(["--session","mine","inspect","exact","css","--params",'{"selector":{"css":"h1"}}'], client=client)
        self.assertEqual([c[0] for c in client.calls], ["tab_bind","inspect_css"])
        self.assertEqual(client.calls[-1][1], {"selector":{"css":"h1"}})
        await execute(["--session","mine","state","exact","cookies-clear","--authorized"], client=client)
        self.assertEqual(client.calls[-1][0], "state_cookies_clear")
        self.assertTrue(client.calls[-1][1]["authorized"])
        with self.assertRaises(BrowserUseError):
            await execute(["--session","mine","output","annotate"], client=FakeClient())


