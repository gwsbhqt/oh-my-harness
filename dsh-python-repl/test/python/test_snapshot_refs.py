"""Snapshots keep modules and skill bindings by name (python/snapshot_refs.py), on the vendored snapshot code."""
import asyncio
import io
import json
import os
import pickle
import subprocess
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

from dsh_kernel import ToolCallError  # noqa: E402
from rlm import repl  # noqa: E402
import snapshot_refs  # noqa: E402


@unittest.skipIf(dill is None, "dill not installed")
class ByName(unittest.TestCase):
    def setUp(self):
        snapshot_refs.install()
        self.dir = self.enterContext(tempfile.TemporaryDirectory())
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

    def test_tool_error_uses_standard_pickle_outside_a_snapshot(self):
        error = ToolCallError("read", "fixture is unavailable")
        error._dsh_args = {"file_path": "fixture.txt"}
        for codec in (pickle, dill):
            with self.subTest(codec=codec.__name__):
                batch = codec.loads(codec.dumps({"type": ToolCallError, "error": error}))
                restored = batch["error"]
                self.assertIs(batch["type"], ToolCallError)
                self.assertIs(type(restored), ToolCallError)
                self.assertEqual((restored.toolName, restored.args, str(restored)),
                                 ("read", ("fixture is unavailable",), "fixture is unavailable"))
                self.assertEqual(restored._dsh_args, error._dsh_args)

    def test_only_complete_legacy_tool_errors_restore_in_a_snapshot(self):
        class OldError:
            def __init__(self, message, state):
                self.message, self.state = message, state

            def __reduce__(self):
                return ToolCallError, (self.message,), self.state

        message = "fictional error"
        good = OldError(message, {"toolName": "read"})
        states = {"good": good, "no_state": OldError(message, None),
                  "no_name": OldError(message, {"other": True}),
                  "bad_name": OldError(message, {"toolName": 42}),
                  "bad_message": OldError(42, {"toolName": "read"})}
        self.assertNotIn("error", repl._snapshot_state(states, self.path, self.manifest, 1 << 20, 1 << 20, False))
        fresh = {}
        result = repl._restore_state(fresh, self.path)
        self.assertEqual(result["restored"], ["good"])
        self.assertEqual({item["name"] for item in result["failed"]}, states.keys() - {"good"})
        self.assertEqual((fresh["good"].toolName, fresh["good"].args), ("read", (message,)))
        with self.assertRaises(TypeError):
            ToolCallError(message)
        for codec in (pickle, dill):
            with self.subTest(codec=codec.__name__), self.assertRaises(TypeError):
                codec.loads(codec.dumps(good))

    def test_legacy_error_with_a_closed_file_keeps_the_host_file_guard(self):
        target = Path(self.dir, "preserve.txt")
        with target.open("w", encoding="utf-8") as handle:
            handle.write("original")

        class OldError:
            def __reduce__(self):
                return ToolCallError, ("failed",), {"toolName": "read", "handle": handle}

        record = OldError()
        _, restored = self.roundtrip({"batch": [ToolCallError, record, record]})
        cls, error, alias = restored["batch"]
        self.assertIs(cls, type(error))
        self.assertIs(error, alias)
        self.assertTrue(error.handle.closed)
        self.assertEqual(target.read_text(encoding="utf-8"), "original")

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

    def test_user_names_roundtrip_in_both_orders_with_literal_manifest_names(self):
        pairs = [("_成本", 17), ("dsh_user_成本", 23)]
        for entries in ([pairs[0]], [pairs[1]], pairs, pairs[::-1]):
            with self.subTest(entries=entries):
                namespace = dict(entries)
                result, fresh = self.roundtrip({**namespace, "_": 1, "__internal": 2})
                self.assertEqual(fresh, namespace)
                self.assertEqual(result["saved"], sorted(namespace))
                self.assertTrue(all(type(name) is str for name in result["saved"]))
                self.assertEqual(json.loads(Path(self.manifest).read_text())["savedNames"], sorted(namespace))
                with open(self.path, "rb") as payload:
                    headers = repl._read_snapshot_records(payload, 1 << 20, 1 << 20)
                self.assertEqual(set(headers), {"__" + n if n.startswith("dsh_user_") else n for n in namespace})

    def test_prefixed_function_and_aliases_use_live_names(self):
        values = []
        ns = {"__name__": "__main__", "_items": values, "dsh_user_items": values,
              "_dsh_user_items": 41, "dsh_user__items": 7, "holder": {"row": values}}
        exec("def _read(): return _items, dsh_user_items, _dsh_user_items + dsh_user__items", ns)
        _, fresh = self.roundtrip(ns)
        self.assertIs(fresh["holder"]["row"], fresh["_items"])
        self.assertIs(fresh["_items"], fresh["dsh_user_items"])
        fresh["_items"] = [2]
        self.assertEqual(fresh["_read"](), ([2], [], 48))
        fresh["__dsh_user_items"] = "already in kernel"
        restored = repl._restore_state(fresh, self.path)
        self.assertEqual(restored["failed"], [])
        self.assertEqual(fresh["__dsh_user_items"], "already in kernel")

    def test_size_limits_and_unavailable_bindings_report_original_names(self):
        broken = self.module("missing_named_ref", "pass\n")
        ns = {"_big": b"x" * 2048, "dsh_user_big": 3, "dsh_user_bad": broken, "_bad": broken}
        committed = []
        saved = repl._snapshot_state(ns, self.path, self.manifest, 1 << 20, 512, True, committed)
        self.assertEqual(committed, [saved])
        self.assertEqual(saved["pruned"], ["_big"])
        self.assertEqual(saved["skipped"][0]["name"], "_big")
        self.assertEqual(set(ns), {"dsh_user_big", "_bad", "dsh_user_bad"})
        manifest = json.loads(Path(self.manifest).read_text())
        self.assertEqual((manifest["pruned"], manifest["skipped"]), (saved["pruned"], saved["skipped"]))
        del sys.modules[broken.__name__]
        Path(self.dir, broken.__name__ + ".py").unlink()
        fresh = {}
        result = repl._restore_state(fresh, self.path, committed)
        self.assertEqual(committed[-1], result)
        self.assertEqual({x["name"] for x in result["failed"]}, {"_bad", "dsh_user_bad"})
        self.assertEqual(fresh, {"dsh_user_big": 3})

    def test_legacy_headers_restore_functions_and_shared_values(self):
        rows = [5]
        ns = {"__name__": "__main__", "_rows": rows, "other": rows}
        exec("def read_row(): return _rows[0]", ns)
        self.roundtrip(ns)
        with open(self.path, "rb") as payload:
            records = repl._read_snapshot_records(payload, 1 << 20, 1 << 20)
        records["dsh_user_rows"] = records.pop("_rows")
        framed = bytearray(repl._SNAPSHOT_MAGIC)
        for name, blob in records.items():
            key = name.encode("utf-8")
            framed.extend(len(key).to_bytes(4, "little") + key + len(blob).to_bytes(8, "little") + blob)
        for payload in (framed, dill.dumps(records)):
            with self.subTest(framed=payload is framed):
                Path(self.path).write_bytes(payload)
                fresh = {}
                result = repl._restore_state(fresh, self.path)
                self.assertEqual(result, {"restored": ["_rows", "other", "read_row"], "failed": []})
                self.assertIs(fresh["_rows"], fresh["other"])
                self.assertNotIn("dsh_user_rows", fresh)
                fresh["_rows"] = [11]
                self.assertEqual(fresh["read_row"](), 11)

    def test_legacy_literal_prefix_is_host_specific(self):
        ns = {"__name__": "__main__", "dsh_user_total": 23}
        exec("def total(): return dsh_user_total", ns)
        records = {name: dill.dumps(ns[name], recurse=True) for name in ("total", "dsh_user_total")}
        Path(self.path).write_bytes(dill.dumps(records))
        fresh = {}
        restored = repl._restore_state(fresh, self.path)
        self.assertEqual(restored, {"restored": ["_total", "total"], "failed": []})
        self.assertEqual(fresh["_total"], 23)
        self.assertNotIn("dsh_user_total", fresh)
        with self.assertRaises(NameError):
            fresh["total"]()

        # A different host starts a fresh kernel and never used the DSH underscore alias.
        script = """import sys
import snapshot_refs
from rlm import repl
snapshot_refs.install(legacy_underscore_aliases=False)
ns = {}
restored = repl._restore_state(ns, sys.argv[1])
assert restored == {"restored": ["dsh_user_total", "total"], "failed": []}, restored
assert ns["total"]() == 23 and "_total" not in ns, ns.keys()
"""
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(str(ROOT / p) for p in ("vendor/prime", "python/compat", "python"))}
        child = subprocess.run([sys.executable, "-B", "-c", script, self.path], env=env,
                               capture_output=True, text=True, timeout=20)
        self.assertEqual(child.returncode, 0, child.stderr)

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
