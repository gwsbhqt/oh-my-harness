"""隔离的核心安全回归；不启动或连接任何真实浏览器。"""
from __future__ import annotations

import concurrent.futures
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "_browser_control_engine_safety"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "src" / "browser_control")]
sys.modules[PACKAGE] = package


def load_core(name):
    spec = importlib.util.spec_from_file_location(
        PACKAGE + "." + name, ROOT / "src" / "browser_control" / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


errors = load_core("errors")
load_core("cdp")
engine = load_core("engine")
server = load_core("server")


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = 0
        self.waited = 0
        self.killed = 0

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated += 1
        self.returncode = 0

    def wait(self, timeout=None):
        self.waited += 1
        return self.returncode

    def kill(self):
        self.killed += 1
        self.returncode = -9


class FakeCDP:
    def __init__(self, url):
        self.closed = False

    def call(self, method, params=None, **kwargs):
        if method == "Target.createBrowserContext":
            return {"browserContextId": "fixture-context"}
        if method == "Target.disposeBrowserContext":
            return {}
        raise AssertionError("未定义的 fixture CDP 调用：" + method)

    def close(self):
        self.closed = True


class ChromeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.profiles = []
        self.processes = []
        self.logs = []
        self.ledger_directory = tempfile.TemporaryDirectory(prefix="browser-control-safety-ledger-")
        self.addCleanup(self.ledger_directory.cleanup)
        self.ledger = Mock()
        self.ledger.path = Path(self.ledger_directory.name) / "resources.json"
        self.ledger.list.return_value = []
        self.ledger.prune.return_value = []
        self.engine = engine.Engine(ledger=self.ledger)
        self.real_mkdtemp = tempfile.mkdtemp
        self.port_text = "54321\n/devtools/browser/fixture\n"

    def tearDown(self):
        self.engine.close()
        for profile in self.profiles:
            self.assertFalse(profile.exists(), "引擎关闭后自启 Chrome 的临时资料应已删除")

    def make_profile(self, *args, **kwargs):
        path = self.real_mkdtemp(*args, **kwargs)
        if kwargs.get("prefix") == "profile-":
            self.profiles.append(Path(path))
        return path

    def spawn(self, flags, **kwargs):
        self.logs.append(kwargs["stderr"])
        profile = next(value.split("=", 1)[1] for value in flags if value.startswith("--user-data-dir="))
        (Path(profile) / "DevToolsActivePort").write_text(self.port_text)
        process = FakeProcess()
        self.processes.append(process)
        return process

    def patches(self, spawn=None, discover=None):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(engine.Path, "is_file", return_value=True))
        stack.enter_context(patch.object(engine.tempfile, "mkdtemp", side_effect=self.make_profile))
        stack.enter_context(patch.object(engine.subprocess, "Popen", side_effect=spawn or self.spawn))
        stack.enter_context(patch.object(engine, "discover", side_effect=discover or (lambda url: "ws://127.0.0.1:9222/devtools/browser/11111111-1111-1111-1111-111111111111")))
        stack.enter_context(patch.object(engine, "CDP", side_effect=FakeCDP))
        return stack

    def request(self, action="up"):
        return self.engine.dispatch({"action": action, "session": "safety", "browser": "Chrome"})

    def assert_failure_cleaned(self, reply):
        self.assertFalse(reply["ok"], reply)
        self.assertFalse(self.engine.browsers)
        self.assertTrue(all(not path.exists() for path in self.profiles), self.profiles)
        self.assertTrue(all(log.closed for log in self.logs))
        for process in self.processes:
            self.assertEqual(process.terminated, 1)
            self.assertEqual(process.waited, 1)

    def test_same_session_concurrent_up_creates_one_browser(self):
        entered = threading.Event()
        gate = threading.Event()
        second_spawn = threading.Event()
        def blocked_spawn(*args, **kwargs):
            if entered.is_set():
                second_spawn.set()
            entered.set()
            self.assertTrue(gate.wait(3), "测试未解除启动门闩")
            return self.spawn(*args, **kwargs)
        with self.patches(spawn=blocked_spawn):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self.request)
                self.assertTrue(entered.wait(2))
                second = pool.submit(self.request)
                try:
                    second_spawn.wait(.15)
                finally:
                    gate.set()
                replies = [first.result(timeout=3), second.result(timeout=3)]
            self.assertTrue(all(reply["ok"] for reply in replies), replies)
            self.assertEqual(len(self.processes), 1)
            self.engine.close()
            self.assertEqual(self.processes[0].terminated, 1)
            self.assertEqual(self.processes[0].waited, 1)
            self.assertTrue(all(not path.exists() for path in self.profiles))
            self.assertTrue(all(log.closed for log in self.logs))

    def test_temporary_profile_never_touches_system_keychain(self):
        launched = []
        def record_spawn(flags, **kwargs):
            launched.append(flags)
            return self.spawn(flags, **kwargs)
        with self.patches(spawn=record_spawn):
            self.assertTrue(self.request()["ok"])
        self.assertIn("--use-mock-keychain", launched[0])
        self.assertIn("--password-store=basic", launched[0])

    def test_spawn_failure_removes_profile_and_closes_log(self):
        def fail_spawn(*args, **kwargs):
            self.logs.append(kwargs["stderr"])
            raise OSError("fixture spawn failed")
        with self.patches(spawn=fail_spawn):
            self.assert_failure_cleaned(self.request())

    def test_discover_failure_reaps_process_and_removes_profile(self):
        def fail_discover(url):
            raise errors.BrowserControlError("fixture discover failed", 5)
        with self.patches(discover=fail_discover):
            self.assert_failure_cleaned(self.request())

    def test_empty_port_file_reaps_process_and_removes_profile(self):
        self.port_text = ""
        with self.patches():
            self.assert_failure_cleaned(self.request())

    def test_unreadable_port_file_reaps_process_and_removes_profile(self):
        with self.patches(), patch.object(engine.Path, "read_text", side_effect=PermissionError("fixture port unreadable")):
            self.assert_failure_cleaned(self.request())

    def test_cdp_close_failure_still_reaps_process_and_removes_profile(self):
        with self.patches():
            self.assertTrue(self.request()["ok"])
            record = next(iter(self.engine.browsers.values()))
            with patch.object(record["cdp"], "close", side_effect=RuntimeError("fixture close failed")):
                try:
                    self.engine._stop_browser("Chrome", "safety")
                except Exception:
                    pass
            self.assertEqual(self.processes[0].terminated, 1)
            self.assertEqual(self.processes[0].waited, 1)
            self.assertTrue(all(not path.exists() for path in self.profiles))
            self.assertTrue(all(log.closed for log in self.logs))

    def test_close_failure_in_one_browser_still_cleans_other_sessions(self):
        processes = [FakeProcess(), FakeProcess()]
        connections = [FakeCDP("ws://fixture-a"), FakeCDP("ws://fixture-b")]
        for session, process, connection in zip(("first", "second"), processes, connections):
            self.engine.browsers[("Chrome", session)] = {
                "cdp": connection, "process": process, "profile": None, "log": None,
            }
        with patch.object(connections[0], "close", side_effect=RuntimeError("fixture first close failed")):
            try:
                self.engine.close()
            except Exception:
                pass
        self.assertEqual([process.terminated for process in processes], [1, 1])
        self.assertEqual([process.waited for process in processes], [1, 1])

    def test_network_constructor_failure_closes_driver_and_detaches(self):
        calls = []
        class BindingCDP:
            def call(self, method, params=None, **kwargs):
                calls.append((method, params))
                if method == "Target.getTargets":
                    return {"targetInfos": [{"targetId": "borrowed", "type": "page", "url": "about:blank"}]}
                if method == "Target.attachToTarget":
                    return {"sessionId": "fixture-attachment"}
                if method == "Target.detachFromTarget":
                    return {}
                raise AssertionError(method)
        drivers = []
        class BindingDriver:
            def __init__(self, *args):
                self.closed = False
                drivers.append(self)
            def close(self):
                self.closed = True
        page_module = types.ModuleType(PACKAGE + ".driver")
        page_module.PageDriver = BindingDriver
        network_module = types.ModuleType(PACKAGE + ".network")
        def failed_recorder(driver):
            raise errors.BrowserControlError("fixture recorder setup failed", 5)
        network_module.NetworkRecorder = failed_recorder
        with patch.dict(sys.modules, {PACKAGE + ".driver": page_module, PACKAGE + ".network": network_module}):
            with self.assertRaises(errors.BrowserControlError):
                self.engine._bind("Chrome", "safety", "borrowed", {"cdp": BindingCDP(), "context_id": None})
        self.assertTrue(drivers[0].closed)
        self.assertIn(("Target.detachFromTarget", {"sessionId": "fixture-attachment"}), calls)
        self.assertNotIn("Target.closeTarget", [method for method, params in calls])
        self.assertFalse(self.engine.bindings)

    def test_empty_release_and_unknown_action_do_not_start_browser(self):
        with patch.object(self.engine, "_browser", side_effect=AssertionError("不得启动浏览器")) as browser:
            reply = self.request("release")
            self.assertTrue(reply["ok"], reply)
            self.assertEqual(reply["result"], {"released": []})
            reply = self.request("unsupported_fixture_action")
            self.assertFalse(reply["ok"], reply)
            self.assertEqual(reply["code"], 2)
            browser.assert_not_called()


