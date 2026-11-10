"""Namespace pages stay bounded and complete, and never run user code."""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
import repl_info


class PagingTests(unittest.TestCase):
    def setUp(self):
        self.module = types.ModuleType("__main__")
        self.patched = patch.dict(sys.modules, {"__main__": self.module})
        self.patched.start()
        self.ns = self.module.__dict__
        for i in range(55):
            self.ns[f"row_{i:02}"] = [i]

    def tearDown(self):
        self.patched.stop()

    def test_all_pages_without_duplicates_or_omissions(self):
        page = repl_info.list_names(query="row_", limit=7)
        names = []
        while True:
            names += [item["name"] for item in page["items"]]
            self.assertEqual(page["total"], 55)
            if page["next_cursor"] is None:
                break
            page = repl_info.list_names(query="row_", limit=7, cursor=page["next_cursor"])
        self.assertEqual(names, [f"row_{i:02}" for i in range(55)])

    def test_a_later_page_lists_what_exists_now(self):
        page = repl_info.list_names(query="row_", limit=50)
        self.ns["row_99"] = [99]
        following = repl_info.list_names(query="row_", limit=50, cursor=page["next_cursor"])
        self.assertEqual([i["name"] for i in following["items"]][-1], "row_99")
        self.assertEqual(following["total"], 56)

    def test_bad_cursors_are_errors_not_silent_restarts(self):
        for cursor in ("", "nonsense", "!", "-1", "1.5"):
            with self.subTest(cursor=cursor), self.assertRaisesRegex(ValueError, "invalid cursor"):
                repl_info.list_names(cursor=cursor)
        self.assertEqual(repl_info.list_names(query="row_", cursor="999")["items"], [])

    def test_binding_metadata_never_calls_class_or_metaclass_hooks(self):
        calls = []
        def trap(*args):
            calls.append("hook")
            raise AssertionError("metadata hook executed")
        class Meta(type):
            __getattribute__ = trap
            __hash__ = trap
            __eq__ = trap
            __name__ = property(trap)
        class Hostile(metaclass=Meta):
            __class__ = property(trap)
            __repr__ = trap
            __len__ = trap
        self.ns["row_01"] = Hostile()
        item = repl_info.list_names(query="row_01")["items"][0]
        self.assertEqual(item["summary"], "Hostile")
        self.assertEqual(item["kind"], "data")
        repl_info.list_names(query="row_", limit=3)
        self.assertEqual(calls, [])

    def test_only_displayed_page_is_summarized(self):
        with patch.object(repl_info, "_summary", wraps=repl_info._summary) as summary:
            result = repl_info.list_names(limit=2)
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(summary.call_count, 2)

    def test_limits_and_filter_types_are_validated(self):
        for limit in (True, 0, -1, 501, 2.0, "2"):
            with self.assertRaises(ValueError):
                repl_info.list_names(limit=limit)
        for kwargs in ({"query": 1}, {"kind": []}, {"origin": False}, {"cursor": 2}):
            with self.assertRaises(TypeError):
                repl_info.list_names(**kwargs)


if __name__ == "__main__":
    unittest.main()
