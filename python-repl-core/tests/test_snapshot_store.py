"""Transaction boundaries for the shared Prime snapshot store. Only temporary files are used."""
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from python_repl_core import snapshot_store as store


def save(pair, content, callback=lambda result: None):
    def write(data, meta):
        data.write_bytes(content)
        meta.write_text(json.dumps({"version": 1, "savedNames": ["x"], "skipped": [], "pruned": [],
                                    "timestamp": "2025-01-01T00:00:00+00:00", "bytes": len(content)}))
        return {"saved": ["x"], "skipped": [], "pruned": [], "bytes": len(content)}
    return store.publish_snapshot(pair, write, callback)


def interrupted_save(pair, cut):
    real = os.replace

    def interrupt(src, dst):
        src, dst = Path(src), Path(dst)
        new_pointer = (dst.name == "current" and src.is_symlink() and len(os.readlink(src)) == 32)
        if cut == "before-pointer" and new_pointer:
            os._exit(73)
        real(src, dst)
        if ((cut == "after-first-alias" and dst == pair.payload) or
                (cut == "after-pointer" and new_pointer)):
            os._exit(73)

    with patch.object(os, "replace", interrupt):
        save(pair, b"next")
    raise AssertionError("expected fault was not reached")


def block_encoding(pair, ready, release):
    def write(data, meta):
        ready.set()
        if not release.wait(10):
            raise RuntimeError("fixture encoding wait timed out")
        return {"error": "end of encoding probe"}
    store.publish_snapshot(pair, write, lambda result: None)


def await_reset(pair, ready, finished):
    ready.set()
    store.reset_snapshot(pair.payload, pair.manifest)
    finished.set()


class SnapshotStoreTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.pair = store.SnapshotPair(self.root / "state.dill", self.root / "state.manifest.json")
        self.data, self.meta = self.pair.payload, self.pair.manifest
        self.legacy_data = b"old binary fixture"
        self.legacy_meta = b'{"savedNames": ["old"], "skipped": []}\n'
        self.proc = multiprocessing.get_context("spawn")

    def seed(self, with_manifest=True):
        self.data.write_bytes(self.legacy_data)
        if with_manifest:
            self.meta.write_bytes(self.legacy_meta)

    def selected(self):
        return store.resolve_snapshot(self.data, self.meta)

    def test_reading_absent_or_legacy_state_is_read_only(self):
        with store.open_snapshot(self.data, self.meta) as pair:
            self.assertIsNone(pair)
        self.assertEqual(list(self.root.iterdir()), [])
        self.seed(with_manifest=False)
        with store.open_snapshot(self.data, self.meta) as pair:
            self.assertIsNone(pair.generation)
            self.assertEqual(store.read_manifest(pair), {})
        self.assertEqual(list(self.root.iterdir()), [self.data])
        save(self.pair, b"next")
        self.assertEqual(self.data.read_bytes(), b"next")
        self.assertTrue(self.meta.is_file())
        baseline = self.selected().payload.parent.parent / "legacy"
        self.assertEqual((baseline / self.data.name).read_bytes(), self.legacy_data)
        self.assertFalse((baseline / self.meta.name).exists())

    def test_failed_staging_keeps_both_original_inodes_and_bytes(self):
        self.seed()
        before = self.data.stat().st_ino, self.meta.stat().st_ino
        def fail(data, _):
            data.write_bytes(b"private only")
            return {"error": "manifest failed"}
        self.assertIn("error", store.publish_snapshot(self.pair, fail, self.fail))
        self.assertEqual(before, (self.data.stat().st_ino, self.meta.stat().st_ino))
        self.assertEqual((self.data.read_bytes(), self.meta.read_bytes()), (self.legacy_data, self.legacy_meta))
        self.assertFalse(self.data.is_symlink() or self.meta.is_symlink())

    def test_failed_migration_and_failed_new_pointer_keep_original_names(self):
        self.seed()
        real = os.replace
        for cut in ("second-alias", "new-pointer"):
            with self.subTest(cut=cut):
                def fail(src, dst):
                    if ((cut == "second-alias" and dst == self.meta) or
                            (cut == "new-pointer" and Path(dst).name == "current" and len(os.readlink(src)) == 32)):
                        raise OSError("synthetic publication failure")
                    return real(src, dst)
                receipt = []
                with patch.object(os, "replace", fail), self.assertRaisesRegex(OSError, "synthetic"):
                    save(self.pair, b"new", receipt.append)
                self.assertFalse(receipt)
                self.assertFalse(self.data.is_symlink() or self.meta.is_symlink())
                self.assertEqual((self.data.read_bytes(), self.meta.read_bytes()), (self.legacy_data, self.legacy_meta))
        save(self.pair, b"new")
        selected = self.selected()
        self.assertEqual(self.data.read_bytes(), selected.payload.read_bytes())
        self.assertEqual(self.meta.read_bytes(), selected.manifest.read_bytes())
        self.assertEqual(os.readlink(self.data).split('/')[:-1], os.readlink(self.meta).split('/')[:-1])

    def test_process_dies_before_or_after_the_only_new_commit(self):
        for cut in ("after-first-alias", "before-pointer", "after-pointer"):
            with self.subTest(cut=cut):
                self.seed()
                writer = self.proc.Process(target=interrupted_save, args=(self.pair, cut))
                writer.start()
                writer.join(10)
                self.assertEqual(writer.exitcode, 73)
                chosen = self.selected()
                if cut == "after-pointer":
                    self.assertEqual(chosen.payload.read_bytes(), b"next")
                    self.assertEqual(store.read_manifest(chosen)["savedNames"], ["x"])
                else:
                    self.assertEqual(chosen.payload.read_bytes(), self.legacy_data)
                    self.assertEqual(chosen.manifest.read_bytes(), self.legacy_meta)
                self.assertEqual((self.data.read_bytes(), self.meta.read_bytes()),
                                 (chosen.payload.read_bytes(), chosen.manifest.read_bytes()))
                save(self.pair, b"retry")
                self.assertEqual(self.data.read_bytes(), b"retry")
                store.reset_snapshot(self.data, self.meta)

    def test_interrupted_first_publication_is_not_a_snapshot(self):
        writer = self.proc.Process(target=interrupted_save, args=(self.pair, "before-pointer"))
        writer.start()
        writer.join(10)
        self.assertEqual(writer.exitcode, 73)
        self.assertIsNone(self.selected())
        self.assertFalse(self.data.exists() or self.meta.exists())
        save(self.pair, b"retry")
        self.assertEqual(self.data.read_bytes(), b"retry")

    def test_another_record_can_save_while_this_writer_is_encoding(self):
        ready, release = self.proc.Event(), self.proc.Event()
        slow = self.proc.Process(target=block_encoding, args=(self.pair, ready, release))
        slow.start()
        try:
            self.assertTrue(ready.wait(10))
            other = store.SnapshotPair(self.root / "other.dill", self.root / "other.json")
            save(other, b"independent")
            self.assertEqual(other.payload.read_bytes(), b"independent")
            self.assertTrue(slow.is_alive())
        finally:
            release.set()
            slow.join(10)
        self.assertEqual(slow.exitcode, 0)

    def test_readers_hold_generations_across_publications_and_reset(self):
        save(self.pair, b"one")
        with store.open_snapshot(self.data, self.meta) as held:
            for new in (b"two", b"three", b"four"):
                save(self.pair, new)
            self.assertEqual(held.payload.read_bytes(), b"one")
            self.assertEqual(store.read_manifest(held)["bytes"], 3)
        save(self.pair, b"five")
        self.assertFalse(held.payload.exists())
        with store.open_snapshot(self.data, self.meta) as held:
            ready, finished = self.proc.Event(), self.proc.Event()
            reset = self.proc.Process(target=await_reset, args=(self.pair, ready, finished))
            reset.start()
            self.assertTrue(ready.wait(10))
            self.assertFalse(finished.wait(0.1))
            self.assertEqual(held.payload.read_bytes(), b"five")
        reset.join(10)
        self.assertEqual(reset.exitcode, 0)
        self.assertIsNone(self.selected())

    def test_repeated_dead_writers_do_not_accumulate_candidates_or_collect_the_previous_commit(self):
        save(self.pair, b"first")
        first = self.selected()
        save(self.pair, b"second")
        for _ in range(3):
            process = self.proc.Process(target=interrupted_save, args=(self.pair, "before-pointer"))
            process.start()
            process.join(10)
            self.assertEqual(process.exitcode, 73)
            generations = [p for p in first.payload.parent.parent.iterdir() if len(p.name) == 32]
            self.assertEqual(len(generations), 3)  # current, previous, and this writer's single candidate
            self.assertEqual(first.payload.read_bytes(), b"first")
        save(self.pair, b"third")
        self.assertFalse(first.payload.exists())

    def test_older_writer_replacing_the_public_links_preserves_both_versions(self):
        save(self.pair, b"published")
        chosen = self.selected()
        original_manifest = chosen.manifest.read_bytes()
        for path, changed in ((self.data, b"older writer data"), (self.meta, b"older writer manifest")):
            temp = self.root / "older-writer.tmp"
            temp.write_bytes(changed)
            os.replace(temp, path)
        with self.assertRaisesRegex(store.SnapshotStoreError, "public links"):
            self.selected()
        with self.assertRaises(store.SnapshotStoreError):
            save(self.pair, b"attempted overwrite")
        self.assertEqual((self.data.read_bytes(), self.meta.read_bytes()), (b"older writer data", b"older writer manifest"))
        self.assertEqual((chosen.payload.read_bytes(), chosen.manifest.read_bytes()), (b"published", original_manifest))

    def test_damage_never_falls_back_and_reset_is_scoped(self):
        save(self.pair, b"one")
        selected = self.selected()
        selected.manifest.unlink()
        with self.assertRaises(store.SnapshotStoreError):
            self.selected()
        with self.assertRaises(store.SnapshotStoreError):
            save(self.pair, b"new")
        self.assertEqual(self.data.read_bytes(), b"one")
        neighbor = self.root / "copies"
        neighbor.mkdir()
        store.reset_snapshot(self.data, self.meta)
        self.assertEqual(list(self.root.iterdir()), [neighbor])