def run_socket_fixture(socket_path, notice, idle_timeout=1800):
    class NoBrowserEngine:
        def __init__(self, **options):
            self.draining = threading.Event()
        def idle(self):
            return True
        def dispatch(self, request):
            return {"ok": True, "result": "fixture"}
        def close(self):
            notice.send("closed")
    original = server.socketserver.ThreadingUnixStreamServer
    class NotifyingServer(original):
        def server_activate(self):
            super().server_activate()
            notice.send("ready")
    server.Engine = NoBrowserEngine
    server.socketserver.ThreadingUnixStreamServer = NotifyingServer
    server.serve(socket_path, idle_timeout=idle_timeout)


@unittest.skipUnless(os.name == "posix" and "fork" in multiprocessing.get_all_start_methods(), "需要 Unix socket 和 fork")
class SocketSafetyTests(unittest.TestCase):
    def run_idle_fixture(self, *, live_request):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        with tempfile.TemporaryDirectory(prefix="browser-control-safety-idle-") as directory:
            socket_path = str(Path(directory) / "service.sock")
            process = context.Process(target=run_socket_fixture, args=(socket_path, sender, .2))
            process.start()
            client = None
            try:
                self.assertTrue(receiver.poll(3), "服务没有通知 socket 已就绪")
                self.assertEqual(receiver.recv(), "ready")
                if live_request:
                    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    client.settimeout(2)
                    client.connect(socket_path)
                    client.sendall(b'{"action":')
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                        probe.settimeout(2)
                        probe.connect(socket_path)
                        probe.sendall(b"{}\n")
                        self.assertTrue(json.loads(probe.recv(4096))["ok"])
                    process.join(timeout=.7)
                    self.assertTrue(process.is_alive(), "半行在途请求被空闲退出中断")
                    self.assertFalse(receiver.poll(), "在途请求结束前调用了 Engine.close")
                    client.sendall(b'"fixture"}\n')
                    self.assertTrue(json.loads(client.recv(4096))["ok"])
                    client.close()
                    client = None
                process.join(timeout=2)
                self.assertFalse(process.is_alive(), "无连接的空闲服务未自然退出")
                self.assertEqual(process.exitcode, 0)
                self.assertTrue(receiver.poll(1))
                self.assertEqual(receiver.recv(), "closed")
                self.assertFalse(Path(socket_path).exists())
            finally:
                if client is not None:
                    client.close()
                if process.is_alive():
                    process.kill()
                process.join(timeout=3)
                receiver.close()
                sender.close()

    def test_idle_service_exits_and_closes_engine(self):
        self.run_idle_fixture(live_request=False)

    def test_idle_service_preserves_partial_live_request(self):
        self.run_idle_fixture(live_request=True)

    def test_partial_request_does_not_block_shutdown(self):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        with tempfile.TemporaryDirectory(prefix="browser-control-safety-socket-") as directory:
            socket_path = str(Path(directory) / "service.sock")
            process = context.Process(target=run_socket_fixture, args=(socket_path, sender))
            process.start()
            client = None
            try:
                self.assertTrue(receiver.poll(3), "服务没有通知 socket 已就绪")
                self.assertEqual(receiver.recv(), "ready")
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.settimeout(2)
                client.connect(socket_path)
                client.sendall(b'{"action":')
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.settimeout(2)
                    probe.connect(socket_path)
                    probe.sendall(b"{}\n")
                    self.assertTrue(json.loads(probe.recv(4096))["ok"])
                os.kill(process.pid, signal.SIGTERM)
                process.join(timeout=2)
                self.assertFalse(process.is_alive(), "半行客户端阻止服务停止与 Engine.close")
                self.assertEqual(process.exitcode, 0)
                self.assertTrue(receiver.poll(1))
                self.assertEqual(receiver.recv(), "closed")
                self.assertFalse(Path(socket_path).exists())
            finally:
                if client is not None:
                    client.close()
                if process.is_alive():
                    process.kill()
                process.join(timeout=3)
                receiver.close()
                sender.close()


