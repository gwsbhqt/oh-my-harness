"""Unit tests for the Python bridge module.

Run: python3 -m pytest python -q   (or: python3 python/test_bridge.py)

These test the authority and cancellation contracts on a REAL interpreter,
because their whole point is behaviour CPython version-gates.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import contextvars  # noqa: E402

import dsh_kernel  # noqa: E402

#: Stand-in for the kernel's own `rlm.repl._current_cell`. The bridge adopts
#: whatever contextvar the bootstrap hands it, so tests supply their own.
FAKE_CELL: contextvars.ContextVar = contextvars.ContextVar("_current_cell", default=None)


def use_cell(run_id, epoch=1, host=None):
    """Install the bridge against FAKE_CELL and enter the given cell."""
    async def default_host(payload):
        return {"status": "ok", "result": None}

    dsh_kernel._install(host or default_host, FAKE_CELL, epoch)
    loop = asyncio.get_running_loop()
    if loop.get_task_factory() is None:
        dsh_kernel._track_created_tasks(loop)
    FAKE_CELL.set(run_id)


class InterpreterPreconditions(unittest.TestCase):
    """The environment guarantees the bridge depends on."""

    def test_python_at_least_prime_floor(self) -> None:
        self.assertGreaterEqual(sys.version_info[:2], (3, 11), "dsh-python-repl requires Python >= 3.11")

    def test_tool_call_error_is_not_baseexception_only(self) -> None:
        # Load-bearing: `except ToolCallError` must NOT catch CancelledError.
        self.assertTrue(issubclass(dsh_kernel.ToolCallError, Exception))
        self.assertFalse(issubclass(asyncio.CancelledError, Exception))
        try:
            raise asyncio.CancelledError()
        except dsh_kernel.ToolCallError:  # pragma: no cover - must not run
            self.fail("ToolCallError caught a CancelledError")
        except asyncio.CancelledError:
            pass


class ToolCallErrorContract(unittest.TestCase):
    def test_carries_tool_name_and_message(self) -> None:
        err = dsh_kernel.ToolCallError("echo", "boom")
        self.assertEqual(err.toolName, "echo")
        self.assertEqual(str(err), "boom")

    def test_has_no_invented_retry_fields(self) -> None:
        # The host supplies no such semantics; inventing them would invite
        # callers to auto-retry side effects.
        err = dsh_kernel.ToolCallError("echo", "boom")
        for forbidden in ("retryable", "idempotent", "payload", "arguments"):
            self.assertFalse(hasattr(err, forbidden), f"unexpected field {forbidden}")


class CellAttribution(unittest.IsolatedAsyncioTestCase):
    """Run-id attribution and background-task failure reports."""

    async def test_descendant_tasks_inherit_creating_cell(self) -> None:
        owners = {}

        async def leaf() -> None:
            owners["grandchild"] = FAKE_CELL.get()
            await asyncio.sleep(10)

        async def mid() -> None:
            owners["child"] = FAKE_CELL.get()
            asyncio.create_task(leaf(), name="grandchild")
            await asyncio.sleep(10)

        use_cell("cell-1")
        asyncio.create_task(mid(), name="child")
        await asyncio.sleep(0.01)
        FAKE_CELL.set("cell-2")

        self.assertEqual(owners.get("child"), "cell-1")
        self.assertEqual(
            owners.get("grandchild"), "cell-1", "a task created BY a cell task must inherit the cell"
        )
        for task in asyncio.all_tasks():
            if task is not asyncio.current_task():
                task.cancel()

    async def test_failed_task_nobody_awaited_is_reported_once_from_any_cell(self) -> None:
        """Tasks outlive their cell, as in Prime, so a failure is found wherever it came from."""

        async def write_report() -> None:
            raise OSError("disk full")

        use_cell("cell-1")
        kept = asyncio.create_task(write_report(), name="report")
        await asyncio.sleep(0.01)
        FAKE_CELL.set("cell-2")

        self.assertEqual(dsh_kernel._unretrieved_failures(), ["report (write_report): OSError: disk full"])
        self.assertEqual(dsh_kernel._unretrieved_failures(), [], "reported once")
        self.assertIsInstance(kept.exception(), OSError, "reporting must not consume the error")

    async def test_failure_already_retrieved_is_not_reported(self) -> None:
        async def fail() -> None:
            raise ValueError("x")

        use_cell("cell-1")
        seen = asyncio.create_task(fail(), name="seen")
        await asyncio.sleep(0.01)
        seen.exception()

        self.assertEqual(dsh_kernel._unretrieved_failures(), [])

    async def test_failure_names_what_an_unnamed_task_was_running(self) -> None:
        """`Task-43` tells the model nothing; the function it wrote does."""

        async def fetch_later() -> None:
            raise RuntimeError("gone")

        use_cell("cell-1")
        kept = asyncio.create_task(fetch_later())  # noqa: F841 - tracked weakly, as a cell's variable would hold it
        await asyncio.sleep(0.01)

        failed = dsh_kernel._unretrieved_failures()
        self.assertEqual(len(failed), 1)
        self.assertRegex(failed[0], r"^Task-\d+ \(fetch_later\): RuntimeError: gone$")

    async def test_tool_call_without_cell_context_fails_closed(self) -> None:
        use_cell("cell-1")
        FAKE_CELL.set(None)
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("echo", {})
        self.assertIn("no active cell context", str(caught.exception))

    async def test_tool_call_tags_current_cell(self) -> None:
        seen: list[dict] = []

        async def fake_host(payload):
            seen.append(payload)
            return {"status": "ok", "result": {"ok": True}}

        use_cell("cell-42", epoch=7, host=fake_host)
        result = await dsh_kernel.call_tool("echo", {"text": "hi"})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(seen[0]["runId"], "cell-42")
        self.assertEqual(seen[0]["epoch"], 7)
        self.assertEqual(seen[0]["tool"], "echo")
        self.assertEqual(seen[0]["kind"], "tool_call")

    async def test_cancellation_envelope_raises_cancelled_not_tool_error(self) -> None:
        """A cancelled tool call must not be catchable as a per-item failure."""

        async def fake_host(payload):
            return {"status": "error", "error": "aborted", "cancelled": True}

        use_cell("cell-1", host=fake_host)
        with self.assertRaises(asyncio.CancelledError):
            await dsh_kernel.call_tool("echo", {})

    async def test_host_error_envelope_becomes_tool_call_error(self) -> None:
        async def fake_host(payload):
            return {"status": "error", "error": "denied"}

        use_cell("cell-1", host=fake_host)
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("echo", {})
        self.assertEqual(caught.exception.toolName, "echo")
        self.assertEqual(str(caught.exception), "denied")

    async def test_unwraps_the_host_reply_envelope(self) -> None:
        """Regression: host_request returns {"status","result"}, not the value.

        Returning the envelope verbatim silently handed cell code a dict with
        'status'/'result' keys instead of the tool's canonical JSON, and made
        every failure look like success.
        """

        async def fake_host(payload):
            return {"status": "ok", "result": {"echoed": {"text": "hi"}}}

        use_cell("cell-1", host=fake_host)
        result = await dsh_kernel.call_tool("echo", {"text": "hi"})
        self.assertEqual(result, {"echoed": {"text": "hi"}})
        self.assertNotIn("status", result)

    async def test_malformed_reply_fails_loudly(self) -> None:
        async def fake_host(payload):
            return "not a dict"

        use_cell("cell-1", host=fake_host)
        with self.assertRaises(dsh_kernel.ToolCallError):
            await dsh_kernel.call_tool("echo", {})

    async def test_persistent_function_resolves_against_calling_cell(self) -> None:
        """A function defined in cell 1 and called in cell 2 must use cell 2.

        This is the counterpart of the stale-task rule: proxies must NOT
        capture the defining cell's authority.
        """
        seen: list[str] = []

        async def fake_host(payload):
            seen.append(payload["runId"])
            return {"status": "ok", "result": None}

        use_cell("cell-1", host=fake_host)

        async def helper():
            return await dsh_kernel.call_tool("echo", {})

        FAKE_CELL.set("cell-2")
        await helper()
        self.assertEqual(seen, ["cell-2"])


class NamespaceAccess(unittest.TestCase):
    """Dotted access for ordinary names, subscript for the awkward ones."""

    def setUp(self) -> None:
        self.ns = dsh_kernel._Namespace("tools")
        self.ns._put("echo", dsh_kernel._ToolProxy("echo"))
        self.ns._put("list", dsh_kernel._ToolProxy("list"))
        self.ns._put("my-tool", dsh_kernel._ToolProxy("my-tool"))

    def test_dotted_access_for_ordinary_name(self) -> None:
        self.assertIsInstance(self.ns.echo, dsh_kernel._ToolProxy)

    def test_meta_method_wins_dotted_access(self) -> None:
        # `tools.list` is the meta interface even when a tool is named "list".
        self.assertTrue(callable(self.ns.list))
        self.assertFalse(isinstance(self.ns.list, dsh_kernel._ToolProxy))

    def test_subscript_reaches_shadowed_business_tool(self) -> None:
        self.assertIsInstance(self.ns["list"], dsh_kernel._ToolProxy)

    def test_subscript_reaches_non_identifier_name(self) -> None:
        self.assertIsInstance(self.ns["my-tool"], dsh_kernel._ToolProxy)

    def test_unknown_member_error_is_actionable(self) -> None:
        with self.assertRaises(AttributeError) as caught:
            _ = self.ns.nope
        self.assertIn("list()", str(caught.exception))

    def test_dir_includes_meta_and_members(self) -> None:
        names = dir(self.ns)
        self.assertIn("echo", names)
        self.assertIn("describe", names)

    def test_subscripting_a_meta_name_with_no_such_member_points_at_the_method(self) -> None:
        ns = dsh_kernel._Namespace("tools", {"echo": dsh_kernel._ToolProxy("echo")})
        with self.assertRaises(KeyError) as caught:
            ns["list"]
        self.assertIn("await tools.list(...)", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class DocumentedApiActuallyExists(unittest.TestCase):
    """Whatever the module docstring tells a skill author to import must work.

    The docstring previously advertised `from dsh_kernel import tools, bash`,
    which raised ImportError: `bash` is a REPL top-level convenience, not a
    bridge export (review, "other gaps" #4).
    """

    def test_every_documented_import_resolves(self) -> None:
        import inspect
        import re

        doc = inspect.getdoc(dsh_kernel) or ""
        promised = re.findall(r"from dsh_kernel import ([\w, ]+)", doc)
        self.assertTrue(promised, "the docstring must show how to reach DSH capability")
        for group in promised:
            for name in (n.strip() for n in group.split(",")):
                with self.subTest(name=name):
                    self.assertTrue(
                        hasattr(dsh_kernel, name),
                        f"docstring promises `{name}` but the module does not export it",
                    )

    def test_top_level_tool_names_are_not_bridge_exports(self) -> None:
        # They are REPL namespace conveniences; importing them here must fail
        # loudly rather than appear to work.
        for name in ("read", "write", "edit", "bash", "glob", "grep"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(dsh_kernel, name))


def reply_with(value):
    async def fake_host(payload):
        return {"status": "ok", "result": value}

    return fake_host


BASH_OK = {
    "kind": "foreground", "exitCode": 0, "signal": None, "timedOut": False, "aborted": False,
    "timeoutMs": 120000,
    "stdout": {"text": "line one\nline two\n", "truncated": False},
    "stderr": {"text": "", "truncated": False},
}


class CompleteBashOutput(unittest.TestCase):
    def test_complete_success_preserves_original_text(self) -> None:
        result = dict(BASH_OK)
        self.assertEqual(dsh_kernel.require_complete(result), "line one\nline two\n")
        self.assertEqual(dsh_kernel.require_complete(result, "stderr"), "")
        self.assertEqual(result, BASH_OK)

    def test_truncated_tail_never_claims_completeness(self) -> None:
        result = dict(BASH_OK, stdout={"text": "JSON tail", "truncated": True, "spillPath": "/tmp/full"})
        with self.assertRaisesRegex(ValueError, "truncated.*full output path: /tmp/full"):
            dsh_kernel.require_complete(result)
        self.assertEqual(result["stdout"]["text"], "JSON tail")

    def test_missing_spill_still_rejects_tail(self) -> None:
        result = dict(BASH_OK, stdout={"text": "tail", "truncated": True})
        with self.assertRaisesRegex(ValueError, "not reported"):
            dsh_kernel.require_complete(result)

    def test_failed_and_interrupted_results_need_explicit_inspection(self) -> None:
        for changed in ({"exitCode": 2}, {"timedOut": True}, {"aborted": True}, {"signal": "SIGTERM"}):
            result = dict(BASH_OK, **changed)
            with self.assertRaises(ValueError):
                dsh_kernel.require_complete(result)
        self.assertEqual(dsh_kernel.require_complete(dict(BASH_OK, exitCode=2), check_exit=False), BASH_OK["stdout"]["text"])

    def test_stopped_result_is_not_complete_even_with_zero_exit(self) -> None:
        with self.assertRaisesRegex(ValueError, "finish normally"):
            dsh_kernel.require_complete(dict(BASH_OK, stopped="executor interrupted"), check_exit=False)

    def test_missing_or_mistyped_completion_metadata_is_rejected(self) -> None:
        for field in ("timedOut", "aborted"):
            missing = dict(BASH_OK)
            del missing[field]
            for result in (missing, *(dict(BASH_OK, **{field: v}) for v in (None, 0, "false"))):
                with self.subTest(field=field, value=result.get(field, "missing")), self.assertRaises(ValueError):
                    dsh_kernel.require_complete(result, check_exit=False)
        for code in (None, False, True, "0"):
            with self.subTest(exitCode=code), self.assertRaises(ValueError):
                dsh_kernel.require_complete(dict(BASH_OK, exitCode=code), check_exit=False)

    def test_rejects_background_and_malformed_stream(self) -> None:
        for result in ({"kind": "background", "jobId": "bash-1"}, dict(BASH_OK, stdout={"text": None})):
            with self.assertRaises(ValueError):
                dsh_kernel.require_complete(result)
        with self.assertRaises(ValueError):
            dsh_kernel.require_complete(BASH_OK, "not-a-stream")


class ToolResultViews(unittest.IsolatedAsyncioTestCase):
    """Readable displays for canonical results.

    The kernel shows a trailing value with repr(); a raw dict repr buried the
    exit status and truncation flags, so the model hand-printed stdout in most
    cells and never checked them. The value must stay an ordinary dict.
    """

    async def call(self, tool, value, args=None):
        use_cell("cell-1", host=reply_with(value))
        return await dsh_kernel.call_tool(tool, args or {})

    async def test_value_is_still_the_canonical_dict(self) -> None:
        import json

        result = await self.call("bash", dict(BASH_OK))
        self.assertIsInstance(result, dict)
        self.assertEqual(result, BASH_OK)
        self.assertEqual(json.loads(json.dumps(result)), BASH_OK)
        self.assertEqual(result["stdout"]["text"], "line one\nline two\n")

    async def test_bash_view_leads_with_exit_status_and_keeps_newlines(self) -> None:
        text = repr(await self.call("bash", dict(BASH_OK)))
        first = text.splitlines()[0]
        self.assertIn("exitCode=0", first)
        self.assertIn("view of a dict", first)
        self.assertIn("line one\nline two", text)
        self.assertEqual(str(await self.call("bash", dict(BASH_OK))), text)

    async def test_an_empty_glob_says_how_slash_patterns_match(self) -> None:
        empty = {"paths": [], "root": "/w", "truncated": False}
        use_cell("cell-1", host=reply_with(dict(empty)))
        below = repr(await dsh_kernel.call_tool("glob", {"pattern": "*/package.json", "path": "pkgs"}))
        self.assertIn("`**/*/package.json`", below)
        use_cell("cell-1", host=reply_with(dict(empty)))
        absolute = repr(await dsh_kernel.call_tool("glob", {"pattern": "/w/pkgs/*/package.json"}))
        self.assertIn("pass the directory as `path`", absolute)
        use_cell("cell-1", host=reply_with(dict(empty)))
        from_root = repr(await dsh_kernel.call_tool("glob", {"pattern": "src/*.ts"}))
        self.assertNotIn("matched from the workspace root", from_root)

    async def test_a_promoted_bash_result_says_where_its_output_is(self) -> None:
        result = await self.call("bash", {"kind": "promoted", "jobId": "job-7", "timeoutMs": 120000, "output": "partial"})
        with self.assertRaises(KeyError) as caught:
            result["stdout"]
        self.assertIn("job_output", str(caught.exception))
        self.assertIn("job-7", str(caught.exception))
        self.assertIsNone(result.get("stdout"))
        with self.assertRaises(KeyError) as plain:
            (await self.call("bash", dict(BASH_OK)))["missing"]
        # Still a KeyError (`.get` and `in` are unchanged); the message names the key and the keys that exist.
        self.assertIn("'missing' is not a key of this tool result", str(plain.exception))
        self.assertIn("'exitCode'", str(plain.exception))

    async def test_bash_view_surfaces_failure_stderr_and_truncation(self) -> None:
        value = dict(BASH_OK, exitCode=None, signal="SIGTERM", timedOut=True, timeoutMs=60000)
        value["stdout"] = {"text": "tail\n", "truncated": True, "spillPath": "/spill/1.txt"}
        value["stderr"] = {"text": "boom\n", "truncated": False}
        text = repr(await self.call("bash", value))
        self.assertIn("exitCode=None", text)
        self.assertIn("signal=SIGTERM", text)
        self.assertIn("TIMED OUT after 60000ms", text)
        self.assertIn("[stderr]\nboom", text)
        self.assertIn("truncated to its tail; full output: /spill/1.txt", text)

    async def test_bash_background_view_says_how_to_collect(self) -> None:
        text = repr(await self.call("bash", {"kind": "background", "jobId": "bash-7"}))
        self.assertIn("bash-7", text)
        # Collect after DSH wakes the agent; never block a cell for it.
        self.assertIn("DSH wakes you when it finishes", text)
        self.assertNotIn("timeout_ms", text)

    async def test_read_view_numbers_lines_and_points_at_the_rest(self) -> None:
        value = {"path": "/w/a.txt", "offset": 1, "totalLines": 5,
                 "lines": [{"number": 1, "text": "alpha"}, {"number": 2, "text": "beta"}]}
        text = repr(await self.call("read", value))
        self.assertIn("lines 1-2 of 5", text)
        self.assertIn("1: alpha\n2: beta", text)
        self.assertIn("offset=3", text)

    async def test_existing_keys_read_by_attribute_too(self) -> None:
        # 2026-11-03 maintenance sessions failed on `r.totalLines`, `files.paths`, `g.matches`, `job.jobId`.
        read = await self.call("read", {"path": "/w/a.txt", "offset": 1, "totalLines": 5,
                                        "lines": [{"number": 1, "text": "alpha"}]})
        self.assertEqual(read.totalLines, 5)
        self.assertEqual(read.lines[-1]["number"], 1)
        self.assertEqual(read.lines[-1].text, "alpha")
        self.assertEqual(read.text, "alpha")
        self.assertEqual((await self.call("glob", {"paths": ["/w/a"], "root": "/w"})).paths, ["/w/a"])
        self.assertEqual((await self.call("grep", {"matches": []})).matches, [])
        bash = await self.call("bash", dict(BASH_OK))
        self.assertEqual(bash.stdout.text, "line one\nline two\n")
        self.assertEqual(bash.stderr.text, "")
        self.assertIsInstance(bash.stdout, dict)
        job = await self.call("job_output", {"text": "", "job": {
            "id": "job-attr", "kind": "bash", "label": "x", "status": "completed", "startedAt": 1,
        }})
        self.assertEqual(job.job.status, "completed")
        self.assertEqual(dsh_kernel.BashJob("j-attr", "make").jobId, "j-attr")
        with self.assertRaises(AttributeError) as missing:
            read.exitCode
        self.assertIn("'totalLines'", str(missing.exception))
        self.assertFalse(hasattr(read, "__deepcopy_hook__"))
        promoted = await self.call("bash", {"kind": "promoted", "jobId": "job-8", "timeoutMs": 1, "output": ""})
        with self.assertRaises(AttributeError) as running:
            promoted.stdout
        self.assertIn("job_output", str(running.exception))

    async def test_empty_grep_view_warns_that_absence_is_not_proven(self) -> None:
        text = repr(await self.call("grep", {"matches": []}))
        self.assertIn("0 matches", text)
        self.assertIn("selected search scope", text)

    async def test_grep_view_lists_path_line_text(self) -> None:
        value = {"matches": [{"path": "a.fish", "lineNumber": 3, "line": "set -gx X"}]}
        self.assertIn("a.fish:3: set -gx X", repr(await self.call("grep", value)))

    async def test_grep_view_shows_requested_scope_without_changing_result(self) -> None:
        value = {"matches": [{"path": ".hidden/a.fish", "lineNumber": 1, "line": "found"}]}
        for requested, expected in (({}, "normal"), ({"scope": "all"}, "all")):
            with self.subTest(scope=expected):
                result = await self.call("grep", value, requested)
                self.assertIn(f"scope={expected}", repr(result))
                self.assertEqual(result, value)
                self.assertEqual(list(result), ["matches"])

    async def test_big_grep_is_capped_in_the_view_but_complete_in_the_value(self) -> None:
        # Field regression 2026-09-23: a cell's `grep e` printed all 6519 matches.
        matches = [{"path": f"f{i % 40}.txt", "lineNumber": i, "line": "e" * (1000 if i == 0 else 3)} for i in range(6519)]
        result = await self.call("grep", {"matches": matches})
        text = repr(result)
        self.assertEqual(len(result["matches"]), 6519)
        self.assertIn("6519 matches in 40 files", text)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("f")), 250)
        self.assertIn("… 6269 more not shown", text)
        self.assertIn("r['matches'][250:]", text)
        self.assertIn("… (1000 chars)", text)
        self.assertLess(len(text), 20_000)

    async def test_big_glob_is_capped_in_the_view(self) -> None:
        paths = [f"p{i}" for i in range(500)]
        result = await self.call("glob", {"paths": paths, "root": "/r"})
        text = repr(result)
        self.assertEqual(len(result["paths"]), 500)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("p")), 100)
        self.assertIn("… 400 more not shown", text)

    async def test_job_output_view_shows_detail_and_running_state(self) -> None:
        done = {"text": "fatal: nope\n", "job": {"id": "bash-5", "kind": "bash", "label": "git",
                                                  "status": "completed", "detail": "exit code: 128"}}
        text = repr(await self.call("job_output", done))
        self.assertIn("status=completed · exit code: 128", text)
        running = {"text": "", "job": {"id": "bash-2", "kind": "bash", "label": "x", "status": "running"}}
        text = repr(await self.call("job_output", running))
        self.assertIn("still running", text)
        self.assertIn("no new output", text)

    async def test_unknown_shape_falls_back_to_the_raw_repr(self) -> None:
        result = await self.call("bash", {"unexpected": True})
        self.assertEqual(repr(result), "{'unexpected': True}")

    async def test_other_tools_are_untouched(self) -> None:
        result = await self.call("echo", {"a": 1})
        self.assertIs(type(result), dict)

    async def test_view_survives_pickling(self) -> None:
        import pickle

        result = await self.call("bash", dict(BASH_OK))
        clone = pickle.loads(pickle.dumps(result))
        self.assertEqual(clone, BASH_OK)
        self.assertEqual(repr(clone), repr(result))

class DisplayHint(unittest.TestCase):
    """`display()` is IPython's; here it is a plain NameError (10 GPT cells, 2026-10-08)."""

    def module(self):
        import traceback
        import types

        mod = types.ModuleType("fake_repl")

        def _error_event(cell_id, exc):
            lines = list(traceback.TracebackException.from_exception(exc).format())
            return {"event": "error", "id": cell_id, "ename": type(exc).__name__, "evalue": str(exc), "traceback": lines}

        mod._error_event = _error_event
        dsh_kernel._hint_name_errors(mod)
        return mod

    def event(self, mod, code):
        try:
            exec(code, {})
        except BaseException as exc:  # noqa: BLE001
            return mod._error_event("c1", exc)
        self.fail("code did not raise")

    def test_display_name_error_gets_the_hint(self) -> None:
        mod = self.module()
        text = "".join(self.event(mod, "display(1)")["traceback"])
        self.assertIn("NameError: name 'display' is not defined", text)
        self.assertIn("This is not IPython", text)
        self.assertIn("print()", text)

    def test_other_errors_are_untouched(self) -> None:
        mod = self.module()
        for code in ("displayed(1)", "x = undefined_thing", "raise ValueError('display')"):
            with self.subTest(code=code):
                self.assertNotIn("not IPython", "".join(self.event(mod, code)["traceback"]))

    def test_wrapping_twice_adds_one_hint(self) -> None:
        mod = self.module()
        dsh_kernel._hint_name_errors(mod)
        self.assertEqual("".join(self.event(mod, "display(1)")["traceback"]).count("not IPython"), 1)

    def test_display_is_not_predefined(self) -> None:
        self.assertFalse(hasattr(dsh_kernel, "display"))


class BashStdin(unittest.IsolatedAsyncioTestCase):
    """`bash({"command", "stdin"})`: the host tool has no stdin (field 2026-09-23).

    The rewritten command is run by a real /bin/bash here, so the quoting is
    proven rather than pattern-matched.
    """

    async def sent(self, args):
        seen = []

        async def fake_host(payload):
            seen.append(payload["args"])
            return {"status": "ok", "result": None}

        use_cell("cell-1", host=fake_host)
        await dsh_kernel.call_tool("bash", args)
        return seen[0]

    def run_bash(self, command):
        import subprocess

        return subprocess.run(["/bin/bash", "-c", command], capture_output=True, text=True, check=True).stdout

    async def test_stdin_reaches_the_command_verbatim(self) -> None:
        text = "echo '$HOME' \"$(whoami)\" `x` \\\\ done\nline two"
        args = await self.sent({"command": "cat", "stdin": text, "description": "d"})
        self.assertNotIn("stdin", args)
        self.assertEqual(args["description"], "d")
        self.assertEqual(self.run_bash(args["command"]), text + "\n")

    async def test_a_trailing_newline_is_not_doubled(self) -> None:
        args = await self.sent({"command": "cat", "stdin": "a\nb\n"})
        self.assertEqual(self.run_bash(args["command"]), "a\nb\n")

    async def test_delimiter_collision_and_compound_commands(self) -> None:
        text = "DSH_STDIN\nDSH_STDIN_1\n"
        args = await self.sent({"command": "echo start; cat; echo end", "stdin": text})
        self.assertEqual(self.run_bash(args["command"]), "start\n" + text + "end\n")

    async def test_other_tools_and_absent_stdin_are_untouched(self) -> None:
        original = {"command": "true"}
        self.assertIs(dsh_kernel._with_stdin("bash", original), original)
        self.assertEqual(dsh_kernel._with_stdin("read", {"stdin": "x"}), {"stdin": "x"})
        self.assertEqual(dsh_kernel._with_stdin("bash", {"command": "true", "stdin": None}), {"command": "true"})

    async def test_non_string_stdin_is_rejected(self) -> None:
        use_cell("cell-1")
        with self.assertRaises(dsh_kernel.ToolCallError):
            await dsh_kernel.call_tool("bash", {"command": "cat", "stdin": b"bytes"})


class EditMany(unittest.IsolatedAsyncioTestCase):
    """`edit` with `edits`: several changes, each one host `edit` under its policy."""

    def host(self, fail_at=None):
        self.sent = []

        async def fake_host(payload):
            self.sent.append(payload["args"])
            if fail_at is not None and len(self.sent) == fail_at:
                return {"status": "error", "error": "old_string not found"}
            return {"status": "ok", "result": {"ok": len(self.sent)}}

        use_cell("cell-1", host=fake_host)

    async def test_changes_go_one_by_one_in_order(self) -> None:
        self.host()
        out = await dsh_kernel.call_tool("edit", {"file_path": "/f", "edits": [
            {"old_string": "a", "new_string": "b"},
            {"old_string": "c", "new_string": "d", "replace_all": True},
        ]})
        self.assertEqual(self.sent, [
            {"file_path": "/f", "old_string": "a", "new_string": "b"},
            {"file_path": "/f", "old_string": "c", "new_string": "d", "replace_all": True},
        ])
        self.assertEqual(out["applied"], 2)

    async def test_first_failure_stops_and_says_what_is_applied(self) -> None:
        self.host(fail_at=2)
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("edit", {"file_path": "/f", "edits": [
                {"old_string": "a", "new_string": "b"},
                {"old_string": "x", "new_string": "y"},
                {"old_string": "c", "new_string": "d"},
            ]})
        self.assertEqual(len(self.sent), 2)
        message = str(caught.exception)
        self.assertIn("change 2 of 3 failed", message)
        self.assertIn("changes 1-1 are applied", message)
        self.assertIn("old_string not found", message)

    async def test_bad_edits_are_rejected_before_anything_is_sent(self) -> None:
        self.host()
        for bad in ([], "a->b", [{"old_string": "a", "new_string": "b"}, "c"]):
            with self.assertRaises(dsh_kernel.ToolCallError):
                await dsh_kernel.call_tool("edit", {"file_path": "/f", "edits": bad})
        self.assertEqual(self.sent, [])

    def file(self, text: str, name: str = "f.txt") -> str:
        """A real file holding `text`, removed after the test; returns its path."""
        import tempfile

        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / name
        path.write_bytes(text.encode("utf-8"))
        return str(path)

    async def test_a_later_mismatch_rejects_the_whole_batch_before_dispatch(self) -> None:
        self.host()
        path = self.file("alpha\nbeta\n")
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
                {"old_string": "alpha", "new_string": "ALPHA"},
                {"old_string": "gamma", "new_string": "GAMMA"},
            ]})
        self.assertEqual(self.sent, [])
        message = str(caught.exception)
        self.assertIn("no change was applied", message)
        self.assertIn("change 2 of 2", message)
        self.assertIn("not found", message)

    async def test_a_change_may_match_text_an_earlier_change_wrote(self) -> None:
        self.host()
        path = self.file("one\r\ntwo\r\n")
        out = await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
            {"old_string": "one\r\n", "new_string": "first\nmarker\n"},
            {"old_string": "marker\ntwo", "new_string": "second"},
        ]})
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(out["applied"], 2)

    async def test_an_ambiguous_change_without_replace_all_rejects_the_batch(self) -> None:
        self.host()
        path = self.file("x = 1\nx = 1\ny = 2\n")
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
                {"old_string": "y = 2", "new_string": "y = 3"},
                {"old_string": "x = 1", "new_string": "x = 0"},
            ]})
        self.assertEqual(self.sent, [])
        self.assertIn("matches 2 places", str(caught.exception))
        self.assertIn("no change was applied", str(caught.exception))
        await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
            {"old_string": "x = 1", "new_string": "x = 0", "replace_all": True},
        ]})
        self.assertEqual(len(self.sent), 1)

    async def test_a_nul_in_new_string_rejects_the_batch_before_dispatch(self) -> None:
        self.host()
        path = self.file("alpha\nbeta\ngamma\n")
        with self.assertRaises(dsh_kernel.ToolCallError) as caught:
            await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
                {"old_string": "alpha", "new_string": "ALPHA"},
                {"old_string": "beta", "new_string": 'if "\x00" in name:'},
                {"old_string": "gamma", "new_string": "GAMMA"},
            ]})
        self.assertEqual(self.sent, [])
        message = str(caught.exception)
        self.assertIn("no change was applied", message)
        self.assertIn("change 2 new_string contains a NUL", message)
        out = await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
            {"old_string": "beta", "new_string": r'if "\x00" in name:'},
        ]})
        self.assertEqual(out["applied"], 1)

    async def test_relative_paths_resolve_against_the_declared_workspace(self) -> None:
        import os
        from unittest import mock

        self.host()
        path = Path(self.file("alpha\n", name="rel.txt"))
        with mock.patch.dict(os.environ, {"DSH_PYTHON_REPL_WORKSPACE": str(path.parent)}):
            with self.assertRaises(dsh_kernel.ToolCallError):
                await dsh_kernel.call_tool("edit", {"file_path": "rel.txt", "edits": [
                    {"old_string": "missing", "new_string": "x"},
                ]})
        self.assertEqual(self.sent, [])

    async def test_unreadable_files_fall_back_to_dispatching_one_by_one(self) -> None:
        not_utf8 = self.file("")
        Path(not_utf8).write_bytes(b"\xff\xfe old \x80")
        for path in ("/definitely/not/here.txt", not_utf8):
            self.host(fail_at=2)
            with self.assertRaises(dsh_kernel.ToolCallError) as caught:
                await dsh_kernel.call_tool("edit", {"file_path": path, "edits": [
                    {"old_string": "old", "new_string": "new"},
                    {"old_string": "gone", "new_string": "x"},
                ]})
            self.assertEqual(len(self.sent), 2)
            self.assertIn("changes 1-1 are applied", str(caught.exception))


