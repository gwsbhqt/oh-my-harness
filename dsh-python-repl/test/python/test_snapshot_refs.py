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

    def test_shared_values_survive_failed_or_oversized_neighbors(self):
        shared = []
        missing = self.module("refs_temporary", "pass\n")
        ns = {"will_fail": [shared, missing], "large": [shared, b"x" * 4096],
              "bad": [shared, (i for i in ())], "left": {"items": [shared]}, "right": (shared,)}
        result = repl._snapshot_state(ns, self.path, self.manifest, 8192, 1024, False)
        self.assertEqual(set(result["saved"]), {"will_fail", "left", "right"})
        self.assertEqual({item["name"] for item in result["skipped"]}, {"large", "bad"})
        self.assertLessEqual(os.path.getsize(self.path), 8192)
        del sys.modules[missing.__name__]
        Path(self.dir, "refs_temporary.py").unlink()
        fresh = {}
        restored = repl._restore_state(fresh, self.path, max_bytes=8192, max_variable_bytes=1024)
        self.assertEqual(restored["restored"], ["left", "right"])
        self.assertEqual([item["name"] for item in restored["failed"]], ["will_fail"])
        fresh["left"]["items"][0].append(1)
        self.assertIs(fresh["left"]["items"][0], fresh["right"][0])
        self.assertEqual(fresh["right"][0].pop(), 1)

    def test_nested_cycles_and_equal_independent_values(self):
        shared = []
        shared.append(shared)
        separate = []
        separate.append(separate)
        _, fresh = self.roundtrip({"first": {"rows": shared}, "second": (shared,), "other": separate})
        value = fresh["first"]["rows"]
        self.assertIs(value, value[0])
        self.assertIs(value, fresh["second"][0])
        self.assertIsNot(value, fresh["other"])

    def test_preexisting_legacy_snapshot_still_loads(self):
        Path(self.path).write_bytes(dill.dumps({"old": dill.dumps({"rows": [1]})}))
        fresh = {}
        result = repl._restore_state(fresh, self.path)
        self.assertEqual(result, {"restored": ["old"], "failed": []})
        self.assertEqual(fresh["old"], {"rows": [1]})

    def test_reference_scan_reads_builtin_storage_without_user_hooks(self):
        def forbidden(*args):
            raise AssertionError("user hook called while looking for shared values")

        class Row(dict):
            keys = values = items = __iter__ = __repr__ = forbidden
            __class__ = property(forbidden)

        class Rows(list):
            __iter__ = __getitem__ = __len__ = __repr__ = forbidden

        leaf = []
        nested = Rows([Row(items=leaf)])
        names, refs = snapshot_refs.shared_references({"left": nested, "right": leaf}, {})
        self.assertEqual(names, {"left", "right"})
        self.assertIs(refs[id(leaf)][2], leaf)

    def test_failed_owner_does_not_split_its_other_containers(self):
        shared = []
        left, right = [shared], {"ref": shared}
        missing = self.module("refs_skipped_owner", "pass\n")
        ns = {"broken": [left, right, missing], "left": left, "right": right}
        repl._snapshot_state(ns, self.path, self.manifest, 8192, 1024, False)
        del sys.modules[missing.__name__]
        Path(self.dir, "refs_skipped_owner.py").unlink()
        fresh = {}
        result = repl._restore_state(fresh, self.path)
        self.assertEqual([item["name"] for item in result["failed"]], ["broken"])
        self.assertIs(fresh["left"][0], fresh["right"]["ref"])

    def test_prune_still_removes_only_oversized_live_names(self):
        data = [b"x" * 4096]
        ns = {"large": data, "also_large": data, "small": 7}
        result = repl._snapshot_state(ns, self.path, self.manifest, 4096, 128, True)
        self.assertEqual(result["pruned"], ["also_large", "large"])
        self.assertEqual(ns, {"small": 7})
        self.assertLessEqual(os.path.getsize(self.path), 4096)
        fresh = {}
        self.assertEqual(repl._restore_state(fresh, self.path)["restored"], ["small"])
        self.assertEqual(fresh, ns)

    def test_rebuilt_function_aliases_share_attributes_and_live_globals(self):
        ns = {"__name__": "__main__", "setting": 1}
        exec("def apply(): return setting", ns)
        ns["alias"] = ns["apply"]
        ns["box"] = (ns["apply"],)
        _, fresh = self.roundtrip(ns)
        fresh["alias"].enabled = True
        self.assertIs(fresh["apply"], fresh["box"][0])
        self.assertTrue(fresh["box"][0].enabled)
        fresh["setting"] = 42
        self.assertEqual(fresh["apply"](), 42)

    def test_immutable_leaves_do_not_prevent_archiving(self):
        fixed = (frozenset({1}), ("ready",))
        roots = {"one": [fixed], "two": {"key": fixed}}
        self.assertEqual(snapshot_refs.shared_references(roots, {}), (set(), {}))

    def test_text_pickle_setting_never_formats_a_shared_value(self):
        class Quiet(list):
            def __repr__(self):
                raise AssertionError("snapshot formatted a user value")

        value = Quiet([3])
        protocol = dill.settings["protocol"]
        try:
            dill.settings["protocol"] = 0
            _, fresh = self.roundtrip({"first": value, "second": value})
        finally:
            dill.settings["protocol"] = protocol
        self.assertIs(fresh["first"], fresh["second"])
        self.assertEqual(fresh["second"].pop(), 3)

    def test_main_and_unimportable_modules_keep_dills_own_rule(self):
        fake = types.ModuleType("not_in_sys_modules")
        self.assertFalse(snapshot_refs.by_name(fake))
        self.assertFalse(snapshot_refs.by_name(sys.modules["__main__"]))
        self.assertTrue(snapshot_refs.by_name(sys.modules["json"]))


if __name__ == "__main__":
    unittest.main()
