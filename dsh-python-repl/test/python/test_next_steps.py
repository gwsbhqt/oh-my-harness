"""Next-step hints built from the file system, retired skill names, and what `_` holds after a cut."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import cell_errors  # noqa: E402
import dsh_kernel  # noqa: E402
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

    def test_background_job_cap_says_to_batch_into_one_command(self):
        hint = cell_errors.tool_hint("background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job, wait for it to finish, then retry")
        self.assertIn("at most 10 run at once", hint)
        self.assertIn("one command", hint)
        self.assertIn("tools.job_list({})", hint)

    def test_offset_out_of_range_gives_the_line_count(self):
        hint = cell_errors.tool_hint(f'offset 90 is out of range for "{self.dir}/session.ts"')
        self.assertIn("The file has 2 lines", hint)


def missing_grep_root(path, workdir):
    return f"grep 路径不存在：{path}（相对路径按工作区 {workdir} 解析）。请检查拼写，或先用 glob 找到正确路径。"


class MissingSkillReferences(unittest.TestCase):
    def test_only_the_missing_root_of_this_grep_offers_a_replacement_path(self):
        path = "other/skills/demo-reader/references/guide.md"
        directory = Path("/fixture/reader's shelf/skills/demo-reader")
        namespace = skills._SkillsNamespace()
        skills.load([{"skill": "demo-reader", "path": str(directory), "instructions_file": "SKILL.md"}], namespace)
        args = {"pattern": "fixture query", "path": path, "scope": "all"}
        missing = missing_grep_root(path, "/fixture/project")
        denied = f"grep 无法读取搜索路径 {path}：Permission denied (os error 13)"
        invalid = f"grep 路径无效：{path} 中有一段是文件而不是目录（Not a directory (os error 20)）。"
        with patch.object(dsh_kernel, "skills", namespace):
            hint = cell_errors.tool_hint(missing, args, tool_name="grep")
            expected = str(directory / "references" / "guide.md")
            self.assertIn(f"`path={expected!r}`", hint)
            self.assertNotIn(args["pattern"], hint)
            self.assertNotIn("await read", hint)
            relative = "skills/demo-reader/references/absent.md"
            same_root = cell_errors.tool_hint(missing_grep_root(relative, directory.parent.parent),
                                              {**args, "path": relative}, tool_name="grep")
            self.assertIn("already uses the discovered directory", same_root)
            self.assertNotIn("`path=", same_root)
            for message, request, tool in (
                (denied, args, "grep"), (invalid, args, "grep"),
                (missing, {**args, "path": "another"}, "grep"), (missing, args, "other"),
            ):
                with self.subTest(message=message, tool=tool):
                    self.assertIsNone(cell_errors.tool_hint(message, request, tool_name=tool))

    def test_ambiguous_unavailable_and_traversing_paths_offer_no_alternate_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            namespace = skills._SkillsNamespace()
            def entry(name, source):
                return {"skill": name, "path": str(root / source / name), "instructions_file": "SKILL.md"}
            entries = [entry("shared", "first"), entry("shared", "second"), entry("guide", "catalog"),
                       {**entry("broken", "private"), "document_error": "invalid fixture"}]
            skills.load(entries, namespace, disabled=["disabled"])
            with patch.object(dsh_kernel, "skills", namespace):
                for name in ("shared", "broken", "disabled", "unknown", "guide/.."):
                    path = str(root / "guessed" / "skills" / name / "references" / "common.md")
                    with self.subTest(name=name):
                        hints = (
                            cell_errors.tool_hint(f'cannot read "{path}": not found', {"file_path": path}),
                            cell_errors.tool_hint(missing_grep_root(path, tmp), {"path": path, "pattern": "guide"},
                                                  tool_name="grep"),
                        )
                        for hint in hints:
                            self.assertNotIn("await read", hint)
                            self.assertNotIn("`path=", hint)
                            self.assertNotIn(str(root), hint)
                path = str(root / "catalog" / "skills" / "guide" / "SKILL.md")
                self.assertIsNone(cell_errors.tool_hint(f'cannot read "{path}": permission denied', {"file_path": path}))


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
