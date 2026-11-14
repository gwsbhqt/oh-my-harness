"""跨机器做完通知：隔离家目录里用假的 ssh 与 dsh-use 真跑观察进程，分发入口用替身核对参数与回执。"""

import concurrent.futures
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from agentkit.remote import done_watch as d, notifications as n, ssh, target
import test_notifications as base

FAKE_DSH = r"""
import json, os, sys
from pathlib import Path
home = Path.home()
args = sys.argv[1:]
if '--capabilities' in args:
 feats = ['local-routing','task-outcomes'] + ([] if (home / 'old-remote').exists() else ['settled-wait'])
 print(json.dumps({'ok':True,'tool':'dsh-use','protocol':1,'features':feats}))
 sys.exit(0)
with (home / 'tool-calls').open('a') as f:
 f.write(json.dumps({'args':args, 'session':os.getenv('DSH_SESSION_ID')}) + '\n')
if args[1] == 'notice':
 print(json.dumps({'ok':True,'data':{'sessionId':args[2],'accepted':True,'scheduled':True}}))
 sys.exit(0)
if args[1] == 'wait':
 script = json.loads((home / 'wait-script').read_text())
 step = script.pop(0) if len(script) > 1 else script[0]
 (home / 'wait-script').write_text(json.dumps(script))
 print(json.dumps(step['body']))
 sys.exit(step['exit'])
raise RuntimeError('unexpected command')
"""


def turn_body(reply="全部完成，证据见 docs/plan.md", ended="completed", status="ok"):
    return {"ok": status == "ok", "status": status,
            "data": {"turns": [{"turn": 3, "ended": ended, "reply": reply}]}}


class DoneWatchCase(unittest.TestCase):
    # 借用重启观察测试的隔离家目录与假 ssh，不继承它的测试
    tearDown = base.WatchCase.tearDown
    install = base.WatchCase.install
    receipt = base.WatchCase.receipt
    calls = base.WatchCase.calls

    def setUp(self):
        base.WatchCase.setUp(self)
        self.install("dsh-use", FAKE_DSH)
        self.target = "session-" + str(uuid.uuid4())

    def script(self, *steps):
        (self.home / "wait-script").write_text(json.dumps([{"exit": e, "body": b} for e, b in steps]))

    def run_worker(self, timeout=15):
        directory = d._state_dir()
        n._private_dir(directory)
        watch_id = str(uuid.uuid4())
        now = time.time()
        state = {"version": 1, "kind": "done", "watchId": watch_id, "host": "fixture", "ssh": n._ssh_snapshot("fixture"),
                 "localSession": self.session, "target": self.target, "since": 41, "targetTitle": None,
                 "createdAt": now, "deadlineAt": now + timeout, "interval": 0.02, "questionInterval": 0.02,
                 "phase": "starting", "pid": None, "notification": {"state": "pending"}}
        n._atomic(directory / (watch_id + ".json"), state)
        child = subprocess.Popen(d._invoke("--worker", watch_id, directory), env=n._environment(),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        self.children.append(child)
        out, err = child.communicate(timeout=timeout + 10)
        self.assertEqual(child.returncode, 0, err)
        self.assertEqual(stat.S_IMODE((directory / (watch_id + ".json")).stat().st_mode), 0o600)
        return d.read_watch(watch_id)

    def notices(self):
        return [c["args"] for c in self.calls() if c["args"][1] == "notice"]

    def test_done_sends_one_local_notice_with_remote_read_commands(self):
        self.script((124, {"ok": True, "status": "timeout", "data": {"title": "测试长工"}}), (0, turn_body()))
        result = self.run_worker()
        self.assertEqual(result["phase"], "ok")
        self.assertEqual(result["targetTitle"], "测试长工")
        self.assertEqual(result["notification"]["state"], "scheduled")
        waits = [c["args"] for c in self.calls() if c["args"][1] == "wait"]
        self.assertEqual(waits[0], ["--local", "wait", self.target, "--since", "41", "--settled",
                                    "--timeout", str(d.WAIT_SLICE), "--json"])
        self.assertTrue(all(c["session"] is None for c in self.calls()))
        [notice] = self.notices()
        self.assertEqual(notice[2], self.session)
        self.assertIn("已经真正做完", notice[3])
        self.assertIn("「测试长工」", notice[3])
        self.assertIn(f"dsh-use -H fixture last {self.target}", notice[3])
        self.assertIn("全部完成", notice[3])

    def test_question_is_reported_once_then_final_notice(self):
        asking = {"ok": True, "status": "waiting-input", "data": {"questions": [{"callId": "q1", "question": "选哪个？"}]}}
        self.script((10, asking), (10, asking), (0, turn_body()))
        result = self.run_worker()
        self.assertEqual(result["phase"], "ok")
        notices = self.notices()
        self.assertEqual(len(notices), 2)
        self.assertIn("在等回答", notices[0][5])
        self.assertIn("选哪个？", notices[0][3])
        self.assertIn("已经真正做完", notices[1][3])

    def test_failed_aborted_gone_and_idle_are_terminal(self):
        cases = {"failed": (1, turn_body(ended="error", status="failed")),
                 "aborted": (1, turn_body(ended="aborted", status="aborted")),
                 "idle": (11, {"ok": True, "status": "idle", "data": {}}),
                 "gone": (2, {"ok": False, "error": {"code": "not-found", "message": "找不到会话"}})}
        for phase, step in cases.items():
            with self.subTest(phase=phase):
                before = len(self.notices())
                self.script(step)
                result = self.run_worker()
                self.assertEqual(result["phase"], phase)
                self.assertEqual(len(self.notices()) - before, 1)

    def test_repeated_errors_stop_with_unconfirmed_notice(self):
        self.script((2, {"ok": False, "error": {"code": "usage", "message": "旧插件不认 --settled"}}))
        result = self.run_worker()
        self.assertEqual(result["phase"], "error")
        [notice] = self.notices()
        self.assertIn("没确认结果", notice[3])
        self.assertIn("旧插件", notice[3])

    def test_deliver_waits_for_local_restart_then_sends_once(self):
        calls = []
        def fake(argv, timeout):
            calls.append(argv)
            if len(calls) == 1:
                return subprocess.CompletedProcess(argv, 69, b"", b"down")
            return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "data": {
                "sessionId": self.session, "accepted": True, "scheduled": True}}).encode(), b"")
        with mock.patch.object(d, "_bounded_command", side_effect=fake), mock.patch.object(d.time, "sleep"):
            result = d._deliver({"localSession": self.session}, "s", "t")
        self.assertEqual(result["state"], "scheduled")
        self.assertEqual(len(calls), 2)


class DispatchCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        (home / ".ssh").mkdir()
        (home / ".ssh/config").write_text("Host alpha\n")
        self.origin = "session-" + str(uuid.uuid4())
        self.remote = "session-" + str(uuid.uuid4())
        patch = mock.patch.dict(os.environ, {"HOME": str(home), "XDG_STATE_HOME": str(home / "state"),
                                             "XDG_CACHE_HOME": str(home / "cache"), "REMOTE_HOST_NO_LOG": "1",
                                             "DSH_SESSION_ID": self.origin})
        patch.start()
        self.addCleanup(patch.stop)
        ssh.PROXY["on"] = False

    def call(self, *args, receipt=None, start=None):
        receipt = receipt or {"ok": True, "status": "ok", "data": {"sessionId": self.remote, "since": 7, "sent": True}}
        out, err = io.StringIO(), io.StringIO()
        done = subprocess.CompletedProcess([], 0, json.dumps(receipt).encode(), b"")
        start = start or mock.DEFAULT
        with mock.patch.object(ssh, "run_remote", return_value=done) as run, \
             mock.patch("agentkit.remote.done_watch.start_done_watch", **({"side_effect": start} if isinstance(start, Exception) else {"return_value": {"watchId": "w", "pid": 1, "statePath": "/fixture"}})) as watch, \
             mock.patch("agentkit.remote.notifications.capture_ssh_target", return_value={"fixture": "original"}), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            _, code = target.dispatch("dsh-use", ["-H", "alpha", *args])
        return code, out.getvalue(), run, watch

    def test_send_strips_notify_requires_settled_wait_and_watches_locally(self):
        code, out, run, watch = self.call("send", self.remote, "干活", "--notify", "self")
        self.assertEqual(code, 0)
        script = run.call_args.args[1]
        self.assertIn("settled-wait", script)
        self.assertNotIn("--notify", script)
        self.assertIn("--json", script)
        watch.assert_called_once_with("alpha", self.remote, 7, self.origin, title=None, ssh_snapshot={"fixture": "original"})
        self.assertIn("做完时通知本机会话", out)

    def test_new_json_receipt_carries_local_watch(self):
        code, out, run, watch = self.call("new", "/tmp/x", "干活", "--tier", "fast", "--notify=self", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["data"]["notify"]["observer"], "local")

    def test_watch_failure_keeps_receipt_and_exit_zero(self):
        code, out, run, watch = self.call("send", self.remote, "干活", "--notify", "self", "--json", start=OSError("spawn"))
        self.assertEqual(code, 0)
        self.assertIn("没登记上", json.loads(out)["data"]["notify"]["error"])
        self.assertEqual(run.call_count, 1)

    def test_chat_and_missing_session_are_rejected_before_sending(self):
        code, _, run, watch = self.call("chat", self.remote, "干活", "--notify", "self")
        self.assertEqual(code, 2)
        run.assert_not_called()
        with mock.patch.dict(os.environ, {"DSH_SESSION_ID": str(uuid.uuid4())}):
            code, _, run, watch = self.call("send", self.remote, "干活", "--notify", "self")
        self.assertEqual(code, 2)
        run.assert_not_called()

    def test_explicit_remote_notify_target_passes_through(self):
        other = "session-" + str(uuid.uuid4())
        code, _, run, watch = self.call("send", self.remote, "干活", "--notify", other, "--json")
        self.assertEqual(code, 0)
        self.assertIn(other, run.call_args.args[1])
        watch.assert_not_called()


