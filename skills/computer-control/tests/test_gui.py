"""Opt-in real macOS acceptance: COMPUTER_CONTROL_GUI_TESTS=1 python3 -m unittest discover -s tests -p test_gui.py -v."""
import asyncio
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import computer_control

@unittest.skipUnless(sys.platform == "darwin" and os.environ.get("COMPUTER_CONTROL_GUI_TESTS") == "1", "explicit isolated macOS GUI acceptance only")
class OwnershipGUI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cache_root = Path.home() / ".cache" / "computer-control-gui-acceptance"
        cache_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="run-", dir=cache_root)
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.bundle_id = "local.computer_control.acceptance." + uuid.uuid4().hex
        bundle = self.directory / "OwnershipFixture.app"
        executable = bundle / "Contents/MacOS/OwnershipFixture"
        executable.parent.mkdir(parents=True)
        (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": self.bundle_id, "CFBundleExecutable": executable.name,
            "CFBundleName": "computer-control ownership acceptance", "CFBundlePackageType": "APPL", "LSUIElement": True}))
        built = await asyncio.to_thread(subprocess.run, ["xcrun", "swiftc", str(ROOT / "tests/ownership.swift"), "-o", str(executable)], capture_output=True, text=True)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.previous_cache = os.environ.get("XDG_CACHE_HOME")
        os.environ["XDG_CACHE_HOME"] = str(self.directory / "cache")
        self.executable = executable
        self.addAsyncCleanup(self.cleanup_fixture)
        await self.start_fixture()
        self.a = computer_control.app(self.bundle_id, host="local", scope="acceptance-a")
        self.b = computer_control.app(self.bundle_id, host="local", scope="acceptance-b")

    async def start_fixture(self, *args):
        self.proc = await asyncio.create_subprocess_exec(str(self.executable), *args,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.assertEqual((await asyncio.wait_for(self.proc.stdout.readline(), 10)).strip(), b"ready")

    async def cleanup_fixture(self):
        await computer_control.disconnect()
        if self.proc.returncode is None:
            self.proc.terminate()
        output, error = await asyncio.wait_for(self.proc.communicate(), 10)
        if self.previous_cache is None:
            os.environ.pop("XDG_CACHE_HOME", None)
        else:
            os.environ["XDG_CACHE_HOME"] = self.previous_cache
        self.assertFalse(error, error.decode())

    async def cli(self, *args):
        args = list(args)
        args.insert(args.index("--") if "--" in args else len(args), "--json")
        proc = await asyncio.create_subprocess_exec(str(ROOT / "scripts/computer-control"), "--local", *args,
                                                  stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(proc.communicate(), 30)
        try:
            data = json.loads(output)
        except ValueError:
            self.fail(f"CLI did not return JSON: {output!r}, {error!r}")
        return proc.returncode, data

    async def denied(self, awaitable, code=6):
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            await awaitable
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.outcome, "not_sent")

    async def test_close_requests_normal_quit_and_waits_for_process_exit(self):
        await self.a.snap()
        closed = await self.a.close(authorized=True, timeout=5)
        self.assertTrue(closed["requested"] and closed["terminated"])
        self.assertEqual(closed["pid"], self.proc.pid)
        await asyncio.wait_for(self.proc.communicate(), 10)
        self.assertEqual(self.proc.returncode, 0)
        self.assertEqual((await self.a.owner())["ownership"]["owner"], self.a.scope)
        await self.denied(self.b.claim(), 3)
        self.b.lease = self.a.lease
        await self.denied(self.b.release(), 6)
        current_lease = self.a.lease
        self.a.lease = "stale-lease"
        await self.denied(self.a.release(), 4)
        self.a.lease = current_lease
        await self.a.release()
        self.assertIsNone((await self.a.owner())["ownership"]["owner"])
        self.assertEqual(self.proc.returncode, 0, "释放退出应用的记录不能重开应用")

    async def test_close_timeout_reports_still_running_without_force_kill(self):
        await self.a.snap()
        self.proc.terminate()
        await asyncio.wait_for(self.proc.communicate(), 10)
        await self.start_fixture("--refuse-quit")
        code, data = await self.cli("target-close", self.bundle_id, "--authorized", "--timeout", "0.2",
                                    "--scope", self.a.scope, "--lease", self.a.lease)
        self.assertEqual((code, data["outcome"]), (4, "unknown"), data)
        self.assertIn("尚未退出", data["error"])
        self.assertIsNone(self.proc.returncode)
        await self.a.release()

    async def test_tasks_cli_python_and_handoff(self):
        first = await self.a.snap()
        self.assertFalse(first.truncated or first.timed_out)
        await self.denied(self.b.snap())
        await self.denied(self.b.key("Escape"))
        for args in (("click", self.bundle_id, "--id", "city"),
                     ("open", str(self.directory / "OwnershipFixture.app"))):
            code, data = await self.cli(*args, "--scope", self.b.scope)
            self.assertEqual((code, data["outcome"]), (6, "not_sent"))
        final = await self.a.snap(shot=True)
        self.assertTrue(final.screenshot["ok"])
        old_lease, old_snapshot = self.a.lease, final.snapshot
        handed = await self.a.handoff(self.b.scope)
        await self.denied(self.a.key("Escape"), 4)
        code, data = await self.cli("key", self.bundle_id, "--scope", self.a.scope, "--lease", old_lease, "--", "Escape")
        self.assertEqual((code, data["outcome"]), (6, "not_sent"))
        # Same caller name cannot reinterpret a pre-handoff numbered snapshot.
        code, data = await self.cli("click", self.bundle_id, str(final.one(id="city")["idx"]),
                                    "--scope", self.b.scope, "--lease", handed["ownership"]["lease"], "--snapshot", old_snapshot)
        self.assertEqual((code, data["outcome"]), (4, "not_sent"))
        await self.b.snap()
        code, data = await self.cli("element", self.bundle_id, "resolve", "--selector", '{"id":"city"}',
                                    "--scope", self.b.scope, "--lease", old_lease)
        self.assertEqual((code, data["outcome"]), (4, "not_sent"))
        await self.b.release()
        self.assertIsNone((await self.b.owner())["ownership"]["owner"])
        await self.denied(self.b.snap(), 4)
        await self.b.claim()
        await self.b.snap()
        await self.b.release()

    async def test_crash_recovery_and_busy_command_refuse_without_replay(self):
        await self.a.snap()
        waiting = await asyncio.create_subprocess_exec(str(ROOT / "scripts/computer-control"), "--local", "wait", self.bundle_id,
                    "--label", "never-appears", "--timeout", "3", "--scope", self.a.scope, "--lease", self.a.lease,
                    "--json", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.addAsyncCleanup(self.cleanup_command, waiting)
        # A test-only bounded pause makes the long read acquire the native command lock.
        await asyncio.sleep(.25)
        started = asyncio.get_running_loop().time()
        code, busy = await self.cli("snap", self.bundle_id, "--scope", self.b.scope)
        self.assertEqual((code, busy["outcome"]), (6, "not_sent"))
        self.assertLess(asyncio.get_running_loop().time() - started, 2)
        await asyncio.wait_for(waiting.communicate(), 10)
        self.assertIsNotNone(waiting.returncode)
        # Identity must be fenced before auto-launch too, not after opening the app.
        self.proc.terminate()
        await asyncio.wait_for(self.proc.communicate(), 10)
        code, denied_launch = await self.cli("snap", str(self.directory / "OwnershipFixture.app"), "--scope", self.b.scope)
        self.assertEqual((code, denied_launch["outcome"]), (6, "not_sent"))
        self.proc = await asyncio.create_subprocess_exec(str(self.directory / "OwnershipFixture.app/Contents/MacOS/OwnershipFixture"),
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.assertEqual((await asyncio.wait_for(self.proc.stdout.readline(), 10)).strip(), b"ready")
        # Ending the transport is not evidence that its task is safe to steal.
        await computer_control.disconnect()
        await self.denied(self.b.snap())
        state = (await self.b.owner())["ownership"]
        await self.denied(self.b.recover(expected_owner=self.a.scope, lease=state["lease"]), 6)
        await self.denied(self.b.recover(expected_owner=self.a.scope, lease="wrong", authorized=True), 6)
        await self.b.recover(expected_owner=self.a.scope, lease=state["lease"], authorized=True)
        await self.denied(self.a.snap(), 6)
        await self.b.snap()
        await self.b.release()

    async def cleanup_command(self, process):
        if process.returncode is None:
            process.terminate()
        await asyncio.wait_for(process.communicate(), 10)

    async def test_cli_sigterm_stops_real_text_delivery(self):
        await self.a.snap()
        text = "x" * 500
        typing = await asyncio.create_subprocess_exec(str(ROOT / "scripts/computer-control"), "--local", "type", self.bundle_id,
                    "--scope", self.a.scope, "--lease", self.a.lease, "--json", "--settle", "0", "--", text,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.addAsyncCleanup(self.cleanup_command, typing)
        self.assertEqual((await asyncio.wait_for(self.proc.stdout.readline(), 10)).strip(), b"input-started")
        typing.terminate()
        output, error = await asyncio.wait_for(typing.communicate(), 10)
        result = json.loads(output)
        self.assertEqual((typing.returncode, result["outcome"]), (1, "unknown"), (result, error))
        first = await self.a.snap()
        value = first.one(id="cancel-input")["value"]
        self.assertGreater(len(value), 0)
        self.assertLess(len(value), len(text))
        second = await self.a.snap()
        self.assertEqual(second.one(id="cancel-input")["value"], value)
        await self.a.release()

    async def test_numbered_target_rejects_missing_original_id(self):
        first = await self.a.snap()
        self.assertFalse(first.truncated or first.timed_out)
        target = first.one(id="identity-save")
        await self.a.click(id="remove-identity")
        code, denied = await self.cli("click", self.bundle_id, str(target["idx"]),
                                      "--scope", self.a.scope, "--lease", self.a.lease,
                                      "--snapshot", first.snapshot)
        self.assertEqual((code, denied["outcome"]), (4, "not_sent"), denied)
        final = await self.a.snap()
        self.assertFalse(final.truncated or final.timed_out)
        self.assertEqual(final.one(label="保存测试").get("axid"), None)
        self.assertEqual(final.one(id="press-count")["label"], "0")
        await self.a.release()


if __name__ == "__main__":
    unittest.main()
