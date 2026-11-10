"""四个工具各自的默认机器：browser-control 选机不执行 SSH、不吞网页命令文字；真实入口互不影响。"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
from agentkit.remote import pins, ssh, target


class BrowserControlRouting(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        patch = mock.patch.dict(os.environ, {
            "HOME": str(self.home), "XDG_STATE_HOME": str(self.home / "state"),
            "XDG_CACHE_HOME": str(self.home / "cache"), "REMOTE_HOST_NO_LOG": "1",
        })
        patch.start()
        self.addCleanup(patch.stop)
        hosts = mock.patch.object(ssh, "known_hosts", return_value=["alpha", "beta"])
        hosts.start()
        self.addCleanup(hosts.stop)
        remote = mock.patch.object(ssh, "run_remote", side_effect=AssertionError("must not execute SSH"))
        self.remote = remote.start()
        self.addCleanup(remote.stop)

    def select(self, *argv, tool="browser-control"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = target.select_target(tool, list(argv))
        return result, out.getvalue(), err.getvalue()

    def control(self, *argv, tool="browser-control"):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = target.control_target(tool, list(argv))
        self.assertEqual(out.getvalue(), "")
        return result

    def test_no_pin_defaults_local_except_remote_host(self):
        for tool in ("browser-control", "computer-control", "dsh-control"):
            self.assertEqual(target.resolve_target(tool), "local")
            self.assertEqual(self.select("status", tool=tool)[0], (["status"], "local", None))
        with self.assertRaises(ValueError):
            target.resolve_target("remote-host")
        self.assertEqual(self.select("run", "true", tool="remote-host")[0][2], 2)
        self.remote.assert_not_called()
        self.assertFalse((self.home / ".ssh").exists())

    def test_use_pin_hosts_and_clear_are_independent(self):
        defaults = {"remote-host": "alpha", "computer-control": "beta", "dsh-control": "alpha", "browser-control": "beta"}
        for tool, host in defaults.items():
            self.assertEqual(self.control("pin", host, tool=tool),
                {"ok": True, "tool": tool, "target": host})
        before = {tool: pins.read_pin(tool) for tool in defaults}
        listed = self.control("hosts")
        self.assertEqual(listed, {"ok": True, "tool": "browser-control", "target": "beta", "hosts": ["local", "alpha", "beta"]})
        self.assertEqual(self.control("use", "--clear"), {"ok": True, "tool": "browser-control", "target": "local"})
        self.assertEqual(target.resolve_target("browser-control"), "local")
        self.assertFalse(pins.pin_file("browser-control").exists())
        for tool in ("remote-host", "computer-control", "dsh-control"):
            self.assertEqual(pins.read_pin(tool), before[tool])
        self.control("use", "alpha")
        self.control("use", "local")
        self.assertEqual(target.resolve_target("browser-control"), "local")
        for tool in ("remote-host", "computer-control", "dsh-control"):
            self.assertEqual(pins.read_pin(tool), before[tool])

    def test_each_other_tool_clear_does_not_change_browser_control(self):
        self.control("use", "beta")
        for tool in ("remote-host", "computer-control", "dsh-control"):
            self.control("use", "alpha", tool=tool)
            self.control("use", "--clear", tool=tool)
            self.assertEqual(target.resolve_target("browser-control"), "beta")
        self.assertEqual(self.select("run", "true", tool="remote-host")[0][2], 2)

    def test_explicit_override_is_one_call_only(self):
        self.control("use", "alpha")
        for flag in (["-H", "beta"], ["--host", "beta"], ["-Hbeta"], ["--host=beta"]):
            self.assertEqual(self.select(*flag, "status")[0], (["status"], "beta", None))
        for flag in (["--local"], ["-H", "local"]):
            self.assertEqual(self.select(*flag, "status")[0], (["status"], "local", None))
        self.assertEqual(target.resolve_target("browser-control"), "alpha")
        self.remote.assert_not_called()

    def test_unknown_alias_and_conflicts_never_fall_back(self):
        self.control("use", "alpha")
        before = pins.read_pin("browser-control")
        for argv in (["-H", "missing", "status"], ["-H", "alpha", "--local", "status"],
                     ["-Halpha", "-Hbeta", "status"], ["--host=", "status"], ["-H"]):
            result, _, _ = self.select(*argv)
            self.assertIsNone(result[1])
            self.assertEqual(result[2], 2)
        self.assertFalse(self.control("use", "missing")["ok"])
        self.assertEqual(pins.read_pin("browser-control"), before)
        with self.assertRaises(ValueError):
            target.resolve_target("browser-control", "")
        self.remote.assert_not_called()

    def test_session_and_browser_values_are_not_commands(self):
        argv = ["--session", "hosts", "--browser", "Chrome", "--socket", "/fixture/private/socket",
                "--tab", "use", "--rpc-timeout", "3", "-H", "alpha", "snap", "target"]
        cleaned = argv[:10] + argv[12:]
        self.assertEqual(self.select(*argv)[0], (cleaned, "alpha", None))
        self.assertEqual(pins.read_pin("browser-control"), {})

    def test_equals_global_values_do_not_hide_later_host(self):
        argv = ["--session=pin", "--browser=Chrome", "--socket=/fixture/socket", "--tab=use", "--rpc-timeout=3", "-Hbeta", "status"]
        self.assertEqual(self.select(*argv)[0], (argv[:-2] + ["status"], "beta", None))

    def test_route_words_in_option_values_are_preserved(self):
        argv = ["--session", "--host", "-H", "alpha", "status"]
        self.assertEqual(self.select(*argv)[0], (["--session", "--host", "status"], "alpha", None))

    def test_all_business_tokens_are_preserved_after_command(self):
        for payload in (["type", "tab", "--host"], ["eval", "tab", "--local"],
                        ["paste", "tab", "-H", "alpha"], ["network", "tab", "route", "--host=beta"],
                        ["script", "tab", "add", "--", "--local"],
                        ["snap", "tab", "--session", "mine", "--browser", "Chrome", "--host", "beta"],
                        ["eval", "tab", '"line 1\n-H alpha; $(nope)"']):
            with self.subTest(payload=payload):
                self.assertEqual(self.select("-H", "alpha", *payload)[0], (payload, "alpha", None))

    def test_separator_blocks_router(self):
        argv = ["--session", "mine", "--", "--host", "alpha", "use"]
        self.assertEqual(self.select(*argv)[0], (argv, "local", None))
        self.assertEqual(pins.read_pin("browser-control"), {})

    def test_leading_browser_options_do_not_hide_control(self):
        result, out, _ = self.select("--session", "snap", "--browser", "Chrome", "--json", "pin", "alpha")
        self.assertEqual(result[1:], (None, 0))
        self.assertEqual(json.loads(out), {"ok": True, "tool": "browser-control", "target": "alpha"})
        self.assertEqual(self.control("--session=use", "--json", "hosts")["target"], "alpha")

    def test_select_controls_output_json_and_do_not_execute(self):
        for action in ("use", "pin"):
            result, out, _ = self.select(action, "alpha", "--json")
            self.assertEqual(result, ([action, "alpha", "--json"], None, 0))
            self.assertEqual(json.loads(out), {"ok": True, "tool": "browser-control", "target": "alpha"})
        self.remote.assert_not_called()

    def test_control_is_structured_and_refuses_business_commands(self):
        self.assertEqual(self.control("use"), {"ok": True, "tool": "browser-control", "target": "local"})
        failure = self.control("status")
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["code"], 2)
        self.assertFalse(self.control("use", "alpha", "--cwd", "~/work")["ok"])
        self.assertEqual(pins.read_pin("browser-control"), {})

    def test_malformed_or_unreadable_pin_fails_without_local_fallback(self):
        for raw in ("{", "[]", '{"host":""}', '{"host":null}', '{"hosts":[]}'):
            path = pins.pin_file("browser-control")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(raw)
            self.assertEqual(self.select("status")[0][1:], (None, 2))
        with mock.patch.object(pins, "read_pin", side_effect=PermissionError("fixture unreadable")):
            result, out, _ = self.select("status", "--json")
        self.assertEqual(result[1:], (None, 2))
        self.assertIn("unreadable", json.loads(out)["error"])

    def test_remote_host_still_rejects_local_even_with_pin(self):
        self.control("use", "alpha", tool="remote-host")
        for argv in (["--local", "run", "true"], ["-Hlocal", "run", "true"]):
            self.assertEqual(self.select(*argv, tool="remote-host")[0][2], 2)
        self.control("use", "local", tool="remote-host")
        with self.assertRaises(ValueError):
            target.resolve_target("remote-host")
        self.assertEqual(target.resolve_target("browser-control"), "local")

    def test_legacy_extract_rules_remain_unchanged(self):
        argv = ["-H", "alpha", "run", "curl", "-H", "Accept: application/json", "url"]
        self.assertEqual(target._extract(argv, "remote-host"), (argv[2:], "alpha", False))
        self.assertEqual(target._extract(["type", "Finder", "--host"], "computer-control"), (["type", "Finder", "--host"], None, False))
        self.assertEqual(target._extract(["send", "id", "-H"], "dsh-control"), (["send", "id", "-H"], None, False))
        for tool in ("computer-control", "dsh-control"):
            with self.assertRaises(ValueError):
                target._extract(["status", "-H", "alpha"], tool)

    def test_dispatch_browser_control_remote_refuses_legacy_transport(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            cleaned, code = target.dispatch("browser-control", ["-H", "alpha", "status"])
        self.assertEqual(cleaned, ["status"])
        self.assertEqual(code, 2)
        self.assertIn("RPC", err.getvalue())
        self.remote.assert_not_called()




if __name__ == "__main__":
    unittest.main()
