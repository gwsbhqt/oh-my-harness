"""Exercise existing framed snapshots and explicit copies through the guarded Prime reader."""
import io
import pickletools
from importlib.util import find_spec
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from python_repl_core import recovery_copies
from python_repl_core.snapshot_names import install_snapshot_names, read_snapshot_values

try:
    import dill
except ImportError:
    dill = None


@unittest.skipIf(dill is None, "dill is an optional kernel dependency")
class SnapshotResources(unittest.TestCase):
    def setUp(self):
        project = Path(__file__).resolve().parents[2]
        sources = [str(project / 'dsh-python-repl/vendor/prime'), str(project / 'dsh-python-repl/python/compat')]
        self.enterContext(patch.object(sys, 'path', sources + sys.path))
        self.enterContext(patch.object(sys, 'dont_write_bytecode', True))
        from rlm import repl

        install_snapshot_names(dill._dill, legacy_underscore_aliases=False)
        self.prime = repl
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.snapshot = self.root / 'values.dill'
        self.manifest = self.root / 'manifest.json'

    def save(self, values):
        saved = self.prime._snapshot_state(values, str(self.snapshot), str(self.manifest), 8 << 20, 2 << 20, False)
        self.assertEqual(saved['skipped'], [])
        self.assertEqual(set(saved['saved']), set(values))

    def restore(self):
        values = {}
        result = self.prime._restore_state(values, str(self.snapshot))
        return values, result

    def test_unlocked_and_owned_recursive_locks(self):
        empty, recursive = threading.RLock(), threading.RLock()
        with recursive, recursive:
            self.save({'empty': empty, 'recursive': recursive})
        values, result = self.restore()
        self.assertEqual(result['failed'], [])
        self.assertTrue(values['empty'].acquire(timeout=0.05))
        values['empty'].release()
        self.assertTrue(values['recursive']._is_owned())
        self.assertEqual(values['recursive']._recursion_count(), 2)
        values['recursive'].release()
        values['recursive'].release()

    def test_a_lock_owned_by_another_thread_keeps_dills_failure(self):
        lock = threading.RLock()
        ready, finish = threading.Event(), threading.Event()

        def hold():
            with lock:
                ready.set()
                finish.wait(5)

        owner = threading.Thread(target=hold)
        owner.start()
        try:
            self.assertTrue(ready.wait(2))
            self.save({'held': lock, 'count': 42})
            values, report = self.restore()
            self.assertEqual(values, {'count': 42})
            failed, = report['failed']
            self.assertEqual(failed['name'], 'held')
            self.assertIn('Cannot acquire lock', failed['reason'])
        finally:
            finish.set()
            owner.join()

    def test_disk_archive_fails_by_name_without_publishing_its_shared_references(self):
        path = self.root / 'sample.zip'
        with ZipFile(path, 'w') as archive:
            archive.writestr('amount', '42')
        content = path.read_bytes()
        shared = [42]
        with ZipFile(path) as disk, path.open('rb') as raw, ZipFile(io.BytesIO(content)) as memory:
            values = {'batch': [shared, disk], 'archive': disk, 'values': shared, 'also_values': shared,
                      'mixed': [memory, raw, ZipFile], 'handle': raw, 'path': path.name}
            self.save(values)
            with patch.dict(vars(sys.modules['__main__']), values):
                copy = recovery_copies.save(self.root, tuple(values))
            self.assertEqual(copy['skipped'], [])
        moved = path.rename(self.root / 'moved.zip')
        normal, report = self.restore()
        copied = recovery_copies.read(self.root, copy['copy_id'])
        for source, result, values in [('restart', report, normal), ('copy', copied, copied['values'])]:
            with self.subTest(source=source):
                memory, raw, cls = values['mixed']
                self.addCleanup(memory.close)
                self.assertEqual({entry['name'] for entry in result['failed']}, {'batch', 'archive'})
                for entry in result['failed']:
                    self.assertIn('sample.zip', entry['reason'])
                    self.assertIn('reopen', entry['reason'].lower())
                self.assertEqual(set(values), {'values', 'also_values', 'mixed', 'handle', 'path'})
                self.assertIs(values['values'], values['also_values'])
                self.assertEqual(values['values'], [42])
                self.assertIs(cls, ZipFile)
                self.assertTrue(raw.closed)
                self.assertTrue(values['handle'].closed)
                self.assertTrue(memory._lock.acquire(timeout=0.05))
                memory._lock.release()
                self.assertEqual(memory.read('amount'), b'42')
        self.assertFalse(path.exists())
        self.assertEqual(moved.read_bytes(), content)

    @unittest.skipUnless(find_spec("openpyxl"), "openpyxl is an optional analysis library")
    def test_legacy_input_starts_and_ends_at_the_callers_stream_position(self):
        from openpyxl import Workbook

        old = dill.dumps(dill.loads(dill.dumps(Workbook())))
        prefix = dill.dumps(("earlier", "DimensionHolder"))
        later = dill.dumps("later")
        content = prefix + old + later
        path = self.root / "sequential.dill"
        path.write_bytes(content)
        for stream in (io.BytesIO(content), io.BufferedReader(io.BytesIO(content)), path.open("rb")):
            with self.subTest(stream=type(stream)), stream:
                self.assertEqual(dill.load(stream)[0], "earlier")
                restored = self.prime._snapshot_unpickler(dill)(stream).load()
                self.assertIs(restored.active.row_dimensions[19].parent, restored.active)
                self.assertEqual(stream.tell(), len(prefix) + len(old))
                self.assertEqual(dill.load(stream), "later")

        class NoFileDescriptor(io.BytesIO):
            pass

        control = ["openpyxl.worksheet.dimensions", "DimensionHolder", b")R"]
        with io.BufferedReader(NoFileDescriptor(dill.dumps(control))) as ordinary:
            self.assertEqual(self.prime._snapshot_unpickler(dill)(ordinary).load(), control)
        with io.BytesIO(dill.dumps(control)) as ordinary, patch("pickletools.genops", side_effect=ValueError) as probe:
            self.assertEqual(self.prime._snapshot_unpickler(dill)(ordinary).load(), control)
            probe.assert_called_once()

    def test_optional_module_placeholders_leave_normal_snapshots_alone(self):
        from types import ModuleType
        from python_repl_core.snapshot_resources import dimension_type

        path = "openpyxl.worksheet.dimensions"
        foreign = ModuleType(path)
        foreign.DimensionHolder = dict
        for placeholder in (None, object(), foreign):
            with self.subTest(placeholder=placeholder), patch.dict(sys.modules, {path: placeholder}):
                self.assertIsNone(dimension_type())
                self.save({"record": [42]})
                values, report = self.restore()
                self.assertEqual((values, report["failed"]), ({"record": [42]}, []))

    @unittest.skipUnless(find_spec("openpyxl"), "openpyxl is an optional analysis library")
    def test_historical_worksheet_dimensions_require_one_saved_owner(self):
        from openpyxl import Workbook, load_workbook
        from openpyxl.worksheet.dimensions import DimensionHolder

        original = Workbook()
        sheet = original.active
        sheet["A1"] = 17
        sheet.row_dimensions[3].height = 26
        sheet.column_dimensions["B"].width = 18
        first = dill.dumps(original)
        old = dill.loads(first)
        second = dill.dumps(old)
        empty = dill.loads(dill.dumps(Workbook())).active.row_dimensions
        conflict = dill.loads(first)
        conflict.create_sheet().row_dimensions = conflict.active.row_dimensions
        records = {"first": first, "second": second, "orphan": dill.dumps(empty), "mixed": dill.dumps([old, DimensionHolder]),
                   "conflict": dill.dumps(conflict), "count": dill.dumps(42),
                   "unmemoized_orphan": pickletools.optimize(dill.dumps([empty]))}
        with self.snapshot.open("wb") as stream:
            stream.write(self.prime._SNAPSHOT_MAGIC)
            for name, blob in records.items():
                key = name.encode()
                stream.write(len(key).to_bytes(4, "little") + key + len(blob).to_bytes(8, "little") + blob)
        history = self.snapshot.read_bytes()
        normal, report = self.restore()
        with self.snapshot.open("rb") as stream:
            copied, failed = read_snapshot_values(stream, list(records))
        for values, errors in ((normal, report["failed"]), (copied, failed)):
            reasons = {entry["name"]: entry["reason"] for entry in errors}
            self.assertEqual(set(reasons), {"orphan", "unmemoized_orphan", "conflict"})
            self.assertIn("no saved owning worksheet", reasons["orphan"])
            self.assertIn("conflicting", reasons["conflict"])
            self.assertEqual(values["count"], 42)
            self.assertIs(values["mixed"][1], DimensionHolder)
            for book in (values["first"], values["second"], values["mixed"][0]):
                ws = book.active
                self.assertIs(ws.row_dimensions.worksheet, ws)
                self.assertIs(ws.column_dimensions.default_factory.__self__, ws)
                ws.row_dimensions[8].height = 47
                ws.column_dimensions["G"].width = 29
                dest = self.root / "restored.xlsx"
                book.save(dest)
                again = load_workbook(dest)
                self.assertEqual((again.active["A1"].value, again.active.row_dimensions[8].height,
                                  again.active.column_dimensions["G"].width), (17, 47, 29))
                again.close()
        self.assertEqual(history, self.snapshot.read_bytes())

    @unittest.skipUnless(find_spec("openpyxl"), "openpyxl is an optional analysis library")
    def test_new_nested_dimensions_and_ordinary_data_use_ordinary_dill(self):
        from collections import defaultdict
        from openpyxl import Workbook
        from openpyxl.worksheet.dimensions import DimensionHolder

        book = Workbook()
        book.active["A1"] = "stored after the worksheet dimensions"
        book.active.row_dimensions.note = "kept"
        plain = defaultdict(list, items=[42])
        ordinary = {"alias": [plain, plain]}
        previous = dill.Pickler.dispatch.get(DimensionHolder)
        self.save({"ordinary": ordinary})
        with self.snapshot.open("rb") as stream:
            raw = self.prime._read_snapshot_records(stream, 8 << 20, 2 << 20)["ordinary"]
        self.assertEqual(raw, dill.dumps(ordinary, recurse=True))
        with patch("pickletools.genops", side_effect=AssertionError("parsed ordinary pickle")) as probe:
            values, report = self.restore()
            self.assertEqual(report["failed"], [])
            a, b = values["ordinary"]["alias"]
            self.assertIs(a, b)
            self.assertIs(a.default_factory, list)
            data = b"openpyxl.worksheet.dimensions DimensionHolder )R" * 100_000
            self.assertEqual(self.prime._snapshot_unpickler(dill)(io.BytesIO(dill.dumps(data))).load(), data)
            probe.assert_not_called()
        for value in (book, [book], {"nested": [book]}):
            self.save({"value": value})
            with self.snapshot.open("rb") as stream:
                blob = self.prime._read_snapshot_records(stream, 8 << 20, 2 << 20)["value"]
            genops = pickletools.genops
            checked = []

            def seen_prefix(stream):
                for op, arg, pos in genops(stream):
                    if op.name in ("UNICODE", "SHORT_BINUNICODE"):
                        checked.append(arg)
                    yield op, arg, pos

            with patch.object(pickletools, "genops", seen_prefix):
                self.prime._snapshot_unpickler(dill)(io.BytesIO(blob)).load()
            self.assertIn("openpyxl.dimensions.v1", checked)
            self.assertNotIn("stored after the worksheet dimensions", checked)
            new = dill.loads(blob)
            restored = new if value is book else new[0] if type(new) is list else new["nested"][0]
            self.assertIs(restored.active.row_dimensions.worksheet, restored.active)
            self.assertEqual(restored.active.row_dimensions.note, "kept")
            self.assertIs(restored.active.column_dimensions["J"].parent, restored.active)
        self.assertIs(dill.Pickler.dispatch.get(DimensionHolder), previous)
