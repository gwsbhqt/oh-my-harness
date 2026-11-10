"""本服务临时目录、残留清扫和资源账清理；只用临时目录和假的进程表，不碰真实 $TMPDIR、账本和浏览器。"""
from __future__ import annotations

import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from browser_control import engine as engine_module, scratch
from browser_control.engine import Engine
from browser_control.resources import ResourceLedger

LIVE = "11111111-1111-1111-1111-111111111111"
DEAD = "22222222-2222-2222-2222-222222222222"
ARC_NOW = "33333333-3333-3333-3333-333333333333"
ARC_OLD = "44444444-4444-4444-4444-444444444444"
DAY = 24 * 3600


def hold_run_dir(root, ready, stop):
    """子进程：建自己的 browser-control-run 目录后一直等着，代表另一个还活着的 browser-control 服务。"""
    tempfile.tempdir = root
    scratch._current = None
    path = scratch.subdir("shots")
    ready.send(str(path.parent))
    stop.recv()


class TempRoot(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="scratch-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        # 本进程的服务目录也建在测试目录里，测试结束不在真实 $TMPDIR 留东西。
        # 账本默认在 HOME 下；换掉 HOME，测试漏传账本时也碰不到真实账本。
        home = patch.dict(os.environ, {"HOME": str(self.root / "home")})
        home.start()
        self.addCleanup(home.stop)
        saved = (tempfile.tempdir, scratch._current, scratch._users)
        scratch._current, scratch._users = None, 0
        tempfile.tempdir = str(self.root)
        def restore():
            scratch.remove()
            tempfile.tempdir, scratch._current, scratch._users = saved
        self.addCleanup(restore)

    def old(self, path, age=2 * DAY):
        stamp = time.time() - age
        for item in [path, *path.rglob("*")]:
            os.utime(item, (stamp, stamp), follow_symlinks=False)
        return path

    def legacy(self, prefix, age=2 * DAY):
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=self.root))
        (path / "artifact.bin").write_bytes(b"x" * 10)
        return self.old(path, age)

    def dead_run_dir(self, *, with_chrome=False):
        """伪造一个主人已死的 browser-control-run 目录：有标记、锁没人持有。"""
        path = Path(tempfile.mkdtemp(prefix=scratch.PREFIX + "99999-", dir=self.root))
        (path / scratch.LOCK).touch()
        (path / scratch.MARKER).write_text(json.dumps({"pid": 99999}))
        (path / "shots").mkdir()
        (path / "shots" / "shot.png").write_bytes(b"png")
        if with_chrome:
            (path / "chrome" / "profile-a").mkdir(parents=True)
        return path


class RunDirTests(TempRoot):
    def test_artifacts_land_in_one_service_dir_and_close_removes_it(self):
        core = Engine()
        run = scratch.run_dir()
        self.assertEqual(run.parent, self.root)
        self.assertTrue(run.name.startswith(f"browser-control-run-{os.getpid()}-"))
        from browser_control import driver, network, diagnostics, output
        shot = driver._save_image(b"png", None, False, "png", "browser-control-shot")
        self.assertEqual(shot.parent, run / "shots")
        self.assertTrue(shot.is_file(), "服务存活期间截图路径可读")
        recorder = network.NetworkRecorder.__new__(network.NetworkRecorder)
        recorder._artifact_root = None
        body, fd = recorder._artifact_file(True, "response_body", ".bin")
        os.close(fd)
        self.assertEqual(body.parent.parent, run / "network")
        diag = diagnostics.Diagnostics.__new__(diagnostics.Diagnostics)
        diag._artifact_root = None
        source = diag._new_file("source", ".js")
        source["file"].close()
        self.assertEqual(Path(source["path"]).parent.parent, run / "diagnostics")
        out = output.OutputService.__new__(output.OutputService)
        out._root = None
        self.assertEqual(out._private_root().parent, run / "output")
        self.assertEqual(json.loads((run / scratch.MARKER).read_text())["pid"], os.getpid())
        core.close()
        self.assertFalse(run.exists(), "引擎关闭后本服务临时目录整个删掉")
        core.close()

    def test_second_engine_in_same_process_keeps_dir_until_last_close(self):
        first, second = Engine(), Engine()
        run = scratch.run_dir()
        first.close()
        self.assertTrue(run.exists(), "同进程里另一个引擎还在用，不能删")
        second.close()
        self.assertFalse(run.exists())

    def test_live_owner_dir_is_kept(self):
        context = multiprocessing.get_context("fork")
        ready_r, ready_w = context.Pipe(duplex=False)
        stop_r, stop_w = context.Pipe(duplex=False)
        child = context.Process(target=hold_run_dir, args=(str(self.root), ready_w, stop_r))
        child.start()
        try:
            other = Path(ready_r.recv())
            self.old(other)
            report = scratch.sweep(self.root, processes=[])
            self.assertTrue(other.exists(), report)
            self.assertIn(str(other), report["kept"])
        finally:
            stop_w.send("stop")
            child.join(5)
        # 子进程退出时 atexit 删掉了自己的目录；如果它被强杀没删成，锁也已释放，清扫照删。
        if other.exists():
            self.assertIn(str(other), scratch.sweep(self.root, processes=[])["removed"])


