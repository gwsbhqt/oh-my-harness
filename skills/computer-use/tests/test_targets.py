"""机器绑定、启动器与实际 Swift 参数边界测试，不操作真实界面。"""
import asyncio
import importlib.machinery
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import computer_use
from test_computer_use import Case, SNAP


class Targets(Case):
    def test_remote_snap_uses_launcher_and_preserves_json_objects(self):
        self.target.resolve_target.return_value = "beta"
        self.reply({**SNAP, "shot": "/local/copied.png", "remotePath": "/remote/original.png"})
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub), mock.patch.object(computer_use, "_program", mock.AsyncMock(side_effect=AssertionError("远程不能构建本机"))):
            result = self.run_(computer_use.app("Finder", host="beta").snap(shot=True))
        self.assertIsInstance(result, computer_use.Snap)
        self.assertEqual(result.shot, "/local/copied.png")
        self.assertTrue(all(call == mock.call("computer-use", host="beta") for call in self.target.resolve_target.call_args_list))
        self.assertEqual(self.calls()[0][:4], ["-H", "beta", "snap", "Finder"])
        self.assertEqual(self.calls()[0][-1], "--json")

    def test_no_host_reads_computer_use_default_on_each_call(self):
        self.target.resolve_target.side_effect = ["local", "beta"]
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            self.run_(computer_use.key("Finder", "Escape"))
            self.run_(computer_use.key("Finder", "Escape"))
        self.assertEqual(self.target.resolve_target.call_args_list, [mock.call("computer-use", host=None)] * 2)
        self.assertEqual(self.calls()[0][:2], ["key", "Finder"])
        self.assertEqual(self.calls()[1][:4], ["-H", "beta", "key", "Finder"])

    def test_bound_host_cannot_be_overridden(self):
        self.target.resolve_target.return_value = "beta"
        finder = computer_use.app("Finder", host="beta")
        self.target.resolve_target.reset_mock()
        with self.assertRaises(ValueError):
            self.run_(finder.key("Escape", host="local"))
        self.target.resolve_target.assert_not_called()
        self.assertEqual(self.calls(), [])

    def test_unknown_target_never_starts_local_or_remote(self):
        self.target.resolve_target.side_effect = ValueError("computer-use: unknown host 'missing'")
        with self.assertRaises(computer_use.ComputerUseError) as caught:
            self.run_(computer_use.snap("Finder", host="missing"))
        self.assertEqual(caught.exception.code, 2)
        with self.assertRaises(computer_use.ComputerUseError):
            computer_use.app("Finder", host="missing")
        self.assertEqual(self.calls(), [])

    def test_remote_diff_and_shot_are_wrapped(self):
        self.target.resolve_target.return_value = "beta"
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            self.reply({"ok": True, "mode": "diff", "changed": True, "added": [{}], "removed": []})
            result = self.run_(computer_use.snap("Finder", host="beta", diff=True))
            self.assertIsInstance(result, computer_use.Diff)
            self.assertTrue(result)
            self.reply({"ok": True, "mode": "shot", "path": "/local/shot.png"})
            self.assertEqual(self.run_(computer_use.shot("Finder", host="beta")), "/local/shot.png")

    def test_concurrent_host_bindings_do_not_leak(self):
        self.target.resolve_target.side_effect = lambda tool, host=None: host or "local"
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            async def go():
                await asyncio.gather(computer_use.app("Finder", host="a").key("Escape"), computer_use.app("Finder", host="b").key("Escape"))
            self.run_(go())
        self.assertEqual({tuple(c[:2]) for c in self.calls()}, {("-H", "a"), ("-H", "b")})
        self.assertIsNone(computer_use._target_host.get())

    def test_host_signature_and_app_inheritance(self):
        import inspect
        self.assertIn("host", inspect.signature(computer_use.snap).parameters)
        self.assertIn("host", inspect.signature(computer_use.wake).parameters)
        self.assertIn("host", inspect.signature(computer_use.App.snap).parameters)
        self.target.resolve_target.return_value = "beta"
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            self.run_(computer_use.app("Finder", host="beta").key("Escape"))
        self.assertTrue(all(call == mock.call("computer-use", host="beta") for call in self.target.resolve_target.call_args_list))


    def test_real_shared_selection_default_remote_never_starts_local_serve(self):
        from agentkit.remote import target
        with mock.patch.object(computer_use, "_transport", return_value=target), mock.patch.object(target.pins, "read_pin", return_value={"host": "beta"}) as pin, mock.patch.object(target.ssh, "known_hosts", return_value=["beta"]), mock.patch.object(computer_use, "_USE_SERVE", True), mock.patch.object(computer_use._server, "call", mock.AsyncMock(side_effect=AssertionError("默认远程不能本机serve"))), mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            self.reply(SNAP)
            self.run_(computer_use.app("Finder").snap())
            pin.assert_called_once_with("computer-use")
            self.assertEqual(self.calls()[0][:4], ["-H", "beta", "snap", "Finder"])
            with mock.patch.object(computer_use, "_USE_SERVE", False):
                self.run_(computer_use.snap("Finder", host="local"))
            self.assertEqual(self.calls()[-1][0], "snap")


    def test_bound_app_keeps_creation_target_after_pin_changes(self):
        current = ["beta"]
        self.target.resolve_target.side_effect = lambda tool, host=None: host or current[0]
        self.reply(SNAP)
        with mock.patch.object(computer_use, "_LAUNCHER", self.stub):
            finder = computer_use.app("Finder")
            self.run_(finder.snap())
            current[0] = "other-mac"
            self.run_(finder.click(id="Seven"))
        self.assertEqual(finder.host, "beta")
        self.assertEqual([call[:2] for call in self.calls()], [["-H", "beta"], ["-H", "beta"]])


