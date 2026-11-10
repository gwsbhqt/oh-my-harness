"""Next-step hints built from the file system, retired skill names, and what `_` holds after a cut."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import cell_errors  # noqa: E402
import output_notes  # noqa: E402
import skills  # noqa: E402


class NextSteps(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        Path(self.dir, "session.ts").write_text("a\nb\n")
        Path(self.dir, "src").mkdir()

    def test_near_paths_for_a_missing_file(self):
        hint = cell_errors.tool_hint(f'cannot read "{self.dir}/sesion.ts": not found')
        self.assertIn(f"{self.dir}/session.ts", hint)
        deep = cell_errors.tool_hint(f'cannot read "{self.dir}/nope/deeper/x.py": not found')
        self.assertIn(f"the deepest existing directory is {self.dir}", deep)

    def test_closest_text_for_an_edit_that_did_not_match(self):
        path = Path(self.dir, "a.py")
        path.write_text("def f():\n    return compute(x,  y)\n\ndef g():\n    pass\n")
        args = {"file_path": str(path), "old_string": "def f():\n    return compute(x, y)", "new_string": "z"}
        hint = cell_errors.tool_hint(f'old_string was not found in "{path}"', args)
        self.assertIn("Closest text in the file (lines 1-2", hint)
        self.assertIn("2:     return compute(x,  y)", hint)
        batch = {"file_path": str(path), "edits": [{"old_string": "def g():", "new_string": "q"}, {"old_string": "def g(:\n    pass", "new_string": "r"}]}
        hint2 = cell_errors.tool_hint("batch rejected before dispatch (no change was applied): change 2 of 2: old_string was not found", batch)
        self.assertIn("lines 4-5", hint2)

    def test_unrelated_text_keeps_the_generic_hint(self):
        path = Path(self.dir, "b.py")
        path.write_text("alpha\nbeta\n")
        hint = cell_errors.tool_hint(f'old_string was not found in "{path}"', {"file_path": str(path), "old_string": "zzzz qqqq", "new_string": "x"})
        self.assertIn("does not contain that exact text", hint)

    def test_offset_out_of_range_gives_the_line_count(self):
        hint = cell_errors.tool_hint(f'offset 90 is out of range for "{self.dir}/session.ts"')
        self.assertIn("The file has 3 lines", hint)


class RetiredSkillNames(unittest.TestCase):
    def test_successor_and_close_spelling(self):
        available = ["demo_reader", "demo_writer"]
        self.assertIn("did you mean skills.demo_reader?", skills._missing_skill("old", available, {"old": "demo_reader"}))
        self.assertIn("did you mean skills.demo_reader?", skills._missing_skill("demo_reade", available))
        self.assertNotIn("did you mean", skills._missing_skill("old", available))
        self.assertNotIn("did you mean", skills._missing_skill("old", available, {"old": "unavailable"}))

    def test_namespaces_keep_configured_hints_separate(self):
        configured = skills._SkillsNamespace({"OLD": "demo_reader"})
        configured._put("demo_reader", object())
        other = skills._SkillsNamespace()
        other._put("demo_reader", object())
        with self.assertRaisesRegex(AttributeError, "did you mean skills.demo_reader"):
            configured.old
        with self.assertRaises(AttributeError) as caught:
            other.old
        self.assertNotIn("did you mean", str(caught.exception))


class UnderscoreAfterCut(unittest.TestCase):
    def test_describes_this_cells_value_and_notices_a_stale_one(self):
        ns = {"_": [{"id": 1, "name": "a"}] * 300}
        note = output_notes.after_cell(ns, True)
        self.assertIn("a list of 300 items; items are dicts with keys 'id', 'name'", note)
        self.assertIn("still holds an earlier result", output_notes.after_cell(ns, True))
        ns["_"] = "x" * 9000
        self.assertIn("a str of 9000 characters", output_notes.after_cell(ns, True))
        self.assertIsNone(output_notes.after_cell({"_": 1}, False))

    def test_never_calls_user_code(self):
        class Loud(dict):
            def __len__(self):
                raise AssertionError("user __len__ called")
        self.assertIn("Loud", output_notes.after_cell({"_": Loud(a=1)}, True))


if __name__ == "__main__":
    unittest.main()