class CallForms(unittest.IsolatedAsyncioTestCase):
    """A tool takes one dict, keyword arguments, or (six tools) positional values."""

    async def asyncSetUp(self) -> None:
        self.sent = []

        async def host(payload):
            self.sent.append((payload["tool"], payload["args"]))
            return {"status": "ok", "result": None}

        use_cell("run-forms", host=host)

    async def test_dict_keywords_and_positionals_send_the_same_payload(self) -> None:
        read = dsh_kernel._proxy("read")
        await read({"file_path": "a.txt", "limit": 3})
        await read(file_path="a.txt", limit=3)
        await read("a.txt", limit=3)
        await read(Path("a.txt"), limit=3)
        self.assertEqual([args for _, args in self.sent], [{"file_path": "a.txt", "limit": 3}] * 4)

    async def test_bash_positionals_follow_command_then_description(self) -> None:
        await dsh_kernel._proxy("bash")("ls", "列出文件")
        self.assertEqual(self.sent, [("bash", {"command": "ls", "description": "列出文件"})])

    async def test_dict_plus_keywords_merge_and_duplicates_fail(self) -> None:
        bash = dsh_kernel._proxy("bash")
        await bash({"command": "ls"}, description="d")
        self.assertEqual(self.sent[-1][1], {"command": "ls", "description": "d"})
        with self.assertRaisesRegex(TypeError, "command twice"):
            bash({"command": "ls"}, command="pwd")

    def test_positionals_are_refused_where_no_order_exists(self) -> None:
        with self.assertRaisesRegex(TypeError, "one dict of arguments or keyword arguments"):
            dsh_kernel._proxy("web_fetch")("https://example.com")
        with self.assertRaisesRegex(TypeError, "at most 1 positional"):
            dsh_kernel._proxy("read")("a", "b")

    async def test_no_arguments_send_an_empty_object(self) -> None:
        job_list = dsh_kernel._proxy("job_list")
        await job_list()
        await job_list(None)
        self.assertEqual(self.sent, [("job_list", {}), ("job_list", {})])


