"""验证真实子进程传参、退出码、回执和取消，不连接日常 DSH。"""
import asyncio
import json
import inspect
import importlib.util
import shutil
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skills/dsh-control/src"))
import dsh_control


class Wrapper(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-control-python-")
        self.root = Path(self.temp.name)
        self.cli = self.root / "dsh-control"
        self.cli.write_text("#!" + sys.executable + "\n" + r'''
import json, os, sys, time
args = sys.argv[1:]
code = next((int(x.split("=", 1)[1]) for x in args if x.startswith("--fixture-code=")), 0)
receipt = {"sent": True, "requestId": "request-fixture", "sessionId": "session-fixture", "since": 42}
result = {"ok": code in (0, 10, 11, 124), "status": {0:"completed", 10:"waiting-input", 11:"idle", 124:"timeout"}.get(code, "failed"), "data": {"argv": args}, "receipt": receipt, "meta": {"complete": True}}
if code not in (0, 10, 11, 124):
    result["error"] = {"code": "fixture-failed", "message": "中文失败"}
print("纯文本输出" if "--plain" in args or "--malformed" in args else json.dumps(result, ensure_ascii=False), flush=True)
print("诊断信息", file=sys.stderr, flush=True)
if "--block" in args:
    marker = next(x.split("=", 1)[1] for x in args if x.startswith("--marker="))
    with open(marker, "w") as out: out.write(str(os.getpid()))
    time.sleep(60)
sys.exit(code)
''')
        self.cli.chmod(0o700)
        self.patcher = patch.object(dsh_control, "_COMMAND", self.cli)
        self.patcher.start()

    async def asyncTearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    async def test_failure_and_wait_statuses_preserve_exit_codes_and_receipts(self):
        for code in (0, 1, 2, 10, 11, 69, 124):
            result = await dsh_control.chat("session-fixture", "中文 空格 $HOME ; --host", fixture_code=code)
            self.assertEqual(result["exit_code"], code)
            self.assertEqual(result["receipt"]["since"], 42)
            self.assertTrue(result["meta"]["complete"])
            self.assertIn("诊断信息", result["stderr"])
            self.assertIn("--", result["data"]["argv"])
            self.assertEqual(result["data"]["argv"][-1], "中文 空格 $HOME ; --host")
            if code in (1, 2, 69):
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "fixture-failed")

    async def test_effort_is_forwarded_for_model_and_new(self):
        for command in (dsh_control.model, dsh_control.new):
            result = await command("目标", effort="high")
            self.assertIn("--effort=high", result["data"]["argv"])

    async def test_routing_and_json_options_stay_structured(self):
        result = await dsh_control.answer("session-fixture", host="gamma", json={"answers": [{"id": "q", "custom": "--json 中文"}]}, select=["蓝色", "绿色"], call_id="call-fixture")
        args = result["data"]["argv"]
        self.assertEqual(args[:4], ["-H", "gamma", "answer", "--json"])
        self.assertIn('--json={"answers": [{"id": "q", "custom": "--json 中文"}]}', args)
        self.assertIn("--select=蓝色", args)
        self.assertIn("--select=绿色", args)
        self.assertIn("--call-id=call-fixture", args)
        local = await dsh_control.sessions(local=True, include_blank=True, all=False, limit=0)
        self.assertEqual(local["data"]["argv"], ["--local", "sessions", "--json", "--include-blank", "--limit=0"])
        for options in ({"host": "beta", "local": True}, {"host": ""}, {"limit": float("nan")}, {"json": True}):
            with self.assertRaises((ValueError, TypeError)):
                await dsh_control.sessions(**options)

    async def test_notify_false_values_turn_off_each_default(self):
        default = await dsh_control.notify(local=True)
        self.assertEqual(default["data"]["argv"], ["--local", "notify", "--json"])
        body = await dsh_control.notify("正文有 空格", sound=False)
        self.assertEqual(body["data"]["argv"], ["notify", "--json", "--no-sound", "--", "正文有 空格"])
        title = await dsh_control.notify(title="标题", body=False, sound=False)
        self.assertEqual(title["data"]["argv"], ["notify", "--json", "--title=标题", "--no-body", "--no-sound"])
        sound = await dsh_control.notify(title=False, body=False)
        self.assertEqual(sound["data"]["argv"], ["notify", "--json", "--no-title", "--no-body"])

    async def test_cancel_collects_output_kills_local_process_and_never_replays(self):
        marker = self.root / "started.pid"
        task = asyncio.create_task(dsh_control.chat("session-fixture", "继续", block=True, marker=marker))
        async with asyncio.timeout(5):
            while not marker.exists():
                await asyncio.sleep(0.01)
        pid = int(marker.read_text())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught:
            await task
        self.assertTrue(caught.exception.result["cancelled"])
        self.assertEqual(caught.exception.result["receipt"]["requestId"], "request-fixture")
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_plain_local_commands_and_malformed_protocol_are_explicit(self):
        success = await dsh_control.help(plain=True)
        self.assertTrue(success["ok"])
        self.assertIn("纯文本输出", success["text"])
        failed = await dsh_control.start(plain=True, fixture_code=1)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["exit_code"], 1)
        self.assertEqual(failed["error"]["code"], "cli-failed")
        malformed = await dsh_control.health(malformed=True)
        self.assertEqual(malformed["exit_code"], 0)
        self.assertFalse(malformed["ok"])
        self.assertEqual(malformed["error"]["code"], "invalid-cli-output")

    async def test_cancellation_is_not_replaced_by_a_simultaneous_spawn_failure(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def fail_spawn(*args, **kwargs):
            started.set()
            await finish.wait()
            raise FileNotFoundError("取消时启动失败")
        with patch.object(dsh_control.asyncio, "create_subprocess_exec", fail_spawn):
            task = asyncio.create_task(dsh_control.health())
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            finish.set()
            with self.assertRaises(asyncio.CancelledError) as caught:
                await task
        self.assertTrue(caught.exception.result["cancelled"])
        self.assertEqual(caught.exception.result["error"]["code"], "launcher-unavailable")

    async def test_installed_layout_uses_only_the_canonical_command_on_path(self):
        package = self.root / "installed/site-packages/dsh_control"
        package.mkdir(parents=True)
        source = package / "__init__.py"
        shutil.copyfile(dsh_control.__file__, source)
        spec = importlib.util.spec_from_file_location("installed_dsh_control_fixture", source)
        installed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installed)
        self.assertEqual(installed._COMMAND, "dsh-control")
        with patch.dict(os.environ, {"PATH": str(self.root)}):
            result = await installed.sessions(running=True)
        self.assertEqual(result["exit_code"], 0, result)
        self.assertEqual(result["data"]["argv"], ["sessions", "--json", "--running"])
        with patch.dict(os.environ, {"PATH": str(self.root / "empty")}):
            missing = await installed.health()
        self.assertEqual(missing["error"]["code"], "launcher-unavailable")
        self.assertIsNone(missing["exit_code"])

    async def test_source_layout_prefers_its_own_launcher_over_path(self):
        spec = importlib.util.spec_from_file_location("source_dsh_control_fixture", dsh_control.__file__)
        source = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"PATH": str(self.root)}):
            spec.loader.exec_module(source)
        self.assertEqual(source._COMMAND, ROOT / "bin/dsh-control")

    async def test_missing_launcher_is_structured_failure(self):
        with patch.object(dsh_control, "_COMMAND", self.root / "absent"), patch.dict(os.environ, {"PATH": str(self.root)}):
            result = await dsh_control.health()
        self.assertFalse(result["ok"])
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["error"]["code"], "launcher-unavailable")

    async def test_real_launcher_offline_capabilities(self):
        with patch.object(dsh_control, "_COMMAND", ROOT / "bin/dsh-control"):
            result = await dsh_control.capabilities(local=True)
        self.assertEqual(result["exit_code"], 0, result)
        self.assertEqual(result["tool"], "dsh-control")
        self.assertIn("task-outcomes", result["features"])


class Coverage(unittest.TestCase):
    def test_every_existing_command_has_an_async_function(self):
        sources = [(ROOT / "src/commands.ts").read_text(), (ROOT / "src/cli/core.ts").read_text()]
        commands = set(re.findall(r"\{ name: '([^']+)'", "\n".join(sources))) | {"use", "pin", "hosts", "capabilities"}
        for command in commands:
            self.assertTrue(inspect.iscoroutinefunction(getattr(dsh_control, command.replace("-", "_"))), command)


if __name__ == "__main__":
    unittest.main()
