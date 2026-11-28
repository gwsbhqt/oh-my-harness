"""Tests for the generic `skills.*` namespace loader and import guard."""

from __future__ import annotations

import asyncio
import builtins
import sys
import tempfile
import unittest
from pathlib import Path

from python_repl_core.skills_runtime import _SkillsNamespace, install_skills_import_guard


class SkillsImportGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_import = builtins.__import__
        self._orig_path = list(sys.path)
        self._orig_modules = set(sys.modules)
        self.addCleanup(self._restore_env)

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

        pkg = self.root / "fixture-reader" / "src" / "fixture_reader"
        sub = pkg / "nested"
        sub.mkdir(parents=True)
        (pkg / "__init__.py").write_text("ANSWER = 42\n", encoding="utf-8")
        (sub / "__init__.py").write_text("VALUE = 99\n", encoding="utf-8")
        (self.root / "fixture-reader" / "PYSKILL.md").write_text("# fixture-reader\n", encoding="utf-8")

        self.skills_ns = _SkillsNamespace()
        report = self.skills_ns._register_all([
            {
                "name": "fixture-reader",
                "import_name": "fixture_reader",
                "description": "Fixture",
                "directory": str(self.root / "fixture-reader"),
                "source_root": str(self.root / "fixture-reader" / "src"),
                "doc_path": str(self.root / "fixture-reader" / "PYSKILL.md"),
                "is_project": False,
            }
        ])
        self.assertEqual(report["failed"], {})
        self.ns: dict = {"__builtins__": builtins, "skills": self.skills_ns}
        install_skills_import_guard(self.ns, self.skills_ns)

    def _restore_env(self) -> None:
        builtins.__import__ = self._orig_import
        sys.path[:] = self._orig_path
        for name in list(sys.modules):
            if name not in self._orig_modules:
                sys.modules.pop(name, None)

    def test_supports_bare_from_and_dotted_skill_imports(self) -> None:
        exec("import skills", self.ns)
        self.assertIs(self.ns["skills"], self.skills_ns)

        exec("import skills.fixture_reader", self.ns)
        self.assertEqual(self.ns["skills"].fixture_reader.ANSWER, 42)

        exec("import skills.fixture_reader as reader", self.ns)
        self.assertEqual(self.ns["reader"].ANSWER, 42)

        exec("from skills import fixture_reader", self.ns)
        self.assertEqual(self.ns["fixture_reader"].ANSWER, 42)

        exec("from skills.fixture_reader import ANSWER", self.ns)
        self.assertEqual(self.ns["ANSWER"], 42)

        exec("import skills.fixture_reader.nested as nested", self.ns)
        self.assertEqual(self.ns["nested"].VALUE, 99)

        exec("from skills.fixture_reader.nested import VALUE", self.ns)
        self.assertEqual(self.ns["VALUE"], 99)

        exec("from skills.fixture_reader import nested as nested2", self.ns)
        self.assertEqual(self.ns["nested2"].VALUE, 99)

    def test_missing_skill_or_attribute_raises_standard_import_errors(self) -> None:
        with self.assertRaises(ModuleNotFoundError):
            exec("import skills.missing_skill", self.ns)

        with self.assertRaises(ModuleNotFoundError):
            exec("from skills.missing_skill import x", self.ns)

        with self.assertRaises(ImportError):
            exec("from skills import missing_skill", self.ns)

        with self.assertRaises(ImportError):
            exec("from skills.fixture_reader import NOT_THERE", self.ns)


    def test_unknown_skill_points_to_the_kernel_catalog_and_project_directory(self) -> None:
        for lookup in (self.skills_ns.describe, self.skills_ns.retry):
            with self.subTest(lookup=lookup.__name__):
                with self.assertRaisesRegex(KeyError, "Unknown skill 'missing_skill'") as error:
                    asyncio.run(lookup("missing_skill"))
                self.assertIn("await skills.list()", str(error.exception))
                self.assertIn("project directory", str(error.exception))

        with self.assertRaisesRegex(AttributeError, "No Python skill named 'missing_skill'") as error:
            self.skills_ns.missing_skill
        self.assertIn("await skills.list()", str(error.exception))
        self.assertIn("project directory", str(error.exception))

    def test_known_name_returns_instructions_and_duplicate_keeps_its_own_error(self) -> None:
        result = asyncio.run(self.skills_ns.describe("fixture-reader"))
        self.assertEqual(result["documentation"], "# fixture-reader\n")

        first = self.skills_ns._entries["fixture_reader"]
        other = self.root / "another-location" / "fixture-reader"
        second = {
            **first,
            "directory": str(other),
            "source_root": str(other / "src"),
            "doc_path": str(other / "PYSKILL.md"),
        }
        duplicate = _SkillsNamespace()
        duplicate._register_all([first, second])
        with self.assertRaisesRegex(KeyError, "duplicate definitions") as error:
            asyncio.run(duplicate.describe("fixture-reader"))
        self.assertNotIn("await skills.list()", str(error.exception))


if __name__ == "__main__":
    unittest.main()
