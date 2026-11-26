"""Keep original session copy manifests readable while isolating each session's list."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from python_repl_core import recovery_copies

try:
    import dill
except ImportError:
    dill = None


@unittest.skipIf(dill is None, "dill is an optional kernel dependency")
class RecoveryCopyFormat(unittest.TestCase):
    def test_existing_copy_layout_reads_into_an_independent_dictionary(self):
        project = Path(__file__).resolve().parents[2]
        paths = [str(project / "dsh-python-repl/vendor/prime"), str(project / "dsh-python-repl/python/compat")]
        self.enterContext(patch.object(sys, "path", paths + sys.path))
        self.enterContext(patch.object(sys, "dont_write_bytecode", True))
        from rlm import repl
        from python_repl_core.snapshot_names import install_snapshot_names

        install_snapshot_names(dill._dill, legacy_underscore_aliases=False)
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        owner = root / "owner"
        sibling = root / "sibling"
        copy_id = "1" * 32
        folder = owner / "copies" / copy_id
        folder.mkdir(parents=True)
        manifest = folder / "manifest.json"
        skipped = [{"name": "archived", "reason": "archived; explicitly unarchive it before saving a copy"}]
        rows = [3, 5]
        result = repl._snapshot_state({"rows": rows, "same": rows}, str(folder / "values.dill"), str(manifest),
                                      repl.DEFAULT_SNAPSHOT_MAX_BYTES, repl.DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES, False)
        self.assertEqual(result["saved"], ["rows", "same"])
        old = json.loads(manifest.read_text())
        old.update(copyId=copy_id, session=owner.name, skipped=skipped)
        manifest.write_text(json.dumps(old))

        self.assertEqual(recovery_copies.list_copies(owner), [copy_id])
        self.assertEqual(recovery_copies.list_copies(sibling), [])
        with self.assertRaises(FileNotFoundError):
            recovery_copies.read(sibling, copy_id)
        with patch.dict(vars(sys.modules["__main__"]), {"rows": "existing live value"}):
            restored = recovery_copies.read(owner, copy_id)
            self.assertEqual(restored["failed"], [])
            self.assertEqual(restored["skipped"], skipped)
            self.assertIs(restored["values"]["rows"], restored["values"]["same"])
            restored["values"]["rows"].append(8)
            self.assertEqual(recovery_copies.read(owner, copy_id)["values"]["rows"], [3, 5])
            self.assertEqual(vars(sys.modules["__main__"])["rows"], "existing live value")
        old["session"] = sibling.name
        manifest.write_text(json.dumps(old))
        self.assertEqual(recovery_copies.list_copies(owner), [])
        with self.assertRaises(ValueError):
            recovery_copies.read(owner, copy_id)
