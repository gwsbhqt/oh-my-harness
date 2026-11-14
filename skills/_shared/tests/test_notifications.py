"""Restart watcher tests use disposable homes and local executable boundaries only."""

import contextlib
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agentkit.remote import notifications as n, ssh, target


class WatchCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.bin = self.home / ".local/bin"
        self.bin.mkdir(parents=True)
        self.request = str(uuid.uuid4())
        self.session = "session-" + str(uuid.uuid4())
        self.environ = mock.patch.dict(os.environ, {"HOME": str(self.home), "XDG_STATE_HOME": str(self.home / "state"),
                                                   "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                                                   "DSH_SESSION_ID": self.session})
        self.environ.start()
        self.receipt("completed")
        (self.home / "resolved-host").write_text("fixture.example")
        self.install("ssh", r"""
import json, os, subprocess, sys
from pathlib import Path
home = Path.home()
if '-G' in sys.argv:
 print('hostname ' + (home / 'resolved-host').read_text())
 print('user fixture-user\nport 2222\nbatchmode yes')
 sys.exit(0)
if (home / 'hang-poll').exists():
 import time
 time.sleep(30)
with (home / 'ssh-calls').open('a') as f:
 f.write(json.dumps({'argv':sys.argv[1:], 'session':os.getenv('DSH_SESSION_ID'), 'group':os.getpgrp()}) + '\n')
r = subprocess.run(['/bin/bash', '-s'], input=sys.stdin.buffer.read(), capture_output=True)
sys.stdout.buffer.write(r.stdout)
sys.stderr.buffer.write(r.stderr)
sys.exit(r.returncode)
""")
        self.install("dsh-use", r"""
import json, os, sys
from pathlib import Path
home = Path.home()
args = sys.argv[1:]
if '--capabilities' in args:
 print(json.dumps({'ok':True,'tool':'dsh-use','protocol':1,'features':['local-routing','task-outcomes','restart-receipts']}))
 sys.exit(0)
with (home / 'tool-calls').open('a') as f:
 f.write(json.dumps({'args':args, 'session':os.getenv('DSH_SESSION_ID')}) + '\n')
if args[1] == 'notice':
 if (home / 'fail-notice').exists():
  print(json.dumps({'ok':False,'error':{'code':'notice-unsupported','message':'no notice'}}))
  sys.exit(7)
 data = {'sessionId':args[2]}
 if not (home / 'legacy-notice').exists():
  data.update(accepted=True, scheduled=not (home / 'unconfirmed-notice').exists(), delivery='followup')
 print(json.dumps({'ok':True,'data':data}))
 sys.exit(0)
if args[1] != 'restart-status':
 raise RuntimeError('unexpected command')
if args[2:4] != ['--request-id', (home / 'request-id').read_text()]:
 raise RuntimeError('wrong request ID')
if (home / 'status-exit').exists():
 sys.stdout.buffer.write((home / 'receipt').read_bytes())
 sys.exit(int((home / 'status-exit').read_text()))
sys.stdout.buffer.write((home / 'receipt').read_bytes())
""")
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        self.environ.stop()
        self.temp.cleanup()

    def install(self, name, source):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o700)

    def receipt(self, phase, **extra):
        data = {"requestId": self.request, "phase": phase, "message": "隔离测试" , **extra}
        (self.home / "receipt").write_text(json.dumps({"ok": True, "status": phase, "data": data}))
        (self.home / "request-id").write_text(self.request)

    def state(self, timeout=3, phase="starting"):
        directory = n._state_dir()
        n._private_dir(directory)
        now = time.time()
        data = {"version": 1, "requestId": self.request, "watchId": self.request,
                "host": "fixture", "localSession": self.session, "ssh": n._ssh_snapshot("fixture"),
                "phase": phase, "createdAt": now, "deadlineAt": now + timeout,
                "interval": 0.02, "pid": None, "notification": {"state": "pending"}}
        n._atomic(directory / (self.request + ".json"), data)
        return data

    def worker(self, timeout=15):
        self.state(timeout=timeout)
        directory = n._state_dir()
        child = subprocess.Popen(n._invoke("--worker", self.request, directory), env=n._environment(),
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
        self.children.append(child)
        out, err = child.communicate(timeout=timeout + 5)
        self.assertEqual(child.returncode, 0, err)
        return n.read_watch(self.request)

    def calls(self):
        path = self.home / "tool-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_real_poll_uses_shared_staged_command_and_core_transport(self):
        state = self.state()
        result = n._poll(state)
        self.assertEqual(result["kind"], "receipt")
        self.assertEqual(result["data"]["phase"], "completed")
        call = self.calls()[0]
        self.assertEqual(call["args"], ["--local", "restart-status", "--request-id", self.request, "--json"])
        self.assertIsNone(call["session"])
        self.assertNotIn(self.session, target.command_script("dsh-use", call["args"][1:]))

    def test_worker_terminal_results_send_one_local_notice_only(self):
        for phase in sorted(n.TERMINAL):
            with self.subTest(phase=phase):
                self.request = str(uuid.uuid4())
                self.receipt(phase)
                before = len(self.calls())
                result = self.worker()
                self.assertEqual(result["phase"], phase)
                self.assertEqual(result["notification"]["state"], "scheduled")
                calls = self.calls()[before:]
                self.assertEqual([c["args"][1] for c in calls], ["restart-status", "notice"])
                self.assertEqual(calls[1]["args"][2], self.session)
                self.assertTrue(all(c["session"] is None for c in calls))
                self.assertEqual(stat.S_IMODE((n._state_dir() / (self.request + ".json")).stat().st_mode), 0o600)

    def test_all_actual_nonterminal_phases_are_accepted(self):
        for phase in ("queued", "attached", "pending", "checking", "waiting", "updating", "quitting", "starting"):
            with self.subTest(phase=phase):
                self.receipt(phase)
                done = subprocess.CompletedProcess([], 0, (self.home / "receipt").read_bytes(), b"")
                self.assertEqual(n._receipt(done, self.request)["data"]["phase"], phase)

    def test_transient_missing_receipt_is_not_misreported_as_remote_failure(self):
        (self.home / "receipt").write_text(json.dumps({"ok": False, "error": {"code": "not-found", "message": "not ready"}}))
        (self.home / "status-exit").write_text("2")
        raw = (self.home / "receipt").read_bytes()
        self.assertEqual(n._receipt(subprocess.CompletedProcess([], 2, raw, b""), self.request)["kind"], "not-found")
        self.assertEqual(n._poll(self.state())["kind"], "not-found")
        result = self.worker(timeout=1)
        self.assertEqual(result["phase"], "unknown")
        self.assertIn(result["lastPoll"]["kind"], {"not-found", "transport-error"})

    def test_pre_restart_snapshot_cannot_be_replaced_at_watch_start(self):
        snapshot = n._ssh_snapshot("fixture")
        (self.home / "resolved-host").write_text("other.example")
        with self.assertRaises(ValueError):
            n.start_restart_watch("fixture", self.request, self.session, ssh_snapshot=snapshot)
        self.assertFalse((self.home / "ssh-calls").exists())
        self.assertFalse((n._state_dir() / (self.request + ".json")).exists())

    def test_reused_pid_without_worker_lock_is_not_alive(self):
        state = self.state(phase="watching")
        state["pid"] = os.getpid()
        n._atomic(n._state_dir() / (self.request + ".json"), state)
        result = n.read_watch(self.request)
        self.assertEqual(result["phase"], "unknown")
        self.assertFalse(result["workerAlive"])

    def test_config_drift_worker_reports_unknown_without_remote_query(self):
        self.state()
        (self.home / "resolved-host").write_text("other.example")
        child = subprocess.run(n._invoke("--worker", self.request, n._state_dir()), env=n._environment(),
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
        self.assertEqual(child.returncode, 0, child.stderr)
        result = n.read_watch(self.request)
        self.assertEqual(result["phase"], "unknown")
        self.assertEqual([c["args"][1] for c in self.calls()], ["notice"])
        self.assertFalse((self.home / "ssh-calls").exists())

    def test_registry_lock_serializes_competing_processes(self):
        program = "from agentkit.remote.notifications import start_restart_watch; import json; print(json.dumps(start_restart_watch('fixture', " + repr(self.request) + ", " + repr(self.session) + ", timeout=1, interval=.02)))"
        env = n._environment()
        # Only the local fixture has these executables; no real SSH/DSH is reachable.
        (self.home / "hang-poll").touch()
        children = [subprocess.Popen([sys.executable, "-c", program], env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                    for _ in range(2)]
        self.children.extend(children)
        results = []
        try:
            for child in children:
                out, err = child.communicate(timeout=4)
                self.assertEqual(child.returncode, 0, err)
                results.append(json.loads(out))
            self.assertEqual(results[0], results[1])
        finally:
            path = n._state_dir() / (self.request + ".json")
            if path.exists():
                state = n._load(path, self.request)
                if n._worker_alive(n._state_dir(), self.request, state.get("pid")):
                    os.killpg(state["pid"], signal.SIGTERM)
        self.assertEqual(self.calls(), [])

    def test_pending_deadline_is_unknown_not_remote_failure(self):
        self.receipt("waiting")
        result = self.worker(timeout=1)
        self.assertEqual(result["phase"], "unknown")
        self.assertIn("不能当成失败或成功", result["message"])

    def test_config_change_never_queries_different_target(self):
        state = self.state()
        (self.home / "resolved-host").write_text("changed.example")
        result = n._poll(state)
        self.assertEqual(result["kind"], "config-changed")
        self.assertFalse((self.home / "ssh-calls").exists())
        self.assertEqual(self.calls(), [])

    def test_notice_failure_is_recorded_without_send_fallback(self):
        (self.home / "fail-notice").touch()
        result = self.worker()
        self.assertEqual(result["phase"], "completed")
        self.assertEqual(result["notification"]["state"], "failed")
        self.assertEqual(result["notification"]["exitCode"], 7)
        self.assertNotIn("send", [c["args"][1] for c in self.calls()])

    def test_recorded_notice_without_scheduling_evidence_is_not_resent(self):
        (self.home / "legacy-notice").touch()
        result = self.worker()
        self.assertEqual(result["phase"], "completed")
        self.assertEqual(result["notification"]["state"], "recorded-unconfirmed")
        self.assertEqual(len([call for call in self.calls() if call["args"][1] == "notice"]), 1)

    def test_accepted_notice_without_scheduled_execution_stays_unconfirmed(self):
        (self.home / "unconfirmed-notice").touch()
        result = self.worker()
        self.assertEqual(result["notification"]["state"], "recorded-unconfirmed")
        self.assertTrue(result["notification"]["receipt"]["accepted"])
        self.assertFalse(result["notification"]["receipt"]["scheduled"])
        self.assertEqual(len([call for call in self.calls() if call["args"][1] == "notice"]), 1)

    def test_invalid_remote_record_is_unknown_and_retains_exit_code(self):
        (self.home / "status-exit").write_text("9")
        result = self.worker()
        self.assertEqual(result["phase"], "unknown")
        self.assertEqual(result["lastPoll"]["exitCode"], 9)
        self.assertNotEqual(result.get("remote", {}).get("phase"), "completed")

    def test_hung_poll_is_killed_with_its_process_group_and_deadline_is_bounded(self):
        (self.home / "hang-poll").touch()
        start = time.monotonic()
        self.state(timeout=15)
        poll = n._poll_child(self.request, n._state_dir(), 0.3)
        self.assertEqual(poll["kind"], "transport-error")
        self.assertLess(time.monotonic() - start, 3)
        result = self.worker(timeout=1)
        self.assertEqual(result["phase"], "unknown")

    def test_detached_start_has_independent_group_and_private_log(self):
        real_popen = subprocess.Popen
        def track(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            self.children.append(child)
            return child
        with mock.patch.object(n.subprocess, "Popen", side_effect=track):
            watch = n.start_restart_watch("fixture", self.request, self.session, timeout=15, interval=0.02)
        self.assertEqual(watch["watchId"], self.request)
        self.assertEqual(os.getpgid(watch["pid"]), watch["pid"])
        self.children[-1].wait(timeout=20)
        result = n.read_watch(self.request)
        self.assertEqual(result["notification"]["state"], "scheduled")
        self.assertEqual(stat.S_IMODE(Path(watch["statePath"]).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(watch["statePath"]).with_suffix(".log").stat().st_mode), 0o600)
        self.assertEqual(n.start_restart_watch("fixture", self.request, self.session), watch)
        self.assertEqual(len([c for c in self.calls() if c["args"][1] == "notice"]), 1)

    def test_start_error_raises_and_cannot_be_relabelled_as_started(self):
        with mock.patch.object(n.subprocess, "Popen", side_effect=OSError("fixture spawn failure")), \
             mock.patch.object(n, "_ssh_snapshot", return_value={"fixture": True}):
            with self.assertRaises(OSError):
                n.start_restart_watch("fixture", self.request, self.session)
        result = n.read_watch(self.request)
        self.assertEqual(result["phase"], "unknown")
        self.assertEqual(result["notification"]["state"], "not-attempted")
        with self.assertRaises(RuntimeError):
            n.start_restart_watch("fixture", self.request, self.session)

    def test_duplicate_request_cannot_attach_another_session_or_host(self):
        state = self.state(phase="unknown")
        with self.assertRaises(ValueError):
            n.start_restart_watch("fixture", self.request, "session-" + str(uuid.uuid4()))
        with self.assertRaises(ValueError):
            n.start_restart_watch("other", self.request, self.session)
        self.assertEqual(n._load(n._state_dir() / (self.request + ".json"), self.request), state)

    def test_read_watch_is_local_even_when_transport_is_unavailable(self):
        self.state(phase="unknown")
        with mock.patch.object(ssh, "run_remote", side_effect=AssertionError("must not connect")), \
             mock.patch.object(n, "_ssh_snapshot", side_effect=AssertionError("must not resolve")):
            self.assertEqual(n.read_watch(self.request)["phase"], "unknown")

    def test_no_terminal_record_and_dead_worker_reports_unknown(self):
        self.state(phase="watching")
        result = n.read_watch(self.request)
        self.assertEqual(result["phase"], "unknown")
        self.assertEqual(result["recordedPhase"], "watching")

    def test_schema_rejects_wrong_identity_json_bytes_and_success_on_nonzero_exit(self):
        good = (self.home / "receipt").read_bytes()
        malformed = [b'[]', b'{}', b'\xff', good.decode(), b'{"ok":true,"ok":false}', b'{"value":NaN}',
                     json.dumps({"ok": True, "status": "completed", "data": {"requestId": str(uuid.uuid4()), "phase": "completed"}}).encode(),
                     json.dumps({"ok": True, "status": "failed", "data": {"requestId": self.request, "phase": "completed"}}).encode()]
        for raw in malformed:
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                n._receipt(subprocess.CompletedProcess([], 0, raw, b""), self.request)
        result = n._receipt(subprocess.CompletedProcess([], 12, good, b"failed"), self.request)
        self.assertEqual(result["kind"], "remote-error")
        self.assertEqual(result["exitCode"], 12)

    def test_reject_noncanonical_ids_and_session_names_before_spawn(self):
        for args in [("fixture", "../bad", self.session), ("fixture", self.request, "my session"),
                     ("local", self.request, self.session), ("-bad", self.request, self.session)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                n.start_restart_watch(*args)
        with self.assertRaises(ValueError):
            n.read_watch("../bad")

    def test_state_privacy_and_identity_are_required(self):
        self.state()
        path = n._state_dir() / (self.request + ".json")
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            n.read_watch(self.request)
        path.chmod(0o600)
        data = json.loads(path.read_text())
        data["requestId"] = str(uuid.uuid4())
        n._atomic(path, data)
        with self.assertRaises(ValueError):
            n.read_watch(self.request)

    def test_duplicate_workers_use_cross_process_lock_and_no_duplicate_notice(self):
        self.receipt("waiting")
        self.state(timeout=0.5)
        directory = n._state_dir()
        with n._lock(directory / (self.request + ".worker.lock")):
            child = subprocess.run(n._invoke("--worker", self.request, directory), env=n._environment(),
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
