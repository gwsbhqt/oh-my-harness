"""后台服务的退出时机与换新：空闲多久退出、新任务碰上排空中的旧服务时怎么等。"""
import json
import multiprocessing
import os
from pathlib import Path
import socket
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch

from browser_control import client as client_module
from browser_control import server
from browser_control.client import Client
from browser_control.errors import BrowserControlError

SRC = Path(server.__file__).resolve().parents[1]
FORK = os.name == "posix" and "fork" in multiprocessing.get_all_start_methods()


def run_lifecycle_fixture(socket_path, notice, owners, fingerprint=None, idle_timeout=600, empty_idle_timeout=600, attach_lost=False, live_browser=False):
    """owners 是占着页面的任务；它们 release 后引擎才算空闲。"""
    class FixtureEngine:
        def __init__(self, **options):
            self.draining = threading.Event()
            self.owners = set(owners)
            self.lost = attach_lost
        def holdings(self):
            return [{"session": s, "pages": 1, "browsers": ["Chrome"]} for s in sorted(self.owners)]
        def blockers(self):
            return [f"{s}（1 个页面、Chrome 浏览器）" for s in sorted(self.owners)]
        def idle(self):
            return not self.owners
        def attach_lost(self):
            return self.lost
        def has_live_browser(self):
            return live_browser
        def holds(self, request):
            return request.get("session") in self.owners
        def dispatch(self, request):
            if request.get("action") == "release":
                self.owners.discard(request.get("session"))
            notice.send(("dispatch", request.get("session"), request.get("action")))
            return {"ok": True, "result": {"servedBy": os.getpid()}}
        def close(self):
            notice.send("closed")
    original = server.socketserver.ThreadingUnixStreamServer
    class NotifyingServer(original):
        def server_activate(self):
            super().server_activate()
            notice.send("ready")
    server.Engine = FixtureEngine
    server.socketserver.ThreadingUnixStreamServer = NotifyingServer
    if fingerprint is not None:
        server.source_fingerprint = lambda: fingerprint
    server.serve(socket_path, idle_timeout=idle_timeout, empty_idle_timeout=empty_idle_timeout)


