"""Look up discovered skill instructions in a real AGY kernel."""

from __future__ import annotations

import ast
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agy_python_repl.manager import KernelManager


class SkillLookupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.first = self.root / "first"
        self.second = self.root / "second"
        self.project = self.root / "project-skills"
        self.manager = KernelManager(
            data_dir=self.root / "data", skill_roots=[self.first, self.second],
            project_skill_roots=[self.project], auto_snapshot=False,
        )
        self.addAsyncCleanup(self.manager.shutdown_all)

    def add_skill(self, root: Path, *, name: str = "fixture-reader", code: str = "answer = 42") -> Path:
        skill = root / name
        package = skill / "src" / name.replace("-", "_")
        package.mkdir(parents=True)
        (package / "__init__.py").write_text(code, encoding="utf-8")
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Fixture\n---\nShell instructions\n", encoding="utf-8"
        )
        selected = skill / "PYSKILL.md"
        selected.write_text(f"---\nname: {name}\ndescription: Fixture\n---\nPython instructions\n", encoding="utf-8")
        return selected

    async def cell(self, code: str) -> dict:
        return await self.manager.run_code(code, cwd=self.root)

    async def test_listed_name_and_import_name_read_the_same_project_instructions(self) -> None:
        self.add_skill(self.first)
        project_doc = self.add_skill(self.project)
        result = await self.cell(
            "entry = next(s for s in await skills.list() if s['name'] == 'fixture-reader')\n"
            "from_name = await skills.describe(entry['name'])\n"
            "from_import = await skills.describe(import_name=entry['import_name'])\n"
            "(from_name == from_import, from_name['import_name'], from_name['doc_path'], from_name['documentation'])"
        )
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(ast.literal_eval(result["result"]), (
            True, "fixture_reader", str(project_doc), project_doc.read_text(encoding="utf-8"),
        ))

    async def test_invalid_python_documents_keep_their_errors_without_importing_modules(self) -> None:
        broken = {
            "changed": (b"---\nname: another-skill\ndescription: Valid summary\n---\n", "name must remain"),
            "blank": (b"---\ndescription: '  '\n---\n", "non-empty description"),
            "null": (b"---\nname: null\ndescription: Valid summary\n---\n", "name must remain"),
            "boolean": (b"---\ndescription: true\n---\n", "non-empty description"),
            "mapping": (b"---\ndescription: {nested: value}\n---\n", "non-empty description"),
            "syntax": (b"---\ndescription: [unfinished\n---\n", "YAML"),
            "duplicate": (b"---\ndescription: One\ndescription: Two\n---\n", "YAML"),
            "encoding": (b"---\ndescription: \xff\n---\n", "utf-8"),
            "link": (None, "No such file"), "directory": (None, "regular file"),
        }
        for label, (contents, _) in broken.items():
            selected = self.add_skill(self.project, name=f"fixture-{label}", code=(
                f"from pathlib import Path\nPath({str(self.root / label)!r}).touch()"
            ))
            if contents is not None:
                selected.write_bytes(contents)
            else:
                selected.unlink()
                if label == "link":
                    selected.symlink_to("missing.md")
                else:
                    selected.mkdir()
        self.add_skill(self.first, name="fixture-changed", code="raise AssertionError('shadowed skill ran')")
        valid = self.add_skill(self.first, name="fixture-valid")
        valid.write_bytes(b"\xef\xbb\xbf---\r\ndescription: >-\r\n  Python skill\r\n  summary\r\n---\r\nPython body")
        fallback = self.add_skill(self.first, name="fixture-fallback")
        fallback.unlink()
        plain_date = self.add_skill(self.first, name="fixture-date")
        plain_date.write_text("---\ndescription: 2025-01-01\n---\n")
        tagged = self.add_skill(self.first, name="fixture-scalar")
        tagged.write_text("---\ndescription: !!bool yes\n---\n")
        rows = await self.cell("{r['name']: (r['status'], r['description'], r.get('error')) for r in await skills.list()}")
        self.assertEqual(rows["status"], "ok", rows)
        listed = ast.literal_eval(rows["result"])
        for label, (_, reason) in broken.items():
            name = f"fixture-{label}"
            with self.subTest(skill=name):
                status, _, message = listed[name]
                self.assertEqual(status, "failed")
                self.assertIn(str(self.project / name / "PYSKILL.md"), message)
                self.assertIn(reason, message)
                self.assertFalse((self.root / label).exists())
        self.assertEqual(listed["fixture-valid"], ("loaded", "Python skill summary", None))
        self.assertEqual(listed["fixture-fallback"], ("loaded", "Fixture", None))
        self.assertEqual(listed["fixture-date"], ("loaded", "2025-01-01", None))
        self.assertEqual(listed["fixture-scalar"], ("loaded", "yes", None))
        docs = await self.cell("(skills.fixture_valid.answer, (await skills.describe('fixture-fallback'))['doc_path'])")
        self.assertEqual(ast.literal_eval(docs["result"]), (42, str(fallback.with_name("SKILL.md"))))
        for name in ("fixture-changed", "fixture_changed"):
            failure = await self.cell(f"await skills.describe({name!r})")
            self.assertIn("name must remain", failure["error"]["evalue"])
        self.assertIn("fixture_changed", self.manager.get_overview()["kernels"][0]["skills_failed"])

    async def test_wrong_standard_instructions_and_document_retry_keep_other_cells_usable(self) -> None:
        preferred = self.add_skill(self.project, code="from pathlib import Path\nPath('imported').touch()\nvalue=11")
        preferred.unlink()
        standard = preferred.with_name("SKILL.md")
        standard.write_bytes(b"---\ndescription: \xff\n---\n")
        self.add_skill(self.first, name="fixture-healthy")
        response = await self.cell("number=7\n(skills.fixture_healthy.answer, number, "
                                   "next(r['error'] for r in await skills.list() if r['name']=='fixture-reader'))")
        self.assertEqual(response["status"], "ok", response)
        healthy, original, error = ast.literal_eval(response["result"])
        self.assertEqual((healthy, original), (42, 7))
        self.assertIn(str(standard), error)
        standard.write_text("---\nname: fixture-reader\ndescription: Corrected\n---\n")
        for name in ("fixture-reader", "fixture_reader"):
            failed = await self.cell(f"await skills.retry({name!r})")
            self.assertEqual(failed["error"]["ename"], "ValueError")
            self.assertIn("new kernel", failed["error"]["evalue"])
            self.assertIn(str(standard), failed["error"]["evalue"])
        restarted = await self.manager.kernel_state("restart")
        self.assertEqual(restarted["status"], "ok", restarted)
        self.assertEqual((await self.cell("number"))["result"], "7")
        self.assertFalse((self.root / "imported").exists())
        await self.manager.shutdown_all()
        self.manager.auto_snapshot = True
        fresh = await self.cell("(skills.fixture_reader.value, number)")
        self.assertEqual(ast.literal_eval(fresh["result"]), (11, 7))
        self.assertTrue((self.root / "imported").exists())

    async def test_only_names_recorded_for_the_loaded_skill_match(self) -> None:
        self.add_skill(self.first, name="fixture_reader")
        result = await self.cell("await skills.describe('fixture-reader')")
        self.assertEqual(result["error"]["ename"], "KeyError")
        self.assertIn("Unknown skill", result["error"]["evalue"])

    async def test_colliding_display_names_never_select_a_document(self) -> None:
        self.add_skill(self.first)
        self.add_skill(self.second, name="fixture_reader")
        for target in ("fixture-reader", "fixture_reader"):
            with self.subTest(target=target):
                result = await self.cell(f"await skills.describe({target!r})")
                self.assertEqual(result["error"]["ename"], "KeyError")
                self.assertIn("duplicate", result["error"]["evalue"].lower())
                self.assertIn(target, result["error"]["evalue"])

    async def test_failed_import_retains_its_reason_for_both_names(self) -> None:
        self.add_skill(self.first, code="raise RuntimeError('fixture initialization failed')")
        for target in ("fixture-reader", "fixture_reader"):
            with self.subTest(target=target):
                result = await self.cell(f"await skills.describe({target!r})")
                self.assertEqual(result["error"]["ename"], "KeyError")
                self.assertIn("RuntimeError: fixture initialization failed", result["error"]["evalue"])

    async def test_retry_updates_this_kernel_and_its_host_after_a_dependency_appears(self) -> None:
        selected = self.add_skill(self.project, code=(
            "from fixture_first_dependency import value\nfrom fixture_second_dependency import extra\n"
            "def answer(): return value + extra"
        ))
        self.add_skill(self.first, code="raise AssertionError('shadowed global skill ran')")
        self.add_skill(self.first, name="fixture-other", code="import fixture_untouched_dependency")
        initial = await self.cell(
            "marker = object()\nmarker_id = id(marker)\n"
            "next(row for row in await skills.list() if row['name'] == 'fixture-reader')"
        )
        self.assertEqual(initial["status"], "ok", initial)
        row = ast.literal_eval(initial["result"])
        self.assertEqual(row["status"], "failed")
        self.assertIn("fixture_first_dependency", row["error"])

        source = selected.parent / "src"
        (source / "fixture_first_dependency.py").write_text("value = 40", encoding="utf-8")
        still_missing = await self.cell("await skills.retry('fixture-reader')")
        self.assertEqual(still_missing["error"]["ename"], "ModuleNotFoundError")
        self.assertIn("fixture_second_dependency", still_missing["error"]["evalue"])
        overview = self.manager.get_overview()["kernels"][0]
        self.assertIn("fixture_second_dependency", overview["skills_failed"]["fixture_reader"])
        self.assertIn("fixture_other", overview["skills_failed"])
        failed = await self.cell("await skills.describe('fixture_reader')")
        self.assertIn("fixture_second_dependency", failed["error"]["evalue"])

        (source / "fixture_second_dependency.py").write_text("extra = 2", encoding="utf-8")
        (source / "fixture_untouched_dependency.py").touch()
        result = await self.cell(
            "retry_alias = skills.retry\nretry_result = await retry_alias('fixture_reader')\n"
            "raise RuntimeError('after retry')"
        )
        self.assertEqual(result["error"]["evalue"], "after retry")
        state = (await self.manager.kernel_state("list"))["active_kernels"][0]
        self.assertIn("fixture_reader", state["skills_loaded"])
        self.assertEqual(set(state["skills_failed"]), {"fixture_other"})
        overview = self.manager.get_overview()["kernels"][0]
        self.assertEqual(overview["skills_loaded"], state["skills_loaded"])
        self.assertEqual(overview["skills_failed"], state["skills_failed"])
        usable = await self.cell(
            "row = next(row for row in await skills.list() if row['name'] == 'fixture-reader')\n"
            "(retry_result, row['status'], id(marker) == marker_id, skills.fixture_reader.answer(), "
            "(await skills.describe('fixture-reader'))['doc_path'])"
        )
        self.assertEqual(ast.literal_eval(usable["result"]), (
            {"import_name": "fixture_reader", "status": "loaded"}, "loaded", True, 42, str(selected),
        ))
        again = await self.cell(
            "skills.fixture_reader.answer = lambda: 99\n"
            "((await skills.retry('fixture-reader'))['status'], skills.fixture_reader.answer())"
        )
        self.assertEqual(ast.literal_eval(again["result"]), ("already_loaded", 99))

    async def test_cancelling_the_cell_after_retry_keeps_the_host_in_sync(self) -> None:
        selected = self.add_skill(self.first, code="import fixture_dependency\nanswer = 42")
        await self.cell("pass")
        (selected.parent / "src" / "fixture_dependency.py").touch()
        running = asyncio.create_task(self.cell(
            "import asyncio\nawait skills.retry('fixture-reader')\n"
            "Path('retried').touch()\nawait asyncio.sleep(60)"
        ))
        try:
            async with asyncio.timeout(5):
                while not (self.root / "retried").exists():
                    await asyncio.sleep(0.01)
            self.assertFalse(running.done())
        finally:
            running.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await running
        self.assertEqual((await self.cell("skills.fixture_reader.answer"))["result"], "42")
        overview = self.manager.get_overview()["kernels"][0]
        self.assertIn("fixture_reader", overview["skills_loaded"])
        self.assertNotIn("skills_failed", overview)

    async def test_late_retry_updates_only_the_kernel_that_emitted_it(self) -> None:
        selected = self.add_skill(self.first, code="import fixture_dependency")
        await self.cell("pass")
        await self.manager.run_code("pass", kernel="other", cwd=self.root)
        (selected.parent / "src" / "fixture_dependency.py").touch()
        scheduled = await self.cell(
            "import asyncio\n"
            "async def later():\n"
            "    while not Path('release').exists():\n        await asyncio.sleep(0.01)\n"
            "    await skills.retry('fixture-reader')\n"
            "background = asyncio.create_task(later())"
        )
        self.assertEqual(scheduled["status"], "ok", scheduled)
        (self.root / "release").touch()
        async with asyncio.timeout(5):
            while True:
                kernels = {k["name"]: k for k in self.manager.get_overview()["kernels"]}
                if "fixture_reader" in kernels["default"]["skills_loaded"]:
                    break
                await asyncio.sleep(0.01)
        self.assertIn("fixture_reader", kernels["other"]["skills_failed"])

    async def test_display_observer_errors_leave_the_kernel_and_receipt_usable(self) -> None:
        await self.cell("pass")
        client = self.manager._kernels["default"].client
        def bad_observer(display):
            raise ValueError("observer failed")

        client.on_display = bad_observer
        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "call_exception_handler") as reported:
            receipt = await client.execute("from rlm.repl import emit\nemit({'text/plain': 'fixture'})\n42")
        self.assertEqual(str(reported.call_args.args[0]["exception"]), "observer failed")
        self.assertEqual(receipt.displays, [{"text/plain": "fixture"}])
        self.assertEqual(receipt.result, "42")
        self.assertEqual((await self.cell("6 * 7"))["result"], "42")

    async def test_retry_only_selects_previously_discovered_unique_names(self) -> None:
        self.add_skill(self.first)
        self.add_skill(self.second, name="fixture_reader")
        self.add_skill(self.first, name="strict_name", code="import fixture_missing_dependency")
        await self.cell("pass")
        self.add_skill(self.first, name="added-later", code="raise AssertionError('new skill executed')")
        for name, diagnostic in (("fixture-reader", "duplicate"), ("fixture_reader", "duplicate"),
                                 ("strict-name", "Unknown"), ("added-later", "Unknown")):
            with self.subTest(name=name):
                result = await self.cell(f"await skills.retry({name!r})")
                self.assertEqual(result["error"]["ename"], "KeyError", result)
                self.assertIn(diagnostic, result["error"]["evalue"])

    async def test_retry_keeps_the_original_target_of_a_linked_source(self) -> None:
        selected = self.add_skill(self.first, code="import fixture_dependency\nanswer = 42")
        linked_source = selected.parent / "src"
        original = self.root / "original-source"
        linked_source.rename(original)
        linked_source.symlink_to(original, target_is_directory=True)
        await self.cell("pass")
        replacement = self.add_skill(self.second, name="replacement")
        (replacement.parent / "src" / "replacement").rename(replacement.parent / "src" / "fixture_reader")
        linked_source.unlink()
        linked_source.symlink_to(replacement.parent / "src", target_is_directory=True)
        (original / "fixture_dependency.py").touch()
        result = await self.cell(
            "await skills.retry('fixture-reader')\nPath(skills.fixture_reader.__file__).parent"
            ".relative_to(Path.cwd()).as_posix()"
        )
        self.assertEqual(ast.literal_eval(result["result"]), "original-source/fixture_reader")

    async def test_retry_never_executes_a_namesake_outside_the_selected_source(self) -> None:
        selected = self.add_skill(self.first, code="import fixture_missing_dependency")
        await self.cell("pass")
        (selected.parent / "src" / "fixture_reader" / "__init__.py").unlink()
        (self.root / "fixture_reader.py").write_text(
            "from pathlib import Path\nPath('wrong-source-ran').touch()", encoding="utf-8"
        )
        result = await self.cell("await skills.retry('fixture-reader')")
        self.assertEqual(result["error"]["ename"], "ImportError", result)
        self.assertIn(str(selected.parent / "src"), result["error"]["evalue"])
        self.assertFalse((self.root / "wrong-source-ran").exists())

    async def test_selected_python_instructions_become_unreadable(self) -> None:
        selected = self.add_skill(self.first)
        ok = await self.cell("(await skills.describe('fixture_reader'))['documentation']")
        self.assertIn("Python instructions", ok["result"])
        selected.unlink()
        missing = await self.cell("await skills.describe('fixture_reader')")
        self.assertEqual(missing["error"]["ename"], "RuntimeError")
        self.assertIn(str(selected), missing["error"]["evalue"])
        selected.write_bytes(b"\xff")
        invalid = await self.cell("await skills.describe('fixture-reader')")
        self.assertEqual(invalid["error"]["ename"], "RuntimeError")
        self.assertIn(str(selected), invalid["error"]["evalue"])
