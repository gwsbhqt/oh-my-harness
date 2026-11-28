"""Exercise the six local shortcuts, result displays and kernel helper introspection."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agy_python_repl.builtin_tools import ToolCallError, create_builtin_tools
from agy_python_repl.manager import KernelManager


class BuiltinToolsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.workspace = root / "work"
        self.workspace.mkdir()
        self.data = root / "data"

    def new_manager(self) -> KernelManager:
        manager = KernelManager(data_dir=self.data, skill_roots=[], project_skill_roots=[])
        self.addAsyncCleanup(manager.shutdown_all)
        return manager

    async def test_shortcuts_keep_structured_values_and_snapshots_clean(self) -> None:
        manager = self.new_manager()
        res = await manager.run_code(
            '''
w = await write("sub/demo.txt", "alpha\\nbeta\\ngamma\\ndelta\\n")
r = await read("sub/demo.txt", offset=2, limit=2)
e1 = await edit("sub/demo.txt", "beta", "BETA")
e_batch = await edit("sub/demo.txt", edits=[
    {"old_string": "alpha", "new_string": "ALPHA"},
    {"old_string": "ALPHA\\nBETA", "new_string": "TOP\\nMID"},
])
g_files = await glob("*.txt")
g_hits = await grep("MID", include="*.txt")
(w.lines, r.lines[0].number, r.text, e_batch.applied, g_files.paths, g_hits.matches[0].lineNumber)
''',
            cwd=self.workspace,
        )
        self.assertEqual(res["status"], "ok", res)
        self.assertEqual(
            res["result"],
            repr((4, 2, "beta\ngamma", 2, ["sub/demo.txt"], 2)),
        )
        # System tools stay invisible to repl.vars() and snapshots.
        self.assertEqual((await manager.run_code("repl.vars()"))["result"], "['e1', 'e_batch', 'g_files', 'g_hits', 'r', 'w']")

    async def test_batch_edit_rehearsal_rejects_atomically_with_tool_call_error(self) -> None:
        manager = self.new_manager()
        target = self.workspace / "atomic.txt"
        target.write_text("one\ntwo\nthree\n", encoding="utf-8")
        res = await manager.run_code(
            '''
try:
    await edit("atomic.txt", edits=[
        {"old_string": "one", "new_string": "ONE"},
        {"old_string": "missing", "new_string": "NOPE"},
    ])
    err = None
except ToolCallError as exc:
    err = (exc.toolName, str(exc))
err
''',
            cwd=self.workspace,
        )
        self.assertEqual(res["status"], "ok", res)
        self.assertIn("'edit'", res["result"])
        self.assertIn("batch rejected", res["result"])
        self.assertEqual(target.read_text(encoding="utf-8"), "one\ntwo\nthree\n")

    async def test_parallel_bash_timeout_and_helpers_introspection(self) -> None:
        manager = self.new_manager()
        res = await manager.run_code(
            '''
def summarize(items):
    """Count non-empty entries."""
    return len([x for x in items if x])

a, b = await asyncio.gather(
    bash("printf 'hi\\\\n'", "greet"),
    bash({"command": "cat", "stdin": "from-stdin"}),
)
try:
    timed = await bash("sleep 5", timeout_ms=80)
except Exception as exc:
    timed = str(exc)

helpers = await repl.helpers()
sz = await repl.size([1, 2, 3])
read = "shadowed"
restored = await repl.restore_binding("read")
(a.exitCode, a.stdout.text.strip(), b.stdout.text, timed.timedOut, [h["name"] for h in helpers], sz, restored["restored"], callable(read))
''',
            cwd=self.workspace,
        )
        self.assertEqual(res["status"], "ok", res)
        self.assertEqual(
            res["result"],
            repr((0, "hi", "from-stdin", True, ["summarize"], "list, len=3", "read", True)),
        )

    async def cell(self, manager: KernelManager, code: str) -> str:
        reply = await manager.run_code(code, cwd=self.workspace)
        self.assertEqual(reply["status"], "ok", reply)
        return reply["result"]

    async def assert_cell_value(self, manager: KernelManager, code: str, expected: object) -> None:
        self.assertEqual(await self.cell(manager, code), repr(expected))

    async def test_bare_file_results_display_and_retain_actual_data(self) -> None:
        manager = self.new_manager()
        preview = await self.cell(manager, r'''p = Path("docs/n.txt")
await write(p, "first\r\n\r\nthird\nlast\n")''')
        self.assertIn("operation=create", preview)
        self.assertNotIn("third", preview)
        self.assertEqual(await self.cell(manager, "(_.before, _.after.count('\\n'), _.lines)"), "(None, 4, 4)")
        preview = await self.cell(manager, "await read(p, offset=2, limit=2)")
        self.assertIn("2: \n3: third", preview)
        self.assertIn("offset=4", preview)
        self.assertEqual(await self.cell(manager, "(_.lines[0].number, _['text'], _.truncated)"), repr((2, "\nthird", True)))
        preview = await self.cell(manager, "await edit(p, 'third', 'THIRD')")
        self.assertIn("edit", preview)
        self.assertEqual(await self.cell(manager, "(Path(_.path) == p.resolve(), _.before != _.after)"), "(True, True)")
        preview = await self.cell(manager, "await edit(p, edits=["
                                           "dict(old_string='last', new_string='END'), "
                                           "dict(old_string='END', new_string='DONE')])")
        self.assertIn("applied=2", preview)
        self.assertNotIn("DONE", preview)
        self.assertEqual(await self.cell(manager, "(_.results[0].after == _.results[1].before, _.results[1].replacements)"), "(True, 1)")
        self.assertEqual((self.workspace / "docs/n.txt").read_bytes(), b"first\r\n\r\nTHIRD\nDONE\n")
        self.assertIn("operation=update", await self.cell(manager, "await write(p, '')"))
        self.assertIn("of 0", await self.cell(manager, "await read(p)"))

    async def test_read_counts_file_lines_and_distinguishes_empty_from_failure(self) -> None:
        path = self.workspace / "lines"
        path.write_bytes(("a\rb\r\nc\u2028d\n" + "x\n" * 1999).encode())
        manager = self.new_manager()
        (self.workspace / "alias").symlink_to(path)
        await self.assert_cell_value(
            manager, "p = Path('alias')\nr = await read(p)\n"
                     "(r.path, r.totalLines, len(r.lines), r.lines[0].text, r.lines[1].text)",
            (str(path), 2001, 2000, "a\rb", "c\u2028d"),
        )
        self.assertIn("2001: x", await self.cell(manager, "await read(p, offset=r.lines[-1].number + 1)"))
        for code, error in [
            ("await read(p, offset=2002)", "range"),
            ("await read(p.parent)", "directory"),
            ("await read(Path('absent'))", "exist"),
        ]:
            res = await manager.run_code(code, cwd=self.workspace)
            self.assertEqual(res["error"]["ename"], "ToolCallError")
            self.assertIn(error, res["error"]["evalue"])
        path.write_bytes(b"bin\0ary")
        res = await manager.run_code("await read(p)", cwd=self.workspace)
        self.assertIn("binary", res["error"]["evalue"])

    async def test_search_paths_scopes_and_exact_limit_in_actual_cells(self) -> None:
        manager = self.new_manager()
        docs = self.workspace / "docs"
        for name in ("one.txt", "deep/two.txt", "deep/code.py", ".private/secret.txt", ".venv/dep.txt", "node_modules/pkg.txt"):
            path = docs / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("token\n", encoding="utf-8")
        preview = await self.cell(manager, "d = Path('docs')\nawait glob('docs/*.txt', d)")
        self.assertIn("docs/one.txt", preview)
        self.assertNotIn("deep", preview)
        all_text = ["docs/.private/secret.txt", "docs/deep/two.txt", "docs/one.txt"]
        await self.assert_cell_value(manager, "r = await glob('docs/**/*.txt', d)\nsorted(r.paths)", all_text)
        await self.assert_cell_value(
            manager, "r = await glob('**/node_modules/*.txt', d)\n(r.paths, (await read(r.paths[0])).text)",
            (["docs/node_modules/pkg.txt"], "token"),
        )
        preview = await self.cell(manager, "await glob('*.txt', d, limit=1)")
        self.assertIn("INCOMPLETE", preview)
        self.assertEqual(await self.cell(manager, "(_.total, _.truncated)"), "(3, True)")
        self.assertEqual(await self.cell(manager, "r = await glob('one.txt', d, limit=1)\nr.truncated"), "False")
        preview = await self.cell(manager, "await grep('token', d, include='*.txt')")
        self.assertIn("docs/one.txt:1: token", preview)
        await self.assert_cell_value(manager, "sorted(m.path for m in _.matches)", ["docs/deep/two.txt", "docs/one.txt"])
        await self.assert_cell_value(
            manager, "r = await grep('token', d, scope='all', include='*.txt')\nsorted(m.path for m in r.matches)",
            all_text,
        )
        await self.assert_cell_value(
            manager, "r = await grep('TOKEN', d, scope='all', include='**/.venv/*.txt', case_sensitive=False)\n"
                     "(r.matches[0].path, (await read(r.matches[0].path)).text)",
            ("docs/.venv/dep.txt", "token"),
        )
        await self.assert_cell_value(manager, "r = await grep('token', d / 'node_modules', scope='all')\nlen(r.matches)", 1)
        preview = await self.cell(manager, "await grep('token', d, limit=1)")
        self.assertIn("INCOMPLETE", preview)
        preview = await self.cell(manager, "await grep('token', d / 'one.txt', limit=1)")
        self.assertNotIn("INCOMPLETE", preview)
        self.assertIn("0 matches", await self.cell(manager, "await grep('absent', d, scope='all')"))
        self.assertIn("0 paths", await self.cell(manager, "await glob('absent', d)"))

    async def test_bash_named_arguments_timeout_and_failures_at_call_site(self) -> None:
        manager = self.new_manager()
        (self.workspace / "job").mkdir()
        preview = await self.cell(manager, r'''d = Path('job')
await bash("[[ -n $BASH_VERSION ]] || exit 3; pwd; cat; printf err >&2; exit 7", workdir=d, stdin="raw $word\nlast", run_in_background=False)''')
        self.assertIn("exitCode=7", preview)
        self.assertIn("[stderr]\nerr", preview)
        await self.assert_cell_value(
            manager, "(_.kind, Path(_.cwd) == d.resolve(), _.stdout.text.splitlines(), _.stderr.text)",
            ("foreground", True, [str(self.workspace / "job"), "raw $word", "last"], "err"),
        )
        await self.assert_cell_value(
            manager, "os.environ['WORDS'] = 'parent'\n"
                     "r = await bash('printf %s \"$WORDS\"', cwd=d, env={'WORDS': 'mixed words'})\n"
                     "empty = await bash('printf %s \"$WORDS\"', env={'WORDS': None})\n"
                     "(r.stdout.text, empty.stdout.text, os.environ['WORDS'])",
            ("mixed words", "", "parent"),
        )
        preview = await self.cell(manager, "await bash('printf early; printf note >&2; sleep 5', timeoutMs=150)")
        self.assertIn("TIMED OUT", preview)
        self.assertIn("early", preview)
        self.assertIn("note", preview)
        self.assertEqual(await self.cell(manager, "(_.timedOut, _.exitCode, _.signal)"), "(True, None, 'SIGKILL')")
        self.assertIn("no output", await self.cell(manager, "await bash('true')"))
        for options in ("run_in_background=True", "typo=True", "cwd=d, workdir=d", "timeout_ms=10, timeoutMs=20", "env=[]"):
            res = await manager.run_code(f"await bash('touch started', {options})", cwd=self.workspace)
            self.assertEqual(res["status"], "error", (options, res))
        self.assertFalse((self.workspace / 'started').exists())

    @unittest.skipUnless(shutil.which("rg"), "requires ripgrep")
    async def test_normal_scope_ignores_user_ripgrep_configuration(self) -> None:
        manager = self.new_manager()
        for name in ("visible.txt", "ignored.txt", ".hidden.txt"):
            (self.workspace / name).write_text("needle\n", encoding="utf-8")
        (self.workspace / ".ignore").write_text("ignored.txt\n", encoding="utf-8")
        (self.workspace / "rg-options").write_text("--hidden\n--no-ignore\n", encoding="utf-8")
        preview = await self.cell(manager, "os.environ['RIPGREP_CONFIG_PATH'] = str(Path('rg-options').resolve())\n"
                                           "await grep('needle')")
        self.assertIn("visible.txt:1: needle", preview)
        self.assertNotIn(".hidden.txt", preview)
        self.assertNotIn("ignored.txt", preview)

    async def test_search_errors_show_partial_coverage_and_keep_the_matches(self) -> None:
        manager = self.new_manager()
        (self.workspace / "ok.txt").write_text("visible\n", encoding="utf-8")
        for name in ("denied", ".venv/denied", "node_modules/denied"):
            directory = self.workspace / name
            directory.mkdir(parents=True)
            (directory / "inside.txt").write_text("visible\n", encoding="utf-8")
            directory.chmod(0)
            self.addCleanup(directory.chmod, 0o700)
        if os.access(self.workspace / "denied", os.R_OK):
            self.skipTest("This account can read mode-000 directories")
        for code in ("await glob('*.txt')", "await grep('visible', scope='all')"):
            preview = await self.cell(manager, code)
            self.assertIn("INCOMPLETE", preview)
            self.assertIn("ok.txt", preview)
            self.assertIn("denied", preview)
            self.assertEqual(await self.cell(manager, "[Path(e.path).name for e in _.unreadable]"), repr(["denied"]))
        preview = await self.cell(manager, "await grep('absent', scope='all')")
        self.assertIn("0 matches", preview)
        self.assertIn("INCOMPLETE", preview)
        response = await manager.run_code("await grep('[')", cwd=self.workspace)
        self.assertEqual(response["error"]["ename"], "ToolCallError")

    async def test_grep_without_ripgrep_handles_files_but_reports_unsupported_ignore_rules(self) -> None:
        grep = create_builtin_tools()["grep"]
        (self.workspace / "source.txt").write_text("a.b\na?b\n", encoding="utf-8")
        (self.workspace / ".ignore").write_text("source.txt\n", encoding="utf-8")
        with patch("agy_python_repl.builtin_tools.shutil.which", return_value=None):
            with self.assertRaisesRegex(ToolCallError, "ignore files require"):
                await grep("a.b", self.workspace)
            result = await grep("A.B", self.workspace, include="*.txt", scope="all", fixed_strings=True,
                                case_sensitive=False, limit=1)
            self.assertFalse(result.outputCapped)
            self.assertEqual([(m.lineNumber, m.line) for m in result.matches], [(1, "a.b")])
            result = await grep("a.b", self.workspace / "source.txt", limit=1)
            self.assertTrue(result.outputCapped)

    async def test_bash_large_output_separates_display_from_retained_bytes(self) -> None:
        manager = self.new_manager()
        preview = await self.cell(manager, "await bash(\"printf '%04200000d' 0; printf one >&2\")")
        self.assertIn("stdout truncated", preview)
        self.assertIn("[stderr]\none", preview)
        self.assertLess(len(preview), 5000)
        data = await self.cell(manager, "r = _\n(r.exitCode, len(r.stdout.text), r.stdout.truncated, r.stderr.truncated)")
        self.assertEqual(data, repr((0, 4 * 1024 * 1024, True, False)))
        await self.assert_cell_value(manager, "p = Path(r.stdout.spillPath)\n"
                                              "(p.read_bytes() == b'0' * 4_200_000, 'spillPath' in r.stderr)", (True, False))
        (saved,) = self.data.rglob("bash-stdout-*.bin")
        self.assertIn(str(saved), preview)

    async def test_bash_capture_boundary_full_binary_files_and_unique_paths(self) -> None:
        limit = 4 * 1024 * 1024
        capture_dir = self.data / "overflow"
        bash = create_builtin_tools(capture_dir=capture_dir)["bash"]
        out = bytes(range(256)) * (limit // 256)
        err = bytes(reversed(range(256))) * (limit // 256)
        out_file, err_file = self.workspace / "out", self.workspace / "err"
        out_file.write_bytes(out)
        err_file.write_bytes(err[:-1])
        command = "cat out; cat err >&2; exit 7"
        result = await bash(command, workdir=self.workspace)
        self.assertEqual(result.exitCode, 7)
        self.assertFalse(result.stdout.truncated or result.stderr.truncated)
        self.assertNotIn("spillPath", result.stdout)
        self.assertFalse(capture_dir.exists())

        out += b"\xff"
        err += bytes(range(256)) * 3072 + b"\x00end\r\n\x80"
        out_file.write_bytes(out)
        err_file.write_bytes(err)
        results = await asyncio.gather(*(bash(command, workdir=self.workspace) for _ in range(2)))
        paths = set()
        for result in results:
            self.assertEqual(result.exitCode, 7)
            view = repr(result)
            for name, expected in (("stdout", out), ("stderr", err)):
                stream = result[name]
                self.assertTrue(stream.truncated)
                self.assertEqual(stream.text, expected[:limit].decode("utf-8", errors="replace"))
                path = Path(stream.spillPath)
                self.assertTrue(path.is_absolute())
                self.assertEqual(path.parent, capture_dir)
                self.assertEqual(path.read_bytes(), expected)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(path, paths)
                self.assertIn(str(path), view[:1500])
                paths.add(path)
        self.assertEqual(set(capture_dir.iterdir()), paths)

    async def test_bash_capture_errors_keep_partial_preview_and_other_channel(self) -> None:
        directory = self.data / "captures"
        (self.workspace / "payload").write_bytes(b"x" * (4 * 1024 * 1024 + 1))
        bash = create_builtin_tools(capture_dir=directory)["bash"]
        open_capture = tempfile.NamedTemporaryFile

        def fail_write(**options):
            destination = open_capture(**options)
            if "stdout" in options["prefix"]:
                write = destination.write

                def write_partial(chunk):
                    write(chunk[:7])
                    raise OSError("fixture write failure")

                destination.write = write_partial
            return destination

        with patch("agy_python_repl.builtin_tools.tempfile.NamedTemporaryFile", side_effect=fail_write):
            result = await bash("cat payload; cat payload >&2; exit 3", workdir=self.workspace)
        self.assertEqual(result.exitCode, 3)
        self.assertTrue(result.stdout.truncated)
        self.assertIn("fixture write failure", result.stdout.spillError)
        self.assertIn("fixture write failure", repr(result))
        self.assertNotIn("spillPath", result.stdout)
        self.assertEqual(len(result.stdout.text), 4 * 1024 * 1024)
        self.assertEqual(Path(result.stderr.spillPath).read_bytes(), (self.workspace / "payload").read_bytes())
        self.assertEqual(list(directory.iterdir()), [Path(result.stderr.spillPath)])

        for location in (None, self.workspace / "payload"):
            local_bash = create_builtin_tools(capture_dir=location)["bash"]
            result = await local_bash("cat payload", workdir=self.workspace)
            self.assertTrue(result.stdout.truncated)
            self.assertNotIn("spillPath", result.stdout)
            self.assertTrue(result.stdout.spillError)
            self.assertIn(result.stdout.spillError, repr(result))
            self.assertFalse(result.stderr.truncated)

    async def test_cancel_during_second_stream_removes_unreturned_captures(self) -> None:
        directory = self.data / "captures"
        bash = create_builtin_tools(capture_dir=directory)["bash"]
        (self.workspace / "payload").write_bytes(b"x" * (4 * 1024 * 1024 + 1))
        open_capture = tempfile.NamedTemporaryFile

        def cancel_on_stderr(**options):
            destination = open_capture(**options)
            if "stderr" in options["prefix"]:
                asyncio.get_running_loop().call_soon(running.cancel)
            return destination

        with patch("agy_python_repl.builtin_tools.tempfile.NamedTemporaryFile", side_effect=cancel_on_stderr):
            running = asyncio.create_task(bash("cat payload; cat payload >&2", workdir=self.workspace))
            with self.assertRaises(asyncio.CancelledError):
                await running
        self.assertEqual(list(directory.iterdir()), [])

    async def test_bash_timeout_saves_all_bytes_emitted_before_termination(self) -> None:
        directory = self.data / "captures"
        bash = create_builtin_tools(capture_dir=directory)["bash"]
        payload = b"prefix\x00" * 600000
        (self.workspace / "payload").write_bytes(payload)
        result = await bash("cat payload; printf ready >&2; sleep 5", workdir=self.workspace, timeoutMs=400)
        self.assertTrue(result.timedOut)
        self.assertEqual(result.signal, "SIGKILL")
        self.assertEqual(result.stderr.text, "ready")
        self.assertNotIn("spillPath", result.stderr)
        self.assertEqual(Path(result.stdout.spillPath).read_bytes(), payload)
