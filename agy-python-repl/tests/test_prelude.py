"""Exercise the shared standard-library prelude through the real AGY kernel and snapshots."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager
from python_repl_core.kernel_client import KernelClient


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

    async def test_preview_displays_text_and_preserves_metadata_across_reload(self) -> None:
        manager = self.new_manager()
        whole = await manager.run_code("summary = repl.preview(['春', '夏', '秋'])\nsummary", cwd=self.workspace)
        self.assertEqual(whole["status"], "ok", whole)
        self.assertIn("whole in-memory value", whole["result"])
        self.assertIn("春", whole["result"])
        self.assertNotIn("upstream_completeness", whole["result"])

        limited = await manager.run_code("repl.preview([1, 2, 3], items=1)")
        self.assertIn("items_limit", limited["result"])
        generated = await manager.run_code("g = iter(['first', 'second'])\nrepl.preview(g)")
        self.assertIn("unsupported_type", generated["result"])
        self.assertEqual((await manager.run_code("next(g)"))["result"], "'first'")
        await manager.run_code("del g")

        await manager.shutdown_all()
        restored = await self.new_manager().run_code(
            "[summary['truncated'], summary['budget']['items'], summary['upstream_completeness'], summary['text']]",
            cwd=self.workspace,
        )
        self.assertEqual(restored["status"], "ok", restored)
        self.assertIn("[False, 20, 'not_checked',", restored["result"])
        self.assertIn("秋", restored["result"])

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

    async def test_reuses_live_paths_and_looks_up_names_without_reading_values(self) -> None:
        manager = self.new_manager()
        for setup in ('repo = Path("first")', 'repo = Path("project")'):
            self.assertNotIn("reuse_hint", await manager.run_code(setup, cwd=self.workspace))
        await manager.run_code('def case_path(name):\n    return (repo / "tests" / name).as_posix()')
        self.assertEqual((await manager.run_code('case_path("sample")'))["result"], "'project/tests/sample'")
        self.assertEqual((await manager.run_code('repl.vars("rep")'))["result"], "['repo']")
        self.assertEqual((await manager.run_code('repl.vars("missing")'))["result"], "[]")

        same_path = 'from pathlib import Path\nrepo = Path("project")'
        duplicate = await manager.run_code(same_path)
        self.assertIn("`repo`", duplicate["reuse_hint"])
        self.assertNotIn("stdout", duplicate)
        self.assertNotIn("reuse_hint", await manager.run_code(same_path))
        separate = await manager.run_code(same_path, kernel="separate", cwd=self.workspace)
        self.assertNotIn("reuse_hint", separate)

    async def test_helper_lookup_displays_call_shape_without_expanding_defaults(self) -> None:
        manager = self.new_manager()
        await manager.run_code('def select_case(case, /, rows=list(range(2000)), *, strict=False):\n    return case')
        await manager.run_code('def other():\n    return None')
        found = await manager.run_code('await repl.helpers("select")')
        self.assertIn("list", found["result"].lower())
        self.assertIn("select_case(case, /, rows=..., *, strict=False)", found["result"])
        names = await manager.run_code('[item["name"] for item in await repl.helpers()]')
        self.assertEqual(names["result"], "['other', 'select_case']")

    async def test_helper_lookup_preserves_call_shapes_with_type_checking_only_imports(self) -> None:
        manager = self.new_manager()
        future = "from __future__ import annotations\n" if sys.version_info < (3, 14) else ""
        setup = await manager.run_code(
            future + 'from typing import TYPE_CHECKING\n'
            'if TYPE_CHECKING:\n    from collections.abc import Sequence\n'
            'def count_rows(rows: Sequence[str]) -> int:\n    return len(rows)\n'
            'def _probe_repo(path):\n    return path.name', cwd=self.workspace,
        )
        self.assertEqual(setup["status"], "ok", setup)
        for query, name, signature in (("", "count_rows", "count_rows(rows)"),
                                       ("count", "count_rows", "count_rows(rows)"),
                                       ("_probe_repo", "_probe_repo", "_probe_repo(path)")):
            with self.subTest(query=query):
                result = await manager.run_code(
                    f'matches = await repl.helpers({query!r})\n'
                    'isinstance(matches, list), len(matches), matches[0]["name"], matches[0]["signature"]'
                )
                self.assertEqual(result["status"], "ok", result)
                self.assertEqual(result["result"], repr((True, 1, name, signature)))

    async def test_prime_defaults_and_reserved_names_stay_out_but_user_bindings_survive(self) -> None:
        first = self.new_manager()
        await first.run_code('import asyncio', cwd=self.workspace)
        self.assertEqual(self.saved_names(), set())
        setup = await first.run_code(
            'def bash(amount): return amount * 2\nasyncio = {"orders": 3}\n'
            'order_count = asyncio["orders"]'
        )
        self.assertEqual(setup["status"], "ok", setup)
        self.assertEqual(self.saved_names(), {"bash", "asyncio", "order_count"})
        self.assertEqual(set((await first.kernel_state("vars"))["names"]), self.saved_names())
        await first.shutdown_all()

        second = self.new_manager()
        restored = await second.run_code('bash(order_count), asyncio["orders"]', cwd=self.workspace)
        self.assertEqual(restored["result"], "(6, 3)")
        self.assertEqual(restored["restored"]["shadowed_bindings"], ["asyncio", "bash"])
        default = await second.run_code(
            'price_for = bash\norders = asyncio\n'
            'await repl.restore_binding("bash")\nawait repl.restore_binding("asyncio")\n'
            'await asyncio.sleep(0)\n'
            '(await bash("printf ready")).stdout.text, price_for(4), orders["orders"]'
        )
        self.assertEqual(default["result"], "('ready', 8, 3)")
        self.assertEqual(self.saved_names(), {"price_for", "orders", "order_count"})

    async def test_user_helper_matching_a_new_builtin_survives_restoration(self) -> None:
        first = self.new_manager()
        await first.run_code('def read(): return "custom reader"', cwd=self.workspace)
        self.assertIn("read", self.saved_names())
        await first.shutdown_all()

        second = self.new_manager()
        restored = await second.run_code('read(), [entry["name"] for entry in await repl.helpers("read")]')
        self.assertEqual(restored["result"], "('custom reader', ['read'])")
        self.assertIn("read", restored["restored"]["restored_names"])
        self.assertEqual((await second.run_code('await repl.restore_binding("read")'))["status"], "ok")
        self.assertNotIn("read", self.saved_names())

    async def test_legacy_snapshot_only_reports_bindings_that_changed_the_installed_object(self) -> None:
        manager = self.new_manager()
        legacy = KernelClient(python_exe=sys.executable, vendor_dir=manager.vendor_dir,
                              compat_dir=manager.compat_dir, cwd=self.workspace)
        await legacy.start()
        try:
            seeded = await legacy.execute("import glob\nfrom agy_python_repl.builtin_tools import ToolCallError")
            self.assertEqual(seeded.status, "ok", seeded.error)
            snapshots = self.data / "snapshots"
            saved = await legacy.snapshot(snapshots / "default.dill", snapshots / "default.manifest.json")
            self.assertEqual(set(saved["saved"]), {"glob", "ToolCallError"})
        finally:
            await legacy.shutdown()

        result = await manager.run_code('glob.glob("*.csv"), ToolCallError.__name__', cwd=self.workspace)
        self.assertEqual(result["result"], "([], 'ToolCallError')")
        self.assertEqual(set(result["restored"]["restored_names"]), {"glob", "ToolCallError"})
        self.assertEqual(result["restored"]["shadowed_bindings"], ["glob"])

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