class ReuseCase(unittest.TestCase):
    def test_second_watch_for_same_remote_session_reuses_live_worker(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_STATE_HOME": tmp}):
            directory = d._state_dir()
            n._private_dir(directory)
            target, origin = "session-" + str(uuid.uuid4()), "session-" + str(uuid.uuid4())
            live = {"version": 1, "kind": "done", "watchId": str(uuid.uuid4()), "host": "alpha", "ssh": {"x": 1},
                    "localSession": origin, "target": target, "since": 3, "createdAt": 1.0, "deadlineAt": 2.0,
                    "interval": 1, "phase": "watching", "pid": os.getpid(), "notification": {"state": "pending"}}
            n._atomic(directory / (live["watchId"] + ".json"), live)
            with mock.patch.object(d, "_worker_alive", return_value=True), mock.patch.object(d, "_ssh_snapshot") as snap, \
                 mock.patch.object(d.subprocess, "Popen") as popen:
                result = d.start_done_watch("alpha", target, 9, origin)
                other = d._pending_for(directory, "alpha", target, "session-" + str(uuid.uuid4()))
            self.assertTrue(result["reused"])
            self.assertEqual(result["watchId"], live["watchId"])
            self.assertIsNone(other)
            snap.assert_not_called()
            popen.assert_not_called()


    def ready_worker(self, delay=0):
        """Fake only process startup; persist the same ready state as a real worker."""
        def start(argv, **kwargs):
            if delay:
                time.sleep(delay)
            watch_id = argv[4]
            path = Path(argv[6]) / (watch_id + ".json")
            state = json.loads(path.read_text())
            child = mock.Mock()
            child.pid = 42000
            child.poll.return_value = None
            state.update(pid=child.pid, phase="watching", readyAt=time.time())
            n._atomic(path, state)
            return child
        return start

    def test_concurrent_registration_starts_only_one_worker(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_STATE_HOME": tmp}):
            remote, origin = "session-" + str(uuid.uuid4()), "session-" + str(uuid.uuid4())
            with (
                mock.patch.object(d, "_worker_alive", return_value=True),
                mock.patch.object(d, "_ssh_snapshot", return_value={"x": 1}),
                mock.patch.object(d.subprocess, "Popen", side_effect=self.ready_worker(delay=0.05)) as popen,
            ):
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(
                        lambda _: d.start_done_watch("alpha", remote, 9, origin), range(2)))
            self.assertEqual(len({result["watchId"] for result in results}), 1)
            self.assertEqual(sum(bool(result.get("reused")) for result in results), 1)
            self.assertEqual(popen.call_count, 1)

    def test_failed_or_stale_starting_watch_does_not_block_retry(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_STATE_HOME": tmp}):
            remote, origin = "session-" + str(uuid.uuid4()), "session-" + str(uuid.uuid4())
            with (
                mock.patch.object(d, "_ssh_snapshot", return_value={"x": 1}),
                mock.patch.object(d.subprocess, "Popen", side_effect=OSError("spawn failed")),
            ):
                with self.assertRaises(OSError):
                    d.start_done_watch("alpha", remote, 9, origin)
            directory = d._state_dir()
            [path] = list(directory.glob("*.json"))
            failed = d._load(path, path.stem)
            self.assertEqual(failed["phase"], "unknown")
            self.assertEqual(failed["notification"]["state"], "not-attempted")
            self.assertIsNone(d._pending_for(directory, "alpha", remote, origin))

            # A process crash can leave starting with no worker; it is stale, not a live registration.
            failed.update(phase="starting", pid=None)
            n._atomic(path, failed)
            self.assertIsNone(d._pending_for(directory, "alpha", remote, origin))
            with (
                mock.patch.object(d, "_ssh_snapshot", return_value={"x": 1}),
                mock.patch.object(d.subprocess, "Popen", side_effect=self.ready_worker()) as popen,
            ):
                retry = d.start_done_watch("alpha", remote, 9, origin)
            self.assertNotEqual(retry["watchId"], failed["watchId"])
            self.assertFalse(retry.get("reused", False))
            popen.assert_called_once()


if __name__ == "__main__":
    unittest.main()