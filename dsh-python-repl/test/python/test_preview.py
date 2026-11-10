"""Bounded previews must never run user hooks or certify upstream data."""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
import preview as preview_module

preview = preview_module.preview


class PreviewTests(unittest.TestCase):
    def assert_json_result(self, result, chars):
        self.assertIs(type(result), dict)
        self.assertIs(type(result["text"]), str)
        self.assertLessEqual(len(result["text"]), chars)
        self.assertIs(type(result["truncated"]), bool)
        self.assertIs(type(result["unsupported"]), bool)
        self.assertIs(type(result["reasons"]), list)
        self.assertEqual(json.loads(json.dumps(result)), result)
        self.assertEqual(result["scope"], "in_memory_value")
        self.assertEqual(result["upstream_completeness"], "not_checked")
        self.assertIn("does not prove upstream", result["note"])

    def test_small_values_complete_and_match_builtin_repr(self):
        values = [None, True, False, 123, -42, 1.25, float("nan"), float("inf"),
                  complex(1, -2), "", "quotes'\"\n\\\x00😀", b"\x00'\"",
                  bytearray(b"abc"), [], (), (1,), {}, set(), frozenset(),
                  {1, 2}, frozenset({1}), {"a": [1, ("nested",)], "b": {False, None}}]
        for value in values:
            expected = repr(value)
            with self.subTest(expected=expected):
                result = preview(value)
                self.assert_json_result(result, 4000)
                self.assertEqual(result["text"], expected)
                self.assertFalse(result["truncated"])
                self.assertFalse(result["unsupported"])
                self.assertEqual(result["reasons"], [])
                self.assertEqual(preview(value, chars=len(expected))["text"], expected)
                self.assertFalse(preview(value, chars=len(expected))["truncated"])

    def test_character_limits_include_ellipsis_and_placeholders(self):
        cycle = []
        cycle.append(cycle)
        values = [None, "\x00\n😀'\"" * 1000, b"\x00" * 1000,
                  bytearray(b"a" * 1000), list(range(100)),
                  {"long": ["value"] * 10}, (1,), frozenset({1, 2}),
                  cycle, object(), 1 << 100_000]
        for value in values:
            for chars in range(50):
                with self.subTest(kind=type(value).__name__, chars=chars):
                    result = preview(value, chars=chars)
                    self.assert_json_result(result, chars)
                    if result["truncated"] and "chars_limit" in result["reasons"] and chars:
                        self.assertTrue(result["text"].endswith("…"))
        self.assertEqual(preview(None, chars=0)["text"], "")
        self.assertTrue(preview(None, chars=0)["truncated"])
        self.assertEqual(preview(None, chars=1)["text"], "…")

    def test_items_depth_cycles_and_shared_references(self):
        result = preview(list(range(200_000)), items=3)
        self.assertEqual(result["text"], "[0, 1, 2, …]")
        self.assertEqual(result["reasons"], ["items_limit"])
        self.assertFalse(result["unsupported"])
        self.assertEqual(preview([1], items=0)["text"], "[…]")
        self.assertEqual(preview({"a": 1, "b": 2}, items=1)["text"], "{'a': 1, …}")
        deep = 0
        for _ in range(1000):
            deep = [deep]
        result = preview(deep)
        self.assertEqual(result["text"], "[" * 8 + "<depth list>" + "]" * 8)
        self.assertEqual(result["reasons"], ["depth_limit"])
        self.assertEqual(preview([1], depth=0)["text"], "<depth list>")
        self.assertFalse(preview([], depth=0)["truncated"])
        cycle = []
        cycle.append(cycle)
        self.assertEqual(preview(cycle)["text"], "[<cycle list>]")
        self.assertEqual(preview(cycle)["reasons"], ["cycle"])
        mapping = {}
        mapping["self"] = mapping
        self.assertEqual(preview(mapping)["text"], "{'self': <cycle dict>}")
        shared = [1]
        self.assertEqual(preview([shared, shared])["text"], "[[1], [1]]")
        self.assertFalse(preview([shared, shared])["truncated"])

    def test_fixed_work_budget_limits_wide_nested_inputs(self):
        # Aliases make the conceptual tree huge without allocating a huge fixture.
        wide = [""] * 100
        for _ in range(8):
            wide = [wide] * 100
        calls = []
        original_repr = repr

        def counted_repr(value):
            calls.append(1)
            return original_repr(value)

        with patch.object(preview_module, "repr", counted_repr, create=True):
            result = preview(wide, chars=50_000, items=100, depth=32)
        self.assertIn("work_limit", result["reasons"])
        self.assertLessEqual(len(calls), preview_module._MAX_NODES)
        self.assert_json_result(result, 50_000)

    def test_no_full_container_repr_and_scalars_are_sliced_first(self):
        original_repr = repr
        formatted = []

        def bounded_repr(value):
            cls = type(value)
            self.assertTrue(any(cls is t for t in (str, bytes, bytearray, int, float, complex, bool, type(None))))
            if cls is str or cls is bytes or cls is bytearray:
                self.assertLessEqual(len(value), 4000)
            if cls is int:
                self.assertLessEqual(value.bit_length(), 4096)
            formatted.append(cls)
            return original_repr(value)

        with patch.object(preview_module, "repr", bounded_repr, create=True):
            for value in ["x" * 5_000_000, b"x" * 5_000_000,
                          bytearray(5_000_000), 10 ** 100_000,
                          [0] * 200_000, {"a": [1]}, (1,), {1, 2}, frozenset({1})]:
                self.assert_json_result(preview(value), 4000)
        self.assertNotIn(list, formatted)
        result = preview(10 ** 100_000)
        self.assertIn("integer_limit", result["reasons"])
        self.assertIn("bit_length=", result["text"])

    def test_custom_objects_subclasses_and_metaclasses_never_run_hooks(self):
        calls = []

        def trap(*args, **kwargs):
            calls.append("hook")
            raise AssertionError("user hook executed")

        class Meta(type):
            __getattribute__ = trap
            __getattr__ = trap
            __hash__ = trap
            __eq__ = trap
            __iter__ = trap
            __name__ = property(trap)

        class Hostile(metaclass=Meta):
            __repr__ = trap
            __str__ = trap
            __len__ = trap
            __iter__ = trap
            __getattribute__ = trap
            __getattr__ = trap
            __hash__ = trap
            field = property(trap)

        hostile = Hostile()
        values = [hostile, Hostile, [hostile], {"nested": hostile}]
        for base in (str, bytes, bytearray, int, float, complex, list, tuple, dict, set, frozenset):
            subclass = type("BuiltinSubclass", (base,), {
                "__repr__": trap, "__len__": trap, "__iter__": trap,
                "__getattribute__": trap, "__getitem__": trap})
            values.append(subclass())
        for value in values:
            result = preview(value)
            self.assertTrue(result["unsupported"])
            self.assertTrue(result["truncated"])
            self.assertIn("unsupported_type", result["reasons"])
            self.assertIn("<unsupported ", result["text"])
            self.assert_json_result(result, 4000)
        self.assertEqual(preview(hostile)["type"], "Hostile")
        self.assertEqual(preview(Hostile)["type"], "Meta")
        for name in ("chars", "items", "depth"):
            with self.assertRaises(TypeError):
                preview(1, **{name: hostile})
        self.assertEqual(calls, [])

    def test_safe_name_is_bounded(self):
        cls = type("X" * 100_000, (), {})
        result = preview(cls())
        self.assertLessEqual(len(result["type"]), preview_module._NAME_CHARS)
        self.assertLessEqual(len(result["text"]), 4000)

    def test_string_subclass_class_name_never_runs_hooks(self):
        calls = []

        def trap(*args, **kwargs):
            calls.append("hook")
            raise AssertionError("class name hook executed")

        class Name(str):
            __getitem__ = trap
            __len__ = trap
            __repr__ = trap
            __str__ = trap
            __iter__ = trap
            __getattribute__ = trap

        cls = type(Name("SafeName"), (), {})
        result = preview(cls())
        self.assertEqual(result["type"], "SafeName")
        self.assertIs(type(result["type"]), str)
        self.assertEqual(result["text"], "<unsupported SafeName>")
        self.assertEqual(calls, [])
        self.assert_json_result(result, 4000)

    def test_parameter_validation(self):
        for name, maximum in (("chars", 50_000), ("items", 100), ("depth", 32)):
            for invalid in (True, False, None, "5", 1.0, object()):
                with self.subTest(name=name, kind=type(invalid).__name__):
                    with self.assertRaises(TypeError):
                        preview(1, **{name: invalid})
            for invalid in (-1, maximum + 1, 10 ** 100):
                with self.assertRaises(ValueError):
                    preview(1, **{name: invalid})
            preview(1, **{name: maximum})
            preview(1, **{name: 0})
        class IntSubclass(int):
            pass
        with self.assertRaises(TypeError):
            preview(1, chars=IntSubclass(10))
        with self.assertRaises(TypeError):
            preview(1, 10)

    def test_original_values_are_retained_and_not_returned(self):
        child = [1, 2]
        raw = bytearray(b"abc")
        value = {"child": child, "again": child, "bytes": raw, "set": {3, 4}}
        before = repr(value)
        result = preview(value, chars=10)
        self.assertEqual(repr(value), before)
        self.assertIs(value["child"], child)
        self.assertIs(value["again"], child)
        self.assertIs(value["bytes"], raw)
        self.assert_json_result(result, 10)
        self.assertNotIn("value", result)
        self.assertNotIn("raw", result)

    def test_unsupported_only_describes_encountered_values(self):
        result = preview([1, object()], items=1)
        self.assertFalse(result["unsupported"])
        self.assertTrue(result["truncated"])
        self.assertIn("encountered", result["note"])

    def test_cancellation_and_interrupts_are_not_swallowed(self):
        for error in (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            with self.subTest(error=error.__name__):
                with patch.object(preview_module, "repr", side_effect=error, create=True):
                    with self.assertRaises(error):
                        preview([1])


if __name__ == "__main__":
    unittest.main()