class BashJobs(unittest.IsolatedAsyncioTestCase):
    """bash.start returns at once; awaiting the handle gathers all output."""

    async def test_start_then_await_collects_streamed_text_and_exit_code(self) -> None:
        sent = []
        replies = [
            {"kind": "background", "jobId": "j1"},
            {"text": "a\n", "job": {"id": "j1", "status": "running"}},
            {"text": "b\n[stderr]\nboom\n", "job": {"id": "j1", "status": "completed", "detail": "exit code: 2"}},
        ]

        async def host(payload):
            sent.append((payload["tool"], payload["args"]))
            return {"status": "ok", "result": replies.pop(0)}

        use_cell("run-job", host=host)
        job = await dsh_kernel._proxy("bash").start("make", "构建")
        self.assertIsInstance(job, dsh_kernel.BashJob)
        self.assertEqual(sent[0], ("bash", {"command": "make", "description": "构建", "run_in_background": True}))
        result = await job
        self.assertEqual(result["exitCode"], 2)
        self.assertEqual(result["text"], "a\nb\n[stderr]\nboom\n")
        self.assertEqual([tool for tool, _ in sent], ["bash", "job_output", "job_output"])
        self.assertIs(await job, result)
        self.assertIn("exitCode=2", repr(result))

    async def test_user_message_ends_the_wait_after_one_call(self) -> None:
        # Field regression 2026-11-08: with a user message queued, DSH returns every
        # wait at once; the loop asked again 11737 times in 10 s and froze the session view.
        sent = []

        async def host(payload):
            sent.append(payload)
            return {"status": "ok", "result": {"text": "", "job": {"id": "j5", "status": "running", "detail": "user steered"}}}

        use_cell("run-job5", host=host)
        with self.assertRaises(dsh_kernel.JobStillRunning) as caught:
            await dsh_kernel.BashJob("j5", "hermes chat").wait()
        self.assertEqual(len(sent), 1)
        self.assertIn("user just sent a message", str(caught.exception))

    async def test_missing_exit_code_stays_none(self) -> None:
        async def host(payload):
            return {"status": "ok", "result": {"text": "", "job": {"id": "j", "status": "killed", "detail": "killed by user"}}}

        use_cell("run-job2", host=host)
        result = await dsh_kernel.BashJob("j", "sleep 9").wait()
        self.assertIsNone(result["exitCode"])
        self.assertIn("status=killed", repr(result))

    async def test_output_read_outside_the_handle_still_reaches_await_job(self) -> None:
        # Observed in code review: DSH hands each piece of output out once, so a
        # direct tools.job_output progress check used to take it from `await job`.
        replies = [
            {"text": "step 1\n", "job": {"id": "j3", "status": "running"}},
            {"text": "step 2\n", "job": {"id": "j3", "status": "running"}},
            {"text": "done\n", "job": {"id": "j3", "status": "completed", "detail": "exit code: 0"}},
        ]

        async def host(payload):
            return {"status": "ok", "result": replies.pop(0)}

        use_cell("run-job3", host=host)
        job = dsh_kernel.BashJob("j3", "make")
        await dsh_kernel.call_tool("job_output", {"job_id": "j3"})
        self.assertEqual(await job.peek(), "step 1\nstep 2\n")
        result = await job
        self.assertEqual(result["text"], "step 1\nstep 2\ndone\n")
        self.assertEqual(await job.peek(), result["text"], "peek after the end does not call the host again")

    async def test_unrelated_job_output_is_left_alone(self) -> None:
        async def host(payload):
            return {"status": "ok", "result": {"text": "x", "job": {"id": "other", "status": "running"}}}

        use_cell("run-job4", host=host)
        job = dsh_kernel.BashJob("j4", "make")
        await dsh_kernel.call_tool("job_output", {"job_id": "other"})
        self.assertEqual(job._text, [])

    async def test_only_the_newest_finished_jobs_stay_and_an_old_one_says_why(self) -> None:
        # Code review 2026-11-09: every promoted job stayed in the kernel, output twice, until the kernel died.
        async def host(payload):
            job_id = payload["args"]["job_id"]
            return {"status": "ok", "result": {"text": f"out {job_id}\n", "job": {"id": job_id, "status": "completed", "detail": "exit code: 0"}}}

        use_cell("run-cap", host=host)
        keep = dsh_kernel._KEEP_FINISHED
        results = [await dsh_kernel._BashResult(kind="promoted", jobId=f"cap-{i}", output="") for i in range(keep + 3)]
        self.assertEqual(results[-1]["text"], f"out cap-{keep + 2}\n")
        finished = [job_id for job_id in dsh_kernel._HANDLES if job_id.startswith("cap-")]
        self.assertEqual(len(finished), keep)
        self.assertNotIn("cap-0", dsh_kernel._HANDLES)
        self.assertTrue(all(dsh_kernel._HANDLES[j]._text == [] for j in finished), "the result holds the only copy")
        self.assertEqual(await dsh_kernel._HANDLES["cap-5"].peek(), "out cap-5\n")
        self.assertIs(await dsh_kernel._BashResult(kind="promoted", jobId="cap-5", output=""), dsh_kernel._HANDLES["cap-5"]._result)
        with self.assertRaises(RuntimeError) as gone:
            await dsh_kernel._BashResult(kind="promoted", jobId="cap-0", output="")
        self.assertIn("released to save memory", str(gone.exception))

    async def test_a_finished_background_job_leaves_the_cancel_table(self) -> None:
        import background

        async def host(payload):
            return {"status": "ok", "result": {"jobId": "bg-cap"}}

        use_cell("run-bg", host=host)

        async def work():
            return "value"

        job = await background.start(work())
        self.assertIn("bg-cap", background._HANDLES)
        self.assertEqual(await job, "value")
        await asyncio.sleep(0)
        self.assertNotIn("bg-cap", background._HANDLES)
        self.assertEqual(background.cancel("bg-cap"), "unknown or already finished job")


class ReadText(unittest.TestCase):
    def test_text_joins_lines_without_numbers(self) -> None:
        r = dsh_kernel._ReadResult(path="p", offset=1, totalLines=2,
                                   lines=[{"number": 1, "text": "x"}, {"number": 2, "text": "y"}])
        self.assertEqual(r.text, "x\ny")
        self.assertEqual(r["text"], "x\ny")
        self.assertNotIn("text", r)
        with self.assertRaises(KeyError):
            r["missing"]