class CDPSafetyTests(unittest.TestCase):
    def test_timeout_does_not_replay_and_late_response_is_ignored(self):
        import queue
        incoming = queue.Queue()
        sent = []
        class FixtureWebSocket:
            def __iter__(self):
                while True:
                    value = incoming.get()
                    if value is None:
                        return
                    yield value
            def send(self, raw):
                message = json.loads(raw)
                sent.append(message)
                if len(sent) > 1:
                    incoming.put(json.dumps({"id": message["id"], "result": {"fixture": True}}))
            def close(self):
                incoming.put(None)
        sync_client = types.ModuleType("websockets.sync.client")
        sync_client.connect = lambda *args, **kwargs: FixtureWebSocket()
        cdp_module = sys.modules[PACKAGE + ".cdp"]
        with patch.dict(sys.modules, {"websockets.sync.client": sync_client}):
            connection = cdp_module.CDP("ws://fixture")
        try:
            with self.assertRaises(errors.BrowserControlError) as failure:
                connection.call("Input.dispatchMouseEvent", {"type": "mousePressed"}, timeout=.03)
            self.assertEqual(failure.exception.code, 4)
            self.assertEqual(failure.exception.outcome, "unknown")
            self.assertEqual(len(sent), 1)
            incoming.put(json.dumps({"id": sent[0]["id"], "result": {"late": True}}))
            self.assertEqual(connection.call("Runtime.evaluate", timeout=1), {"fixture": True})
            self.assertEqual([value["method"] for value in sent], ["Input.dispatchMouseEvent", "Runtime.evaluate"])
        finally:
            connection.close()
        self.assertFalse(connection._reader.is_alive())
        self.assertFalse(connection._dispatcher.is_alive())


