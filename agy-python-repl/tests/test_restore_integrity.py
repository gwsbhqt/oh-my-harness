"""Exercise AGY snapshot recovery with real kernels in temporary workspaces."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager


class RestoreIntegrityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.data = self.root / "data"
        self.snapshot = self.data / "snapshots" / "default.dill"
        self.manifest = self.snapshot.with_suffix(".manifest.json")

    def manager(self, *skill_roots: Path) -> KernelManager:
        manager = KernelManager(data_dir=self.data, skill_roots=list(skill_roots), project_skill_roots=[])
        self.addAsyncCleanup(manager.shutdown_all)
        return manager

    async def test_automatic_save_reports_skipped_variables_before_restart(self) -> None:
        manager = self.manager()
        response = await manager.run_code(
            "for index in range(8):\n    globals()[f'stream_{index}'] = (v for v in range(3))\n"
            "count = 42\nprint('日' * 6000)\ncount",
            cwd=self.root,
        )
        self.assertEqual((response["status"], response["result"]), ("ok", "42"))
        self.assertTrue(response["truncated"])
        self.assertEqual(response["snapshot_skipped_count"], 8)
        self.assertEqual(Path(response["snapshot_manifest"]), self.manifest)
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        skipped = {record["name"] for record in manifest["skipped"]}
        self.assertEqual(skipped, {f"stream_{i}" for i in range(8)})
        examples = response["snapshot_skipped_names"]
        self.assertTrue(0 < len(examples) < len(skipped))
        self.assertTrue(set(examples) <= skipped)
        await manager.shutdown_all()
        resumed = await self.manager().run_code("[count, 'stream_0' in globals()]", cwd=self.root)
        self.assertEqual(resumed["result"], "[42, False]")
        self.assertNotIn("snapshot_skipped_count", resumed)

    async def test_partial_restore_preserves_the_snapshot_until_its_module_returns(self) -> None:
        with_module = self.root / "with-module"
        without_module = self.root / "without-module"
        with_module.mkdir()
        without_module.mkdir()
        (with_module / "fixture_meter.py").write_text("class Meter:\n    reading = 42\n", encoding="utf-8")

        writer = self.manager()
        first = await writer.run_code(
            "from fixture_meter import Meter\ninstrument = Meter()\n"
            "count = 7\nunsaved = (n for n in range(2))",
            cwd=with_module,
        )
        self.assertEqual(first["status"], "ok", first)
        await writer.shutdown_all()
        original = self.snapshot.read_bytes(), self.manifest.read_bytes()

        partial = self.manager()
        second = await partial.run_code("count", cwd=without_module)
        self.assertEqual(second["result"], "7")
        report = second["restored"]
        self.assertEqual(report["status"], "partial")
        self.assertFalse(report["restored"])
        self.assertEqual(report["restored_names"], ["count"])
        self.assertEqual(set(report["saved_names"]), {"Meter", "instrument", "count"})
        self.assertEqual({item["name"] for item in report["failed"]}, {"Meter", "instrument"})
        self.assertTrue(all("fixture_meter" in item["reason"] for item in report["failed"]))
        self.assertEqual([item["name"] for item in report["skipped"]], ["unsaved"])
        self.assertEqual((await partial.run_code("count + 1"))["result"], "8")
        await partial.shutdown_all()
        self.assertEqual((self.snapshot.read_bytes(), self.manifest.read_bytes()), original)

        repaired = self.manager()
        final = await repaired.run_code("(count, instrument.reading)", cwd=with_module)
        self.assertEqual(final["result"], "(7, 42)")
        self.assertTrue(final["restored"]["restored"])
        self.assertEqual(final["restored"]["failed"], [])
        self.assertEqual(set(final["restored"]["restored_names"]), {"Meter", "instrument", "count"})

    async def test_unreadable_snapshot_reports_the_protocol_failure(self) -> None:
        self.snapshot.parent.mkdir(parents=True)
        self.snapshot.write_bytes(b"not a snapshot")
        response = await self.manager().run_code("40 + 2", cwd=self.root)
        self.assertEqual(response["result"], "42")
        report = response["restored"]
        self.assertEqual(report["status"], "error")
        self.assertFalse(report["restored"])
        self.assertIn("load failed", report["reason"])
        self.assertEqual(report["restored_names"], [])
        self.assertEqual(self.snapshot.read_bytes(), b"not a snapshot")

    async def test_old_saved_bindings_cannot_replace_current_skills_and_repl(self) -> None:
        writer = self.manager()
        # Older AGY versions saved both live bindings into ordinary user snapshots.
        seed = await writer.run_code(
            "from rlm import repl as _prime\n"
            "_prime._ALWAYS_SKIP.difference_update({'skills', 'repl'})\n"
            "repl.from_previous_kernel = True\nremembered = 41",
            cwd=self.root,
        )
        self.assertEqual(seed["status"], "ok", seed)
        await writer.shutdown_all()
        legacy_names = json.loads(self.manifest.read_text(encoding="utf-8"))["savedNames"]
        self.assertEqual(set(legacy_names), {"skills", "repl", "remembered"})

        skills = self.root / "skills"
        skill = skills / "fixture-counter"
        package = skill / "src" / "fixture_counter"
        package.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: fixture-counter\ndescription: Count items\n---\n", encoding="utf-8"
        )
        (package / "__init__.py").write_text("def answer(): return 42\n", encoding="utf-8")
        reader = self.manager(skills)
        result = await reader.run_code(
            "(any(entry['name'] == 'fixture-counter' for entry in await skills.list()), "
            "skills.fixture_counter.answer(), "
            "remembered, hasattr(repl, 'from_previous_kernel'))",
            cwd=self.root,
        )
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["result"], "(True, 42, 41, False)")
        self.assertTrue(result["restored"]["restored"])
        self.assertEqual(result["restored"]["restored_names"], ["remembered"])
        current_names = json.loads(self.manifest.read_text(encoding="utf-8"))["savedNames"]
        self.assertEqual(current_names, ["remembered"])
