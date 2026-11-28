"""Recovery tests with dedicated data, skill roots, and real kernel processes."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agy_python_repl import manager as manager_module
from agy_python_repl.manager import KernelManager


class ManagerRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.builtin = self.root / "plugin" / "skills"
        self.user = self.root / "user-skills"
        self.project = self.root / "project-skills"
        self.enterContext(patch.object(manager_module, "_BUILTIN_SKILLS_DIR", self.builtin, create=True))
        self.manager = KernelManager(
            data_dir=self.root / "data",
            skill_roots=[self.user],
            project_skill_roots=[self.project],
            max_output_chars=400,
        )
        self.addAsyncCleanup(self.manager.shutdown_all)

    async def cell(self, code: str, **options):
        return await self.manager.run_code(code, cwd=self.root, **options)

    def add_skill(self, root: Path, source: str) -> None:
        skill = root / "agy-use"
        module = skill / "src" / "agy_use"
        module.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: agy-use\ndescription: Fixture\n---\n", encoding="utf-8")
        (module / "__init__.py").write_text(f"origin = {source!r}\n", encoding="utf-8")

    async def test_returns_all_three_overflow_files_with_the_captured_text(self) -> None:
        outputs = {"stdout": "a" * 700 + "\n", "stderr": "b" * 5000 + "\n", "result": repr("雪" * 700)}
        cell = await self.cell("import sys\nprint('a' * 700)\nprint('b' * 5000, file=sys.stderr)\n'雪' * 700")
        self.assertEqual(cell["status"], "ok")
        self.assertTrue(cell["truncated"])
        paths = [Path(p) for p in cell["overflow_files"]]
        self.assertEqual(len(paths), len(outputs))
        for path in paths:
            self.assertEqual(path.parent, self.manager.data_dir / "overflow" / "default")
        self.assertEqual({p.stem.split("_")[-1]: p.read_text(encoding="utf-8") for p in paths}, outputs)

    async def test_transport_clipped_result_is_not_reported_as_saved_in_full(self) -> None:
        size = 1_048_800
        cell = await self.cell(f"payload = 'x' * {size}\npayload")
        self.assertNotIn("full output saved", cell["result"])
        path, = cell["overflow_files"]
        captured = Path(path).read_text(encoding="utf-8")
        self.assertLess(len(captured), size)
        self.assertIn("result truncated", captured[-100:])
        self.assertEqual((await self.cell("len(payload)"))["result"], str(size))

    async def test_unwritable_overflow_returns_cell_status_without_a_file_claim(self) -> None:
        self.manager.data_dir.mkdir()
        (self.manager.data_dir / "overflow").touch()
        cell = await self.cell("runs = globals().get('runs', 0) + 1\n'x' * 800")
        self.assertEqual(cell["status"], "ok")
        self.assertTrue(cell["truncated"])
        self.assertNotIn("overflow_files", cell)
        self.assertNotIn("saved", cell["result"])
        self.assertIn("result", cell["overflow_errors"])
        self.assertEqual((await self.cell("runs"))["result"], "1")

    async def test_snapshot_write_failure_is_reported_without_replaying_the_cell(self) -> None:
        snapshots = self.manager.data_dir / "snapshots"
        snapshots.parent.mkdir()
        snapshots.touch()
        cell = await self.cell("counter = globals().get('counter', 0) + 1\ncounter")
        self.assertEqual((cell["status"], cell["result"]), ("ok", "1"))
        self.assertIn("snapshot_error", cell)
        snapshots.unlink()
        snapshot = snapshots / "default.dill"
        snapshot.mkdir(parents=True)
        refused = await self.cell("counter")
        self.assertEqual(refused["result"], "1")
        self.assertIn("snapshot_error", refused)
        snapshot.rmdir()
        saved = await self.cell("counter")
        self.assertNotIn("snapshot_error", saved)
        await self.manager.shutdown_all()
        recovered = await self.cell("counter")
        self.assertEqual(recovered["result"], "1")
        self.assertTrue(recovered["restored"]["restored"])

    async def test_bootstrap_failure_stops_process_before_user_code_and_can_retry(self) -> None:
        # The temporary working directory supplies a package missing the bootstrap module.
        broken = self.root / "agy_python_repl" / "__init__.py"
        broken.parent.mkdir()
        broken.touch()
        processes = []
        start = manager_module.KernelClient.start

        async def track_process(client):
            await start(client)
            processes.append(client._proc)
            self.addAsyncCleanup(client.shutdown)

        with patch.object(manager_module.KernelClient, "start", track_process):
            with self.assertRaisesRegex(RuntimeError, "ModuleNotFoundError"):
                await self.cell("from pathlib import Path\nPath('ran').touch()")
        self.assertFalse((self.root / "ran").exists())
        self.assertEqual((await self.manager.kernel_state("list"))["active_kernels"], [])
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)
        broken.unlink()
        retry = await self.cell("await skills.list()")
        self.assertEqual((retry["status"], retry["result"]), ("ok", "[]"))

    async def test_malformed_bootstrap_report_does_not_register_a_kernel(self) -> None:
        package = self.root / "agy_python_repl"
        package.mkdir()
        (package / "__init__.py").touch()
        (package / "bootstrap.py").write_text(
            "def install_antigravity_surface(entries, *, kernel, copy_session=None, capture_dir=None): return None\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(RuntimeError, "skill report"):
            await self.cell("1 + 1")
        self.assertEqual((await self.manager.kernel_state("list"))["active_kernels"], [])

    async def test_timeout_keeps_live_pid_and_data_across_the_next_save(self) -> None:
        payload = {"rows": [1, 3, 5], "title": "雪"}
        await self.cell(f"import asyncio, os\npid = os.getpid()\npayload = {payload!r}")
        timed = await self.cell("await asyncio.sleep(30)", timeout_seconds=0.05)
        self.assertEqual(timed["status"], "timeout")
        self.assertEqual((await self.cell("(os.getpid() == pid, payload)"))["result"], repr((True, payload)))
        await self.manager.shutdown_all()
        restored = await self.cell("payload")
        self.assertTrue(restored["restored"]["restored"])
        self.assertEqual(restored["result"], repr(payload))

    async def test_installed_plugin_supplies_missing_python_skill(self) -> None:
        self.add_skill(self.builtin, "builtin")
        result = await self.cell("skills.agy_use.origin")
        self.assertEqual(result["status"], "ok", result.get("error"))
        self.assertEqual(result["result"], repr("builtin"))

    async def test_configured_skill_precedence_and_same_tier_conflicts(self) -> None:
        self.add_skill(self.builtin, "builtin")
        self.add_skill(self.user, "user")
        self.assertEqual((await self.cell("skills.agy_use.origin", kernel="user"))["result"], repr("user"))
        another_user = self.root / "another-user-root"
        self.add_skill(another_user, "other")
        self.manager.skill_roots.append(another_user)
        conflict = await self.cell("skills.agy_use.origin", kernel="conflict")
        self.assertEqual(conflict["status"], "error")
        self.assertIn("duplicate", conflict["error"]["evalue"])
        self.add_skill(self.project, "project")
        self.assertEqual((await self.cell("skills.agy_use.origin", kernel="project"))["result"], repr("project"))

    async def test_manual_snapshot_waits_for_complete_restore(self) -> None:
        module = self.root / "fixture_measurement.py"
        source = "class Measurement:\n    value = 31\n"
        module.write_text(source, encoding="utf-8")
        await self.cell("from fixture_measurement import Measurement\nsample = Measurement()")
        await self.manager.shutdown_all()
        module.unlink()
        partial = await self.cell("2 + 3")
        self.assertEqual(partial["result"], "5")
        refused = await self.manager.kernel_state("snapshot")
        self.assertEqual(refused["status"], "error")
        self.assertIn("restore", refused["error"].lower())
        still_partial = await self.manager.kernel_state("restore")
        self.assertTrue(still_partial["failed"])
        self.assertEqual((await self.manager.kernel_state("snapshot"))["status"], "error")
        module.write_text(source, encoding="utf-8")
        recovered = await self.manager.kernel_state("restore")
        self.assertEqual(recovered["failed"], [])
        self.assertIn("sample", recovered["restored"])
        self.assertEqual((await self.cell("next_value = sample.value + 1\nnext_value"))["result"], "32")
        self.assertEqual((await self.manager.kernel_state("snapshot"))["status"], "ok")
        await self.manager.shutdown_all()
        self.assertEqual((await self.cell("(sample.value, next_value)"))["result"], "(31, 32)")
