"""Look up discovered skill instructions in a real AGY kernel."""

from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

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