class Boundaries(Case):
    def test_actual_swift_flags_are_literal_text(self):
        source = computer_use.build.SOURCE.read_text()
        flags = set(re.findall(r'(?:hasFlag|flagValue)\("([^"]+)"\)', source))
        self.assertTrue(flags)
        for text in flags:
            with self.subTest(text=text):
                self.run_(computer_use.type_text("Finder", text))
                self.assertEqual(self.calls()[-1][-2:], ["--", text])

    def test_text_substrings_spaces_shell_symbols_are_not_options(self):
        for text in ("-H", "-Hmini-mm", "--local", "--host", "--host=beta", "--", "--json hello", "a --no-settle", "$(touch x); 'quoted'", "第一行\n第二行"):
            self.run_(computer_use.paste("Finder", text))
            self.assertEqual(self.calls()[-1][-1], text)

    def test_numeric_boundaries_refuse_before_dispatch(self):
        calls = [computer_use.click("Finder", True), computer_use.click("Finder", 1.9), computer_use.click("Finder", 0),
                 computer_use.click("Finder", 1, count=0), computer_use.click("Finder", 1, button="middle"),
                 computer_use.snap("Finder", max=-1), computer_use.snap("Finder", depth=0), computer_use.snap("Finder", window=0),
                 computer_use.shot("Finder", shrink=-1), computer_use.scroll("Finder", 1, pages=float("nan")),
                 computer_use.drag("Finder", (float("inf"), 2), (3, 4)), computer_use.paste("Finder", "x", settle=-1),
                 computer_use.cli("perms", timeout=0), computer_use.type_text("Finder", "a\x00b")]
        for call in calls:
            with self.assertRaises((ValueError, TypeError)):
                self.run_(call)
        self.assertEqual(self.calls(), [])
        self.target.resolve_target.assert_not_called()


class Help(unittest.TestCase):
    def test_swift_help_exposes_shared_target_controls(self):
        source = computer_use.build.SOURCE.read_text()
        usage = source.split('let usage = """', 1)[1].split('"""', 1)[0]
        for text in ("computer-use -H <host>", "computer-use --host <host>", "computer-use use <host>", "computer-use pin", "computer-use hosts", "computer-use use --clear", "选项放在命令前", "remotePath"):
            with self.subTest(text=text):
                self.assertIn(text, usage)


class Launcher(unittest.TestCase):
    def test_dispatch_runs_before_build_and_handled_remote_exits(self):
        path = Path(__file__).resolve().parents[1] / "src" / "computer_use" / "commands.py"
        loader = importlib.machinery.SourceFileLoader("computer_use_launcher_test", str(path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        launcher = importlib.util.module_from_spec(spec)
        loader.exec_module(launcher)
        dispatch = mock.Mock(return_value=(["snap", "Finder"], 7))
        target = mock.Mock(dispatch=dispatch)
        with mock.patch.dict(sys.modules, {"agentkit.remote.target": target}), mock.patch.object(sys, "argv", [str(path), "-H", "beta", "snap", "Finder"]), mock.patch.object(launcher.importlib.util, "spec_from_file_location", side_effect=AssertionError("不能先构建")):
            self.assertEqual(launcher.main(), 7)
        dispatch.assert_called_once_with("computer-use", ["-H", "beta", "snap", "Finder"])

    def test_text_capabilities_reaches_dispatch_not_local_handshake(self):
        path = Path(__file__).resolve().parents[1] / "src" / "computer_use" / "commands.py"
        loader = importlib.machinery.SourceFileLoader("computer_use_launcher_text", str(path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        launcher = importlib.util.module_from_spec(spec)
        loader.exec_module(launcher)
        argv = ["--local", "type", "Finder", "--", "--capabilities"]
        dispatch = mock.Mock(return_value=(argv, 2))
        with mock.patch.dict(sys.modules, {"agentkit.remote.target": mock.Mock(dispatch=dispatch)}), mock.patch.object(sys, "argv", [str(path), *argv]):
            self.assertEqual(launcher.main(), 2)
        dispatch.assert_called_once_with("computer-use", argv)

    def test_local_dispatch_clean_arguments_reach_binary(self):
        path = Path(__file__).resolve().parents[1] / "src" / "computer_use" / "commands.py"
        loader = importlib.machinery.SourceFileLoader("computer_use_launcher_local", str(path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        launcher = importlib.util.module_from_spec(spec)
        loader.exec_module(launcher)
        dispatch = mock.Mock(return_value=(["--version"], None))
        build = mock.Mock()
        build.ensure_binary.return_value = Path("/tmp/local-computer-use")
        with mock.patch.dict(sys.modules, {"agentkit.remote.target": mock.Mock(dispatch=dispatch)}), mock.patch.object(sys, "argv", [str(path), "-H", "local", "--version"]), mock.patch.object(launcher.importlib.util, "spec_from_file_location", return_value=mock.Mock()), mock.patch.object(launcher.importlib.util, "module_from_spec", return_value=build), mock.patch.object(launcher.os, "execv") as execute:
            launcher.main()
        execute.assert_called_once_with("/tmp/local-computer-use", ["/tmp/local-computer-use", "--version"])


if __name__ == "__main__":
    unittest.main()
