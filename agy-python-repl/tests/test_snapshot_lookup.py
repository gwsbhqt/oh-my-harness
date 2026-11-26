"""A cold lookup checks one legacy snapshot while a listing still discovers all of them."""

from __future__ import annotations

import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest.mock import patch

from agy_python_repl import snapshot_paths as paths


class SnapshotLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.snapshots = self.data / "snapshots"
        self.snapshots.mkdir()

    def write_flat(self, name: str) -> None:
        payload, manifest = paths.snapshot_paths(self.data, Path(name))
        payload.write_bytes(b"legacy fixture")
        manifest.write_text('{"savedNames": ["value"]}', encoding="utf-8")

    def test_lookup_only_resolves_its_own_record_at_each_history_size(self) -> None:
        target = "target"
        self.write_flat(target)
        expected = {target}
        resolve = paths.resolve_snapshot
        previous = 0
        for count in (0, 100, 1000):
            for i in range(previous, count):
                name = f"history-{i:04}"
                self.write_flat(name)
                expected.add(name)
            previous = count
            with self.subTest(unrelated=count):
                for name in ("fresh", target):
                    with patch.object(paths, "resolve_snapshot", wraps=resolve) as checked:
                        self.assertEqual(paths.kernel_identity(self.data, name), (name, Path(name)))
                    visited = [call.args for call in checked.call_args_list]
                    allowed = {
                        paths.snapshot_paths(self.data, paths.named_storage(name)),
                        paths.snapshot_paths(self.data, Path(name)),
                    }
                    self.assertTrue(set(visited) <= allowed, visited)
                    if name == target:
                        self.assertIn(paths.snapshot_paths(self.data, Path(name)), visited)
                self.assertEqual(paths.flat_names(self.data), expected)

    def test_an_absent_name_does_not_enumerate_the_snapshot_directory(self) -> None:
        self.write_flat("history")
        with patch("os.scandir", side_effect=AssertionError("unexpected directory scan")):
            self.assertEqual(paths.kernel_identity(self.data, "fresh"), ("fresh", Path("fresh")))

    def test_legacy_names_require_exact_disk_spelling(self) -> None:
        old = "Scope__Café"
        payload, _ = paths.snapshot_paths(self.data, Path(old))
        payload.write_bytes(b"old manifestless snapshot")
        for name in (old, "Scope:Café"):
            self.assertEqual(paths.kernel_identity(self.data, name), (old, Path(old)))
        for name in ("scope:Café", unicodedata.normalize("NFD", "Scope:Café"), "Scope:Café:daily"):
            self.assertEqual(paths.kernel_identity(self.data, name), (name, paths.named_storage(name)))

        self.write_flat("Ledger")
        lower = "ledger"
        alias = (self.snapshots / "ledger.dill").is_file()
        expected = paths.named_storage(lower) if alias else Path(lower)
        self.assertEqual(paths.kernel_identity(self.data, lower), (lower, expected))

    def test_damaged_flat_record_keeps_its_owner(self) -> None:
        payload, manifest = paths.snapshot_paths(self.data, Path("owner__record"))
        payload.symlink_to("missing-payload")
        manifest.symlink_to("missing-manifest")
        self.assertEqual(
            paths.kernel_identity(self.data, "owner:record"), ("owner__record", Path("owner__record")),
        )
        self.assertEqual(paths.flat_names(self.data), {"owner__record"})
