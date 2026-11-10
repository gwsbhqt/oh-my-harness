"""Isolated ledger fixtures; never read browser state or user configuration."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "_browser_control_resources_fixture"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "src" / "browser_control")]
sys.modules[PACKAGE] = package


def load(name):
    spec = importlib.util.spec_from_file_location(
        PACKAGE + "." + name, ROOT / "src" / "browser_control" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


errors = load("errors")
resources = load("resources")
ResourceLedger = resources.ResourceLedger
SCOPE = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
WS = "ws://127.0.0.1:9222/devtools/browser/" + SCOPE


def writer(path, worker, count, start):
    start.wait(5)
    ledger = ResourceLedger(path)
    for index in range(count):
        ledger.record(SCOPE, "worker_" + str(worker), "tab_" + str(worker) + "_" + str(index), True, "Chrome")


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="browser-control-resources-fixture-")
        # macOS /var is a symlink; use its actual fixture directory explicitly.
        self.root = Path(self.temporary.name).resolve()
        self.path = self.root / "private" / "resources.json"

    def tearDown(self):
        self.temporary.cleanup()

    def ledger(self):
        return ResourceLedger(self.path)

    def assert_closed(self, call):
        with self.assertRaises(errors.BrowserControlError) as caught:
            call()
        self.assertEqual(caught.exception.code, 5)

    def seed(self, target="tab_1", owned=True):
        ledger = self.ledger()
        ledger.record(SCOPE, "owner", target, owned, "Chrome")
        return ledger

    def test_browser_uuid_is_scope_not_port_or_page_uuid(self):
        scope = resources.scope_from_websocket(WS)
        self.assertEqual(scope, SCOPE)
        self.assertEqual(ResourceLedger.scope_from_websocket(WS.replace("9222", "9333")), scope)
        self.assertNotEqual(resources.scope_from_websocket(WS.replace(SCOPE, OTHER)), scope)
        self.assertEqual(resources.scope_from_websocket(WS.replace("ws:", "wss:")), scope)
        self.assertEqual(resources.scope_from_websocket(WS.upper().replace("WS://", "ws://").replace("/DEVTOOLS/BROWSER/", "/devtools/browser/")), scope)
        for bad in [None, "9222", "http://127.0.0.1:9222", "ws://127.0.0.1:9222",
                    WS.replace("browser", "page"), WS + "/", WS + "?token=secret",
                    WS + "#secret", WS.replace(SCOPE, "fixture"), WS.replace("9222", "bad"),
                    WS.replace("127.0.0.1", "user:secret@127.0.0.1")]:
            with self.subTest(value=bad), self.assertRaises(errors.BrowserControlError):
                resources.scope_from_websocket(bad)

    def test_restart_copies_metadata_only_and_owned_is_explicit(self):
        ledger = self.seed()
        ledger.record(SCOPE, "owner", "borrowed", False, "Chrome")
        ledger.record(SCOPE, "another", "created_2", True, "Chrome")
        restarted = self.ledger()
        own = restarted.list(SCOPE, "owner")
        self.assertEqual({item["targetId"] for item in own if item["owned"]}, {"tab_1"})
        self.assertEqual(len(restarted.list(SCOPE)), 3)
        self.assertTrue(all(set(item) == {"scope", "owner", "targetId", "owned", "browser"} for item in own))
        own[0]["owner"] = "changed"
        own.append({"extra": "not saved"})
        self.assertEqual(restarted.list(SCOPE, "owner")[0]["owner"], "owner")
        self.assertEqual(len(restarted.list(SCOPE, "owner")), 2)
        raw = json.loads(self.path.read_text())
        self.assertEqual(len(raw), 3)
        self.assertNotIn("url", self.path.read_text().lower())

    def test_scope_change_never_adopts_old_id_and_preserves_stale_scopes(self):
        ledger = self.seed()
        self.assertEqual(ledger.list(OTHER), [])
        ledger.record(OTHER, "owner", "tab_1", True, "Chrome")
        self.assertEqual(ledger.list(OTHER)[0]["browser"], "Chrome")
        self.assertEqual(ledger.list(SCOPE)[0]["browser"], "Chrome")
        self.assertFalse(ledger.remove(OTHER, "not_owner", "tab_1"))
        self.assertTrue(ledger.remove(OTHER, "owner", "tab_1"))
        self.assertEqual(len(ledger.list(SCOPE)), 1)

    def test_remove_exact_record_does_not_clear_other_owner_scope_or_target(self):
        ledger = self.seed()
        ledger.record(SCOPE, "owner", "tab_2", True, "Chrome")
        ledger.record(SCOPE, "another", "tab_3", True, "Chrome")
        ledger.record(OTHER, "owner", "tab_1", True, "Chrome")
        self.assertFalse(ledger.remove(SCOPE, "another", "tab_1"))
        self.assertTrue(ledger.remove(SCOPE, "owner", "tab_1"))
        self.assertFalse(ledger.remove(SCOPE, "owner", "tab_1"))
        self.assertEqual({item["targetId"] for item in ledger.list(SCOPE)}, {"tab_2", "tab_3"})
        self.assertEqual(len(ledger.list(OTHER)), 1)

    def test_upsert_does_not_duplicate_or_reassign_owner(self):
        ledger = self.seed()
        result = ledger.record(SCOPE, "owner", "tab_1", True, "Chrome")
        result["owned"] = False
        self.assertTrue(ledger.list(SCOPE)[0]["owned"])
        self.assertEqual(len(ledger.list(SCOPE)), 1)
        for owner, browser in [("another", "Chrome")]:
            with self.assertRaises(errors.BrowserControlError) as caught:
                ledger.record(SCOPE, owner, "tab_1", True, browser)
            self.assertEqual(caught.exception.code, 6)
        self.assertEqual(ledger.list(SCOPE)[0]["owner"], "owner")

    def test_private_modes_and_restrictive_umask(self):
        old = os.umask(0o777)
        try:
            self.seed()
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        for path in [self.path, self.path.with_name(self.path.name + ".lock")]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_missing_ledger_is_empty_not_corrupt_file(self):
        ledger = self.ledger()
        self.assertEqual(ledger.list(SCOPE), [])
        self.assertFalse(ledger.remove(SCOPE, "owner", "absent"))
        self.assertFalse(self.path.exists())
        self.path.write_text("")
        self.path.chmod(0o600)
        self.assert_closed(lambda: ledger.list(SCOPE))
        self.assertEqual(self.path.read_bytes(), b"")

    def test_bad_metadata_and_json_fail_closed_without_reset(self):
        ledger = self.seed()
        good = json.loads(self.path.read_text())[0]
        invalid = ["{", "[] trailing", "null", "{}", '[{"scope":"x","scope":"y"}]',
                   json.dumps([good, good])]
        for extra in ["url", "title", "cookie", "cookies"]:
            invalid.append(json.dumps([good | {extra: "secret"}]))
        for field, value in [("scope", "9222"), ("owner", "https://secret"), ("targetId", "https://secret"),
                             ("owned", 1), ("browser", "Safari")]:
            invalid.append(json.dumps([good | {field: value}]))
        for raw in invalid:
            with self.subTest(raw=raw):
                self.path.write_text(raw)
                for call in [lambda: ledger.list(SCOPE),
                             lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"),
                             lambda: ledger.remove(SCOPE, "owner", "tab_1"), self.ledger]:
                    self.assert_closed(call)
                    self.assertEqual(self.path.read_text(), raw)

    def test_symlink_ledger_lock_and_directories_are_rejected(self):
        for kind in ["ledger", "lock", "parent", "ancestor"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(dir=self.root) as fixture:
                directory = Path(fixture)
                actual = directory / "actual"
                actual.mkdir(mode=0o700)
                external = actual / "external"
                external.write_text("[]")
                external.chmod(0o600)
                path = actual / "resources.json"
                if kind in {"ledger", "lock"}:
                    link = path if kind == "ledger" else path.with_name(path.name + ".lock")
                    link.symlink_to(external)
                else:
                    link = directory / "linked"
                    link.symlink_to(actual, target_is_directory=True)
                    path = link / "resources.json" if kind == "parent" else link / "nested/resources.json"
                self.assert_closed(lambda: ResourceLedger(path))
                self.assertEqual(external.read_text(), "[]")

    def test_unsafe_modes_hardlinks_and_nonregular_files_are_rejected(self):
        ledger = self.seed()
        for mode in [0o644, 0o400, 0o000, 0o666]:
            self.path.chmod(mode)
            self.assert_closed(lambda: ledger.list(SCOPE))
        self.path.chmod(0o600)
        os.link(self.path, self.path.with_name("hardlink"))
        self.assert_closed(lambda: ledger.list(SCOPE))
        self.path.with_name("hardlink").unlink()
        self.path.parent.chmod(0o755)
        self.assert_closed(lambda: ledger.list(SCOPE))
        self.path.parent.chmod(0o700)
        for kind in ["directory", "fifo"]:
            path = self.path.parent / kind
            if kind == "directory":
                path.mkdir(mode=0o700)
            else:
                os.mkfifo(path, 0o600)
            self.assert_closed(lambda: ResourceLedger(path))

    def test_foreign_file_or_directory_identity_is_rejected(self):
        ledger = self.seed()
        info = self.path.stat()
        foreign = types.SimpleNamespace(st_mode=info.st_mode, st_uid=os.getuid() + 1, st_nlink=1)
        with patch.object(resources.os, "fstat", return_value=foreign):
            self.assert_closed(lambda: ledger.list(SCOPE))
        foreign.st_mode = stat.S_IFDIR | 0o700
        self.assert_closed(lambda: ledger._check_dir(foreign, True))

    def test_unreadable_existing_file_is_not_treated_as_missing(self):
        ledger = self.seed()
        original = resources.os.open
        def deny(name, *args, **kwargs):
            if name == self.path.name:
                raise PermissionError("fixture unreadable")
            return original(name, *args, **kwargs)
        before = self.path.read_bytes()
        with patch.object(resources.os, "open", side_effect=deny):
            self.assert_closed(lambda: ledger.list(SCOPE))
            self.assert_closed(lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"))
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_inputs_do_not_write_sensitive_values(self):
        ledger = self.ledger()
        for scope, owner, target, owned, browser in [
                ("9222", "owner", "tab", True, "Chrome"),
                (SCOPE, "https://secret", "tab", True, "Chrome"),
                (SCOPE, "owner", "https://secret", True, "Chrome"),
                (SCOPE, "owner", "tab", 1, "Chrome"),
                (SCOPE, "owner", "tab", True, "secret")]:
            with self.assertRaises(errors.BrowserControlError):
                ledger.record(scope, owner, target, owned, browser)
        with self.assertRaises(TypeError):
            ledger.record(SCOPE, "owner", "tab", True, "Chrome", url="secret")
        self.assertFalse(self.path.exists())
        self.assertEqual(ledger.list(SCOPE), [])

    def test_atomic_replace_failure_keeps_old_json_and_removes_own_temporary(self):
        ledger = self.seed()
        before = self.path.read_bytes()
        with patch.object(resources.os, "replace", side_effect=OSError("fixture replacement failure")):
            self.assert_closed(lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.path.parent.glob("*.tmp")))
        self.assertEqual(self.ledger().list(SCOPE)[0]["targetId"], "tab_1")

    def test_atomic_write_fsyncs_data_then_replaces_then_fsyncs_directory(self):
        ledger = self.seed()
        real_fsync, real_replace = resources.os.fsync, resources.os.replace
        events = []
        def sync(fd):
            events.append("dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file")
            return real_fsync(fd)
        def replace(*args, **kwargs):
            events.append("replace")
            return real_replace(*args, **kwargs)
        with patch.object(resources.os, "fsync", side_effect=sync), patch.object(resources.os, "replace", side_effect=replace):
            ledger.record(SCOPE, "owner", "new", True, "Chrome")
        self.assertEqual(events, ["file", "replace", "dir"])

    def test_lock_external_change_is_not_overwritten(self):
        ledger = self.seed()
        real_replace = resources.os.replace
        def changed(directory, records, previous):
            self.path.write_text("[]")
            return original_write(directory, records, previous)
        original_write = ledger._write
        with patch.object(ledger, "_write", side_effect=changed), patch.object(resources.os, "replace", wraps=real_replace) as replace:
            self.assert_closed(lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"))
            replace.assert_not_called()
        self.assertEqual(self.path.read_text(), "[]")

    def test_independent_thread_instances_do_not_lose_updates(self):
        self.seed()
        def write(index):
            ledger = self.ledger()
            ledger.record(SCOPE, "owner", "concurrent_" + str(index), True, "Chrome")
            ledger.remove(SCOPE, "owner", "tab_1")
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(write, range(40)))
        records = self.ledger().list(SCOPE)
        self.assertEqual({item["targetId"] for item in records}, {"concurrent_" + str(index) for index in range(40)})

    @unittest.skipUnless("fork" in multiprocessing.get_all_start_methods(), "需要 fork fixture")
    def test_process_lock_read_modify_write_survives_atomic_inode_replacement(self):
        self.ledger()
        context = multiprocessing.get_context("fork")
        start = context.Event()
        processes = [context.Process(target=writer, args=(str(self.path), worker, 20, start)) for worker in range(4)]
        try:
            for process in processes:
                process.start()
            start.set()
            for process in processes:
                process.join(timeout=10)
                self.assertFalse(process.is_alive(), "fixture writer did not finish")
                self.assertEqual(process.exitcode, 0)
            records = self.ledger().list(SCOPE)
            self.assertEqual(len(records), 80)
            self.assertEqual(len({item["targetId"] for item in records}), 80)
        finally:
            for process in processes:
                if process.is_alive():
                    process.kill()
                process.join(timeout=3)

    def test_lock_permissions_and_foreign_file_fail_closed(self):
        ledger = self.seed()
        lock = self.path.with_name(self.path.name + ".lock")
        lock.chmod(0o644)
        self.assert_closed(lambda: ledger.list(SCOPE))
        lock.chmod(0o600)
        foreign = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600,
                                        st_uid=os.getuid() + 1, st_nlink=1)
        self.assert_closed(lambda: ledger._check_file(foreign))

    def test_data_fsync_failure_leaves_previous_record_and_no_temp(self):
        ledger = self.seed()
        before = self.path.read_bytes()
        with patch.object(resources.os, "fsync", side_effect=OSError("fixture fsync failed")):
            self.assert_closed(lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(list(self.path.parent.glob("*.tmp")))

    def test_directory_fsync_failure_reports_unknown_after_replace(self):
        ledger = self.seed()
        original = resources.os.fsync
        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("fixture directory sync failed")
            return original(fd)
        with patch.object(resources.os, "fsync", side_effect=fail_directory):
            with self.assertRaises(errors.BrowserControlError) as caught:
                ledger.record(SCOPE, "owner", "new", True, "Chrome")
            self.assertEqual(caught.exception.outcome, "unknown")
        self.assertEqual({item["targetId"] for item in ledger.list(SCOPE)}, {"tab_1", "new"})
        self.assertFalse(list(self.path.parent.glob("*.tmp")))

    def test_every_path_open_uses_nofollow(self):
        original = resources.os.open
        flags = []
        def track(name, flag, *args, **kwargs):
            flags.append(flag)
            return original(name, flag, *args, **kwargs)
        with patch.object(resources.os, "open", side_effect=track):
            self.seed().list(SCOPE)
        self.assertTrue(flags)
        self.assertTrue(all(flag & os.O_NOFOLLOW for flag in flags))

    def test_symlink_substitution_before_replace_does_not_touch_destination(self):
        ledger = self.seed()
        external = self.root / "external.json"
        external.write_text("[]")
        external.chmod(0o600)
        original_write = ledger._write
        def substitute(directory, records, previous):
            self.path.unlink()
            self.path.symlink_to(external)
            return original_write(directory, records, previous)
        with patch.object(ledger, "_write", side_effect=substitute):
            self.assert_closed(lambda: ledger.record(SCOPE, "owner", "new", True, "Chrome"))
        self.assertEqual(external.read_text(), "[]")
        self.assertTrue(self.path.is_symlink())

    def test_default_path_uses_private_state_without_reading_real_home(self):
        with patch.object(resources.Path, "home", return_value=self.root):
            ledger = ResourceLedger()
            self.assertEqual(ledger.path, self.root / ".local/state/browser-control/resources.json")
            ledger.record(SCOPE, "owner", "created", True, "Chrome")
            self.assertEqual(len(ResourceLedger().list(SCOPE)), 1)


if __name__ == "__main__":
    unittest.main()
