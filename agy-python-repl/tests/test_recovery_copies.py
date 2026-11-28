"""Explicit copies must survive a protected kernel without changing its original snapshot."""
import json
from pathlib import Path
import tempfile
import unittest

from agy_python_repl.manager import KernelManager


class RecoveryCopies(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.start_manager()

    def start_manager(self):
        self.manager = KernelManager(data_dir=self.root / "data", skill_roots=[], project_skill_roots=[])
        self.addAsyncCleanup(self.manager.shutdown_all)

    async def cell(self, code, kernel="analysis"):
        result = await self.manager.run_code(code, kernel=kernel, cwd=self.workspace)
        self.assertEqual(result["status"], "ok", result.get("error"))
        return result

    def snapshot_identity(self, path):
        manifest = path.with_suffix(".manifest.json")
        return path.resolve(strict=True), path.read_bytes(), manifest.read_bytes()

    async def test_read_selected_values_after_a_partial_restore(self):
        (self.root / "fixture_ledger.py").write_text("class Ledger: pass")
        await self.cell(f"__import__('sys').path.insert(0, {str(self.root)!r})\n"
                        "from fixture_ledger import Ledger\nlegacy = Ledger()\ndel Ledger\nrows = [7]")
        saved = await self.manager.kernel_state("snapshot", kernel="analysis")
        original = Path(saved["snapshot_path"])
        before = self.snapshot_identity(original)
        await self.manager.shutdown_all()
        self.start_manager()

        optional_dir = self.root / "copy-dependency"
        optional_dir.mkdir()
        (optional_dir / "fixture_receipt.py").write_text("class Receipt: pass")
        partial = await self.cell(f"__import__('sys').path.insert(0, {str(optional_dir)!r})\n"
                                  "from fixture_receipt import Receipt\noptional = Receipt()\ndel Receipt\n"
                                  "assert rows == [7] and 'legacy' not in globals()\n"
                                  "assert not await repl.list_copies()\n"
                                  "empty = await repl.save_copy('legacy', 'repl')\n"
                                  "assert empty['copy_id'] is None and not await repl.list_copies()\n"
                                  "rows = [9]\nbox = {'rows':rows}\nbox['loop'] = box\n"
                                  "receipt = await repl.save_copy('rows', 'box', 'optional', 'legacy', 'repl')\n"
                                  "print(__import__('json').dumps(receipt))")
        self.assertIn("snapshot_warning", partial)
        self.assertEqual([x["name"] for x in partial["restored"]["failed"]], ["legacy"])
        receipt = json.loads(partial["stdout"])
        self.assertEqual(receipt["saved"], ["box", "optional", "rows"])
        self.assertEqual({x["name"] for x in receipt["skipped"]}, {"repl", "legacy"})
        copy_id = receipt["copy_id"]
        self.assertRegex(copy_id, r"^[a-f0-9]{32}$")
        await self.manager.shutdown_all()
        self.start_manager()

        reopened = await self.cell(f"assert await repl.list_copies() == [{copy_id!r}]\n"
                                   f"data = await repl.read_copy({copy_id!r})\n"
                                   "assert [item['name'] for item in data['failed']]==['optional']\n"
                                   "assert 'fixture_receipt' in data['failed'][0]['reason']\n"
                                   "assert data['values']['rows']==[9]\n"
                                   "box_value=data['values']['box']\n"
                                   "assert box_value is box_value['loop'] and box_value['rows'] is data['values']['rows']\n"
                                   "assert rows == [7] and 'box' not in globals()")
        self.assertIn("snapshot_warning", reopened)
        self.assertEqual((await self.manager.kernel_state("snapshot", kernel="analysis"))["status"], "error")
        self.assertEqual(before, self.snapshot_identity(original))
        self.assertEqual(list(self.workspace.iterdir()), [])
        for neighbor in ("Analysis", "analysis:sub/../item"):
            await self.cell(f"assert await repl.list_copies() == []\n"
                            f"try: await repl.read_copy({copy_id!r})\n"
                            "except FileNotFoundError: pass\n"
                            "else: raise AssertionError('read a different kernel copy')", kernel=neighbor)

    async def test_read_copy_display_is_compact_preserves_dict_interface_and_isolates_dependencies(self):
        await self.cell(
            'entries = [f"第{i}条记录：" + "甲乙丙丁" * 40 for i in range(1, 25)]\n'
            'def summary():\n'
            '    return f"{len(entries)}:{entries[0][:8]}"\n'
            'saved = await repl.save_copy("entries", "summary")\n'
            'entries = ["更新项"]'
        )
        viewed = await self.cell('c = await repl.read_copy(saved["copy_id"])\nc')
        result_text = viewed["result"]
        self.assertIn("read_copy · 2 values · 0 failed · 0 skipped", result_text)
        self.assertIn("entries, summary", result_text)
        self.assertNotIn("甲乙丙丁", result_text)
        self.assertNotIn("<function summary at 0x", result_text)

        checked = await self.cell(
            'assert isinstance(c, dict) and callable(c.values)\n'
            'assert list(c.keys()) == ["values", "failed", "skipped"]\n'
            'assert len(c["values"]["entries"]) == 24 and entries == ["更新项"]\n'
            'assert c["values"]["summary"].__globals__ is not globals()\n'
            '(c["values"]["summary"](), summary())'
        )
        self.assertEqual(checked["result"], repr(("24:第1条记录：甲乙", "1:更新项")))

    async def test_read_copy_bounds_many_values_and_reports_failed_and_skipped_reasons(self):
        dep_dir = self.root / "ephemeral-dep"
        dep_dir.mkdir()
        (dep_dir / "ephemeral_mod.py").write_text("class Token:\n    pass\n", encoding="utf-8")
        await self.cell(
            f"__import__('sys').path.insert(0, {str(dep_dir)!r})\n"
            "from ephemeral_mod import Token\n"
            "tok = Token()\n"
            "del Token\n"
            "gen_live = (i for i in range(2))\n"
            "for idx in range(15):\n"
            "    globals()[f'item_{idx:02d}'] = '长内容' * 30\n"
            "names = ['tok', 'gen_live'] + [f'item_{idx:02d}' for idx in range(15)]\n"
            "receipt = await repl.save_copy(*names)\n"
            "assert receipt['copy_id'] is not None"
        )
        await self.manager.shutdown_all()
        (dep_dir / "ephemeral_mod.py").unlink()
        self.start_manager()

        await self.cell("copies = await repl.list_copies()\nassert len(copies) == 1")
        viewed = await self.cell("c = await repl.read_copy(copies[0])\nc")
        text = viewed["result"]
        self.assertIn("read_copy · 15 values · 1 failed · 1 skipped", text)
        self.assertIn("(+3 more)", text)
        self.assertIn("failed (1):", text)
        self.assertIn("tok:", text)
        self.assertIn("ephemeral_mod", text)
        self.assertIn("skipped (1):", text)
        self.assertIn("gen_live:", text)
        self.assertNotIn("长内容", text)

        verified = await self.cell(
            "assert [x['name'] for x in c.failed] == ['tok']\n"
            "assert [x['name'] for x in c.skipped] == ['gen_live']\n"
            "len(c['values'])"
        )
        self.assertEqual(verified["result"], "15")

    async def test_read_copy_clips_long_names_and_keeps_mutated_view_fallback_compact(self):
        long_name = "long_" + "变量" * 60
        await self.cell(
            f"{long_name} = ['长内容' * 40]\n"
            f"saved = await repl.save_copy({long_name!r})\n"
            "assert saved['copy_id'] is not None"
        )
        viewed = await self.cell("c = await repl.read_copy(saved['copy_id'])\nc")
        text = viewed["result"]
        self.assertIn("read_copy · 1 values · 0 failed · 0 skipped", text)
        self.assertIn("…", text)
        self.assertNotIn(long_name, text)
        self.assertNotIn("长内容", text)

        mutated = await self.cell(
            f"assert c['values'][{long_name!r}] == ['长内容' * 40]\n"
            "c['failed'] = None\n"
            "del c['skipped']\n"
            "c"
        )
        fallback = mutated["result"]
        self.assertIn("unavailable view", fallback)
        self.assertIn("failed=NoneType(invalid)", fallback)
        self.assertIn("skipped=missing", fallback)
        self.assertNotIn("长内容", fallback)
        self.assertNotIn(long_name, fallback)
