"""Bounded sizing must never run object hooks or certify abbreviated reprs."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
import repl_info


class DisplaySizeTests(unittest.TestCase):
    def test_exact_builtin_repr_lengths_and_budget_boundary(self):
        values = [None, True, False, 123, -42, 1.25, complex(1, -2),
                  "", "quotes'\"\n\\\x00😀", b"\x00'\"", bytearray(b"abc"),
                  [], (), (1,), {}, set(), frozenset(), {1, 2}, frozenset({1}),
                  {"a": [1, ("nested",)], "b": {False, None}}]
        for value in values:
            size = len(repr(value))
            with self.subTest(value=value):
                result = repl_info.display_size(value, size)
                self.assertEqual(result["chars"], size)
                self.assertIs(result["over_budget"], False)
                self.assertEqual(result["status"], "exact")
                self.assertIs(repl_info.display_size(value, size - 1)["over_budget"], True)

    def test_zero_budget_is_not_silently_increased(self):
        result = repl_info.display_size(None, 0)
        self.assertEqual(result['budget'], 0)
        self.assertEqual(result['status'], 'over_budget')
        self.assertIs(result['over_budget'], True)

    def test_negative_budget_is_rejected(self):
        with self.assertRaises(ValueError):
            repl_info.display_size(1, -1)

    def test_long_lists_are_not_mistaken_for_abbreviated_repr(self):
        for value in [list(range(200_000)), {"nested": [list(range(200_000))]}]:
            result = repl_info.display_size(value)
            self.assertIs(result["over_budget"], True)
            self.assertIsNone(result["chars"])
        value = list(range(100))
        self.assertEqual(repl_info.display_size(value)["chars"], len(repr(value)))

    def test_unknown_values_never_execute_hooks(self):
        calls = []

        def trap(*args):
            calls.append("hook")
            raise AssertionError("user hook executed")

        class Meta(type):
            __getattribute__ = trap
            __hash__ = trap
            __eq__ = trap
            __name__ = property(trap)

        class Hostile(metaclass=Meta):
            __repr__ = trap
            __len__ = trap
            __getattribute__ = trap
            __int__ = trap
            field = property(trap)

        class ListSubclass(list):
            __repr__ = trap
            __iter__ = trap
            __len__ = trap

        hostile = Hostile()
        for value in [hostile, [hostile], {"nested": hostile}, Hostile, ListSubclass()]:
            result = repl_info.display_size(value)
            self.assertEqual(result["status"], "unknown")
            self.assertIsNone(result["chars"])
            self.assertIsNone(result["over_budget"])
            self.assertIn("cannot determine", result["advice"])
        self.assertEqual(repl_info.display_size(hostile)["type"], "Hostile")
        with self.assertRaises(TypeError):
            repl_info.display_size(1, hostile)
        self.assertEqual(calls, [])

    def test_cycles_depth_and_huge_budget_are_bounded_unknowns(self):
        cycle = []
        cycle.append(cycle)
        deep = 0
        for _ in range(100):
            deep = [deep]
        for value in [cycle, deep, 10 ** 100_000, "x" * 100_000, [0] * 100_000]:
            result = repl_info.display_size(value, 10 ** 100)
            self.assertEqual(result["status"], "unknown")
            self.assertIsNone(result["over_budget"])

    def test_never_formats_huge_scalars_or_whole_containers(self):
        original_repr = repr
        formatted = []

        def bounded_repr(value):
            self.assertNotIn(type(value), (list, tuple, dict, set, frozenset))
            if type(value) in (str, bytes, bytearray):
                self.assertLessEqual(len(value), repl_info.DISPLAY_BUDGET_CHARS)
            if type(value) is int:
                self.assertLessEqual(value.bit_length(), 4096)
            formatted.append(type(value))
            return original_repr(value)

        with patch.object(repl_info, "repr", bounded_repr, create=True):
            for value in ["x" * 5_000_000, b"x" * 5_000_000,
                          bytearray(5_000_000), 10 ** 100_000]:
                self.assertIsNone(repl_info.display_size(value)["chars"])
            self.assertEqual(formatted, [])
            self.assertIs(repl_info.display_size([0] * 200_000)["over_budget"], True)
            self.assertLess(len(formatted), repl_info.DISPLAY_BUDGET_CHARS)

    def test_cancellation_and_interrupts_are_not_swallowed(self):
        for error in [asyncio.CancelledError, KeyboardInterrupt, SystemExit]:
            with self.subTest(error=error.__name__):
                with patch.object(repl_info, "repr", side_effect=error, create=True):
                    with self.assertRaises(error):
                        repl_info.display_size([1])


if __name__ == "__main__":
    unittest.main()