class PermissionSafetyTests(unittest.TestCase):
    def test_refused_parent_does_not_change_existing_permissions(self):
        with tempfile.TemporaryDirectory(prefix="browser-control-safety-permissions-") as directory:
            parent = Path(directory)
            parent.chmod(0o755)
            occupied = parent / "occupied.sock"
            occupied.write_text("fixture")
            with self.assertRaises(errors.BrowserControlError):
                server.serve(str(occupied))
            self.assertEqual(parent.stat().st_mode & 0o777, 0o755)

    def test_lock_symlink_does_not_change_target_permissions(self):
        with tempfile.TemporaryDirectory(prefix="browser-control-safety-permissions-") as directory:
            parent = Path(directory)
            occupied = parent / "occupied.sock"
            occupied.write_text("fixture")
            victim = parent / "victim"
            victim.write_text("fixture")
            victim.chmod(0o644)
            (parent / "occupied.sock.lock").symlink_to(victim)
            with self.assertRaises((errors.BrowserControlError, OSError)):
                server.serve(str(occupied))
            self.assertEqual(victim.stat().st_mode & 0o777, 0o644)





def run_drain_fixture(socket_path, notice):
    class HoldingEngine:
        def __init__(self, **options):
            self.draining = threading.Event()
            self.owners = {"old-a", "old-b"}
            self.calls = []
        def holdings(self):
            return [{"session": s, "pages": 1, "browsers": ["Chrome"]} for s in sorted(self.owners)]
        def blockers(self):
            return [f"{s}（1 个页面、Chrome 浏览器）" for s in sorted(self.owners)]
        def idle(self):
            return not self.owners
        def holds(self, request):
            return request.get("session") in self.owners
        def dispatch(self, request):
            self.calls.append(request.get("action"))
            if request.get("action") == "release":
                self.owners.discard(request.get("session"))
            notice.send(("dispatch", request.get("session"), request.get("action")))
            return {"ok": True, "result": "fixture"}
        def close(self):
            notice.send("closed")
    original = server.socketserver.ThreadingUnixStreamServer
    class NotifyingServer(original):
        def server_activate(self):
            super().server_activate()
            notice.send("ready")
    server.Engine = HoldingEngine
    server.socketserver.ThreadingUnixStreamServer = NotifyingServer
    server.serve(socket_path, idle_timeout=600)


