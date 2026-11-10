'''remote-host 的 Python 包离线测试：不连网、不碰真主机。

用一个 stub 顶替 remote-host CLI，验证参数拼装、stdin 传递、超时杀进程组和 Result 行为。
Run:  python3 -m unittest discover -s tests -p "test_skill_package.py" -v   (from the skill directory)
'''

import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import remote_host  # noqa: E402


STUB = r'''#!/usr/bin/env python3
import json, os, sys, time
payload = sys.stdin.read()
record = os.environ.get("REMOTE_HOST_STUB_RECORD")
if record:
    with open(record, "a") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "stdin": payload}) + "\n")
time.sleep(float(os.environ.get("REMOTE_HOST_STUB_SLEEP", "0")))
sys.stdout.write(os.environ.get("REMOTE_HOST_STUB_OUT", ""))
sys.stderr.write(os.environ.get("REMOTE_HOST_STUB_ERR", ""))
sys.exit(int(os.environ.get("REMOTE_HOST_STUB_CODE", "0")))
'''


class SkillCase(unittest.TestCase):
    '''每个用例一个临时目录、一个 stub 入口。'''

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.stub = self.dir / "stub_remote_host.py"
        self.stub.write_text(STUB)
        self.record = self.dir / "calls.jsonl"
        self.env = mock.patch.dict(os.environ, {"REMOTE_HOST_STUB_RECORD": str(self.record)})
        self.env.start()
        self.entry = mock.patch.object(remote_host, "_entry",
                                      lambda: [sys.executable, str(self.stub)])
        self.entry.start()
        self.addCleanup(self.entry.stop)
        self.addCleanup(self.env.stop)
        self.addCleanup(self.tmp.cleanup)

    def calls(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def run_(self, coro):
        return asyncio.run(coro)

    def setenv(self, **kw):
        patch = mock.patch.dict(os.environ, kw)
        patch.start()
        self.addCleanup(patch.stop)


class Arguments(SkillCase):
    def test_script_goes_on_stdin_and_host_before_the_subcommand(self):
        r = self.run_(remote_host.run("echo hi", host="mini", quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["-H", "mini", "run"])
        self.assertEqual(self.calls()[0]["stdin"], "echo hi")
        self.assertTrue(r.ok)

    def test_without_a_host_the_pin_decides(self):
        self.run_(remote_host.run("uptime", quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["run"])

    def test_run_flags(self):
        self.run_(remote_host.run("x", host="a,b", table=True, interp="py", cwd="~/p", proxy=True,
                         quiet=True))
        self.assertEqual(self.calls()[0]["argv"],
                         ["-H", "a,b", "run", "--table", "-i", "py", "-C", "~/p", "-P"])

    def test_job_start_sends_the_script_and_follows(self):
        self.run_(remote_host.job("start", "build", script="make -j8", host="mini", follow=True,
                         progress="tail -1 log", quiet=True))
        self.assertEqual(self.calls()[0]["argv"],
                         ["-H", "mini", "job", "start", "build",
                          "--progress", "tail -1 log", "--every", "30", "--follow"])
        self.assertEqual(self.calls()[0]["stdin"], "make -j8")

    def test_job_list_sends_nothing_on_stdin(self):
        self.run_(remote_host.job("list", host="mini", quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["-H", "mini", "job", "list"])
        self.assertEqual(self.calls()[0]["stdin"], "")

    def test_wait_maps_conditions(self):
        self.run_(remote_host.wait(host="mini", port=8000, gone=True, timeout=30, every=5, quiet=True))
        self.assertEqual(self.calls()[0]["argv"],
                         ["-H", "mini", "wait", "--port", "8000", "--gone",
                          "-t", "30", "--every", "5"])

    def test_app_logs_carries_since_and_lines(self):
        self.run_(remote_host.app("logs", "Clash Party", host="mini", since=15, lines=5, quiet=True))
        argv = self.calls()[0]["argv"]
        self.assertEqual(argv[:5], ["-H", "mini", "app", "logs", "Clash Party"])
        self.assertEqual(argv[-4:], ["--since", "15", "-n", "5"])

    def test_copy_defaults_to_verifying(self):
        self.run_(remote_host.copy("mini:~/a", "~/b", quiet=True))
        argv = self.calls()[0]["argv"]
        self.assertEqual(argv[:3], ["copy", "mini:~/a", "~/b"])
        self.assertNotIn("--no-verify", argv)

    def test_copy_opt_outs(self):
        self.run_(remote_host.copy("~/a", "mini:~/b", replace=True, verify=False, quick=True,
                          compress=False, quiet=True))
        argv = self.calls()[0]["argv"]
        self.assertIn("--replace", argv)
        self.assertIn("--no-verify", argv)
        self.assertIn("--quick", argv)
        self.assertIn("--no-compress", argv)

    def test_verify_and_manifest(self):
        self.run_(remote_host.verify("mini:~/a", "~/b", quick=True, quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["verify", "mini:~/a", "~/b", "--quick"])
        self.run_(remote_host.manifest("mini:~/a", full=True, quiet=True))
        self.assertEqual(self.calls()[1]["argv"], ["manifest", "mini:~/a", "--full"])

    def test_send_keeps_state_in_a_session(self):
        self.run_(remote_host.send("cd ~/p", host="mini", session="work", detach=True, quiet=True))
        self.assertEqual(self.calls()[0]["argv"],
                         ["-H", "mini", "send", "-s", "work", "-d", "-t", "300", "-n", "0"])

    def test_use_pins_the_host(self):
        self.run_(remote_host.use("alpha", interp="fish", proxy=True, quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["use", "alpha", "-i", "fish", "-P"])

    def test_cli_passes_anything_through(self):
        self.run_(remote_host.cli("stats", "--days", "7", quiet=True))
        self.assertEqual(self.calls()[0]["argv"], ["stats", "--days", "7"])


class Results(SkillCase):
    def test_a_nonzero_exit_is_not_ok(self):
        self.setenv(REMOTE_HOST_STUB_CODE="3")
        r = self.run_(remote_host.run("false", host="mini", quiet=True))
        self.assertFalse(r.ok)
        self.assertEqual(r.code, 3)

    def test_streams_are_kept_apart(self):
        self.setenv(REMOTE_HOST_STUB_OUT="out line\n", REMOTE_HOST_STUB_ERR="err line\n")
        r = self.run_(remote_host.run("x", host="mini", quiet=True))
        self.assertEqual(r.out, "out line\n")
        self.assertEqual(r.err, "err line\n")
        self.assertEqual(r.text, "out line\nerr line\n")
        self.assertEqual(r.lines, ["out line"])

    def test_screenshot_hands_back_the_local_path(self):
        self.setenv(REMOTE_HOST_STUB_OUT="/tmp/example-home/.cache/remote-host/shots/mini-1.jpg\n")
        r = self.run_(remote_host.screenshot(host="mini", screen=0, quiet=True))
        self.assertEqual(r.last_line, "/tmp/example-home/.cache/remote-host/shots/mini-1.jpg")
        self.assertEqual(self.calls()[0]["argv"], ["-H", "mini", "screenshot", "--screen", "0"])

    def test_repr_stays_a_summary(self):
        self.setenv(REMOTE_HOST_STUB_OUT="x\n" * 500)
        r = self.run_(remote_host.run("big", host="mini", quiet=True))
        self.assertLess(len(repr(r)), 100)
        self.assertIn("exit 0", repr(r))

    def test_quiet_prints_nothing_and_the_default_does(self):
        self.setenv(REMOTE_HOST_STUB_OUT="hello\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.run_(remote_host.run("x", host="mini", quiet=True))
        self.assertEqual(buf.getvalue(), "")
        with contextlib.redirect_stdout(buf):
            self.run_(remote_host.run("x", host="mini"))
        self.assertEqual(buf.getvalue(), "hello\n")

    def test_a_timeout_kills_the_whole_group(self):
        self.setenv(REMOTE_HOST_STUB_SLEEP="30")
        started = time.monotonic()
        r = self.run_(remote_host.run("sleep 30", host="mini", timeout=0.5, quiet=True))
        self.assertTrue(r.timed_out)
        self.assertTrue(r.remote_unknown)
        self.assertEqual(r.outcome, "unknown")
        self.assertIn("远端任务是否停止未知", r.err)
        self.assertIn("不要自动重跑", r.err)
        self.assertFalse(r.ok)
        self.assertLess(time.monotonic() - started, 15)


class RealTimeout(unittest.TestCase):
    def test_actual_local_process_timeout_is_not_remote_cancellation(self):
        with mock.patch.object(remote_host, "_entry", return_value=["/bin/bash", "-c", "sleep 30"]):
            result = asyncio.run(remote_host._exec([], timeout=.1, quiet=True))
        self.assertTrue(result.timed_out)
        self.assertTrue(result.remote_unknown)
        self.assertEqual(result.outcome, "unknown")
        self.assertIn("远端任务是否停止未知", result.err)
        self.assertFalse(result.ok)

    def test_lost_transport_has_unknown_outcome_and_normal_exit_is_known(self):
        for code in (124, 125, 255, None, -15):
            result = remote_host.Result([], code, "", "")
            self.assertTrue(result.remote_unknown)
            self.assertEqual(result.outcome, "unknown")
        self.assertEqual(remote_host.Result([], 7, "", "").outcome, "exited")


if __name__ == "__main__":
    unittest.main()
