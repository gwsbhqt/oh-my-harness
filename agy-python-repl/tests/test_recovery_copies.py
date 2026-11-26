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
