"""使用专用目录和可执行测试替身，检查官方命令边界及故障回执。"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "src"))
import agy_use


FAKE_AGY = r'''import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
log = Path(os.environ["AGY_USE_TEST_LOG"])
with log.open("a") as f:
    f.write(json.dumps({"args": args, "cwd": os.getcwd(), "has_stdin": bool(sys.stdin.read())}) + "\n")
if args == ["--version"]:
    print("1.0.0")
elif args[:2] == ["plugin", "list"]:
    print(json.dumps([{"name": "sample", "enabled": False}]))
elif args[:2] == ["plugin", "validate"]:
    print(json.dumps({"findings": [{"severity": "error", "message": "missing manifest"}]}))
    print("validation failed", file=sys.stderr)
    sys.exit(3)
elif args[:2] == ["plugin", "install"]:
    print("partial install receipt")
    print("installation declined", file=sys.stderr)
    sys.exit(7)
else:
    prompt = next(a.removeprefix("--print=") for a in args if a.startswith("--print="))
    def event(name, **parts):
        print(json.dumps({"event": name, **parts}), flush=True)
    event("init", conversation_id="sample-thread", init={"tools": ["run_command", "call_mcp_tool"]})
    if prompt == "pause":
        print("waiting", file=sys.stderr, flush=True)
        log.with_suffix(".ready").touch()
        time.sleep(30)
    if prompt == "broken":
        print("incomplete-json")
        sys.exit(0)
    result = {"conversation_id": "sample-thread", "status": "SUCCESS", "response": "READY"}
    if prompt == "denied":
        event("step_update", step_update={"conversation_id": "sample-thread", "step_index": 2,
              "step_type": "tool", "state": "ERROR", "tool_name": "call_mcp_tool",
              "tool_info": {"parameters": {"name": "sample_tool"}, "error": {"message": "denied"}}})
        result.update(response="", denied_actions=[{"action": "mcp"}])
    elif prompt == "empty":
        result.update(response="")
    elif prompt == "interrupted":
        result.update(status="INTERRUPTED", response="partial")
    event("result", result=result)
'''


class AgyUseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="agy-use-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name).resolve()
        self.workspace = self.directory / "example workspace"
        self.workspace.mkdir()
        self.log = self.directory / "calls.jsonl"
        command = self.directory / "agy"
        command.write_text(f"#!{sys.executable}\n" + FAKE_AGY, encoding="utf-8")
        command.chmod(0o755)
        self.enterContext(patch.dict(os.environ, {
            "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
            "AGY_USE_TEST_LOG": str(self.log),
        }))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    async def test_status_plugin_list_and_validation_failure(self):
        version = await agy_use.status()
        self.assertEqual(version["executable"], str(self.directory / "agy"))
        self.assertEqual(version["stdout"], "1.0.0\n")
        self.assertTrue(version["ok"])
        plugins = await agy_use.plugins()
        self.assertEqual(plugins["data"], [{"name": "sample", "enabled": False}])
        archive = self.directory / "example.zip"
        archive.touch()
        check = await agy_use.validate_plugin(archive, strict=True)
        self.assertFalse(check["ok"])
        self.assertEqual(check["exit_code"], 3)
        self.assertEqual(check["stderr"], "validation failed\n")
        self.assertEqual(check["data"]["findings"][0]["severity"], "error")
        self.assertEqual([c["args"] for c in self.calls()], [["--version"], ["plugin", "list", "--json"],
                        ["plugin", "validate", str(archive), "--json", "--strict"]])

    async def test_new_thread_and_explicit_continuation(self):
        prompt = "--dangerously-skip-permissions $(example)\n第二行"
        reply = await agy_use.run(prompt, self.workspace)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["workspace"], str(self.workspace))
        self.assertEqual(reply["result"]["response"], "READY")
        self.assertEqual([e["event"] for e in reply["events"]], ["init", "result"])
        again = await agy_use.run("more", self.workspace, conversation_id=reply["result"]["conversation_id"],
                                  model="example model", timeout=2.25)
        self.assertTrue(again["ok"])
        first, second = self.calls()
        self.assertEqual(first["cwd"], str(self.workspace))
        self.assertFalse(first["has_stdin"])
        self.assertEqual(first["args"], ["--output-format=stream-json", "--print-timeout=120000ms", "--print=" + prompt])
        self.assertEqual(second["args"], ["--output-format=stream-json", "--print-timeout=2250ms",
                         "--conversation=sample-thread", "--model=example model", "--print=more"])

    async def test_repl_permission_requires_an_explicit_boolean(self):
        with self.assertRaises(ValueError):
            await agy_use.run("sample", self.workspace, allow_repl="true")
        reply = await agy_use.run("sample", self.workspace, allow_repl=True)
        self.assertTrue(reply["ok"])
        launcher = [sys.executable, str(SKILL / "scripts/agy-use")]
        cli = subprocess.run([*launcher, "run", "--workspace", str(self.workspace), "--allow-repl", "sample"],
                             capture_output=True, text=True, cwd=self.workspace, check=False)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        first, second = self.calls()
        self.assertEqual(first["args"], second["args"])
        settings, = [arg.removeprefix("--settings=") for arg in first["args"] if arg.startswith("--settings=")]
        self.assertEqual(json.loads(settings), {
            "permissions": {"allow": ["mcp(agy-python-repl_agy-python-repl/run_code)"]}
        })
        self.assertNotIn("--dangerously-skip-permissions", first["args"])

    async def test_denied_empty_interrupted_and_damaged_output(self):
        denied = await agy_use.run("denied", self.workspace)
        self.assertFalse(denied["ok"])
        self.assertEqual((denied["exit_code"], denied["result"]["status"]), (0, "SUCCESS"))
        self.assertEqual(denied["result"]["denied_actions"], [{"action": "mcp"}])
        self.assertEqual(denied["events"][1]["step_update"]["state"], "ERROR")
        empty = await agy_use.run("empty", self.workspace)
        self.assertFalse(empty["ok"])
        interrupted = await agy_use.run("interrupted", self.workspace)
        self.assertFalse(interrupted["ok"])
        self.assertEqual(interrupted["result"]["status"], "INTERRUPTED")
        broken = await agy_use.run("broken", self.workspace)
        self.assertFalse(broken["ok"])
        self.assertEqual(broken["events"][0]["event"], "init")
        self.assertIn("output_error", broken)
        self.assertIn("incomplete-json", broken["stdout"])
        self.assertEqual(len(self.calls()), 4)

    async def test_wrong_resumed_session_does_not_report_success_or_retry(self):
        reply = await agy_use.run("more", self.workspace, conversation_id="other-thread")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["exit_code"], 0)
        self.assertEqual(reply["result"]["conversation_id"], "sample-thread")
        self.assertIn("--conversation=other-thread", self.calls()[0]["args"])
        self.assertEqual(len(self.calls()), 1)

    async def test_timeout_preserves_partial_outputs_without_retry(self):
        reply = await agy_use.run("pause", self.workspace, timeout=0.1)
        self.assertTrue(reply["timed_out"])
        self.assertFalse(reply["ok"])
        self.assertIsNotNone(reply["exit_code"])
        self.assertEqual(reply["events"][0]["conversation_id"], "sample-thread")
        self.assertEqual(reply["stderr"], "waiting\n")
        self.assertNotIn("result", reply)
        self.assertEqual(len(self.calls()), 1)

    async def test_cancel_preserves_partial_output_without_retry(self):
        task = asyncio.create_task(agy_use.run("pause", self.workspace))
        async with asyncio.timeout(5):
            while not self.log.with_suffix(".ready").is_file():
                await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught:
            await task
        receipt = caught.exception.receipt
        self.assertIn("sample-thread", receipt["stdout"])
        self.assertEqual(receipt["stderr"], "waiting\n")
        self.assertIsNotNone(receipt["exit_code"])
        self.assertEqual(len(self.calls()), 1)

    async def test_invalid_target_or_timeout_does_not_launch(self):
        with self.assertRaises(ValueError):
            await agy_use.run("test", self.workspace, timeout=float("nan"))
        with self.assertRaises(ValueError):
            await agy_use.run(" ", self.workspace)
        with self.assertRaises(FileNotFoundError):
            await agy_use.run("test", self.directory / "absent")
        with self.assertRaises(NotADirectoryError):
            await agy_use.install_plugin(self.directory / "agy")
        self.assertFalse(self.log.exists())

    def test_cli_uses_python_functions_and_keeps_original_exit(self):
        launcher = [sys.executable, str(SKILL / "scripts/agy-use")]
        install = subprocess.run([*launcher, "install-plugin", str(self.workspace)], capture_output=True,
                                 text=True, cwd=self.workspace, check=False)
        self.assertEqual(install.returncode, 7, install.stderr)
        receipt = json.loads(install.stdout)
        self.assertEqual(receipt["stderr"], "installation declined\n")
        self.assertEqual(receipt["stdout"], "partial install receipt\n")
        denied = subprocess.run([*launcher, "run", "--workspace", str(self.workspace), "denied"],
                                capture_output=True, text=True, cwd=self.workspace, check=False)
        self.assertEqual(denied.returncode, 1, denied.stderr)
        self.assertEqual(json.loads(denied.stdout)["exit_code"], 0)
        self.assertEqual(self.calls()[0]["args"], ["plugin", "install", str(self.workspace)])
        self.assertEqual(len(self.calls()), 2)


if __name__ == "__main__":
    unittest.main()