@unittest.skipUnless(os.name == "posix" and "fork" in multiprocessing.get_all_start_methods(), "需要 Unix socket 和 fork")
class DrainTests(unittest.TestCase):
    def ask(self, socket_path, request):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(5)
            conn.connect(socket_path)
            conn.sendall((json.dumps(request) + "\n").encode())
            return json.loads(conn.makefile("rb").readline())

    def test_drain_refuses_new_tasks_keeps_old_and_exits_after_release(self):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        with tempfile.TemporaryDirectory(prefix="browser-control-drain-") as directory:
            socket_path = str(Path(directory) / "service.sock")
            process = context.Process(target=run_drain_fixture, args=(socket_path, sender))
            process.start()
            try:
                self.assertEqual(receiver.recv(), "ready")
                info = self.ask(socket_path, {"action": "service", "params": {"op": "info"}})
                self.assertEqual(info["result"]["fingerprint"], server.source_fingerprint())
                self.assertFalse(info["result"]["draining"])
                drained = self.ask(socket_path, {"action": "service", "params": {"op": "drain"}})
                self.assertTrue(drained["result"]["draining"])
                self.assertEqual([h["session"] for h in drained["result"]["holdings"]], ["old-a", "old-b"])
                refused = self.ask(socket_path, {"action": "tab_new", "session": "new-task"})
                self.assertFalse(refused["ok"]); self.assertEqual((refused["code"], refused["outcome"]), (5, "not_sent"))
                self.assertIn("old-a（1 个页面", refused["error"], "拒绝时要说清在等哪个任务")
                self.assertEqual(refused["data"]["pid"], process.pid)
                self.assertFalse(receiver.poll(0.2), "排空后新任务的请求不能进入引擎")
                self.assertTrue(self.ask(socket_path, {"action": "page_click", "session": "old-a"})["ok"])
                self.assertEqual(receiver.recv(), ("dispatch", "old-a", "page_click"))
                self.ask(socket_path, {"action": "release", "session": "old-a"}); receiver.recv()
                time.sleep(0.6)
                self.assertTrue(process.is_alive(), "仍有任务持有资源时不能退出")
                self.ask(socket_path, {"action": "release", "session": "old-b"}); receiver.recv()
                process.join(timeout=5)
                self.assertFalse(process.is_alive(), "全部释放后排空中的服务应自己退出")
                self.assertEqual(receiver.recv(), "closed")
                self.assertFalse(Path(socket_path).exists())
            finally:
                if process.is_alive():
                    process.kill()
                process.join(timeout=3)
                receiver.close(); sender.close()

    def test_unknown_service_op_not_sent(self):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        with tempfile.TemporaryDirectory(prefix="browser-control-drain-") as directory:
            socket_path = str(Path(directory) / "service.sock")
            process = context.Process(target=run_drain_fixture, args=(socket_path, sender))
            process.start()
            try:
                self.assertEqual(receiver.recv(), "ready")
                reply = self.ask(socket_path, {"action": "service", "params": {"op": "stop"}})
                self.assertEqual((reply["ok"], reply["code"], reply["outcome"]), (False, 2, "not_sent"))
                self.assertFalse(self.ask(socket_path, {"action": "service", "params": {"op": "info"}})["result"]["draining"])
            finally:
                process.kill(); process.join(timeout=3)
                receiver.close(); sender.close()


    def test_version_mismatch_refused_and_client_rechecks(self):
        context = multiprocessing.get_context("fork")
        receiver, sender = context.Pipe(duplex=False)
        with tempfile.TemporaryDirectory(prefix="browser-control-drain-") as directory:
            socket_path = str(Path(directory) / "service.sock")
            process = context.Process(target=run_drain_fixture, args=(socket_path, sender))
            process.start()
            try:
                self.assertEqual(receiver.recv(), "ready")
                reply = self.ask(socket_path, {"action": "page_click", "session": "old-a", "expectFingerprint": "another-version"})
                self.assertEqual((reply["ok"], reply["code"], reply["outcome"]), (False, 5, "not_sent"))
                self.assertTrue(reply["data"]["versionMismatch"])
                self.assertFalse(receiver.poll(0.2), "版本不一致的请求不能进入引擎")
                ok = self.ask(socket_path, {"action": "page_click", "session": "old-a", "expectFingerprint": server.source_fingerprint()})
                self.assertTrue(ok["ok"])
                self.assertEqual(receiver.recv(), ("dispatch", "old-a", "page_click"))
            finally:
                process.kill(); process.join(timeout=3)
                receiver.close(); sender.close()