class SweepTests(TempRoot):
    def test_dead_owner_dir_removed_even_if_fresh(self):
        dead = self.dead_run_dir()
        report = scratch.sweep(self.root, processes=[])
        self.assertFalse(dead.exists(), report)
        self.assertGreater(report["bytes"], 0)

    def test_dead_owner_orphan_chrome_is_stopped_before_removal(self):
        dead = self.dead_run_dir(with_chrome=True)
        profile = os.path.realpath(dead / "chrome" / "profile-a")
        stopped = []
        with patch.object(scratch, "_stop", side_effect=lambda pids: stopped.extend(pids)):
            report = scratch.sweep(self.root, processes=[(4242, profile, True), (4343, "/elsewhere", True)])
        self.assertEqual(stopped, [4242], "只停用这份资料的 Chrome")
        self.assertEqual(report["stopped"], [4242])
        self.assertFalse(dead.exists())

    def test_half_created_dir_without_marker_waits_grace(self):
        young = Path(tempfile.mkdtemp(prefix=scratch.PREFIX + "1-", dir=self.root))
        scratch.sweep(self.root, processes=[])
        self.assertTrue(young.exists(), "刚建、还没写标记的目录可能主人正在初始化")
        self.old(young, scratch.CREATING_GRACE + 60)
        scratch.sweep(self.root, processes=[])
        self.assertFalse(young.exists())

    def test_legacy_dirs_only_after_one_day(self):
        old = [self.legacy(p) for p in ("browser-control-shots-", "browser-control-network-", "browser-control-diagnostics-", "browser-control-output-")]
        fresh = self.legacy("browser-control-diagnostics-", age=3600)
        unrelated = self.legacy("browser-control-drain-")
        report = scratch.sweep(self.root, processes=[])
        self.assertTrue(all(not p.exists() for p in old), report)
        self.assertTrue(fresh.exists(), "一天内的旧版目录可能还有旧服务在写")
        self.assertTrue(unrelated.exists(), "不认识的 browser-control- 目录不碰")

    def test_legacy_chrome_profile_in_use_is_kept(self):
        busy = self.legacy("browser-control-chrome-")
        stale_lock = self.legacy("browser-control-chrome-")
        (stale_lock / "SingletonLock").symlink_to("host-999999")
        self.old(stale_lock)
        report = scratch.sweep(self.root, processes=[(4242, os.path.realpath(busy), True)])
        self.assertTrue(busy.exists(), "还有 Chrome 用着的旧资料不删")
        self.assertFalse(stale_lock.exists(), report)

    def test_legacy_chrome_kept_when_process_table_unknown(self):
        busy = self.legacy("browser-control-chrome-")
        with patch.object(scratch, "chrome_processes", side_effect=OSError("ps 失败")):
            report = scratch.sweep(self.root)
        self.assertTrue(busy.exists())
        self.assertTrue(report["errors"])

    def test_failure_is_reported_not_raised(self):
        dead = self.dead_run_dir()
        with patch.object(scratch.shutil, "rmtree", side_effect=PermissionError("fixture")):
            report = scratch.sweep(self.root, processes=[])
        self.assertTrue(dead.exists())
        self.assertEqual(report["errors"][0]["path"], str(dead))

    def test_engine_sweep_never_raises(self):
        core = Engine(sweep=False)
        with patch.object(scratch, "sweep", side_effect=RuntimeError("boom")), \
             patch.object(core, "_default_ledger", side_effect=RuntimeError("ledger boom")):
            report = core.sweep_leftovers(self.root)
        core.close()
        self.assertEqual(report, {"files": None, "records": []})

    def test_live_chrome_scopes_reads_devtools_port(self):
        profile = self.root / "p"
        profile.mkdir()
        (profile / "DevToolsActivePort").write_text(f"5555\n/devtools/browser/{LIVE}\n")
        silent = self.root / "q"
        silent.mkdir()
        scopes, unknown = scratch.live_chrome_scopes([(1, str(profile), True), (2, str(silent), False)])
        self.assertEqual((scopes, unknown), ({LIVE}, False))
        (silent / "x").touch()
        self.assertTrue(scratch.live_chrome_scopes([(2, str(silent), True)])[1], "开着端口却读不出编号要报出来")


