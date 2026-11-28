"""Check the actual model text returned by the stdio MCP server and its kernel."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import agy_python_repl
from agy_python_repl.display import render_kernel_state, render_run_code
from agy_python_repl.session_routing import SERVER_NAME
from python_repl_core.kernel_client import KernelClient


# Leave room for the host to prepend its hook notice and timestamps.
_PRELOADED_HEADER = (
    "A pre-tool hook changed the arguments of this tool call before it ran. Changed: cwd, kernel.\n\n"
    "Created At: 2000-01-01T00:00:00Z\nCompleted At: 2000-01-01T00:00:01Z\n"
).encode()


class HostOutputTests(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def server(self, root: Path | None = None, *flags: str):
        if root is None:
            root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "agy_python_repl.server", *flags],
            cwd=root,
            env={
                "HOME": str(root),
                "PLUGIN_DATA": str(root / "data"),
                "PYTHONPATH": str(Path(agy_python_repl.__file__).resolve().parents[1]),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield root, client

    async def cell(self, client: ClientSession, code: str, **arguments) -> tuple[dict, str]:
        return await self.tool(client, "run_code", code=code, **arguments)

    async def tool(self, client: ClientSession, name: str, **arguments) -> tuple[dict, str]:
        reply = await client.call_tool(name, arguments)
        self.assertFalse(reply.isError, reply.content)
        text, = reply.content
        self.assertEqual(text.type, "text")
        self.assertIsInstance(reply.structuredContent, dict)
        return reply.structuredContent, text.text

    def check_captures(self, root: Path, payload: dict, text: str, expected: dict[str, str]) -> None:
        self.assertEqual(next(iter(payload)), "overflow_files")
        self.assertTrue(payload["truncated"])
        self.assertLess(len(_PRELOADED_HEADER + text.encode("utf-8")), 6 * 1024)
        visible = (_PRELOADED_HEADER + text.encode("utf-8"))[:10 * 1024]
        files = {}
        for name in payload["overflow_files"]:
            path = Path(name)
            self.assertTrue(path.resolve().is_relative_to((root / "data").resolve()))
            self.assertIn(name.encode(), visible)
            self.assertLess(text.index(name), text.index(payload["stdout"]))
            key = path.stem.split("_")[-1]
            files[key] = path.read_text(encoding="utf-8")
        self.assertEqual(files, expected)

    async def test_missing_completion_status_preserves_output_without_reporting_success(self) -> None:
        client = KernelClient(python_exe=sys.executable, vendor_dir=Path(), compat_dir=Path())
        client.alive = True

        async def finish_without_status(request, *, done):
            cell_id = request["id"]
            client._pending[cell_id] = done
            client._dispatch_frame({"event": "stdout", "id": cell_id, "text": "partial output"})
            client._dispatch_frame({"event": "done", "id": cell_id})

        with patch.object(client, "_send", finish_without_status):
            result = await client.execute("10 + 2")
        self.assertNotEqual(result.status, "ok")
        self.assertEqual(result.stdout, "partial output")
        self.assertIn("Unconfirmed", render_run_code({"status": result.status, "stdout": result.stdout}))

    async def test_large_mixed_unicode_puts_the_three_actual_files_first(self) -> None:
        async with self.server() as (root, client):
            cell = "import sys\nprint('甲'*26000)\nprint('乙'*14000, file=sys.stderr)\n'丙'*28000"
            payload, text = await self.cell(client, cell)
            self.check_captures(root, payload, text, {
                "stdout": "甲" * 26000 + "\n", "stderr": "乙" * 14000 + "\n", "result": repr("丙" * 28000),
            })
            self.assertIn("captured", payload["output_note"].lower())
            self.assertIn("display", payload["output_note"].lower())

    async def test_utf8_and_json_escaping_share_one_budget(self) -> None:
        async with self.server() as (root, client):
            # Every channel fits its own old limit, even its on-wire byte limit, in isolation.
            streams = {"stdout": '雪"\\\n' * 650, "stderr": "\x01" * 650, "result": "終" * 1500}
            code = f"import sys\nsys.stdout.write({streams['stdout']!r})\nsys.stderr.write({streams['stderr']!r})\n{streams['result']!r}"
            payload, text = await self.cell(client, code)
            self.check_captures(root, payload, text, {**streams, "result": repr(streams["result"])})

    async def test_small_results_and_short_channels_stay_readable(self) -> None:
        async with self.server() as (_, client):
            small, text = await self.cell(client, "import sys\nprint('短')\nprint('提示', file=sys.stderr)\n6*7")
            self.assertEqual(small, {"status": "ok", "stdout": "短\n", "stderr": "提示\n", "result": "42"})
            self.assertEqual(text, "短\n\n提示\n\n42")
            mixed, text = await self.cell(client, "print('甲'*9000)\nprint('提示', file=sys.stderr)\n6*7")
            self.assertEqual((mixed["stderr"], mixed["result"]), ("提示\n", "42"))
            self.assertTrue(text.endswith("\n\n[stderr]\n提示\n\n42"))
            self.assertLess(len(_PRELOADED_HEADER + text.encode("utf-8")), 6 * 1024)

    async def test_only_clipped_channels_have_labeled_capture_paths(self) -> None:
        async with self.server() as (root, client):
            source = root / "sample.log"
            source.write_text(("sample " * 12 + "\n") * 300, encoding="utf-8")
            note = "s" * 74
            code = f"page = await read('sample.log', limit=300)\nprint({note!r})\npage"
            receipt, text = await self.cell(client, code)
            self.assertEqual(receipt["stdout"], note + "\n")
            capture, = map(Path, receipt["overflow_files"])
            self.assertEqual(set(capture.parent.iterdir()), {capture})
            self.assertIn(f"result: {capture}", text)
            self.assertIn("300: sample", capture.read_text(encoding="utf-8"))
            self.assertEqual((await self.cell(client, "len(page.lines)"))[1], "300")

    async def test_failed_writes_are_visible_before_the_preview_and_cell_runs_once(self) -> None:
        async with self.server() as (root, client):
            data = root / "data"
            data.mkdir(exist_ok=True)
            (data / "overflow").touch()
            code = "import sys\nruns = globals().get('runs', 0) + 1\nprint('甲'*9000)\nprint('乙'*9000, file=sys.stderr)\n'丙'*9000"
            payload, text = await self.cell(client, code)
            self.assertEqual(payload["status"], "ok")
            self.assertNotIn("overflow_files", payload)
            self.assertEqual(next(iter(payload)), "overflow_errors")
            self.assertEqual(set(payload["overflow_errors"]), {"stdout", "stderr", "result"})
            self.assertIn("Output truncated.", text)
            for channel, reason in payload["overflow_errors"].items():
                self.assertLess(text.index(f"Could not save {channel}: {reason}"), text.index(payload["stdout"]))
            self.assertLess(len(_PRELOADED_HEADER + text.encode("utf-8")), 6 * 1024)
            self.assertEqual((await self.cell(client, "runs"))[0]["result"], "1")

    async def test_large_exception_retains_error_and_captured_diagnostics(self) -> None:
        async with self.server() as (_, client):
            payload, text = await self.cell(client, "print('先'*9000)\nraise ValueError('错'*9000)")
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["error"]["ename"], "ValueError")
            self.assertEqual(next(iter(payload)), "overflow_files")
            self.assertLess(len(_PRELOADED_HEADER + text.encode("utf-8")), 6 * 1024)
            details, = (Path(name) for name in payload["overflow_files"] if name.endswith(".json"))
            self.assertIn(str(details), text)
            self.assertIn("Diagnostics truncated.", text)
            self.assertIn("ValueError: ", text)
            self.assertEqual(json.loads(details.read_text(encoding="utf-8"))["error"]["evalue"], "错" * 9000)

    async def test_silent_assignment_stdout_and_expression_keep_their_literal_text(self) -> None:
        async with self.server() as (_, client):
            tool, = (tool for tool in (await client.list_tools()).tools if tool.name == "run_code")
            self.assertEqual(tool.outputSchema["type"], "object")
            self.assertTrue(tool.outputSchema["additionalProperties"])
            self.assertEqual(await self.cell(client, "answer = 6 * 7"), ({"status": "ok"}, ""))
            self.assertEqual(await self.cell(client, "answer"), ({"status": "ok", "result": "42"}, "42"))
            stdout = 'first "line"\n  second line\n\n'
            self.assertEqual(await self.cell(client, f"print({stdout!r}, end='')"),
                             ({"status": "ok", "stdout": stdout}, stdout))
            payload, text = await self.cell(client, "import sys\nprint('warning', file=sys.stderr)")
            self.assertEqual(payload, {"status": "ok", "stderr": "warning\n"})
            self.assertEqual(text, "warning\n")

    async def test_cell_error_and_timeout_show_partial_output_and_the_traceback(self) -> None:
        async with self.server() as (_, client):
            failure, text = await self.cell(client, "print('partial')\nraise ValueError('bad sample')")
            self.assertEqual(failure["status"], "error")
            self.assertIn("partial\nTraceback", text)
            self.assertIn('line 2, in <module>', text)
            self.assertTrue(text.endswith("ValueError: bad sample\n"))
            timed, text = await self.cell(client, "import asyncio\nprint('started')\nawait asyncio.sleep(30)",
                                          timeout_seconds=0.1)
            self.assertEqual(timed["status"], "timeout")
            self.assertIn("Execution timed out.", text)
            self.assertIn("started", text)
            self.assertIn("KeyboardInterrupt", text)
            self.assertEqual((await self.cell(client, "1 + 1"))[1], "2")

    async def test_kernel_exit_and_missing_snapshot_report_lost_state(self) -> None:
        async with self.server() as (_, client):
            lost = await client.call_tool("run_code", {"code": "unsaved = 7\n__import__('os')._exit(0)"})
            self.assertTrue(lost.isError)
            self.assertIn("Kernel process exited", lost.content[0].text)
            recovered, text = await self.cell(client, "'unsaved' in globals()")
            self.assertEqual(recovered["result"], "False")
            self.assertNotIn("restored", recovered)
            self.assertIn(recovered["state_loss"], text)
            self.assertIn("state was lost", text)
            self.assertEqual((await self.cell(client, "next_value = 3"))[1], "")

    async def test_normal_restore_shows_count_and_sample_even_after_the_report_spills(self) -> None:
        for count in (4, 450):
            with self.subTest(count=count):
                async with self.server() as (_, client):
                    await self.cell(client, f"globals().update({{f'sample_{{i:03}}': i for i in range({count})}})")
                    restarted = await client.call_tool("kernel_state", {"action": "restart"})
                    self.assertEqual(restarted.structuredContent["status"], "ok")
                    cell, text = await self.cell(client, "sample_000")
                    report = cell["restored"]
                    self.assertTrue(report["restored"])
                    self.assertIn(f"Restored variables: {count} (sample_000, sample_001, sample_002, …).", text)
                    self.assertTrue(text.endswith("0"))
                    if cell.get("details_truncated"):
                        details, = (Path(file) for file in cell["overflow_files"] if file.endswith(".json"))
                        report = json.loads(details.read_text(encoding="utf-8"))["restored"]
                    self.assertEqual(len(report["restored_names"]), count)
                    self.assertNotIn(report["snapshot_path"], text)

    async def test_service_reload_shows_shadowed_bindings_after_guidance_was_delivered(self) -> None:
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (root / "orders.csv").write_text("subtotal\n12\n", encoding="utf-8")
        plugin = Path(agy_python_repl.__file__).resolve().parents[2]
        conversation = {"conversationId": "orders-review", "workspacePaths": [str(root)]}

        def hook(script, *flags, **payload):
            result = subprocess.run(
                [sys.executable, str(plugin / "hooks" / script), *flags], input=json.dumps(conversation | payload),
                env={"HOME": str(root), "PLUGIN_DATA": str(root / "data")}, text=True, capture_output=True,
                check=True, timeout=5,
            )
            return json.loads(result.stdout)

        async def routed_cell(client, code):
            call = {"name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": code}}
            routed = hook("inject_session.py", toolCall=call)
            self.assertEqual(routed["decision"], "allow", routed)
            return await self.tool(client, "run_code", **(call["args"] | routed.get("overwrite", {})))

        self.assertIn("injectSteps", hook("session_start.py", "--pre-invocation"))
        async with self.server(root, "--conversation") as (_, client):
            saved, _ = await routed_cell(client, 'import glob\ndef read(row): return row["subtotal"]\n'
                                         'order = {"subtotal": 12}\n'
                                         'globals().update({f"amount_{i:03}": i for i in range(450)})')
            self.assertEqual(saved["status"], "ok", saved)

        self.assertEqual(hook("session_start.py", "--pre-invocation"), {})
        async with self.server(root, "--conversation") as (_, client):
            result, text = await routed_cell(client, 'glob.glob("*.csv"), read(order)')
            self.assertEqual(result["result"], "(['orders.csv'], 12)")
            self.assertTrue(result["details_truncated"])
            report = result["restored"]
            self.assertNotIn("glob", report["restored_sample"])
            self.assertEqual(report["shadowed_bindings"], ["glob", "read"])
            self.assertIn("glob, read", text)
            self.assertIn("await repl.restore_binding('glob')", text)
            self.assertLess(len(_PRELOADED_HEADER + text.encode()), 6 * 1024)
            next_cell, text = await routed_cell(
                client, 'glob_module = glob\nawait repl.restore_binding("glob")\n'
                'glob_module.glob("*.csv"), (await glob("*.csv")).paths, read(order)',
            )
            self.assertEqual(next_cell["result"], "(['orders.csv'], ['orders.csv'], 12)")
            self.assertNotIn("restored", next_cell)
            self.assertNotIn("restore_binding", text)

    async def test_skipped_state_displays_a_manifest_only_when_names_are_omitted(self) -> None:
        async with self.server() as (_, client):
            cell, text = await self.cell(client, "samples = (n for n in range(3))")
            self.assertEqual(cell["snapshot_skipped_count"], 1)
            self.assertIn("Variables skipped in snapshot: 1 (samples)", text)
            path = Path(cell["snapshot_manifest"])
            self.assertNotIn(str(path), text)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["skipped"][0]["name"], "samples")
            cell, text = await self.cell(client, "a, b, c = ((n for n in range(2)) for _ in range(3))")
            self.assertEqual(cell["snapshot_skipped_count"], 4)
            self.assertIn(cell["snapshot_manifest"], text)

    async def test_failed_restore_is_visible_even_when_the_cell_succeeds(self) -> None:
        async with self.server() as (root, client):
            path = root / "data" / "snapshots" / "default.dill"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"invalid snapshot")
            cell, text = await self.cell(client, "42")
            self.assertEqual(cell["status"], "ok")
            self.assertFalse(cell["restored"]["restored"])
            self.assertIn(cell["restored"]["reason"], text)
            self.assertIn(str(path), text)
            self.assertIn(cell["snapshot_warning"], text)
            self.assertTrue(text.endswith("42"))

    async def test_reuse_hint_is_only_attached_to_the_cell_that_emitted_it(self) -> None:
        async with self.server() as (_, client):
            code = "from pathlib import Path\nsample_path = Path('fixture')\n42"
            first, text = await self.cell(client, code)
            self.assertNotIn("reuse_hint", first)
            self.assertEqual(text, "42")
            repeated, text = await self.cell(client, code)
            self.assertIn("sample_path", repeated["reuse_hint"])
            self.assertEqual(text.splitlines(), ["42", f"Hint: {repeated['reuse_hint']}"])
            self.assertEqual((await self.cell(client, "sample_path.name"))[1], "'fixture'")

    async def test_management_actions_summarize_their_own_status_and_names(self) -> None:
        async with self.server() as (_, client):
            async def state(action):
                return await self.tool(client, "kernel_state", action=action)

            empty, text = await state("list")
            self.assertEqual(empty, {"active_kernels": [], "saved_snapshots": []})
            self.assertEqual(text, "Kernels: 0.\nSaved snapshots: 0.")
            refused, text = await state("restart")
            self.assertEqual(refused["status"], "error")
            self.assertIn(refused["error"], text)
            missing, text = await state("restore")
            self.assertIn(missing["error"], text)
            await self.cell(client, "alpha, beta, gamma, omega = range(4)")
            values, text = await state("vars")
            self.assertEqual(len(values["names"]), 4)
            self.assertEqual(text, "Variables: 4 (alpha, beta, gamma, …).")
            active, text = await state("list")
            self.assertEqual(active["saved_snapshots"], ["default"])
            self.assertEqual(text, "Kernels: 1 (default).\nSaved snapshots: 1 (default).")
            for action, field in (("snapshot", "saved"), ("restore", "restored"), ("restart", "restored")):
                with self.subTest(action=action):
                    result, text = await state(action)
                    self.assertEqual(result["status"], "ok")
                    self.assertEqual(len(result[field]), 4)
                    self.assertIn(f"{field.capitalize()} variables: 4 (alpha, beta, gamma, …).", text)
                    if "snapshot_path" in result:
                        self.assertNotIn(result["snapshot_path"], text)
            await self.cell(client, "unsaved = (x for x in range(2))")
            snapshot, text = await state("snapshot")
            self.assertIn(snapshot["snapshot_path"], text)
            self.assertIn(snapshot["skipped"][0]["reason"], text)
            refused, text = await state("restart")
            self.assertTrue(refused["original_kept"])
            self.assertIn(refused["error"], text)
            self.assertIn("original kernel is still running", text)
            self.assertIn(refused["skipped"][0]["reason"], text)
            self.assertEqual(await state("reset"), ({"kernel": "default", "status": "reset"}, "Kernel reset."))

    async def test_partial_restore_identifies_the_failed_binding_and_snapshot(self) -> None:
        async with self.server() as (root, client):
            module = root / "fixture_record.py"
            module.write_text("class Record: pass\n", encoding="utf-8")
            await self.cell(client, "from fixture_record import Record as read\nsample = read()\nimport glob\nkept = 9")
            module.unlink()
            lost = await client.call_tool("run_code", {"code": "__import__('os')._exit(0)"})
            self.assertTrue(lost.isError)
            partial, text = await self.tool(client, "kernel_state", action="restore")
            self.assertEqual(partial["status"], "partial")
            self.assertEqual(partial["shadowed_bindings"], ["glob"])
            self.assertIn("await repl.restore_binding('glob')", text)
            self.assertIn("partially completed", text)
            self.assertIn(partial["snapshot_path"], text)
            for issue in partial["failed"]:
                self.assertIn(f"{issue['name']} ({issue['reason']})", text)
            self.assertEqual((await self.cell(client, "kept"))[0]["result"], "9")

    async def test_missing_variable_list_does_not_report_an_empty_kernel(self) -> None:
        async with self.server() as (_, client):
            await self.cell(client, "from rlm import repl as _prime\n_prime._list_names = lambda ns: None")
            malformed = await client.call_tool("kernel_state", {"action": "vars"})
            self.assertTrue(malformed.isError)
            self.assertIn("did not confirm its variable list", malformed.content[0].text)

    async def test_panel_title_and_app_tools_preserve_the_overview_and_variable_data(self) -> None:
        async with self.server() as (_, client):
            await self.cell(client, "chart_value = 7")
            panel, title = await self.tool(client, "open_kernel_panel")
            self.assertEqual(title, "Python REPL")
            self.assertTrue(panel["history"])
            overview, text = await self.tool(client, "app_kernel_overview")
            self.assertEqual(overview, panel)
            self.assertEqual(json.loads(text), overview)
            variables, text = await self.tool(client, "app_kernel_action", action="vars")
            self.assertEqual(variables["names"], ["chart_value"])
            self.assertEqual(json.loads(text), variables)

    def test_incomplete_receipts_and_shared_directory_index(self) -> None:
        for action in ("snapshot", "restart", "restore", "reset"):
            self.assertIn("could not be confirmed", render_kernel_state(action, {}))
        self.assertIn("Missing restored variable list", render_kernel_state("restart", {"status": "ok"}))
        self.assertIn("unavailable", render_kernel_state("vars", {}))
        self.assertIn("missing", render_run_code({}))
        self.assertIn("No error details", render_run_code({"status": "error"}))
        self.assertIn("No capture path", render_run_code({"status": "ok", "truncated": True}))
        self.assertIn("could not be confirmed", render_run_code({"status": "ok", "restored": {}}))
        indexed = {"directory": "/example/captures", "files": ["cell_stdout.txt", "cell_result.txt"]}
        text = render_run_code({"status": "ok", "truncated": True, "overflow_index": indexed})
        for name in indexed["files"]:
            self.assertIn(str(Path(indexed["directory"]) / name), text)
