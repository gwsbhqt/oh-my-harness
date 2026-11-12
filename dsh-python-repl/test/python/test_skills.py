"""Tests for skill loading.

Builds real skill directories on disk. `found` stands in for the host's
discovery (src/skill-discovery.ts, tested there): it lists what the host
would pass to the kernel.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import dsh_kernel  # noqa: E402
import skills as skills_mod  # noqa: E402


def write_skill(
    root: Path,
    name: str,
    *,
    import_name: str | None = None,
    body: str = "",
    description: str = "A test skill.",
    python_description: str | None = None,
) -> Path:
    """Create a skill directory in the real Prime layout."""
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n", encoding="utf-8"
    )
    if python_description is not None:
        (directory / "PYSKILL.md").write_text(
            f"---\nname: {name}\ndescription: {python_description}\n---\n\n# Python {name}\n",
            encoding="utf-8",
        )
    if import_name is not None:
        package = directory / "src" / import_name
        package.mkdir(parents=True)
        (package / "__init__.py").write_text(body, encoding="utf-8")
    return directory


def found(*roots: Path, without: tuple[str, ...] = ()) -> list[dict]:
    """Model host selection for valid fixture documents, not YAML validation."""
    entries = []
    for root in roots:
        if not root.is_dir():
            continue
        for directory in sorted(root.iterdir()):
            md = directory / "SKILL.md"
            if not md.is_file() or directory.name in without:
                continue
            src = directory / "src"
            packages = sorted(p.name for p in src.iterdir() if (p / "__init__.py").is_file()) if src.is_dir() else []
            selected = directory / "PYSKILL.md" if packages and (directory / "PYSKILL.md").is_file() else md
            description = re.search(r"^description: (.*)$", selected.read_text(encoding="utf-8"), re.M)
            entries.append({
                "skill": directory.name, "description": description.group(1) if description else "",
                "path": str(directory), "import_name": packages[0] if packages else None,
                "src": str(src) if packages else None,
                "instructions_file": selected.name,
                "status": "discovered" if packages else "docs-only",
            })
    return entries


class SkillLoading(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="dsh-skills-"))
        home = self.root / "home"
        home.mkdir()
        environment = mock.patch.dict(os.environ, {"HOME": str(home), "DSH_HOME": str(home / ".dsh")})
        environment.start()
        self.addCleanup(environment.stop)
        self.namespace = dsh_kernel._Namespace("skills")
        self._original_path = list(sys.path)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        sys.path[:] = self._original_path
        for name in ("good_skill", "dupe", "broken", "needs_prime", "uses_bridge", "dep_missing", "switched_off"):
            sys.modules.pop(name, None)

    def test_loads_a_plain_python_skill(self) -> None:
        write_skill(self.root, "good", import_name="good_skill", body="def run(x):\n    return x * 2\n")
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], ["good_skill"])
        self.assertEqual(self.namespace.good_skill.run(21), 42)

    def test_switched_off_skill_is_reported_and_never_imported(self) -> None:
        write_skill(self.root, "good", import_name="good_skill", body="def run(x):\n    return x\n")
        write_skill(self.root, "off", import_name="switched_off", body="raise RuntimeError('must not run')\n")
        report = skills_mod.load(found(self.root, without=("off",)), self.namespace, ["off"])
        self.assertEqual(report["loaded"], ["good_skill"])
        record = next(r for r in report["skills"] if r["skill"] == "off")
        self.assertEqual(record["status"], "disabled")
        self.assertNotIn("switched_off", sys.modules)
        self.assertEqual(report["failed"], [], "关掉的技能不算加载失败")

    def test_markdown_only_skill_is_reported_not_imported(self) -> None:
        write_skill(self.root, "docs", import_name=None)
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], [])
        record = next(r for r in report["skills"] if r["skill"] == "docs")
        self.assertEqual(record["status"], "docs-only")
        self.assertIn("instructions only", record["reason"])

    def test_docs_only_skill_points_at_tools_skill(self) -> None:
        write_skill(self.root, "cf-cli", import_name=None)
        namespace = skills_mod._SkillsNamespace()
        skills_mod.load(found(self.root), namespace)
        with self.assertRaisesRegex(AttributeError, r"tools\.skill"):
            namespace.cf_cli

    def test_duplicate_import_name_loads_neither(self) -> None:
        write_skill(self.root / "a", "one", import_name="dupe", body="value = 1\n")
        write_skill(self.root / "b", "two", import_name="dupe", body="value = 2\n")
        report = skills_mod.load(found(self.root / "a", self.root / "b"), self.namespace)
        self.assertEqual(report["loaded"], [])
        self.assertEqual(len(report["failed"]), 2, "both candidates must be rejected")
        for record in report["failed"]:
            self.assertIn("none is loaded", record["reason"])

    def test_scan_order_does_not_change_the_conflict_verdict(self) -> None:
        write_skill(self.root / "a", "one", import_name="dupe", body="value = 1\n")
        write_skill(self.root / "b", "two", import_name="dupe", body="value = 2\n")
        forward = skills_mod.load(found(self.root / "a", self.root / "b"), dsh_kernel._Namespace("skills"))
        backward = skills_mod.load(found(self.root / "b", self.root / "a"), dsh_kernel._Namespace("skills"))
        self.assertEqual(forward["loaded"], backward["loaded"])
        self.assertEqual(forward["loaded"], [])

    def test_broken_skill_is_isolated_and_others_still_load(self) -> None:
        write_skill(self.root, "aaa-broken", import_name="broken", body="raise RuntimeError('boom')\n")
        write_skill(self.root, "zzz-good", import_name="good_skill", body="ok = True\n")
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], ["good_skill"], "one bad skill must not block the rest")
        failed = next(r for r in report["failed"] if r["import_name"] == "broken")
        self.assertIn("RuntimeError", failed["reason"])
        self.assertIn("traceback", failed)

    def test_prime_dependent_skill_is_refused_with_a_location(self) -> None:
        write_skill(
            self.root,
            "legacy",
            import_name="needs_prime",
            body="from rlm import bash\n\ndef run():\n    return bash\n",
        )
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], [])
        record = report["failed"][0]
        self.assertIn("Prime's own host runtime", record["reason"])
        self.assertIn("needs_prime", record["reason"])
        self.assertIn("dsh_kernel", record["reason"], "the error must point at the supported path")

    def test_using_a_failed_skill_names_the_reason(self) -> None:
        # Like Prime's placeholder: the error at the point of use says why.
        write_skill(self.root, "needsdep", import_name="dep_missing", body="import a_package_that_does_not_exist_anywhere\n")
        namespace = skills_mod._SkillsNamespace()
        skills_mod.load(found(self.root), namespace)
        with self.assertRaisesRegex(AttributeError, "not available: ModuleNotFoundError"):
            namespace.dep_missing

    def test_missing_third_party_dependency_is_reported_not_installed(self) -> None:
        write_skill(
            self.root,
            "needsdep",
            import_name="dep_missing",
            body="import a_package_that_does_not_exist_anywhere\n",
        )
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], [])
        self.assertIn("ModuleNotFoundError", report["failed"][0]["reason"])

    def test_skill_can_reach_dsh_tools_through_the_bridge_module(self) -> None:
        # A skill module has its OWN globals: the REPL's top-level names are
        # invisible to it. The bridge import is the supported path.
        write_skill(
            self.root,
            "bridge",
            import_name="uses_bridge",
            body="from dsh_kernel import call_tool\n\nasync def run(text):\n    return await call_tool('echo', {'text': text})\n",
        )
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], ["uses_bridge"])
        self.assertTrue(callable(self.namespace.uses_bridge.run))

    def test_missing_root_is_skipped_quietly(self) -> None:
        report = skills_mod.load(found(self.root / "nope"), self.namespace)
        self.assertEqual(report["loaded"], [])
        self.assertEqual(report["skills"], [])

    def test_report_includes_description_for_the_prompt_catalog(self) -> None:
        write_skill(self.root, "described", import_name="good_skill", body="", description="Does a thing.")
        report = skills_mod.load(found(self.root), self.namespace)
        record = next(r for r in report["skills"] if r["import_name"] == "good_skill")
        self.assertEqual(record["description"], "Does a thing.")


class SkillCatalog(unittest.TestCase):
    def setUp(self):
        SkillLoading.setUp(self)
        self.namespace = skills_mod._SkillsNamespace()

    tearDown = SkillLoading.tearDown

    def test_local_description_has_instructions_and_safe_members(self):
        write_skill(self.root, "good", import_name="good_skill", body='''
class Meta(type):
    def __hash__(self):
        raise AssertionError("metaclass hash executed")
class Trap(metaclass=Meta):
    def __repr__(self):
        raise AssertionError("repr executed")
    @property
    def hidden(self):
        raise AssertionError("property executed")
trap = Trap()
def run(x, /, default=trap, *, option="yes"):
    """Full function documentation."""
    return x
def __getattr__(name):
    raise AssertionError("dynamic lookup executed")
def __dir__():
    raise AssertionError("dir executed")
run.__signature__ = trap
run.__wrapped__ = trap
''')
        skills_mod.load(found(self.root), self.namespace)
        result = asyncio.run(self.namespace.describe(["good_skill", "good_skill.run", "good_skill.trap.hidden", "good_skill._private", "good_skill.missing"]))["items"]
        self.assertIn("# good", result[0]["instructions"])
        self.assertEqual(result[0]["instructions_file"], "SKILL.md")
        self.assertIn("run", result[0]["members"])
        self.assertEqual(result[0]["access"], "skills.good_skill")
        self.assertEqual(result[1]["signature"], "skills.good_skill.run(x, /, default=Ellipsis, *, option='yes')")
        self.assertEqual(result[1]["description"], "Full function documentation.")
        self.assertNotIn("instructions", result[1], "member lookup must not repeat the whole module guide")
        self.assertNotIn("directory", result[1])
        self.assertTrue(all(item["status"] == "unknown" for item in result[2:]))

    def test_empty_failed_and_docs_only_are_distinct(self):
        skills_mod.load([], self.namespace)
        empty = asyncio.run(self.namespace.list())
        self.assertEqual(empty["status"], "ready")
        self.assertIn("No Python skills", empty["reason"])
        self.assertIn("tools.skill", empty["note"])
        write_skill(self.root, "broken", import_name="broken", body="raise RuntimeError('boom')")
        write_skill(self.root, "docs.with.dot")
        skills_mod.load(found(self.root), self.namespace)
        result = asyncio.run(self.namespace.describe(["broken", "docs.with.dot"]))["items"]
        self.assertEqual(result[0]["status"], "unavailable")
        self.assertIn("boom", result[0]["reason"])
        self.assertIsNone(result[0]["access"])
        self.assertEqual(result[1]["status"], "docs-only")
        self.assertIn("# docs.with.dot", result[1]["instructions"])
        self.assertIsNone(result[1]["access"])
        self.assertEqual(asyncio.run(self.namespace.list(query="absent"))["items"], [])
        self.assertEqual(asyncio.run(self.namespace.list())["status"], "ready")

    def test_pagination_query_and_collision_access(self):
        for name in ("list", "read", "class"):
            write_skill(self.root, name, import_name=name, body="def run(): return 1")
        try:
            skills_mod.load(found(self.root), self.namespace)
            first = asyncio.run(self.namespace.list(limit=1))
            second = asyncio.run(self.namespace.list(limit=1, cursor=first["next_cursor"]))
            self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])
            with self.assertRaisesRegex(ValueError, "invalid cursor"):
                asyncio.run(self.namespace.list(cursor="x"))
            self.assertEqual(asyncio.run(self.namespace.describe("list"))["items"][0]["access"], "skills['list']")
            self.assertEqual(asyncio.run(self.namespace.describe("class"))["items"][0]["access"], "skills['class']")
            self.assertEqual(asyncio.run(self.namespace.describe("read"))["items"][0]["access"], "skills.read")
            self.assertEqual(asyncio.run(self.namespace["list"]()), 1, "a sync run is awaited, as in Prime")
        finally:
            for name in ("list", "read", "class"):
                sys.modules.pop(name, None)


class SkillInstructions(unittest.TestCase):
    setUp = SkillCatalog.setUp
    tearDown = SkillLoading.tearDown

    def describe(self, name="good_skill"):
        return asyncio.run(self.namespace.describe(name))["items"][0]

    def test_python_document_supplies_instructions_description_and_summary(self):
        directory = write_skill(
            self.root, "good", import_name="good_skill", body="value = 42\n",
            description="CLI guide.", python_description="Use skills.good_skill in Python.",
        )
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], ["good_skill"])
        self.assertEqual(report["skills"][0]["instructions_file"], "PYSKILL.md")
        result = self.describe()
        self.assertEqual(result["instructions_file"], "PYSKILL.md")
        self.assertEqual(result["instructions"], (directory / "PYSKILL.md").read_text(encoding="utf-8"))
        self.assertEqual(result["directory"], str(directory), "relative links in the guide need the skill's own directory")
        self.assertIn("directory", result["links"])
        self.assertEqual(list(result)[-1], "instructions", "a truncated print of the result must still reach directory")
        self.assertEqual(result["description"], "Use skills.good_skill in Python.")
        catalog = asyncio.run(self.namespace.list())["items"]
        self.assertEqual(catalog[0]["summary"], "Use skills.good_skill in Python.")
        self.assertEqual(self.namespace.good_skill.value, 42)

    def test_python_skill_without_python_document_uses_cli_document(self):
        directory = write_skill(self.root, "good", import_name="good_skill", description="CLI fallback.")
        skills_mod.load(found(self.root), self.namespace)
        result = self.describe()
        self.assertEqual(result["instructions_file"], "SKILL.md")
        self.assertEqual(result["instructions"], (directory / "SKILL.md").read_text(encoding="utf-8"))
        self.assertEqual(result["description"], "CLI fallback.")

    def test_document_only_skill_keeps_cli_document_even_with_python_guide(self):
        directory = write_skill(
            self.root, "docs", description="CLI instructions only.", python_description="Not a Python package.",
        )
        report = skills_mod.load(found(self.root), self.namespace)
        self.assertEqual(report["loaded"], [])
        result = self.describe("docs")
        self.assertEqual(result["status"], "docs-only")
        self.assertEqual(result["instructions_file"], "SKILL.md")
        self.assertEqual(result["instructions"], (directory / "SKILL.md").read_text(encoding="utf-8"))
        self.assertEqual(result["description"], "CLI instructions only.")

    def test_selected_python_document_deleted_does_not_fall_back(self):
        directory = write_skill(self.root, "good", import_name="good_skill", python_description="Python guide.")
        skills_mod.load(found(self.root), self.namespace)
        (directory / "PYSKILL.md").unlink()
        self.assertTrue((directory / "SKILL.md").is_file())
        with self.assertRaisesRegex(RuntimeError, "PYSKILL[.]md unreadable") as raised:
            self.describe()
        self.assertIsInstance(raised.exception.__cause__, FileNotFoundError)

    def test_selected_python_document_invalid_utf8_does_not_fall_back(self):
        directory = write_skill(self.root, "good", import_name="good_skill", python_description="Python guide.")
        entries = found(self.root)
        (directory / "PYSKILL.md").write_bytes(b"\xff\xfe not UTF-8")
        skills_mod.load(entries, self.namespace)
        self.assertTrue((directory / "SKILL.md").is_file())
        with self.assertRaisesRegex(RuntimeError, "PYSKILL[.]md unreadable") as raised:
            self.describe()
        self.assertIsInstance(raised.exception.__cause__, UnicodeDecodeError)

    def test_host_document_error_blocks_import_and_description(self):
        marker = Path.home() / "module-top-level-ran"
        directory = write_skill(
            self.root, "good", import_name="good_skill",
            body=f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n",
            python_description="Python guide.",
        )
        entries = found(self.root)
        # YAML validation belongs to the host; the kernel only receives its verdict.
        (directory / "PYSKILL.md").write_text("---\nname: [invalid YAML\n---\n", encoding="utf-8")
        error = "PYSKILL.md: invalid YAML reported by the host"
        entries[0]["document_error"] = error
        entries[0]["status"] = "unavailable"
        report = skills_mod.load(entries, self.namespace)
        self.assertEqual(report["loaded"], [])
        self.assertEqual(report["failed"][0]["reason"], error)
        self.assertEqual(report["failed"][0]["instructions_file"], "PYSKILL.md")
        self.assertFalse(marker.exists(), "a rejected guide must block module-level side effects")
        self.assertNotIn("good_skill", sys.modules)
        with self.assertRaisesRegex(RuntimeError, re.escape(error)):
            self.describe()
        self.assertFalse(marker.exists())

    def test_invalid_host_filename_never_reads_outside_or_imports(self):
        marker = Path.home() / "module-top-level-ran"
        write_skill(
            self.root, "good", import_name="good_skill",
            body=f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n",
        )
        outside = self.root / "outside.md"
        outside.write_text("must not be disclosed", encoding="utf-8")
        for filename in ("../outside.md", str(outside), "sub/PYSKILL.md", "pyskill.md", None):
            with self.subTest(filename=filename):
                entry = {**found(self.root)[0], "instructions_file": filename}
                with mock.patch.object(Path, "read_text", side_effect=AssertionError("unexpected document read")):
                    report = skills_mod.load([entry], self.namespace)
                    self.assertEqual(report["loaded"], [])
                    self.assertIn("valid skill instruction document", report["failed"][0]["reason"])
                    with self.assertRaisesRegex(ValueError, "valid skill instruction document"):
                        self.describe()
                self.assertFalse(marker.exists())
                self.assertNotIn("good_skill", sys.modules)

    def test_missing_host_filename_is_rejected_before_import(self):
        write_skill(self.root, "good", import_name="good_skill", body="raise AssertionError('must not import')")
        entry = found(self.root)[0]
        del entry["instructions_file"]
        report = skills_mod.load([entry], self.namespace)
        self.assertEqual(report["loaded"], [])
        self.assertIn("valid skill instruction document", report["failed"][0]["reason"])
        self.assertNotIn("good_skill", sys.modules)

    def test_cached_cli_selection_is_not_changed_by_new_python_document(self):
        directory = write_skill(self.root, "good", import_name="good_skill", description="Host chose CLI.")
        entries = found(self.root)
        (directory / "PYSKILL.md").write_text(
            "---\nname: good\ndescription: A later Python guide.\n---\n\n# Later Python guide\n", encoding="utf-8",
        )
        self.assertEqual(found(self.root)[0]["instructions_file"], "PYSKILL.md")
        skills_mod.load(entries, self.namespace)
        result = self.describe()
        self.assertEqual(result["instructions_file"], "SKILL.md")
        self.assertEqual(result["description"], "Host chose CLI.")
        self.assertEqual(result["instructions"], (directory / "SKILL.md").read_text(encoding="utf-8"))

    def test_cached_python_selection_does_not_require_cli_to_remain(self):
        directory = write_skill(
            self.root, "good", import_name="good_skill", python_description="Host chose Python.",
        )
        entries = found(self.root)
        (directory / "SKILL.md").unlink()
        skills_mod.load(entries, self.namespace)
        result = self.describe()
        self.assertEqual(result["instructions_file"], "PYSKILL.md")
        self.assertEqual(result["description"], "Host chose Python.")
        self.assertEqual(result["instructions"], (directory / "PYSKILL.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
