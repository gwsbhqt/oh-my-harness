"""Detour notices, calibrated on a real session.

Every positive case is the shape of a cell from session-e7455d7c (2026-09-29),
where 25 cells reached pymupdf through a second interpreter. Every negative
case is a cell shape that ran in real sessions and must NOT be flagged: test
runs, script files, stdlib-only probes, and text written to files.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import detours  # noqa: E402

TRIPLE = "'" * 3


def notice(code: str) -> list[str]:
    detours._REPORTED.clear()
    return detours.observe(code)


class Flags(unittest.TestCase):
    def test_uv_run_with_script_on_stdin(self) -> None:
        code = (
            f"rp = r{TRIPLE}\nimport pymupdf, sys\nd = pymupdf.open(sys.argv[1])\n{TRIPLE}\n"
            'r = await bash({"command": f"fish -lc \'uv run --quiet --with pymupdf python - {BIG}\'", '
            '"stdin": rp, "description": "x"})\n'
        )
        lines = notice(code)
        self.assertEqual(len(lines), 1)
        self.assertIn('repl.install("pymupdf")', lines[0])

    def test_uv_run_with_inline_c(self) -> None:
        self.assertTrue(notice('await bash({"command": "uv run --with pymupdf python -c \'import fitz\'"})'))

    def test_bare_python_c_importing_a_third_party_library(self) -> None:
        lines = notice('await bash({"command": "python3 -c \'import yaml; print(1)\'"})')
        self.assertIn('repl.install("yaml")', lines[0])

    def test_through_tools_attribute_and_a_named_script(self) -> None:
        self.assertTrue(notice('s = "import pandas\\nprint(1)"\nawait tools.bash({"command": "python3 -", "stdin": s})'))

    def test_once_per_kernel(self) -> None:
        code = 'await bash({"command": "uv run --with x python -c \'import x\'"})'
        self.assertTrue(notice(code))
        self.assertEqual(detours.observe(code), [])


class DoesNotFlag(unittest.TestCase):
    def test_a_test_run_through_uv(self) -> None:
        self.assertEqual(notice('await bash({"command": "uv run --with pymupdf python -m unittest discover -s tests"})'), [])

    def test_running_a_script_file(self) -> None:
        self.assertEqual(notice('await bash({"command": "uv run --with aiohttp python -u /tmp/proxy.py"})'), [])
        self.assertEqual(notice('await bash({"command": "python3 scripts/decode.py a.pdf"})'), [])

    def test_inline_python_in_the_project_environment(self) -> None:
        # Prime's usage rule: project code runs through the project's own environment.
        self.assertEqual(notice('await bash({"command": "uv run --no-project python -c \'print(1)\'"})'), [])
        self.assertEqual(notice('await bash({"command": "uv run python -c \'import mypkg, pandas\'"})'), [])

    def test_stdlib_only_inline_python(self) -> None:
        self.assertEqual(notice('await bash({"command": "python3 -c \'import sys, json; print(sys.version)\'"})'), [])

    def test_text_written_to_a_file(self) -> None:
        code = 'await write({"file_path": "a.md", "content": "uv run --with pymupdf python -c \'import fitz\'"})'
        self.assertEqual(notice(code), [])

    def test_kernel_side_import(self) -> None:
        self.assertEqual(notice("import pymupdf\nd = pymupdf.open('x.pdf')"), [])

    def test_prose_mentioning_python_c(self) -> None:
        self.assertEqual(notice('await bash({"command": "echo \'python -c is slow\'"})'), [])

    def test_broken_code(self) -> None:
        self.assertEqual(notice("def ("), [])


class FileWrites(unittest.TestCase):
    """Writing files from Python gets no note at all (user 2026-11-05: any way of writing is fine)."""

    def setUp(self) -> None:
        self.workspace = Path(tempfile.mkdtemp(prefix="dsh-detours-"))
        self.patch = mock.patch.dict(os.environ, {"DSH_PYTHON_REPL_WORKSPACE": str(self.workspace)})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_writing_a_deliverable_in_the_workspace_is_not_flagged(self) -> None:
        ws = str(self.workspace)
        for code in (
            f'open({ws + "/report.md"!r}, "w").write("x")',
            f'p = {ws + "/index.html"!r}\nopen(p, "w").write("x")',
            f'from pathlib import Path\n(Path({ws!r}) / "docs" / "a.json").write_text("x")',
            f'name = "r"\nopen(f"{ws}/{{name}}.py", "w").write("x")',
            'open("/tmp/note.md", "w").write("x")',
        ):
            with self.subTest(code=code):
                self.assertEqual(notice(code), [])


class ShellHabits(unittest.TestCase):
    """`| head`/`| tail` and `cat <source>` in bash (session analysis 2026-10-08); `2>/dev/null` is not flagged.

    Every case is a command shape from the 297 analysed sessions.
    """

    def notes(self, command: str) -> list[str]:
        detours._REPORTED.clear()
        return detours.observe(f"r = await bash({{'command': {command!r}, 'description': 'x'}})")

    def test_each_kind_names_the_python_way(self) -> None:
        for command, marker in (
            ("git diff dsh-example/src/window.ts | head -80", "| head`/`| tail"),
            ("cat apps/web/src/adapters/fire.tsx", "`cat`"),
        ):
            with self.subTest(command=command):
                lines = self.notes(command)
                self.assertEqual(len(lines), 1, lines)
                self.assertIn(marker, lines[0])
                self.assertIn("already a Python string", lines[0])
                self.assertIn("read files with `read`", lines[0])

    def test_once_per_kind_per_kernel(self) -> None:
        detours._REPORTED.clear()
        cell = "await bash({'command': 'ls | head -3'})"
        self.assertTrue(detours.observe(cell))
        self.assertEqual(detours.observe(cell), [])
        self.assertTrue(detours.observe("await bash({'command': 'cat package.json'})"))

    def test_several_kinds_in_one_cell(self) -> None:
        self.assertEqual(len(self.notes("cat src/a.ts; grep x b | tail -2; grep y c 2>/dev/null")), 2)

    def test_the_command_can_come_from_a_variable(self) -> None:
        detours._REPORTED.clear()
        self.assertTrue(detours.observe("cmd = 'git log | head -5'\nr = await bash({'command': cmd})"))
        detours._REPORTED.clear()
        self.assertTrue(detours.observe("args = {'command': 'cat x.py'}\nawait tools.bash(args)"))

    def test_not_flagged(self) -> None:
        for command in (
            "tail -f /tmp/server.log",
            "tail -F log.txt | grep ERROR",
            'f=$(ls -t ~/.dsh/sessions/*.jsonl | head -1); echo "$f"',
            "git cat-file -e HEAD:x 2>/dev/null && echo yes || echo no",
            "kill $pid 2>/dev/null; true",
            "ls ../migration 2>/dev/null; ls build",
            "networksetup -setwebproxy Wi-Fi 127.0.0.1 8080 off 2>/dev/null",
            "cat a.log",
            "cat package.json | jq .version",
            'agent-browser eval "$(cat /tmp/probe.js)"',
            "ssh host 'cat ~/.config/app.toml'",
            "cat > out.py <<'EOF'\nprint(1)\nEOF",
            "npm test 2>&1",
            "grep -rn TODO src 2>/dev/null",
            "ls ../migration 2>/dev/null",
        ):
            with self.subTest(command=command):
                self.assertEqual(self.notes(command), [])

    def test_description_and_stdin_are_not_the_command(self) -> None:
        detours._REPORTED.clear()
        code = "await bash({'command': 'python3 -', 'stdin': 'cat a.py | head', 'description': 'cat x.py | tail'})"
        self.assertEqual(detours.observe(code), [])

    def test_text_written_to_a_file_is_not_a_command(self) -> None:
        detours._REPORTED.clear()
        self.assertEqual(detours.observe("await write({'file_path': 'a.md', 'content': 'run: cat a.py | head'})"), [])


if __name__ == "__main__":
    unittest.main()