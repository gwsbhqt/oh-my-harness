"""Exercise host directory changes against a real persistent kernel in temporary workspaces."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager


class KernelCwdTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.first = self.root / "first"
        self.second = self.root / "新 'workspace'"
        self.user_dir = self.first / "working"
        for directory in (self.first, self.second, self.user_dir):
            directory.mkdir()
            (directory / "marker").write_text(directory.name, encoding="utf-8")
        self.manager = KernelManager(data_dir=self.root / "data", skill_roots=[], project_skill_roots=[])
        self.addAsyncCleanup(self.manager.shutdown_all)

    async def test_switch_reads_writes_and_imports_in_new_directory_with_live_state(self) -> None:
        (self.second / "fixture_new_module.py").write_text("answer = 35\n", encoding="utf-8")
        first = await self.manager.run_code(
            "import os\nfrom pathlib import Path\npid = os.getpid()\nnumber = 7\nPath('marker').read_text()",
            cwd=self.first,
        )
        self.assertEqual(first["result"], repr(self.first.name))
        second = await self.manager.run_code(
            "from fixture_new_module import answer\nPath('written').touch()\n"
            "(os.getpid() == pid, Path('marker').read_text(), number + answer)", cwd=self.second,
        )
        self.assertEqual(second["status"], "ok", second.get("error"))
        self.assertEqual(second["result"], repr((True, self.second.name, 42)))
        self.assertTrue((self.second / "written").is_file())
        self.assertFalse((self.first / "written").exists())

    async def test_same_or_unspecified_host_directory_preserves_user_chdir(self) -> None:
        (self.user_dir / "fixture_local_module.py").write_text("answer = 11\n", encoding="utf-8")
        await self.manager.run_code("import os\nfrom pathlib import Path\nos.chdir('working')", cwd=self.first)
        repeated = await self.manager.run_code("Path('marker').read_text()", cwd=self.first)
        self.assertEqual(repeated["result"], repr(self.user_dir.name))
        implicit = await self.manager.run_code("from fixture_local_module import answer\n(answer, Path.cwd().name)")
        self.assertEqual(implicit["status"], "ok", implicit.get("error"))
        self.assertEqual(implicit["result"], repr((11, self.user_dir.name)))
        switched = await self.manager.run_code("Path('marker').read_text()", cwd=self.second)
        self.assertEqual(switched["result"], repr(self.second.name))

    async def test_invalid_directory_prevents_execution_and_retries_without_losing_state(self) -> None:
        missing = self.root / "missing"
        cell = "from pathlib import Path\nPath('wrong').touch()"
        with self.assertRaisesRegex(OSError, "missing"):
            await self.manager.run_code(cell, cwd=missing)
        await self.manager.run_code("from pathlib import Path\nvalue = 41", cwd=self.first)
        for invalid in (missing, self.first / "marker"):
            with self.assertRaises(OSError):
                await self.manager.run_code(cell, cwd=invalid)
            self.assertFalse((self.first / "wrong").exists())
        missing.mkdir()
        recovered = await self.manager.run_code("Path('right').touch()\nvalue + 1", cwd=missing)
        self.assertEqual(recovered["result"], "42")
        self.assertTrue((missing / "right").exists())

    async def test_concurrent_cells_keep_their_own_host_directory(self) -> None:
        await self.manager.run_code("import asyncio\nfrom pathlib import Path\nseen = []", cwd=self.first)
        tasks = []
        targets = [self.second, self.first, self.second, self.first]
        for target in targets:
            tasks.append(self.manager.run_code(
                "before = Path('marker').read_text()\nawait asyncio.sleep(0.01)\n"
                "seen.append(before)\n(before, Path('marker').read_text())", cwd=target,
            ))
        for target, cell in zip(targets, await asyncio.gather(*tasks), strict=True):
            self.assertEqual(cell["result"], repr((target.name, target.name)))
        state = await self.manager.run_code("sorted(seen)")
        self.assertEqual(state["result"], repr(sorted(target.name for target in targets)))
