"""Read real Prime snapshots through independently started AGY MCP servers."""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from importlib.util import find_spec
from pathlib import Path
from textwrap import dedent

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import agy_python_repl
from agy_python_repl.manager import KernelManager
from python_repl_core.kernel_client import KernelClient


class SnapshotReferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.data = self.workspace / "data"
        self.server = StdioServerParameters(
            command=sys.executable,
            args=["-m", "agy_python_repl.server"],
            cwd=self.workspace,
            env={
                "HOME": str(self.workspace),
                "PLUGIN_DATA": str(self.data),
                "PYTHONPATH": str(Path(agy_python_repl.__file__).resolve().parents[1]),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )

    async def cell_in_new_server(self, code: str) -> dict:
        async with stdio_client(self.server) as streams, ClientSession(*streams) as client:
            await client.initialize()
            reply = await client.call_tool("run_code", {"code": code})
        self.assertFalse(reply.isError, reply.content)
        result = reply.structuredContent
        self.assertEqual(result["status"], "ok", result.get("error"))
        self.assertNotIn("snapshot_error", result)
        return result

    async def test_shared_list_and_underscore_name_survive_server_restart(self) -> None:
        first = await self.cell_in_new_server(
            "a = [1]\nb = a\nholder = {'item': a}\n_ordinary = 37\n"
            "def read_a():\n    return a\n"
            "a.append(2)\n(a is b is holder['item'] is read_a(), b, holder['item'], _ordinary)"
        )
        self.assertEqual(ast.literal_eval(first["result"]), (True, [1, 2], [1, 2], 37))

        second = await self.cell_in_new_server(
            "a.append(3)\noriginal = a\na = [9]\n"
            "(original is b, original is holder['item'], read_a() is a, "
            "original, b, holder['item'], globals().get('_ordinary'))"
        )
        report = second["restored"]
        self.assertTrue(report["restored"], report)
        direct, nested, from_function, a, b, item, ordinary = ast.literal_eval(second["result"])
        with self.subTest("shared list"):
            expected = [1, 2, 3]
            self.assertEqual((direct, nested, a, b, item), (True, True, expected, expected, expected))
        with self.subTest("function reads the live global"):
            self.assertTrue(from_function)
        with self.subTest("single underscore"):
            self.assertEqual(ordinary, 37)
            self.assertIn("_ordinary", report["saved_names"])
            self.assertIn("_ordinary", report["restored_names"])

    async def test_damaged_owner_keeps_other_named_members_connected(self) -> None:
        (self.workspace / "sample_member.py").write_text(
            "def fail_after_reading(member):\n    raise ValueError('sample record is unavailable')\n"
            "class Broken:\n    saves = 0\n    def __init__(self, member): self.member = member\n"
            "    def __reduce__(self):\n"
            "        type(self).saves += 1\n        return fail_after_reading, (self.member,)\n",
            encoding="utf-8",
        )
        await self.cell_in_new_server(dedent("""\
            from types import SimpleNamespace
            from sample_member import Broken
            damaged = Broken(None)
            owner = SimpleNamespace()
            leaf = []
            left = {'member': leaf}
            right = [leaf]
            owner.child = damaged.member = left
            receipt = await repl.save_copy('damaged', 'owner', 'leaf', 'left', 'right')
            assert not receipt['skipped'] and Broken.saves == 1
            del Broken, SimpleNamespace
        """))
        reply = await self.cell_in_new_server(dedent("""\
            copy = await repl.read_copy(receipt['copy_id'])
            kept = copy['values']
            assert owner.child is left and left['member'] is right[0] is leaf
            assert kept['owner'].child is kept['left']
            assert kept['leaf'] is kept['right'][0] is kept['left']['member']
            assert kept['leaf'] is not leaf
            [item['name'] for item in copy['failed']]
        """))
        self.assertEqual(ast.literal_eval(reply["result"]), ["damaged"])
        self.assertEqual([item["name"] for item in reply["restored"]["failed"]], ["damaged"])

    async def test_unrelated_records_keep_their_byte_limits_and_archive_eligibility(self) -> None:
        reply = await self.cell_in_new_server(dedent("""\
            import dill
            from pathlib import Path
            from types import SimpleNamespace
            from rlm import repl as prime
            from python_repl_core.snapshot_names import shared_references
            repeated = [[]] * 200
            rows = {'amounts': list(range(200))}
            ordinary = {f'value_{i}': [i] for i in range(700)}
            ordinary.update(repeated=repeated, rows=rows, other=SimpleNamespace(level=3))
            assert not shared_references(ordinary, ordinary, list(ordinary))[0]
            linked = ordinary | {'left': [rows], 'right': {'ref': rows}}
            assert shared_references(linked, linked, ['rows'])[0] == {'left', 'right', 'rows'}
            path = Path('bounds.dill')
            for checked in (repeated, rows):
                roots = ordinary if checked is rows else {'repeated': repeated, 'other': ordinary['other']}
                saved = prime._snapshot_state(roots, str(path), 'bounds.json', 2**20, len(dill.dumps(checked)), False)
                assert not saved['skipped'], saved
                with path.open('rb') as stream:
                    blobs = prime._read_snapshot_records(stream, 2**20, 2**20)
                assert all(blobs[name] == dill.dumps(value) for name, value in roots.items())
                restored = {}
                report = prime._restore_state(restored, str(path))
                assert not report['failed'] and restored == roots
                assert restored['repeated'][0] is restored['repeated'][-1]
            protocol = dill.settings['protocol']
            try:
                dill.settings['protocol'] = 0
                value = SimpleNamespace(flag=False, text='short')
                original = dill.dumps(value)
                saved = prime._snapshot_state({'object': value, 'table': [4]}, str(path), 'text.json', 2**20, len(original), False)
                assert not saved['skipped']
                with path.open('rb') as stream:
                    assert prime._read_snapshot_records(stream, 2**20, 2**20)['object'] == original
            finally:
                dill.settings['protocol'] = protocol
            len(restored)
        """))
        self.assertEqual(reply["result"], "703")

    async def test_long_binding_name_with_text_and_binary_pickles(self) -> None:
        reply = await self.cell_in_new_server(dedent("""\
            import dill
            from pathlib import Path
            from types import SimpleNamespace
            from rlm import repl as prime
            from python_repl_core.snapshot_names import read_snapshot_values
            name = '測' * 3501
            value = [41]
            different = value.copy()
            namespace = {'holder': SimpleNamespace(member=value, other=different), name: value, name + '乙': different}
            original_protocol = dill.settings['protocol']
            try:
                for protocol in (0, 4):
                    dill.settings['protocol'] = protocol
                    path = Path(f'protocol-{protocol}.dill')
                    saved = prime._snapshot_state(namespace, str(path), str(path.with_suffix('.json')), 2**20, 2**20, False)
                    assert not saved['skipped'], saved['skipped']
                    restored = {}
                    assert not prime._restore_state(restored, str(path))['failed']
                    with path.open('rb') as stream:
                        copied, failed = read_snapshot_values(stream, list(reversed(saved['saved'])))
                    assert not failed
                    for result in (restored, copied):
                        assert result['holder'].member is result[name]
                        assert result['holder'].other is result[name + '乙']
                        assert result[name] == result[name + '乙'] == [41] and result[name] is not result[name + '乙']
                    small = prime._snapshot_state(namespace, str(path), 'limited.json', 2**20, 256, False)
                    assert [item['name'] for item in small['skipped']] == ['holder']
                    assert set(small['saved']) == {name, name + '乙'}
            finally:
                dill.settings['protocol'] = original_protocol
        """))
        self.assertNotIn("error", reply)

    @unittest.skipUnless(find_spec("openpyxl"), "openpyxl is an optional analysis library")
    async def test_named_worksheet_and_cell_write_to_the_reopened_workbook(self) -> None:
        await self.cell_in_new_server(dedent("""\
            from openpyxl import Workbook
            book = Workbook()
            sheet = book.active
            sheet.title = '读数'
            sheet['B2'] = 23
            cell = sheet['B2']
            book.create_sheet('图例')['A1'] = 52
            receipt = await repl.save_copy('cell', 'sheet', 'book')
            assert not receipt['skipped']
            del Workbook
        """))
        reply = await self.cell_in_new_server(dedent("""\
            assert sheet is book['读数'] and sheet.parent is book
            assert cell is sheet['B2'] and cell.parent is sheet
            copy = await repl.read_copy(receipt['copy_id'])
            assert not copy['failed']
            values = copy['values']
            assert values['cell'] is values['sheet']['B2']
            assert values['sheet'] is values['book']['读数'] and values['sheet'].parent is values['book']
            cell.value = 71
            book.save('readings.xlsx')
            values['cell'].value
        """))
        self.assertEqual(reply["result"], "23")
        from openpyxl import load_workbook

        book = load_workbook(self.workspace / "readings.xlsx")
        self.addCleanup(book.close)
        self.assertEqual(book.sheetnames, ["读数", "图例"])
        self.assertEqual((book["读数"]["B2"].value, book["图例"]["A1"].value), (71, 52))

    @unittest.skipUnless(find_spec("openpyxl"), "openpyxl is an optional analysis library")
    async def test_three_workbook_generations_keep_creating_rows_and_columns(self) -> None:
        await self.cell_in_new_server(dedent("""\
            from openpyxl import Workbook
            book = Workbook()
            book.active['A1'] = 3
            book.active.row_dimensions[4].height = 31
            book.active.column_dimensions.group('B', 'D', hidden=True)
            book.create_sheet('Other')['B2'] = 27
            del Workbook
        """))
        for generation, column in enumerate("GHI", 1):
            await self.cell_in_new_server(dedent(f"""\
                assert book.active.row_dimensions.worksheet is book.active
                receipt = await repl.save_copy('book')
                assert receipt['saved'] == ['book'] and not receipt['skipped']
                result = await repl.read_copy(receipt['copy_id'])
                assert not result['failed'] and result['values']['book'] is not book
                book = result['values']['book']
                assert book.active.column_dimensions.default_factory.__self__ is book.active
                book.active.row_dimensions[{generation + 10}].height = {generation + 40}
                book.active.column_dimensions['{column}'].width = {generation + 20}
                book.save('generation-{generation}.xlsx')
                del result, receipt
            """))
        from openpyxl import load_workbook

        for generation, column in enumerate("GHI", 1):
            book = load_workbook(self.workspace / f"generation-{generation}.xlsx")
            self.addCleanup(book.close)
            self.assertEqual((book.active['A1'].value, book['Other']['B2'].value), (3, 27))
            self.assertEqual(book.active.row_dimensions[4].height, 31)
            self.assertEqual(book.active.column_dimensions['B'].max, 4)
            self.assertTrue(book.active.column_dimensions['B'].hidden)
            self.assertEqual(book.active.row_dimensions[generation + 10].height, generation + 40)
            self.assertEqual(book.active.column_dimensions[column].width, generation + 20)

    async def test_unmodified_prime_snapshot_preserves_values_and_public_names(self) -> None:
        # Bare Prime writes the format used before AGY tracked references and underscore names.
        layout = KernelManager(data_dir=self.data)
        prime = KernelClient(
            python_exe=sys.executable, vendor_dir=layout.vendor_dir, compat_dir=layout.compat_dir, cwd=self.workspace,
        )
        await prime.start()
        try:
            seeded = await prime.execute("a = [1, 2]\nb = a\ndsh_user_total = 23")
            self.assertEqual(seeded.status, "ok", seeded.error)
            snapshots = self.data / "snapshots"
            saved = await prime.snapshot(snapshots / "default.dill", snapshots / "default.manifest.json")
            self.assertEqual(saved["status"], "ok", saved)
        finally:
            await prime.shutdown()

        restored = await self.cell_in_new_server("(a, b, globals().get('dsh_user_total'), '_total' in globals())")
        self.assertTrue(restored["restored"]["restored"], restored["restored"])
        self.assertEqual(ast.literal_eval(restored["result"]), ([1, 2], [1, 2], 23, False))
        self.assertIn("dsh_user_total", restored["restored"]["restored_names"])
