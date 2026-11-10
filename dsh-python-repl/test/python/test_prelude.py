"""Names every kernel starts with (python/prelude.py)."""

from __future__ import annotations

import collections
import datetime
import json
import pathlib
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import prelude  # noqa: E402
import repl_info  # noqa: E402


class PreludeTest(unittest.TestCase):
    def setUp(self):
        self.module = types.ModuleType("__main__")
        self.ns = self.module.__dict__
        self.saved_main = sys.modules["__main__"]
        sys.modules["__main__"] = self.module
        prelude.install(self.ns)

    def tearDown(self):
        sys.modules["__main__"] = self.saved_main

    def test_binds_the_real_stdlib_objects(self):
        self.assertIs(self.ns["json"], json)
        self.assertIs(self.ns["Path"], pathlib.Path)
        self.assertIs(self.ns["Counter"], collections.Counter)
        self.assertIs(self.ns["defaultdict"], collections.defaultdict)
        self.assertIs(self.ns["timedelta"], datetime.timedelta)
        self.assertIs(self.ns["timezone"], datetime.timezone)
        self.assertNotIn("datetime", self.ns)

    def test_stdlib_only(self):
        for module_name, _ in prelude.NAMES.values():
            self.assertIn(module_name.split(".")[0], sys.stdlib_module_names)

    def test_preloaded_until_rebound(self):
        self.assertTrue(prelude.is_preloaded("json", json))
        self.ns["json"] = {"a": 1}
        self.assertFalse(prelude.is_preloaded("json", self.ns["json"]))
        self.assertFalse(prelude.is_preloaded("rows", json))

    def test_repl_list_hides_them_unless_asked(self):
        self.ns["rows"] = [1]
        default = [i["name"] for i in repl_info.list_names(limit=500)["items"]]
        self.assertIn("rows", default)
        for name in prelude.NAMES:
            self.assertNotIn(name, default)
        asked = [i["name"] for i in repl_info.list_names(origin="preloaded", limit=500)["items"]]
        self.assertEqual(sorted(asked), sorted(prelude.NAMES))
        self.assertEqual([i["name"] for i in repl_info.list_names("json")["items"]], ["json"])
        self.assertEqual(repl_info.list_names(origin="user")["items"][0]["name"], "rows")

    def test_rebound_name_becomes_the_users(self):
        self.ns["Counter"] = 3
        self.assertEqual(repl_info.describe("Counter")["origin"], "user")
        self.assertNotIn("shadowed", repl_info.describe("Counter"))
        self.assertEqual(repl_info.describe("Path")["origin"], "preloaded")
        self.assertNotIn("shadowed", repl_info.describe("Path"))
        self.assertEqual(repl_info.shadowed_bindings({}), [])

    def test_not_helpers_and_not_restorable(self):
        self.assertEqual(repl_info.helpers()["items"], [])
        self.assertFalse(repl_info.restore_binding("json", {})["restored"])

    def test_info_counts_them_separately(self):
        self.ns["rows"] = [1]
        counts = repl_info.info()["bindings"]
        self.assertEqual(counts.get("preloaded"), len(prelude.NAMES))
        self.assertEqual(counts.get("user"), 1)


if __name__ == "__main__":
    unittest.main()