class DrainOwnershipTests(unittest.TestCase):
    def test_new_session_refused_while_long_action_holds_engine_lock(self):
        core = engine.Engine()
        core._hold_browser(("Chrome", "old-a"))
        core._hold_page(("Chrome", "page-a"), "old-a")
        core.draining.set()
        acquired = threading.Event(); release = threading.Event()
        def long_action():
            with core._lock:
                acquired.set(); release.wait(5)
        worker = threading.Thread(target=long_action); worker.start()
        try:
            self.assertTrue(acquired.wait(2))
            started = time.monotonic()
            self.assertFalse(core.holds({"session": "new-task"}), "长动作持锁时也不能把新任务当成旧任务")
            self.assertTrue(core.holds({"session": "old-a"}))
            self.assertLess(time.monotonic() - started, 0.3, "归属查询不能等引擎大锁")
            self.assertEqual([h["session"] for h in core.holdings()], ["old-a"])
            self.assertFalse(core.idle())
        finally:
            release.set(); worker.join(timeout=5)

    def test_refuse_inside_lock_before_creating_resources(self):
        core = engine.Engine()
        core._hold_browser(("Chrome", "old-a"))
        core.draining.set()
        with self.assertRaises(engine.BrowserControlError) as raised:
            core._browser("Chrome", "sneaky", {})
        self.assertEqual((raised.exception.code, raised.exception.outcome), (5, "not_sent"))
        with self.assertRaises(engine.BrowserControlError) as raised:
            core._bind("Chrome", "sneaky", "target-x", {"cdp": None})
        self.assertEqual(raised.exception.code, 5)
        core._refuse_new_holder("old-a")

    def test_holdings_follow_add_and_remove(self):
        core = engine.Engine()
        core._hold_page(("Chrome", "p1"), "a"); core._hold_browser(("Chrome", "a"))
        self.assertFalse(core.idle())
        core._drop_page(("Chrome", "p1")); core._drop_browser(("Chrome", "a"))
        self.assertTrue(core.idle())


if __name__ == "__main__":
    unittest.main()
