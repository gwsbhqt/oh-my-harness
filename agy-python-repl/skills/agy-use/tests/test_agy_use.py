"""使用专用目录和可执行测试替身，检查官方命令边界及故障回执。"""
import asyncio
import json
import os
import shlex
import signal
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
    f.write(json.dumps({"args": args, "cwd": os.getcwd(), "pid": os.getpid(), "has_stdin": bool(sys.stdin.read())}) + "\n")
if args == ["--version"]:
    print("1.0.0")
elif args == ["models"]:
    print("sample-chat   Sample Chat")
    print("catalog message", file=sys.stderr)
    sys.exit(int(os.environ.get("AGY_USE_TEST_CATALOG_EXIT", "0")))
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
        ending = "\r\n" if prompt == "crlf" else "\n"
        if name == "result" and prompt == "no-final-lf":
            ending = ""
        payload = json.dumps({"event": name, **parts}, ensure_ascii=False)
        sys.stdout.buffer.write((payload + ending).encode("utf-8"))
        sys.stdout.buffer.flush()
    event("init", conversation_id="sample-thread", init={"tools": ["run_command", "call_mcp_tool"]})
    if prompt == "long-turn":
        time.sleep(2.2)
    if prompt == "pause":
        print("waiting", file=sys.stderr, flush=True)
        log.with_suffix(".ready").touch()
        time.sleep(30)
    if prompt == "broken":
        print("incomplete-json")
        sys.exit(0)
    result = {"conversation_id": "sample-thread", "status": "SUCCESS", "response": "READY"}
    if prompt in ("u0085", "u2028", "u2029"):
        text = "前" + chr(int(prompt[1:], 16)) + "后"
        event("step_update", step_update={"conversation_id": "sample-thread", "step_index": 1,
              "step_type": "agent_response", "state": "DONE", "text_delta": text})
        result.update(response=text)
    if prompt == "denied":
        event("step_update", step_update={"conversation_id": "sample-thread", "step_index": 2,
              "step_type": "tool", "state": "ERROR", "tool_name": "call_mcp_tool",
              "tool_info": {"parameters": {"name": "sample_tool"}, "error": {"message": "denied"}}})
        result.update(response="", denied_actions=[{"action": "mcp"}])
    elif prompt == "empty":
        result.update(response="")
    elif prompt == "interrupted":
        result.update(status="INTERRUPTED", response="partial")
    elif prompt in ("quota", "quota-and-wait"):
        result.update(status="ERROR", response="", error="Individual quota reached for this example.")
        event("result", result=result)
        if prompt == "quota-and-wait":
            time.sleep(30)
        sys.exit(3)
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
        script = self.directory / "fake_agy.py"
        script.write_text(FAKE_AGY, encoding="utf-8")
        command = self.directory / "agy"
        invocation = shlex.join([sys.executable, str(script)])
        command.write_text(f'#!/bin/sh\nexec {invocation} "$@"\n', encoding="utf-8")
        command.chmod(0o755)
        self.enterContext(patch.dict(os.environ, {
            "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
            "AGY_USE_TEST_LOG": str(self.log),
        }))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    async def test_status_plugin_list_and_validation_failure(self):
        version = await agy_use.cli_status()
        self.assertEqual(version["executable"], str(self.directory / "agy"))
        self.assertEqual(version["stdout"], "1.0.0\n")
        self.assertTrue(version["ok"])
        plugins = await agy_use.cli_plugins()
        self.assertEqual(plugins["data"], [{"name": "sample", "enabled": False}])
        archive = self.directory / "example.zip"
        archive.touch()
        check = await agy_use.cli_validate_plugin(archive, strict=True)
        self.assertFalse(check["ok"])
        self.assertEqual(check["exit_code"], 3)
        self.assertEqual(check["stderr"], "validation failed\n")
        self.assertEqual(check["data"]["findings"][0]["severity"], "error")
        self.assertEqual([c["args"] for c in self.calls()], [["--version"], ["plugin", "list", "--json"],
                        ["plugin", "validate", str(archive), "--json", "--strict"]])

    async def test_models_returns_native_output_and_exit_from_both_entries(self):
        launcher = [sys.executable, str(SKILL / "scripts/agy-use"), "cli-models"]
        for code in (0, 6):
            with self.subTest(code=code), patch.dict(os.environ, {"AGY_USE_TEST_CATALOG_EXIT": str(code)}):
                reply = await agy_use.cli_models()
                self.assertEqual(reply["ok"], code == 0)
                self.assertEqual(reply["exit_code"], code)
                self.assertEqual(reply["stdout"], "sample-chat   Sample Chat\n")
                self.assertEqual(reply["stderr"], "catalog message\n")
                cli = subprocess.run(launcher, capture_output=True, text=True, cwd=self.workspace, check=False)
                self.assertEqual(cli.returncode, code, cli.stderr)
                self.assertEqual(json.loads(cli.stdout), reply)
        self.assertEqual([c["args"] for c in self.calls()], [["models"]] * 4)

    async def test_zero_waits_for_native_completion_and_propagates_a_native_error(self):
        # The fixture runs longer than the grace period for a positive native timeout.
        async with asyncio.timeout(10):
            reply = await agy_use.cli_run("long-turn", self.workspace, timeout=0)
        self.assertTrue(reply["ok"], reply)
        self.assertFalse(reply["timed_out"])
        self.assertEqual(reply["result"]["response"], "READY")
        cli = subprocess.run([sys.executable, str(SKILL / "scripts/agy-use"), "cli-run", "--workspace", str(self.workspace),
                              "--timeout", "0", "quota"], capture_output=True, text=True, cwd=self.workspace, check=False)
        self.assertEqual(cli.returncode, 3, cli.stderr)
        failed = json.loads(cli.stdout)
        self.assertFalse(failed["ok"])
        self.assertFalse(failed["timed_out"])
        self.assertEqual(failed["error"], failed["result"]["error"])
        first, second = self.calls()
        self.assertEqual(first["args"], ["--output-format=stream-json", "--print-timeout=0", "--print=long-turn"])
        self.assertEqual(second["args"], ["--output-format=stream-json", "--print-timeout=0", "--print=quota"])

    async def test_new_thread_and_explicit_continuation(self):
        prompt = "--dangerously-skip-permissions $(example)\n第二行"
        reply = await agy_use.cli_run(prompt, self.workspace)
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["workspace"], str(self.workspace))
        self.assertEqual(reply["result"]["response"], "READY")
        self.assertEqual([e["event"] for e in reply["events"]], ["init", "result"])
        again = await agy_use.cli_run("more", self.workspace, conversation_id=reply["result"]["conversation_id"],
                                      model="example model", timeout=2.25)
        self.assertTrue(again["ok"])
        first, second = self.calls()
        self.assertEqual(first["cwd"], str(self.workspace))
        self.assertFalse(first["has_stdin"])
        self.assertEqual(first["args"], ["--output-format=stream-json", "--print-timeout=120000ms", "--print=" + prompt])
        self.assertEqual(second["args"], ["--output-format=stream-json", "--print-timeout=2250ms",
                         "--conversation=sample-thread", "--model=example model", "--print=more"])

    async def test_unicode_separators_remain_in_text_events(self):
        for prompt, separator in (("u0085", "\u0085"), ("u2028", "\u2028"), ("u2029", "\u2029")):
            with self.subTest(prompt=prompt):
                reply = await agy_use.cli_run(prompt, self.workspace)
                expected = "前" + separator + "后"
                self.assertIn(expected, reply["stdout"])
                self.assertTrue(reply["ok"], reply.get("output_error"))
                self.assertEqual([e["event"] for e in reply["events"]], ["init", "step_update", "result"])
                self.assertEqual(reply["events"][1]["step_update"]["text_delta"], expected)
                self.assertEqual(reply["result"]["response"], expected)

    async def test_jsonl_accepts_crlf_and_final_record_without_lf(self):
        for prompt, ending in (("crlf", "\r\n"), ("no-final-lf", "}")):
            with self.subTest(prompt=prompt):
                reply = await agy_use.cli_run(prompt, self.workspace)
                self.assertTrue(reply["stdout"].endswith(ending))
                self.assertTrue(reply["ok"], reply.get("output_error"))
                self.assertEqual([e["event"] for e in reply["events"]], ["init", "result"])
                self.assertEqual(reply["result"]["response"], "READY")

    async def test_repl_permission_requires_an_explicit_boolean(self):
        with self.assertRaises(ValueError):
            await agy_use.cli_run("sample", self.workspace, allow_repl="true")
        reply = await agy_use.cli_run("sample", self.workspace, allow_repl=True)
        self.assertTrue(reply["ok"])
        launcher = [sys.executable, str(SKILL / "scripts/agy-use")]
        cli = subprocess.run([*launcher, "cli-run", "--workspace", str(self.workspace), "--allow-repl", "sample"],
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
        denied = await agy_use.cli_run("denied", self.workspace)
        self.assertFalse(denied["ok"])
        self.assertEqual((denied["exit_code"], denied["result"]["status"]), (0, "SUCCESS"))
        self.assertEqual(denied["result"]["denied_actions"], [{"action": "mcp"}])
        self.assertEqual(denied["events"][1]["step_update"]["state"], "ERROR")
        empty = await agy_use.cli_run("empty", self.workspace)
        self.assertFalse(empty["ok"])
        interrupted = await agy_use.cli_run("interrupted", self.workspace)
        self.assertFalse(interrupted["ok"])
        self.assertEqual(interrupted["result"]["status"], "INTERRUPTED")
        broken = await agy_use.cli_run("broken", self.workspace)
        self.assertFalse(broken["ok"])
        self.assertEqual(broken["events"][0]["event"], "init")
        self.assertIn("output_error", broken)
        self.assertIn("incomplete-json", broken["stdout"])
        self.assertEqual(len(self.calls()), 4)

    async def test_native_error_in_receipt_and_local_timeout_precedence(self):
        expected = "Individual quota reached for this example."
        failed = await agy_use.cli_run("quota", self.workspace)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["exit_code"], 3)
        self.assertEqual(failed["result"]["status"], "ERROR")
        self.assertEqual(failed["events"][-1]["result"]["error"], expected)
        self.assertEqual(failed.get("error"), expected)
        timed_out = await agy_use.cli_run("quota-and-wait", self.workspace, timeout=0.05)
        self.assertTrue(timed_out["timed_out"])
        self.assertIn("等待 AGY CLI 超过", timed_out["error"])
        self.assertEqual(timed_out["result"]["error"], expected)
        self.assertEqual(len(self.calls()), 2)

    async def test_wrong_resumed_session_does_not_report_success_or_retry(self):
        reply = await agy_use.cli_run("more", self.workspace, conversation_id="other-thread")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["exit_code"], 0)
        self.assertEqual(reply["result"]["conversation_id"], "sample-thread")
        self.assertIn("--conversation=other-thread", self.calls()[0]["args"])
        self.assertEqual(len(self.calls()), 1)

    async def test_timeout_preserves_partial_outputs_without_retry(self):
        reply = await agy_use.cli_run("pause", self.workspace, timeout=0.1)
        self.assertTrue(reply["timed_out"])
        self.assertFalse(reply["ok"])
        self.assertIsNotNone(reply["exit_code"])
        self.assertEqual(reply["events"][0]["conversation_id"], "sample-thread")
        self.assertEqual(reply["stderr"], "waiting\n")
        self.assertNotIn("result", reply)
        self.assertEqual(len(self.calls()), 1)

    async def wait_until_paused(self):
        async with asyncio.timeout(5):
            while not self.log.with_suffix(".ready").is_file():
                await asyncio.sleep(0.01)

    def assert_cancelled_receipt(self, receipt):
        self.assertTrue(receipt["cancelled"])
        self.assertIn("sample-thread", receipt["stdout"])
        self.assertEqual(receipt["stderr"], "waiting\n")
        self.assertFalse(receipt["timed_out"])
        self.assertFalse(receipt["ok"])
        self.assertIsNotNone(receipt["exit_code"])
        if os.name == "posix":
            with self.assertRaises(ProcessLookupError):
                os.kill(self.calls()[-1]["pid"], 0)

    async def test_cancel_preserves_partial_output_without_retry(self):
        for timeout in (120, 0):
            with self.subTest(timeout=timeout):
                self.log.with_suffix(".ready").unlink(missing_ok=True)
                task = asyncio.create_task(agy_use.cli_run("pause", self.workspace, timeout=timeout))
                await self.wait_until_paused()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError) as caught:
                    await task
                self.assert_cancelled_receipt(caught.exception.receipt)
        self.assertEqual(len(self.calls()), 2)

    @unittest.skipUnless(os.name == "posix", "requires POSIX signals")
    async def test_cli_interrupts_unbounded_run_and_reports_partial_output(self):
        cli = await asyncio.create_subprocess_exec(
            sys.executable, str(SKILL / "scripts/agy-use"), "cli-run", "--workspace", str(self.workspace),
            "--timeout", "0", "pause", cwd=self.workspace,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            await self.wait_until_paused()
            cli.send_signal(signal.SIGINT)
            async with asyncio.timeout(5):
                stdout, stderr = await cli.communicate()
            self.assertEqual(cli.returncode, 130, stderr)
            self.assert_cancelled_receipt(json.loads(stdout))
            self.assertEqual(len(self.calls()), 1)
        finally:
            if cli.returncode is None:
                cli.kill()
                await cli.wait()

    async def test_invalid_target_or_timeout_does_not_launch(self):
        for timeout in (True, False, -1, float("nan"), float("inf"), -float("inf"), None):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                await agy_use.cli_run("test", self.workspace, timeout=timeout)
        for function, args in [(agy_use.cli_status, ()), (agy_use.cli_models, ()), (agy_use.cli_plugins, ()),
                               (agy_use.cli_validate_plugin, (self.workspace,)), (agy_use.cli_install_plugin, (self.workspace,))]:
            with self.subTest(function=function), self.assertRaises(ValueError):
                await function(*args, timeout=0)
        with self.assertRaises(ValueError):
            await agy_use.cli_run(" ", self.workspace)
        with self.assertRaises(FileNotFoundError):
            await agy_use.cli_run("test", self.directory / "absent")
        with self.assertRaises(NotADirectoryError):
            await agy_use.cli_install_plugin(self.directory / "agy")
        self.assertFalse(self.log.exists())

    def test_cli_uses_python_functions_and_keeps_original_exit(self):
        launcher = [sys.executable, str(SKILL / "scripts/agy-use")]
        install = subprocess.run([*launcher, "cli-install-plugin", str(self.workspace)], capture_output=True,
                                 text=True, cwd=self.workspace, check=False)
        self.assertEqual(install.returncode, 7, install.stderr)
        receipt = json.loads(install.stdout)
        self.assertEqual(receipt["stderr"], "installation declined\n")
        self.assertEqual(receipt["stdout"], "partial install receipt\n")
        denied = subprocess.run([*launcher, "cli-run", "--workspace", str(self.workspace), "denied"],
                                capture_output=True, text=True, cwd=self.workspace, check=False)
        self.assertEqual(denied.returncode, 1, denied.stderr)
        self.assertEqual(json.loads(denied.stdout)["exit_code"], 0)
        self.assertEqual(self.calls()[0]["args"], ["plugin", "install", str(self.workspace)])
        self.assertEqual(len(self.calls()), 2)


if __name__ == "__main__":
    unittest.main()
