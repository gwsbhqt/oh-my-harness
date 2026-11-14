"""Task defaults are exercised only inside a temporary HOME, without browsers."""
import concurrent.futures
import json
import multiprocessing
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

from browser_use import contexts
from browser_use.errors import BrowserUseError


def _process_choose(scope, output):
    try:
        output.put((True, contexts.choose_session(scope=scope)))
    except Exception as exc:
        output.put((False, repr(exc)))


def _process_identity(output):
    output.put((contexts.PROCESS_SESSION, [path.name for path in Path.home().iterdir()]))


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory()
        self.addCleanup(self.fixture.cleanup)
        self.home = Path(self.fixture.name).resolve()
        self.home.chmod(0o700)
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def store(self, scope="task-a"):
        return contexts._SessionStore(scope)

    def fail(self, callback, code):
        with self.assertRaises(BrowserUseError) as got:
            callback()
        self.assertEqual(got.exception.code, code)

    def test_explicit_does_not_create_state_or_change_pin(self):
        self.assertEqual(contexts.choose_session("explicit", scope="task-a"), "explicit")
        self.assertEqual(list(self.home.iterdir()), [])
        auto = contexts.choose_session(scope="task-a")
        contexts.session_control("use", "pin", scope="task-a")
        before = self.store().path.read_bytes()
        self.assertEqual(contexts.choose_session("explicit", scope="task-a"), "explicit")
        self.assertEqual(self.store().path.read_bytes(), before)
        self.assertEqual(contexts.choose_session(scope="task-a"), "pin")
        self.assertNotEqual(auto, "pin")

    def test_scope_order_and_stable_automatic(self):
        os.environ.update(BROWSER_USE_CONTEXT_ID="browser-use-task", DSH_SESSION_ID="dsh-task")
        named = contexts.choose_session(scope="named")
        browser_use = contexts.choose_session()
        self.assertEqual(browser_use, contexts.choose_session(scope="browser-use-task"))
        del os.environ["BROWSER_USE_CONTEXT_ID"]
        dsh = contexts.choose_session()
        self.assertEqual(dsh, contexts.choose_session(scope="dsh-task"))
        self.assertEqual(named, contexts.choose_session(scope="named"))
        self.assertEqual(len({named, browser_use, dsh}), 3)

    def test_pin_current_clear_retains_automatic_and_resources(self):
        automatic = contexts.session_control("current", scope="task-a")
        self.assertEqual(automatic["source"], "automatic")
        self.assertIsNone(automatic["pinned"])
        resource = self.home / ".local/state/browser-use/resources.json"
        resource.write_text("fixture resource metadata")
        resource.chmod(0o600)
        pinned = contexts.session_control("use", "chosen", scope="task-a")
        self.assertEqual(pinned, {"ok": True, "scope": "task-a", "session": "chosen",
                                  "source": "pinned", "pinned": "chosen"})
        self.assertEqual(contexts.session_control("current", scope="task-a"), pinned)
        contexts.choose_session(scope="other")
        cleared = contexts.session_control("use", scope="task-a", clear=True)
        self.assertEqual(cleared, automatic)
        self.assertEqual(contexts.choose_session(scope="task-a"), automatic["session"])
        self.assertEqual(resource.read_text(), "fixture resource metadata")
        self.assertEqual(json.loads(self.store().path.read_text())["automatic"], automatic["session"])

    def test_no_scope_cli_fails_and_process_default_is_opt_in(self):
        self.fail(lambda: contexts.choose_session(), 2)
        self.fail(lambda: contexts.session_control("current"), 2)
        self.fail(lambda: contexts.session_control("use", "pinned"), 2)
        self.fail(lambda: contexts.session_control("use", clear=True), 2)
        self.assertEqual(contexts.choose_session(allow_process_default=True), contexts.PROCESS_SESSION)
        self.assertEqual(contexts.choose_session(allow_process_default=True), contexts.PROCESS_SESSION)
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertRegex(contexts.PROCESS_SESSION, r"^py_[a-f0-9]{32}$")

    def test_fresh_import_has_no_state_and_new_process_random_default(self):
        ctx = multiprocessing.get_context("spawn")
        output = ctx.Queue()
        processes = [ctx.Process(target=_process_identity, args=(output,)) for _ in range(2)]
        try:
            for process in processes:
                process.start()
            results = [output.get(timeout=15) for _ in processes]
            for process in processes:
                process.join(timeout=15)
                self.assertEqual(process.exitcode, 0)
            self.assertTrue(all(files == [] for _, files in results), results)
            self.assertEqual(len({name for name, _ in results} | {contexts.PROCESS_SESSION}), 3)
            self.assertEqual(list(self.home.iterdir()), [])
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
            output.close()
            output.join_thread()

    def test_invalid_names_and_inputs_do_not_write(self):
        for bad in ["", "a" * 65, "with.dot", "space name", "../x", "中文", "a\n", 1, True, []]:
            with self.subTest(name=bad):
                self.fail(lambda: contexts.choose_session(bad), 2)
                self.fail(lambda: contexts.session_control("use", bad, scope="task"), 2)
        for good in ["a", "a" * 64, "_-abc123", "012"]:
            self.assertEqual(contexts.choose_session(good), good)
        for bad in ["", "x" * 257, "a\n", "a\x00", "a\x7f", "\ud800", 1, []]:
            with self.subTest(scope=repr(bad)):
                self.fail(lambda: contexts.choose_session(scope=bad), 2)
        for args in [("bad",), ([],), ("current", "x"), ("use", "x", "task", True),
                     ("current", None, "task", True), ("use", None, "task", 1)]:
            self.fail(lambda: contexts.session_control(*args), 2)
        self.fail(lambda: contexts.choose_session(allow_process_default=1), 2)
        self.assertEqual(list(self.home.iterdir()), [])

    def test_private_permissions_and_minimal_hashed_metadata(self):
        scope = "https://private.example/task?secret=fixture"
        chosen = contexts.choose_session(scope=scope)
        store = self.store(scope)
        for directory in [store.path.parent, store.path.parent.parent]:
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        for path in [store.path, store.path.with_name(store.lock_name)]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertNotIn(scope, store.path.name)
        raw = store.path.read_text()
        self.assertNotIn(scope, raw)
        self.assertEqual(json.loads(raw), {"version": 1, "automatic": chosen, "pinned": None})
        before = store.path.stat().st_ino
        contexts.session_control("use", "new", scope=scope)
        self.assertNotEqual(store.path.stat().st_ino, before)
        self.assertEqual(list(store.path.parent.glob("*.tmp")), [])

    def test_corruption_fails_closed_without_reset(self):
        contexts.choose_session(scope="task-a")
        path = self.store().path
        good = json.loads(path.read_text())
        cases = ["", "{", "null", "[]", "{}", json.dumps(good) + " trailing",
                 '{"version":1,"version":1,"automatic":"x","pinned":null}',
                 json.dumps(good | {"url": "private"}), json.dumps(good | {"version": True}),
                 json.dumps(good | {"automatic": "bad.name"}),
                 json.dumps(good | {"pinned": 1}), " " * 4097]
        for raw in cases:
            with self.subTest(raw=raw[:80]):
                path.write_text(raw)
                for callback in [lambda: contexts.choose_session(scope="task-a"),
                                 lambda: contexts.session_control("use", "new", scope="task-a"),
                                 lambda: contexts.session_control("use", clear=True, scope="task-a")]:
                    self.fail(callback, 5)
                    self.assertEqual(path.read_text(), raw)
        self.assertEqual(contexts.choose_session("explicit", scope="task-a"), "explicit")
        self.assertRegex(contexts.choose_session(scope="other"), r"^task_[a-f0-9]{32}$")

    def test_unsafe_file_permissions_fail_closed(self):
        contexts.choose_session(scope="task-a")
        store = self.store()
        for path in [store.path, store.path.with_name(store.lock_name), store.path.parent,
                     store.path.parent.parent]:
            original = stat.S_IMODE(path.stat().st_mode)
            path.chmod(0o755 if path.is_dir() else 0o644)
            self.fail(lambda: contexts.choose_session(scope="task-a"), 5)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755 if path.is_dir() else 0o644)
            path.chmod(original)

    def test_symlink_files_and_hard_links_fail_closed(self):
        contexts.choose_session(scope="task-a")
        store = self.store()
        for path in [store.path, store.path.with_name(store.lock_name)]:
            raw = path.read_bytes()
            target = self.home / "outside"
            target.write_bytes(raw)
            target.chmod(0o600)
            path.unlink()
            path.symlink_to(target)
            self.fail(lambda: contexts.choose_session(scope="task-a"), 5)
            self.assertEqual(target.read_bytes(), raw)
            path.unlink()
            os.link(target, path)
            self.fail(lambda: contexts.choose_session(scope="task-a"), 5)
            self.assertEqual(target.read_bytes(), raw)
            path.unlink()
            path.write_bytes(raw)
            path.chmod(0o600)
            target.unlink()

    def test_symlink_ancestor_fails_closed(self):
        outside = self.home / "outside"
        outside.mkdir(mode=0o700)
        (self.home / ".local").symlink_to(outside, target_is_directory=True)
        self.fail(lambda: contexts.choose_session(scope="task-a"), 5)
        self.assertEqual(list(outside.iterdir()), [])

    def test_restrictive_umask_still_creates_exact_modes(self):
        previous = os.umask(0o777)
        try:
            contexts.choose_session(scope="task-a")
        finally:
            os.umask(previous)
        store = self.store()
        self.assertEqual(stat.S_IMODE(store.path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(store.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(store.path.with_name(store.lock_name).stat().st_mode), 0o600)

    def test_concurrent_threads_and_independent_tasks(self):
        scopes = ["same"] * 24 + ["other-" + str(i) for i in range(12)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda scope: contexts.choose_session(scope=scope), scopes))
        self.assertEqual(len(set(results[:24])), 1)
        self.assertEqual(len(set(results)), 13)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: contexts.session_control("use", "pin_" + str(i), scope="same"), range(24)))
        self.assertRegex(contexts.choose_session(scope="same"), r"^pin_\d+$")
        self.assertEqual(contexts.choose_session(scope="other-0"), results[24])

    def test_concurrent_processes_get_same_stable_session(self):
        ctx = multiprocessing.get_context("spawn")
        output = ctx.Queue()
        processes = [ctx.Process(target=_process_choose, args=("cross-cli", output)) for _ in range(8)]
        try:
            for process in processes:
                process.start()
            results = [output.get(timeout=15) for _ in processes]
            for process in processes:
                process.join(timeout=15)
                self.assertEqual(process.exitcode, 0)
            self.assertTrue(all(ok for ok, _ in results), results)
            self.assertEqual(len({name for _, name in results}), 1)
            self.assertEqual(contexts.choose_session(scope="cross-cli"), results[0][1])
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
            output.close()
            output.join_thread()

    def test_external_change_before_replace_is_not_overwritten(self):
        contexts.choose_session(scope="task-a")
        path = self.store().path
        original = contexts._SessionStore._current
        changed = json.dumps({"version": 1, "automatic": "external", "pinned": None})
        def replace_outside(store, directory):
            path.write_text(changed)
            return original(store, directory)
        with mock.patch.object(contexts._SessionStore, "_current", replace_outside):
            self.fail(lambda: contexts.session_control("use", "new", scope="task-a"), 5)
        self.assertEqual(path.read_text(), changed)
        self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_directory_sync_failure_reports_unknown_not_success(self):
        original = os.fsync
        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("fixture sync failure")
            return original(fd)
        with mock.patch.object(contexts.os, "fsync", fail_directory):
            with self.assertRaises(BrowserUseError) as got:
                contexts.choose_session(scope="task-a")
        self.assertEqual(got.exception.outcome, "unknown")
        self.assertRegex(contexts.choose_session(scope="task-a"), r"^task_[a-f0-9]{32}$")
