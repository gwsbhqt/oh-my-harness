import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
"""Session-analysis regressions for bounded tool views and input validation."""
import json
import unittest
import dsh_kernel
from test_bridge import BASH_OK, use_cell, reply_with


class ResultSafety(unittest.IsolatedAsyncioTestCase):
    async def call(self, tool, value):
        use_cell("safety", host=reply_with(value))
        return await dsh_kernel.call_tool(tool, {})

    async def test_mutation_views_keep_full_value_without_dumping_content(self):
        value = {"path": "/tmp/a", "operation": "update", "before": "BEFORE" * 300000, "after": "AFTER" * 300000}
        for tool in ("write", "edit"):
            result = await self.call(tool, value)
            self.assertEqual(result, value)
            self.assertEqual(json.loads(json.dumps(result)), value)
            shown = repr(result)
            self.assertLess(len(shown), 1500)
            self.assertIn("/tmp/a", shown)
            self.assertIn("before", shown)
            self.assertIn("after", shown)
            self.assertNotIn("BEFORE", shown)
            self.assertNotIn("AFTER", shown)

    async def test_batch_view_is_bounded_too(self):
        use_cell("safety", host=reply_with({"path": "/tmp/a", "before": "x" * 100000, "after": "y" * 100000}))
        result = await dsh_kernel.call_tool("edit", {"file_path": "/tmp/a", "edits": [
            {"old_string": str(i), "new_string": str(i + 1)} for i in range(100)]})
        self.assertEqual(result["applied"], 100)
        self.assertEqual(len(result["results"][-1]["after"]), 100000)
        self.assertLess(len(repr(result)), 3000)
        self.assertIn("100", repr(result))

    async def test_promoted_receipt_keeps_output_and_collection_not_success(self):
        value = {"kind": "promoted", "jobId": "bash-42", "timeoutMs": 7, "output": "partial\noutput"}
        result = await self.call("bash", value)
        self.assertEqual(result, value)
        shown = repr(result)
        for text in ("promoted", "bash-42", "7ms", "partial\noutput", "`await` this value", "not a final result"):
            self.assertIn(text, shown)
        self.assertNotIn("exitCode=0", shown)

    async def test_read_view_warns_about_unknown_byte_completeness(self):
        result = await self.call("read", {"path": "/tmp/a", "offset": 1, "totalLines": 1,
            "lines": [{"number": 1, "text": "x... (line truncated to 2000 chars)"}]})
        self.assertIn("byte completeness", repr(result))
        self.assertIn("read_window", repr(result))
        with self.assertRaisesRegex(ValueError, "read.*byte completeness"):
            dsh_kernel.require_complete(result)

    def test_failed_bash_teaches_explicit_failure_analysis(self):
        with self.assertRaisesRegex(ValueError, "check_exit=False.*failed output"):
            dsh_kernel.require_complete(dict(BASH_OK, exitCode=2))
        with self.assertRaises(ValueError):
            dsh_kernel.require_complete(dict(BASH_OK, exitCode=2, stdout={"text": "tail", "truncated": True}), check_exit=False)
        with self.assertRaisesRegex(ValueError, "truncation flag"):
            dsh_kernel.require_complete(dict(BASH_OK, stdout={"text": "unknown"}))