class LedgerTests(TempRoot):
    def setUp(self):
        super().setUp()
        state = self.root / "state"
        state.mkdir(mode=0o700)
        self.ledger = ResourceLedger(state / "resources.json")
        for scope, owner, target, browser in ((LIVE, "other-service", "T1", "Chrome"), (DEAD, "mr7292-readonly-review", "T2", "Chrome"),
                                               (DEAD, "someone", "T3", "Chrome"), (LIVE, "other-live", "T4", "Chrome"), (DEAD, "old-task", "T5", "Chrome")):
            self.ledger.record(scope, owner, target, True, browser)
        self.core = Engine(ledger=self.ledger)
        self.addCleanup(self.core.close)

    def remaining(self):
        with self.ledger._transaction() as (_, records, _previous):
            return sorted(r["targetId"] for r in records)



    def test_unreadable_chrome_keeps_all_chrome_records(self):
        with patch.object(scratch, "live_chrome_scopes", return_value=({LIVE}, True)):
            self.core._prune_ledger(self.ledger)
        self.assertEqual(self.remaining(), ["T1", "T2", "T3", "T4", "T5"])

    def test_release_without_browser_cleans_this_task_record(self):
        with patch.object(scratch, "live_chrome_scopes", return_value=({LIVE}, False)):
            reply = self.core.dispatch({"action": "release", "session": "mr7292-readonly-review", "browser": "Chrome"})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"]["closedExternally"], ["T2"])
        self.assertEqual(self.remaining(), ["T1", "T3", "T4", "T5"], "只删这个任务的记录")
        with patch.object(scratch, "live_chrome_scopes", return_value=({LIVE}, False)):
            again = self.core.dispatch({"action": "release", "session": "other-service", "browser": "Chrome"})
        self.assertEqual(again["result"], {"released": []}, "Chrome 还活着的记录不删")

    def test_close_drops_records_of_self_started_chrome(self):
        class Proc:
            def poll(self): return 0
        class Conn:
            def close(self): pass
        self.core.browsers[("Chrome", "mine")] = {"scope": LIVE, "process": Proc(), "profile": None, "cdp": Conn(), "log": None, "launch": {}}
        self.core.close()
        self.assertEqual(self.remaining(), ["T2", "T3", "T5"], "只删本服务自启 Chrome 的记录")


if __name__ == "__main__":
    unittest.main()
