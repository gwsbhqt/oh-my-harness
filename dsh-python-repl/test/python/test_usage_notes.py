"""Usage notes read the syntax tree: code inside a string is not this cell doing it."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import detours  # noqa: E402


class UsageNotes(unittest.TestCase):
    def notes(self, code):
        return detours.observe(code)

    def test_writing_files_gets_no_note(self):
        # User 2026-11-05: writing with open()/write_text is fine; no reminder to use write/edit.
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.dict(os.environ, {"DSH_PYTHON_REPL_WORKSPACE": root}):
                html = str(Path(root) / "a.html")
                md = str(Path(root) / "out.md")
                self.assertEqual(self.notes(f'from pathlib import Path\nPath({html!r}).write_text("<p>x</p>")'), [])
                self.assertEqual(self.notes(f'with open({md!r}, "w") as fh:\n    fh.write("x")'), [])

    def test_reading_is_not_writing(self):
        self.assertEqual(self.notes('t = open("a.md").read()\nu = open("b.json", "r").read()'), [])

    def test_scratch_file_without_deliverable_extension(self):
        self.assertEqual(self.notes('open("/tmp/x.log", "w").write("x")'), [])

    def test_subprocess_real_call_and_alias(self):
        self.assertIn(detours.SUBPROCESS_NOTE, self.notes('import subprocess\nsubprocess.run(["ls"])'))
        self.assertIn(detours.SUBPROCESS_NOTE, self.notes('import subprocess as sp\nsp.check_output(["ls"])'))
        self.assertIn(detours.SUBPROCESS_NOTE, self.notes('import os\nos.system("ls")'))

    def test_subprocess_inside_a_string_is_not_a_call(self):
        self.assertEqual(self.notes('await bash("python3 -c \'import subprocess; subprocess.run([1])\'", "x")'), [])
        self.assertEqual(self.notes('note = "use subprocess.run here"'), [])


    def test_sleep_poll_loop(self):
        self.assertIn(detours.SLEEP_POLL_NOTE, self.notes('while True:\n    r = await tools.job_output({"job_id": "j"})\n    await asyncio.sleep(5)'))
        self.assertIn(detours.SLEEP_POLL_NOTE, self.notes('import time\nfor i in range(9):\n    time.sleep(1)'))
        self.assertNotIn(detours.SLEEP_POLL_NOTE, self.notes('await asyncio.sleep(1)\nx = 1'))


if __name__ == "__main__":
    unittest.main()
