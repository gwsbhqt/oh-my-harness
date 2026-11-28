"""Round-trip human kernel names through real stdio, processes, snapshots, and panel controls."""

from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from itertools import count
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.session_routing import SERVER_NAME, scope_kernel

ROOT = Path(__file__).resolve().parents[1]
SESSION = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"


class KernelNameTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.data = self.root / "data"
        self.snapshots = self.data / "snapshots"
        self.steps = count()

    @asynccontextmanager
    async def server(self, *, managed=True):
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "agy_python_repl.server", *(["--conversation"] if managed else [])], cwd=self.root,
            env={"HOME": str(self.root), "PLUGIN_DATA": str(self.data), "PYTHONPATH": str(ROOT / "src"),
                 "PYTHONDONTWRITEBYTECODE": "1"},
        )
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield client

    def qualified(self, name: str, session: str = SESSION) -> str:
        return scope_kernel(name, session)

    def hook(self, payload, *flags):
        proc = subprocess.run([sys.executable, str(ROOT / "hooks" / "inject_session.py"), *flags],
                              input=json.dumps(payload), capture_output=True, text=True, check=True,
                              env={"HOME": str(self.root), "PLUGIN_DATA": str(self.data)})
        return json.loads(proc.stdout)

    async def tool(self, client: ClientSession, name: str, *, kernel: str | None = None, **arguments) -> dict:
        if name in ("run_code", "kernel_state") and kernel and kernel != "default":
            conversation = OTHER if kernel.startswith(OTHER) else SESSION
            if kernel != conversation:
                arguments["kernel"] = kernel.removeprefix(conversation + ":")
            payload = {"stepIdx": next(self.steps), "conversationId": conversation,
                       "toolCall": {"name": f"mcp_{SERVER_NAME}_{name}", "args": arguments}}
            decision = self.hook(payload)
            self.assertEqual(decision["decision"], "allow", decision)
            reply = await client.call_tool(name, {**arguments, **decision.get("overwrite", {})})
            self.assertEqual(self.hook({**payload, "error": reply.isError}, "--post-tool-use"), {})
        else:
            if kernel is not None:
                arguments["kernel"] = kernel
            reply = await client.call_tool(name, arguments)
        self.assertFalse(reply.isError, reply.content)
        return reply.structuredContent

    async def cell(self, client: ClientSession, name: str, code: str) -> dict:
        result = await self.tool(client, "run_code", kernel=name, code=code)
        self.assertEqual(result["status"], "ok", result.get("error"))
        return result

    async def test_names_persist_separately_through_the_panel_and_three_server_starts(self):
        suffixes = ["quarter 1", "quarter_1", "Week", "week", "team:one", "team__one", "é", "e\u0301", "报表" * 180]
        names = [self.qualified(n) for n in suffixes]
        self.assertEqual(self.qualified(f"{SESSION}__week"), self.qualified("week"))
        other = self.qualified("quarter 1", OTHER)
        async with self.server() as first:
            processes, paths = set(), set()
            for i, name in enumerate([*names, other]):
                code = f"import os\nprevious = globals().get('value')\nvalue = {i}\n(previous, os.getpid())"
                previous, pid = ast.literal_eval((await self.cell(first, name, code))["result"])
                self.assertIsNone(previous)
                processes.add(pid)
                saved = await self.tool(first, "kernel_state", action="snapshot", kernel=name)
                self.assertTrue(Path(saved["snapshot_path"]).is_file())
                paths.add(Path(saved["snapshot_path"]).resolve())
            self.assertEqual((len(processes), len(paths)), (len(names) + 1, len(names) + 1))
            listing = await self.tool(first, "kernel_state", action="list", kernel=SESSION)
            self.assertEqual(set(listing["saved_snapshots"]), set(names))
            self.assertEqual({k["name"] for k in listing["active_kernels"]}, set(names))
        async with self.server() as second:
            overview = await self.tool(second, "app_kernel_overview")
            self.assertTrue(all(not row["alive"] for row in overview["kernels"]))
            rows = {k["name"]: k for k in overview["kernels"]}
            self.assertEqual(set(rows), {*names, other})
            for i, name in enumerate([*names, other]):
                panel_name = rows[name]["name"]
                variables = await self.tool(second, "app_kernel_action", kernel=panel_name, action="vars")
                self.assertIn("value", variables["names"])
                cell = await self.cell(second, panel_name, "value")
                self.assertEqual(cell["result"], str(i))
                self.assertTrue(cell["restored"]["restored"])
            reset = await self.tool(second, "app_kernel_action", kernel=rows[names[0]]["name"], action="reset")
            self.assertEqual(reset["status"], "reset")
        async with self.server() as third:
            saved = await self.tool(third, "kernel_state", kernel=SESSION, action="list")
            self.assertEqual(set(saved["saved_snapshots"]), set(names[1:]))
            self.assertEqual((await self.cell(third, names[0], "'value' in globals()"))["result"], "False")
            for i, name in enumerate(names[1:], 1):
                self.assertEqual((await self.cell(third, name, "value"))["result"], str(i))

    async def test_old_named_snapshot_only_opens_at_its_exact_spelling(self):
        legacy = f"{SESSION}__quarter_1"
        async with self.server(managed=False) as seed:
            await self.cell(seed, "default", "previous_report = 73")
            # Old installations had two independent regular files at their original flat names.
            for suffix in (".dill", ".manifest.json"):
                (self.snapshots / f"{legacy}{suffix}").write_bytes((self.snapshots / f"default{suffix}").read_bytes())
            await self.tool(seed, "kernel_state", action="reset", kernel="default")
        original = (self.snapshots / f"{legacy}.dill").read_bytes()
        async with self.server() as reader:
            for name in ("quarter 1", "Quarter_1"):
                probe = await self.cell(reader, self.qualified(name), "'previous_report' in globals()")
                self.assertEqual(probe["result"], "False")
                self.assertNotIn("restored", probe)
            self.assertEqual((self.snapshots / f"{legacy}.dill").read_bytes(), original)
            saved = await self.tool(reader, "kernel_state", kernel=SESSION, action="list")
            self.assertIn(legacy, saved["saved_snapshots"])
            overview = await self.tool(reader, "app_kernel_overview")
            row = next(k for k in overview["kernels"] if k["name"] == legacy)
            self.assertFalse(row["alive"])
            control = await self.tool(reader, "app_kernel_action", kernel=row["name"], action="vars")
            self.assertIn("previous_report", control["names"])
            exact = await self.cell(reader, self.qualified("quarter_1"), "previous_report")
            self.assertEqual(exact["result"], "73")
            self.assertIn("original", exact["restored"]["legacy_name_warning"].lower())
            self.assertEqual(Path(exact["restored"]["snapshot_path"]).name, f"{legacy}.dill")
            panel = await self.tool(reader, "app_kernel_action", kernel=row["name"], action="snapshot")
            self.assertEqual(Path(panel["snapshot_path"]), self.snapshots / f"{legacy}.dill")
        async with self.server() as fresh:
            self.assertEqual((await self.cell(fresh, legacy, "previous_report"))["result"], "73")
            self.assertEqual((await self.cell(fresh, self.qualified("quarter 1"), "'previous_report' in globals()"))["result"], "False")

    async def test_default_uuid_keeps_the_existing_snapshot_and_start_hook(self):
        async with self.server() as first:
            default = self.qualified("default")
            self.assertEqual(default, SESSION)
            await self.cell(first, default, "default_value = 41")
            saved = await self.tool(first, "kernel_state", kernel=default, action="snapshot")
            self.assertEqual(Path(saved["snapshot_path"]), self.snapshots / f"{SESSION}.dill")
        message = subprocess.run([sys.executable, str(ROOT / "hooks/session_start.py")],
                                 input=json.dumps({"conversationId": SESSION}), capture_output=True, text=True,
                                 env={"PLUGIN_DATA": str(self.data)}, check=True)
        self.assertIn("default_value", message.stdout)
        async with self.server() as second:
            kept = await self.cell(second, SESSION, "default_value + 1")
            self.assertEqual(kept["result"], "42")
            self.assertEqual(kept["restored"]["snapshot_path"], saved["snapshot_path"])
            self.assertNotIn("legacy_name_warning", kept["restored"])