class AbsorbedUxCoverage(unittest.IsolatedAsyncioTestCase):
    async def test_unreadable_grep_paths_are_not_hidden(self):
        value = {"matches": [{"path": "a", "lineNumber": 1, "line": "hit"}],
                 "unreadable": [{"path": "/secret", "error": "Permission denied"}], "unreadableIncomplete": True}
        use_cell("safety", host=reply_with(value))
        result = await dsh_kernel.call_tool("grep", {})
        self.assertEqual(result, value)
        shown = repr(result)
        for text in ("INCOMPLETE", "/secret", "Permission denied", "list itself"):
            self.assertIn(text, shown)

    async def test_read_limit_and_missing_path_are_not_silently_repaired(self):
        sent = []
        async def host(payload):
            sent.append(payload)
            return {"status": "error", "error": "cannot read /missing: not found"}
        use_cell("safety", host=host)
        args = {"file_path": "/missing", "limit": 5000}
        with self.assertRaises(dsh_kernel.ToolCallError):
            await dsh_kernel.call_tool("read", args)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["args"], args)

    async def test_empty_old_string_rejected_without_dispatch(self):
        sent = []
        async def host(payload):
            sent.append(payload)
            return {"status": "ok", "result": None}
        use_cell("safety", host=host)
        with self.assertRaisesRegex(dsh_kernel.ToolCallError, "no change was applied"):
            await dsh_kernel.call_tool("edit", {"file_path": "/f", "edits": [
                {"old_string": "a", "new_string": "b"}, {"old_string": "", "new_string": "insert"}]})
        self.assertEqual(sent, [])

    async def test_malformed_mutation_view_never_falls_back_to_full_dump(self):
        value = {"unexpected": "SECRET" * 100000}
        use_cell("safety", host=reply_with(value))
        result = await dsh_kernel.call_tool("write", {})
        self.assertEqual(result, value)
        self.assertLess(len(repr(result)), 1000)
        self.assertIn("unrecognized", repr(result))


class BatchPrevalidation(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_later_input_and_noop_reject_entire_batch(self):
        seen = []
        async def host(payload):
            seen.append(payload)
            return {"status": "ok", "result": {"path": "/tmp/a", "before": "a", "after": "b"}}
        use_cell("safety", host=host)
        for bad in ({"old_string": "x", "new_string": "x"}, {"old_string": 1, "new_string": "z"},
                    {"old_string": "x"}, {"old_string": "x", "new_string": "z", "replace_all": "yes"},
                    {"old_string": "x", "new_string": "z", "file_path": "/different"},
                    {"old_string": "x", "new_string": "z", "extra": float("nan")}):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(dsh_kernel.ToolCallError, "no change was applied"):
                    await dsh_kernel.call_tool("edit", {"file_path": "/tmp/a", "edits": [
                        {"old_string": "a", "new_string": "b"}, bad]})
                self.assertEqual(seen, [])


class ReadWindow(unittest.TestCase):
    def value(self, texts=("a", "b"), offset=1, total=3):
        return {"path": "/tmp/a", "offset": offset, "totalLines": total,
                "lines": [{"number": offset + i, "text": t} for i, t in enumerate(texts)]}

    def test_valid_window_returns_cursor_and_unknown_bytes(self):
        value = self.value()
        window = dsh_kernel.validate_read_window(value, offset=1, limit=10)
        self.assertEqual(window["lines"], value["lines"])
        self.assertEqual(window["next_offset"], 3)
        self.assertTrue(window["has_more"])
        self.assertEqual(window["byte_completeness"], "unknown")
        final = dsh_kernel.validate_read_window(self.value(("c",), offset=3))
        self.assertIsNone(final["next_offset"])
        self.assertFalse(final["has_more"])

    def test_rejects_known_truncation_and_bad_window(self):
        bad = [self.value(("x... (line truncated to 2000 chars)",), total=1),
               dict(self.value(), truncated=True), dict(self.value(), offset=0),
               dict(self.value(), lines=[{"number": 2, "text": "b"}]),
               dict(self.value(), lines=[]), dict(self.value(), totalLines=1)]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError):
                dsh_kernel.validate_read_window(value)
        with self.assertRaises(ValueError):
            dsh_kernel.validate_read_window(self.value(), offset=2)
        with self.assertRaises(ValueError):
            dsh_kernel.validate_read_window(self.value(), limit=1)
        empty = dsh_kernel.validate_read_window(self.value((), total=0))
        self.assertIsNone(empty["next_offset"])
