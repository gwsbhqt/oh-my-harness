"""Repetition notes (python/habits.py): what earns a note, and what never does.

The thresholds themselves are calibrated on real sessions;
these tests pin the behaviour each gate exists for, so a later tweak that
silently disables one fails here.
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import habits  # noqa: E402

NS = {"bash": len, "grep": len, "edit": len, "json": json if (json := __import__("json")) else None}

# call → parse → check: the shape worth a function (big: fires on the 2nd time)
BIG = '''r = await bash({"command": "git log -n 5", "description": "log"})
rows = [l.split(" ", 1) for l in r["stdout"]["text"].splitlines() if l.strip()]
bad = [h for h, msg in rows if "WIP" in msg]
if bad:
    print("unfinished:", ", ".join(h[:8] for h in bad))
print(len(rows), bad)
'''

# small processing unit: fires only on the 3rd time
SMALL = '''i = text.find("marker")
print(text[max(0, i - 200):i + 400])
'''


def run(tracker, code):
    return tracker.observe(code, NS | {"text": "x"})


class Thresholds(unittest.TestCase):
    def test_big_unit_is_noted_on_its_second_occurrence(self):
        t = habits.Tracker()
        self.assertEqual(run(t, BIG), [])
        notes = run(t, BIG.replace("git log -n 5", "git log -n 9").replace("WIP", "fixup"))
        self.assertEqual(len(notes), 1)
        self.assertIn("2nd time", notes[0])
        self.assertIn("repl.helpers()", notes[0])

    def test_small_unit_waits_for_its_third_occurrence(self):
        t = habits.Tracker()
        got = [run(t, SMALL.replace("marker", f"m{i}")) for i in range(5)]
        self.assertEqual([bool(n) for n in got], [False, False, True, False, False])
        self.assertIn("3rd time", got[2][0])

    def test_once_per_shape(self):
        t = habits.Tracker()
        got = [run(t, BIG) for _ in range(4)]
        self.assertEqual(sum(bool(n) for n in got), 1)


class NeverNoted(unittest.TestCase):
    def assertSilent(self, cells):
        t = habits.Tracker()
        for code in cells:
            self.assertEqual(run(t, code), [], code)

    def test_echo_code_without_processing(self):
        echo = 'r = await bash({"command": "ls", "description": "d"})\nprint(r["stdout"]["text"])\nprint(r["exitCode"])\n'
        self.assertSilent([echo.replace("ls", c) for c in ("ls", "pwd", "id", "who", "date")])

    def test_bare_tool_calls(self):
        call = 'await bash({"command": "make CMD", "description": "build CMD"})\nawait bash({"command": "test CMD"})\n'
        self.assertSilent([call.replace("CMD", str(i)) for i in range(5)])

    def test_literal_heavy_units(self):
        # An edit's substance is its text; two edits share only the wrapper.
        body = "x" * 300
        edit = f'await edit({{"file_path": p, "old_string": "{body}A", "new_string": "{body}B"}})\nif ok: print(n)\n'
        self.assertSilent([edit.replace("A", str(i)) for i in range(5)])

    def test_calling_your_own_helper_is_reuse(self):
        t = habits.Tracker()
        ns = NS | {"summarize": len}
        for host in ("a", "b", "c", "d", "e"):
            self.assertEqual(t.observe(f'rows = summarize("{host}", limit=3)\nprint(host, rows)\n', ns), [])

    def test_processing_around_a_helper_still_counts(self):
        # The same filter+slice after every call belongs inside the helper;
        # the note says so ("redefine it under the same name").
        t = habits.Tracker()
        ns = NS | {"summarize": len}
        cell = 'rows = summarize("{h}")\nkeep = [r.strip() for r in rows if r and not r.startswith("#")]\nprint(len(keep), keep[:3])\n'
        got = [t.observe(cell.format(h=h), ns) for h in "abcd"]
        self.assertEqual([bool(n) for n in got], [False, False, True, False])

    def test_code_inside_a_function_body_is_not_counted(self):
        self.assertSilent([f"def f{i}(text):\n" + "".join("    " + l + "\n" for l in BIG.splitlines()) for i in range(3)])

    def test_syntax_error_is_ignored_and_prints_nothing(self):
        t = habits.Tracker()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(t.observe("def (:\n", NS), [])
            # "\\$" in a plain string raises a SyntaxWarning in compile(); it
            # must not reach the cell's stderr.
            t.observe('print("\\$HOME")\n', NS)
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(t.cells, 1)


class HandEdits(unittest.TestCase):
    def test_repeated_hand_edit_gets_edit_tool_advice(self):
        t = habits.Tracker()
        cell = 'assert src.count(old) == 1\nsrc = src.replace(old, "{new}")\nopen(path, "w").write(src)\n'
        self.assertEqual(run(t, cell.format(new="a")), [])
        notes = run(t, cell.format(new="b"))
        self.assertEqual(len(notes), 1)
        self.assertIn("Hand-rolled file edit", notes[0])
        self.assertIn('"edits"', notes[0])

    def test_pathlib_write_text_counts_too(self):
        t = habits.Tracker()
        cell = 'p.write_text(t.replace(old, "{new}"))\n'
        run(t, cell.format(new="a"))
        self.assertIn("Hand-rolled", run(t, cell.format(new="b"))[0])


class DisplayTrimming(unittest.TestCase):
    def test_trimming_inside_print_is_not_processing(self):
        t = habits.Tracker()
        cell = 'r = subprocess.run(["make", "{t}"], capture_output=True, text=True)\nprint(r.returncode, r.stdout.strip()[-300:], r.stderr[:200])\n'
        for target in ("a", "b", "c", "d"):
            self.assertEqual(t.observe(cell.format(t=target), NS | {"subprocess": sys}), [])


class PolicyKnobs(unittest.TestCase):
    def test_policy_is_honoured(self):
        t = habits.Tracker(habits.Policy(small_occurrence=2))
        self.assertEqual(run(t, SMALL), [])
        self.assertEqual(len(run(t, SMALL)), 1)

    def test_units_carry_features_independent_of_policy(self):
        tree = habits.parse(BIG)
        units = habits.units(tree, set(NS))
        whole = max(units, key=lambda u: u.size)
        self.assertEqual(whole.stmts, 3)
        self.assertTrue(whole.logic)
        self.assertLess(whole.literal, 0.5)
        self.assertFalse(whole.plain)


if __name__ == "__main__":
    unittest.main()
