"""browser-control tab find：在当前 Chrome 中查找已加载标签；不连接真实浏览器。"""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from browser_control.engine import Engine
from browser_control.errors import BrowserControlError


class FakeCDP:
    def __init__(self, pages):
        self.pages = pages

    def call(self, method, params=None, **kwargs):
        if method == "Target.getTargets":
            return {"targetInfos": [dict(p, type="page") for p in self.pages]}
        raise AssertionError(method)


class FindTabTests(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.cdp = FakeCDP([
            {"targetId": "T-front", "url": "https://linux.do/", "title": "LINUX DO"},
            {"targetId": "T-scto", "url": "https://www.sctocloud.com/user", "title": "古歌云"},
            {"targetId": "T-lx", "url": "https://example.com/#/dashboard", "title": "良心云"},
            {"targetId": "T-lx2", "url": "https://example.com/#/shop", "title": "良心云 商店"},
        ])
        self.browser = {"cdp": self.cdp}
        self.bound = []
        patch.object(self.engine, "_bind", side_effect=lambda name, session, target, browser, **k: self.bound.append(target) or {"targetId": target, "owned": False, "browser": name, "url": "", "owner": session}).start()
        self.addCleanup(patch.stopall)

    def find(self, query):
        return self.engine._find_tab("Chrome", "s", self.browser, {"query": query})

    def test_loaded_tab_is_bound(self):
        data = self.find("古歌")
        self.assertEqual(self.bound, ["T-scto"])
        self.assertEqual(data["targetId"], "T-scto")
        self.assertEqual(data["loaded"], "already")

    def test_ambiguous_and_missing_queries_bind_nothing(self):
        with self.assertRaises(BrowserControlError) as many:
            self.find("良心云")
        self.assertEqual(many.exception.code, 2)
        self.assertEqual(len(many.exception.data["matches"]), 2)
        with self.assertRaises(BrowserControlError) as none:
            self.find("不存在的网站")
        self.assertEqual(none.exception.code, 3)
        self.assertEqual(self.bound, [])

    def test_all_words_must_match(self):
        self.find("良心云 dashboard")
        self.assertEqual(self.bound, ["T-lx"])

    def test_empty_query_rejected(self):
        for query in ("", "   ", None):
            with self.assertRaises(BrowserControlError) as exc:
                self.find(query)
            self.assertEqual(exc.exception.code, 2)
        self.assertEqual(self.bound, [])


if __name__ == "__main__":
    unittest.main()