def ask(socket_path, request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(5)
        conn.connect(socket_path)
        conn.sendall((json.dumps(request) + "\n").encode())
        return json.loads(conn.makefile("rb").readline())


class FixtureCase(unittest.TestCase):
    def start(self, owners=(), **options):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        directory = tempfile.mkdtemp(prefix="browser-control-life-")
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        socket_path = str(Path(directory) / "service.sock")
        process = context.Process(target=run_lifecycle_fixture, args=(socket_path, sender, tuple(owners)), kwargs=options)
        process.start()
        def cleanup():
            if process.is_alive():
                process.kill()
            process.join(timeout=3)
            receiver.close(); sender.close()
        self.addCleanup(cleanup)
        self.assertTrue(receiver.poll(5), "服务没有通知 socket 已就绪")
        self.assertEqual(receiver.recv(), "ready")
        return socket_path, process, receiver


@unittest.skipUnless(FORK, "需要 Unix socket 和 fork")
class IdleExitTests(FixtureCase):
    def test_nothing_held_exits_after_short_idle(self):
        socket_path, process, receiver = self.start(empty_idle_timeout=.3)
        self.assertTrue(ask(socket_path, {"action": "tab_list", "session": "a"})["ok"])
        process.join(timeout=3)
        self.assertFalse(process.is_alive(), "没人占着页面时应按短空闲时限退出")
        self.assertEqual(process.exitcode, 0)
        self.assertFalse(Path(socket_path).exists())

    def test_held_pages_keep_long_protection_then_short_after_release(self):
        socket_path, process, receiver = self.start(owners=("old-a",), empty_idle_timeout=.3)
        process.join(timeout=1.2)
        self.assertTrue(process.is_alive(), "还有任务占着页面时不能按短时限退出")
        self.assertTrue(ask(socket_path, {"action": "release", "session": "old-a"})["ok"])
        process.join(timeout=3)
        self.assertFalse(process.is_alive(), "释放后应按短时限退出")

    def test_chrome_loss_exits_without_waiting_for_idle_timeout(self):
        socket_path, process, receiver = self.start(attach_lost=True, idle_timeout=600, empty_idle_timeout=600)
        process.join(timeout=3)
        self.assertFalse(process.is_alive(), "Chrome 失效后立即退出，不等空闲时限")
        self.assertEqual(process.exitcode, 0)

    def test_lost_browser_does_not_stop_another_live_browser(self):
        socket_path, process, receiver = self.start(owners=("chrome-task",), attach_lost=True, live_browser=True)
        process.join(timeout=.6)
        self.assertTrue(process.is_alive(), "Arc 断开时不能结束仍在使用 Chrome 的服务")
        self.assertTrue(ask(socket_path, {"action": "tab_list", "session": "chrome-task"})["ok"])

    def test_long_limit_still_applies_when_held(self):
        socket_path, process, receiver = self.start(owners=("old-a",), idle_timeout=.3, empty_idle_timeout=600)
        process.join(timeout=3)
        self.assertFalse(process.is_alive(), "占用中也保留原来的长空闲退出")



@unittest.skipUnless(FORK, "需要 Unix socket 和 fork")
class DrainWaitTests(FixtureCase):
    def fake_launcher(self):
        """代替真实启动器：拉起一个不碰浏览器、版本和本地源码一致的服务。"""
        path = Path(tempfile.mkdtemp(prefix="browser-control-launcher-")) / "browser-control"
        self.addCleanup(lambda: __import__("shutil").rmtree(path.parent, ignore_errors=True))
        path.write_text(textwrap.dedent(f"""
            import os, sys
            sys.path.insert(0, {str(SRC)!r})
            from browser_control import server
            class Engine:
                def __init__(self, **options):
                    import threading
                    self.draining = threading.Event()
                def holdings(self): return []
                def blockers(self): return []
                def idle(self): return True
                def holds(self, request): return False
                def dispatch(self, request): return {{"ok": True, "result": {{"servedBy": os.getpid(), "session": request.get("session")}}}}
                def close(self): pass
            server.Engine = Engine
            server.serve(sys.argv[3], idle_timeout=20, empty_idle_timeout=20)
        """))
        return path

    def stop_started(self, caller):
        if caller._process is not None:
            caller._process.terminate()
            caller._process.wait(timeout=5)

    def test_new_task_waits_for_old_service_then_new_version_serves(self):
        socket_path, old, receiver = self.start(owners=("old-a",), fingerprint="old-version")
        caller = Client(socket_path)
        self.addCleanup(self.stop_started, caller)
        def release_later():
            time.sleep(.8)
            ask(socket_path, {"action": "release", "session": "old-a"})
        releaser = threading.Thread(target=release_later)
        with patch.object(client_module, "LAUNCHER", self.fake_launcher()):
            # 旧任务占着页面，排空期间照旧直接发给旧服务。
            self.assertEqual(caller.call("page_click", session="old-a", timeout=5)["servedBy"], old.pid)
            releaser.start()
            started = time.monotonic()
            result = caller.call("tab_list", session="new-task", timeout=10)
            waited = time.monotonic() - started
        releaser.join()
        self.assertNotEqual(result["servedBy"], old.pid, "等旧服务退出后应由新版服务执行")
        self.assertEqual(result["session"], "new-task")
        self.assertGreater(waited, .5)
        old.join(timeout=3)
        self.assertFalse(old.is_alive())
        seen = []
        while receiver.poll(.1):
            seen.append(receiver.recv())
        self.assertNotIn(("dispatch", "new-task", "tab_list"), seen, "新任务的动作不能发给旧服务")
        self.assertEqual(seen.count(("dispatch", "old-a", "release")), 1)

    def test_wait_gives_up_within_call_timeout_and_names_blockers(self):
        socket_path, old, receiver = self.start(owners=("old-a",), fingerprint="old-version")
        caller = Client(socket_path, autostart=False)
        started = time.monotonic()
        with self.assertRaises(BrowserControlError) as raised:
            caller.call("tab_list", session="new-task", timeout=1.5)
        waited = time.monotonic() - started
        self.assertLess(waited, 2.5, "等待不能超过这次调用的 timeout")
        error = raised.exception
        self.assertEqual((error.code, error.outcome), (5, "not_sent"))
        self.assertIn("old-a（1 个页面", str(error))
        self.assertIn(str(old.pid), str(error))
        self.assertTrue(old.is_alive(), "等不到也不能强停旧服务")
        self.assertEqual(caller.call("page_click", session="old-a", timeout=5)["servedBy"], old.pid, "旧任务不受影响")
        seen = []
        while receiver.poll(.1):
            seen.append(receiver.recv())
        self.assertEqual(seen, [("dispatch", "old-a", "page_click")], "新任务的动作没有发出过")

    def test_wait_capped_by_drain_wait(self):
        socket_path, old, receiver = self.start(owners=("old-a",), fingerprint="old-version")
        caller = Client(socket_path, autostart=False)
        started = time.monotonic()
        with patch.object(client_module, "DRAIN_WAIT", .5), self.assertRaises(BrowserControlError) as raised:
            caller.call("tab_list", session="new-task", timeout=20)
        self.assertLess(time.monotonic() - started, 1.5, "最多等 DRAIN_WAIT")
        self.assertIn("还没退出", str(raised.exception))

    def test_service_gone_ignores_live_lock_holder(self):
        socket_path, old, receiver = self.start()
        caller = Client(socket_path, autostart=False)
        self.assertFalse(caller._service_gone(), "服务还持有锁时不能当它已退出")
        old.kill(); old.join(timeout=3)
        self.assertTrue(caller._service_gone())


if __name__ == "__main__":
    unittest.main()
