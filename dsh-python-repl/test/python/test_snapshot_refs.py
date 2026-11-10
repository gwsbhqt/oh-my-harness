"""Snapshots keep modules and skill bindings by name (python/snapshot_refs.py), on the vendored snapshot code."""
import asyncio
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Importing the vendored package must not write bytecode into vendor/ (test_vendor_integration checks it).
sys.dont_write_bytecode = True
for sub in ("vendor/prime", "python/compat", "python"):
    sys.path.insert(0, str(ROOT / sub)) if str(ROOT / sub) not in sys.path else None

try:
    import dill  # noqa: F401
except ImportError:  # pragma: no cover - the test venv has dill
    dill = None

from rlm import repl  # noqa: E402
import snapshot_refs  # noqa: E402


@unittest.skipIf(dill is None, "dill not installed")
class ByName(unittest.TestCase):
    def setUp(self):
        snapshot_refs.install()
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "state.dill")
        self.manifest = os.path.join(self.dir, "state.json")
        sys.path.insert(0, self.dir)
        self.addCleanup(lambda: sys.path.remove(self.dir))

    def module(self, name, source):
        Path(self.dir, f"{name}.py").write_text(source)
        sys.modules.pop(name, None)
        return __import__(name)

    def roundtrip(self, ns, forget=()):
        result = repl._snapshot_state(ns, self.path, self.manifest, 64 << 20, 16 << 20, False)
        self.assertNotIn("error", result, result)
        for name in forget:
            sys.modules.pop(name, None)
        fresh = {}
        restored = repl._restore_state(fresh, self.path, max_bytes=64 << 20, max_variable_bytes=16 << 20)
        self.assertEqual(restored.get("failed"), [], restored)
        return result, fresh

    def test_a_module_comes_back_with_its_current_code_not_old_globals(self):
        mod = self.module("refs_mod_a", "X = 1\ndef f():\n    return X\n")
        mod.X = 99
        Path(self.dir, "refs_mod_a.py").write_text("X = 2\ndef f():\n    return X\n")
        _, fresh = self.roundtrip({"m": mod}, forget=["refs_mod_a"])
        self.assertEqual(fresh["m"].X, 2)
        self.assertEqual(fresh["m"].f(), 2)

    def test_a_closed_write_handle_on_a_module_never_truncates_its_file(self):
        target = Path(self.dir, "keep.txt")
        target.write_text("precious")
        mod = self.module("refs_mod_b", "pass\n")
        with open(target, "w") as fh:
            fh.write("precious")
        mod.fh = fh
        _, fresh = self.roundtrip({"m": mod, "box": {"h": fh}}, forget=["refs_mod_b"])
        self.assertEqual(target.read_text(), "precious")
        self.assertIn("m", fresh)

    def test_a_function_using_a_module_alias_survives(self):
        mod = self.module("refs_mod_c", "def hello():\n    return 'hi'\n")
        ns = {"__name__": "__main__"}
        exec("def call():\n    return RH.hello()\n", ns)
        ns["RH"] = mod
        _, fresh = self.roundtrip({"RH": mod, "call": ns["call"]}, forget=["refs_mod_c"])
        self.assertIs(fresh["RH"], sys.modules["refs_mod_c"])

    def test_a_function_that_reads_the_skills_namespace_survives(self):
        import skills

        fake = skills._SkillsNamespace()
        fake._put("demo", types.SimpleNamespace(value=42))
        main = sys.modules["__main__"]
        had_skills = hasattr(main, "skills")
        old_skills = getattr(main, "skills", None)
        main.skills = fake
        try:
            ns = {"__name__": "__main__", "skills": fake}
            exec(
                "def uses_skill():\n    return skills.demo.value\n"
                "async def uses_skill_async():\n    return skills.demo.value\n",
                ns,
            )
            _, fresh = self.roundtrip({"sync_skill": ns["uses_skill"], "async_skill": ns["uses_skill_async"]})
            self.assertEqual(fresh["sync_skill"](), 42)
            self.assertEqual(asyncio.run(fresh["async_skill"]()), 42)
        finally:
            if had_skills:
                main.skills = old_skills
            else:
                delattr(main, "skills")

    def test_main_and_unimportable_modules_keep_dills_own_rule(self):
        fake = types.ModuleType("not_in_sys_modules")
        self.assertFalse(snapshot_refs.by_name(fake))
        self.assertFalse(snapshot_refs.by_name(sys.modules["__main__"]))
        self.assertTrue(snapshot_refs.by_name(sys.modules["json"]))


if __name__ == "__main__":
    unittest.main()
