"""Panel protocol safety independent of user-cell teardown machinery."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
import panel_state


class PanelStateTests(unittest.TestCase):
    def test_no_user_hooks_or_scalar_values_and_preserves_names(self):
        calls = []

        class Meta(type):
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)

        class Hostile(list, metaclass=Meta):
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)

            def __len__(self):
                calls.append("len")
                raise AssertionError("len")

            def __repr__(self):
                calls.append("repr")
                raise AssertionError("repr")

        messages = []
        kernel = SimpleNamespace(_compile_cell=lambda source, filename: ([compile(source, filename, "exec")], False), _send=messages.append, _ALWAYS_SKIP={"system"})
        panel_state.install(kernel, 7)
        ns = {"hostile": Hostile(), "Hostile": Hostile, "secret": 918273645,
              "text": "SECRET_SENTINEL", "rows": ["SECRET_SENTINEL"], "_internal": None,
              "__dunder__": "SECRET_SENTINEL", "system": None}
        asyncio.run(kernel._handle_list_names({"id": "panel"}, ns))
        self.assertEqual(calls, [])
        message = messages[0]
        self.assertEqual(message["names"], ["Hostile", "hostile", "rows", "secret", "text"])
        self.assertEqual(message["total"], len(message["metadata"]))
        self.assertTrue(message["complete"])
        self.assertEqual(message["info"]["epoch"], 7)
        self.assertNotIn("918273645", str(message))
        self.assertNotIn("SECRET_SENTINEL", str(message))
        self.assertEqual(next(x["summary"] for x in message["metadata"] if x["name"] == "hostile"), "Hostile")

    def test_imported_functions_classes_and_methods_without_descriptors(self):
        from math import sqrt
        from collections import deque
        from pathlib import Path as ImportedClass
        self.assertEqual(panel_state._origin("sqrt", sqrt), "import")
        self.assertEqual(panel_state._origin("deque", deque), "import")
        self.assertEqual(panel_state._origin("Path", ImportedClass), "import")
        self.assertEqual(panel_state._origin("cwd", ImportedClass.cwd), "import")
        self.assertEqual(panel_state._origin("number", 123), "user")

class PanelPreviewTests(unittest.TestCase):
    def preview(self, value):
        import panel_preview
        result = panel_preview.preview({"target": value}, "target", 7, 7)
        self.assertEqual(result["status"], "ok")
        return result

    def test_large_values_are_bounded_in_utf8_and_json_shape(self):
        import json
        import time
        deep = []
        cursor = deep
        for _ in range(10000):
            child = []
            cursor.append(child)
            cursor = child
        cycle = []
        cycle.append(cycle)
        values = [list(range(1000000)), "🐈中文" * 1000000, 1 << 1000000,
                  b"x" * 1000000, deep, cycle, {str(i): "🐈" * 10000 for i in range(500)},
                  [float("nan"), float("inf"), -float("inf")]]
        def dimensions(value, depth=0):
            if type(value) is dict:
                children = list(value.values())
            elif type(value) is list:
                children = value
            else:
                return 1, depth
            sizes = [dimensions(x, depth + 1) for x in children]
            return 1 + sum(x[0] for x in sizes), max([depth] + [x[1] for x in sizes])
        for value in values:
            with self.subTest(kind=type(value).__name__):
                started = time.monotonic()
                result = self.preview(value)
                text = json.dumps(result, ensure_ascii=False, allow_nan=False)
                self.assertLessEqual(len(text.encode("utf-8")), 40 * 1024)
                nodes, depth = dimensions(result)
                self.assertLessEqual(nodes, 200)
                self.assertLessEqual(depth, 5)
                self.assertLess(time.monotonic() - started, 0.5)
        self.assertIn("circular", json.dumps(self.preview(cycle)))
        self.assertIn("bits", json.dumps(self.preview(1 << 1000000)))
        self.assertEqual(self.preview(2 ** 100)["value"]["decimal"], str(2 ** 100))

    def test_dictionary_key_identity_and_no_hooks(self):
        import json
        calls = []
        class Meta(type):
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)
        class Hostile(list, metaclass=Meta):
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)
            def __repr__(self):
                calls.append("repr")
                raise AssertionError("repr")
            def __iter__(self):
                calls.append("iter")
                raise AssertionError("iter")
            def __len__(self):
                calls.append("len")
                raise AssertionError("len")
            @property
            def __dict__(self):
                calls.append("descriptor")
                raise AssertionError("descriptor")
        class Ordinary:
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)
            @property
            def field(self):
                calls.append("property")
                raise AssertionError("property")
        ordinary = Ordinary()
        object.__setattr__(ordinary, "stored", 42)
        for value in [Hostile(), Hostile, ordinary, {1: "integer", "1": "string", (1,): "tuple", Hostile: "class"}]:
            self.preview(value)
        pairs = self.preview({1: "integer", "1": "string"})["value"]["entries"]
        self.assertEqual(pairs, [[1, "integer"], ["1", "string"]])
        self.assertEqual(self.preview({"ok": 1, "nested": {"name": "汤圆"}})["value"], {"ok": 1, "nested": {"name": "汤圆"}})
        long_keys = self.preview({"a" * 2000 + "x": 1, "a" * 2000 + "y": 2})
        self.assertEqual(long_keys["value"]["$type"], "dict")
        self.assertEqual(len(long_keys["value"]["entries"]), 2)
        self.assertIn("42", json.dumps(self.preview(ordinary)))
        self.assertEqual(calls, [])

    def test_exact_names_epoch_and_malicious_namespace_key(self):
        import panel_preview
        calls = []
        class Key:
            def __hash__(self):
                return hash("target")
            def __eq__(self, other):
                calls.append("eq")
                raise AssertionError("eq")
        ns = {Key(): "hidden"}
        self.assertEqual(panel_preview.preview(ns, "target", 7, 7)["status"], "missing")
        self.assertEqual(calls, [])
        self.assertEqual(panel_preview.preview({"target": 1}, "target", 6, 7)["status"], "stale")
        for expression in ("target.x", "target[0]", "target()", "__import__('os')"):
            self.assertEqual(panel_preview.preview({}, expression, 7, 7)["status"], "error")

    def test_source_is_only_the_selected_cached_function_and_no_disk_io(self):
        import linecache
        import panel_preview
        from unittest.mock import patch
        filename = "<preview-test>"
        source = "def selected(x):\n    return x + 1\n\ndef unrelated():\n    return 'DO_NOT_INCLUDE'\nsecret = 'ALSO_EXCLUDED'\n"
        namespace = {}
        code = compile(source, filename, "exec")
        panel_preview.remember_source([code], source)
        exec(code, namespace)
        wrong_source = "def selected(x):\n    return 'WRONG_CACHED_SOURCE'\n"
        linecache.cache[filename] = (len(wrong_source), None, wrong_source.splitlines(keepends=True), filename)
        try:
            with patch("builtins.open", side_effect=AssertionError("no disk reads")):
                result = self.preview(namespace["selected"])
                imported = self.preview(panel_preview.preview)
                builtin = self.preview(len)
            self.assertEqual(result["kind"], "source")
            self.assertEqual(result["line"], 1)
            self.assertIn("return x + 1", result["source"])
            self.assertNotIn("DO_NOT_INCLUDE", result["source"])
            self.assertNotIn("ALSO_EXCLUDED", result["source"])
            self.assertNotIn("WRONG_CACHED_SOURCE", result["source"])
            self.assertEqual(imported["kind"], "metadata")
            self.assertIn("缓存", imported["reason"])
            self.assertIn("内置函数", builtin["value"]["note"])
        finally:
            linecache.cache.pop(filename, None)

    def test_protocol_preview_returns_no_namespace_copy(self):
        messages = []
        kernel = SimpleNamespace(_compile_cell=lambda source, filename: ([compile(source, filename, "exec")], False), _send=messages.append, _ALWAYS_SKIP=set())
        panel_state.install(kernel, 7)
        asyncio.run(kernel._handle_list_names({"id": "p", "preview": {"name": "target", "epoch": 7}}, {"target": 123}))
        self.assertEqual(messages[0]["preview"]["value"], 123)
        self.assertNotIn("metadata", messages[0])


class SourceIdentityTests(unittest.TestCase):
    def setUp(self):
        import panel_preview
        panel_preview._source_records.clear()
        panel_preview._source_chars = 0

    def tearDown(self):
        import panel_preview
        panel_preview._source_records.clear()
        panel_preview._source_chars = 0

    def function(self, source, filename="<same-cell>"):
        import panel_preview
        code = compile(source, filename, "exec")
        panel_preview.remember_source([code], source)
        namespace = {}
        exec(code, namespace)
        return namespace["target"]

    def preview(self, function):
        import panel_preview
        return panel_preview.preview({"target": function}, "target", 7, 7)

    def test_same_filename_keeps_source_for_each_identity_and_nested_codes(self):
        import linecache
        first_source = "def target():\n    return 1\n"
        second_source = "def target():\n    return 2\n"
        first = self.function(first_source)
        second = self.function(second_source)
        linecache.cache["<same-cell>"] = (len(second_source), None, second_source.splitlines(keepends=True), "<same-cell>")
        try:
            self.assertEqual(self.preview(first)["source"], first_source)
            self.assertEqual(self.preview(second)["source"], second_source)
            nested = self.function("def target():\n    def child():\n        return 'nested-original'\n    return child\n")()
            self.assertIn("nested-original", self.preview(nested)["source"])
            self.assertNotIn("return child", self.preview(nested)["source"])
        finally:
            linecache.cache.pop("<same-cell>", None)

    def test_equal_but_distinct_code_and_stale_reference_do_not_match(self):
        import panel_preview
        import types
        first = self.function("def target():\n    return 1\n")
        clone = first.__code__.replace()
        other = types.FunctionType(clone, {})
        self.assertIsNot(clone, first.__code__)
        self.assertEqual(self.preview(other)["kind"], "metadata")
        # Simulate an id collision without relying on allocator-specific reuse.
        panel_preview._source_records[id(clone)] = panel_preview._source_records[id(first.__code__)]
        panel_preview._source_chars += len(panel_preview._source_records[id(clone)][1])
        self.assertEqual(self.preview(other)["kind"], "metadata")
        self.assertNotIn(id(clone), panel_preview._source_records)
        self.assertIn("原始源码", self.preview(other)["reason"])

    def test_dill_restored_function_never_borrows_new_same_filename_source(self):
        try:
            import dill
        except ImportError:
            self.skipTest("dill is covered by the real-kernel snapshot environment")
        import linecache
        first = self.function("def target():\n    return 1\n")
        restored = dill.loads(dill.dumps(first))
        second_source = "def target():\n    return 2\n"
        second = self.function(second_source)
        linecache.cache["<same-cell>"] = (len(second_source), None, second_source.splitlines(keepends=True), "<same-cell>")
        try:
            self.assertIsNot(restored.__code__, first.__code__)
            self.assertEqual(restored(), 1)
            result = self.preview(restored)
            self.assertEqual(result["kind"], "metadata")
            self.assertNotIn("source", result)
            self.assertNotIn("sourceEndLine", result)
            self.assertIn("原始源码", result["reason"])
            self.assertEqual(self.preview(second)["source"], second_source)
        finally:
            linecache.cache.pop("<same-cell>", None)


    def test_unregistered_main_and_missing_module_never_offer_host_file_source(self):
        import panel_preview
        source = "def target():\n    return 'live-code'\n"
        code = compile(source, __file__, "exec")
        for module in ("__main__", None, ""):
            namespace = {"__name__": module}
            exec(code, namespace)
            result = self.preview(namespace["target"])
            self.assertEqual(result["kind"], "metadata")
            self.assertNotIn("sourceEndLine", result)
            self.assertIn("原始源码", result["reason"])
        imported = self.preview(panel_preview.preview)
        self.assertEqual(imported["kind"], "metadata")
        self.assertIn("sourceEndLine", imported)

    def test_weak_cleanup_and_both_capacity_limits(self):
        import gc
        import panel_preview
        import weakref
        function = self.function("def target():\n    return 'temporary'\n")
        identity = id(function.__code__)
        reference = weakref.ref(function.__code__)
        self.assertIn(identity, panel_preview._source_records)
        del function
        gc.collect()
        self.assertIsNone(reference())
        self.assertNotIn(identity, panel_preview._source_records)
        self.assertEqual(panel_preview._source_chars, 0)
        codes = [compile("pass", "<limit>", "exec") for _ in range(300)]
        for code in codes:
            panel_preview.remember_source([code], "pass")
        self.assertEqual(len(panel_preview._source_records), 256)
        self.assertEqual(panel_preview._source_chars, 256 * 4)
        self.assertNotIn(id(codes[0]), panel_preview._source_records)
        self.assertIn(id(codes[-1]), panel_preview._source_records)
        large = "#" * 65536
        for code in codes[:10]:
            panel_preview.remember_source([code], large)
        self.assertLessEqual(panel_preview._source_chars, 262144)
        self.assertLessEqual(len(panel_preview._source_records), 4)
        self.assertEqual(panel_preview._source_chars, sum(len(entry[1]) for entry in panel_preview._source_records.values()))
        ignored = compile("pass", "<oversized>", "exec")
        panel_preview.remember_source([ignored], large + "#")
        self.assertNotIn(id(ignored), panel_preview._source_records)

    def test_constants_never_hash_compare_iterate_or_inspect_user_objects(self):
        import panel_preview
        import types
        from unittest.mock import patch
        calls = []
        class Hostile:
            def __hash__(self):
                calls.append("hash")
                raise AssertionError("hash")
            def __eq__(self, other):
                calls.append("equality")
                raise AssertionError("equality")
            def __getattribute__(self, key):
                calls.append(key)
                raise AssertionError(key)
            def __repr__(self):
                calls.append("repr")
                raise AssertionError("repr")
            def __iter__(self):
                calls.append("iter")
                raise AssertionError("iter")
        source = "def target():\n    return 1\n"
        original = compile(source, "<hostile-constants>", "exec")
        target = next(item for item in original.co_consts if type(item) is types.CodeType)
        hostile = Hostile()
        code = target.replace(co_consts=(None, hostile, (hostile,), [hostile]))
        function = types.FunctionType(code, {})
        with patch("builtins.compile", side_effect=AssertionError("must not compile")):
            panel_preview.remember_source([code], source)
            self.assertEqual(self.preview(function)["kind"], "source")
            clone = types.FunctionType(code.replace(), {})
            self.assertEqual(self.preview(clone)["kind"], "metadata")
        self.assertEqual(calls, [])

    def test_nested_node_and_constant_scan_limits(self):
        import panel_preview
        from unittest.mock import patch
        base = compile("pass", "<bounded-constants>", "exec")
        children = tuple(base.replace() for _ in range(600))
        root = base.replace(co_consts=children)
        with patch.object(panel_preview, "_remember_code", wraps=panel_preview._remember_code) as remember:
            panel_preview.remember_source([root], "pass")
            self.assertLessEqual(remember.call_count, 512)
        tail = base.replace()
        wide = base.replace(co_consts=(None,) * 100000 + (tail,))
        panel_preview.remember_source([wide], "pass")
        self.assertNotIn(id(tail), panel_preview._source_records)
        self.assertLessEqual(len(panel_preview._source_records), 256)

    def test_install_wraps_original_compile_once_and_preserves_results(self):
        import panel_preview
        calls = []
        code = compile("def target():\n    return 1\n", "<wrapped>", "exec")
        codes = [code]
        def original(source, filename):
            calls.append((source, filename))
            return codes, True
        kernel = SimpleNamespace(_compile_cell=original, _send=lambda value: None, _ALWAYS_SKIP=set())
        panel_state.install(kernel, 7)
        source = "def target():\n    return 1\n"
        result, trailing = kernel._compile_cell(source, "<wrapped>")
        self.assertIs(result, codes)
        self.assertTrue(trailing)
        self.assertEqual(calls, [(source, "<wrapped>")])
        namespace = {}
        exec(code, namespace)
        self.assertEqual(self.preview(namespace["target"])["source"], source)


if __name__ == "__main__":
    unittest.main()
