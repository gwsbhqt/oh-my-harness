"""Exercise the shared standard-library prelude through the real AGY kernel and snapshots."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager


class KernelPreludeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.data = self.workspace / "data"

    def new_manager(self) -> KernelManager:
        manager = KernelManager(data_dir=self.data, skill_roots=[], project_skill_roots=[])
        self.addAsyncCleanup(manager.shutdown_all)
        return manager

    def saved_names(self) -> set[str]:
        manifest = self.data / "snapshots" / "default.manifest.json"
        return set(json.loads(manifest.read_text(encoding="utf-8"))["savedNames"])

    async def test_first_cell_uses_stdlib_without_adding_user_variables(self) -> None:
        manager = self.new_manager()
        cell = await manager.run_code(
            '''json.dumps([Path("data.csv").suffix, Counter("aba")["a"], defaultdict(int)["x"],
                        os.path.basename("a/b"), re.search("ok", "okay")[0], bool(sys.version),
                        callable(time.time), timezone.utc.utcoffset(None) == timedelta(0)])''',
            cwd=self.workspace,
        )
        self.assertEqual(cell["status"], "ok", cell)
        expected = json.dumps([".csv", 2, 0, "b", "ok", True, True, True])
        self.assertEqual(cell["result"], repr(expected))
        self.assertEqual((await manager.kernel_state("vars"))["names"], [])
        self.assertEqual((await manager.run_code("repl.vars()"))["result"], "[]")
        self.assertEqual(self.saved_names(), set())

    async def test_last_result_belongs_to_a_user_expression(self) -> None:
        manager = self.new_manager()
        empty = await manager.run_code("'_' in globals()", cwd=self.workspace)
        self.assertEqual(empty["result"], "False")

        first = await manager.run_code("entries = [3, 4, 7]\nentries")
        self.assertEqual(first["result"], "[3, 4, 7]")
        self.assertNotIn("result", await manager.run_code("total = sum(entries)"))
        printed = await manager.run_code("print(total)\nNone")
        self.assertEqual(printed["stdout"], "14\n")
        self.assertNotIn("result", printed)
        other = self.workspace / "another directory"
        other.mkdir()
        self.assertEqual((await manager.run_code("_ is entries", cwd=other))["result"], "True")

        await manager.shutdown_all()
        reopened = await self.new_manager().run_code("('_' in globals(), entries)", cwd=other)
        self.assertEqual(reopened["result"], "(False, [3, 4, 7])")

    async def test_user_rebindings_survive_a_restart_and_reimported_defaults_are_hidden(self) -> None:
        first = self.new_manager()
        initial = await first.run_code(
            'json = {"count": 7}\nPath = "report"\nrows = [4, 5]', cwd=self.workspace,
        )
        self.assertEqual(initial["status"], "ok", initial)
        self.assertEqual(set((await first.kernel_state("vars"))["names"]), {"json", "Path", "rows"})
        self.assertEqual((await first.run_code("repl.vars()"))["result"], "['Path', 'json', 'rows']")
        self.assertEqual(self.saved_names(), {"json", "Path", "rows"})
        await first.shutdown_all()

        second = self.new_manager()
        restored = await second.run_code('(json["count"], Path, Counter(rows)[5])', cwd=self.workspace)
        self.assertEqual(restored["result"], "(7, 'report', 1)")
        self.assertTrue(restored["restored"]["restored"])
        self.assertEqual(set(restored["restored"]["restored_names"]), {"json", "Path", "rows"})
        self.assertEqual((await second.run_code('import json\njson.loads("42")'))["result"], "42")
        self.assertEqual(set((await second.kernel_state("vars"))["names"]), {"Path", "rows"})
        self.assertEqual(self.saved_names(), {"Path", "rows"})
