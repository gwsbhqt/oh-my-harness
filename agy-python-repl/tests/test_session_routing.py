"""Exercise the desktop hook, official tool arguments and real stdio kernel routing."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.session_routing import LEGACY_SERVER_NAME, SERVER_NAME

ROOT = Path(__file__).resolve().parents[1]
CONV_A = "00000000-0000-4000-8000-0000000000aa"
CONV_B = "00000000-0000-4000-8000-0000000000bb"


class SessionRoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.data = self.root / "plugin data"
        self.ws_a, self.ws_b = self.root / "north", self.root / "south"
        for ws in (self.ws_a, self.ws_b):
            ws.mkdir()
            (ws / "region.txt").write_text(ws.name, encoding="utf-8")
        self.hooks = json.loads((ROOT / "hooks.json").read_text())["agy-python-repl-session"]
        config = json.loads((ROOT / "mcp_config.json").read_text())["mcpServers"]
        self.assertEqual(list(config), [SERVER_NAME.removeprefix("agy-python-repl_")])

    @asynccontextmanager
    async def server(self, *, managed=True, data=None, variable="PLUGIN_DATA"):
        env = {"HOME": str(self.root), variable: str(data or self.data),
               "PYTHONPATH": str(ROOT / "src"), "PYTHONDONTWRITEBYTECODE": "1"}
        args = ["-m", "agy_python_repl.server"]
        if managed:
            env["PLUGIN_ROOT"] = str(ROOT)
            args.append("--conversation")
        params = StdioServerParameters(command=sys.executable, args=args, cwd=self.root, env=env)
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield client

    def hook(self, event, payload, *, data=None, hours_ago=0):
        group = self.hooks[event][0]
        handler = group["hooks"][0] if "hooks" in group else group
        command = shlex.split(handler["command"])
        if hours_ago:
            # Run the same hook with its wall clock at the time approval was requested.
            script = ("import runpy,sys,time; original=time.time; "
                      f"time.time=lambda: original()-{3600 * hours_ago}; "
                      "sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')")
            command = [sys.executable, "-c", script, *command[1:]]
        result = subprocess.run(command, cwd=ROOT, input=json.dumps(payload), text=True,
                                capture_output=True, check=True, timeout=handler["timeout"],
                                env={"HOME": str(self.root), "PLUGIN_DATA": str(data or self.data),
                                     "PATH": os.pathsep.join((str(Path(sys.executable).parent), os.defpath))})
        return json.loads(result.stdout)

    def payload(self, conv, step, name, args, *, workspace=None, deferred=False, server=SERVER_NAME):
        call = {"name": f"mcp_{server}_{name}", "args": args}
        if deferred:
            call = {"name": "call_mcp_tool", "args": {"ServerName": server, "ToolName": name, "Arguments": args}}
        return {"conversationId": conv, "stepIdx": step, "workspacePaths": [str(workspace or self.ws_a)], "toolCall": call}

    def prepare(self, payload, **kwargs):
        decision = self.hook("PreToolUse", payload, **kwargs)
        self.assertEqual(decision["decision"], "allow", decision)
        # The host shallow-merges at the outer tool, including for call_mcp_tool.
        call = payload["toolCall"]
        merged = {**call["args"], **decision.get("overwrite", {})}
        arguments = merged["Arguments"] if call["name"] == "call_mcp_tool" else merged
        return decision, arguments

    async def execute(self, client, payload, wire):
        call = payload["toolCall"]
        tool = call["args"]["ToolName"] if call["name"] == "call_mcp_tool" else call["name"].split(SERVER_NAME + "_")[1]
        reply = await client.call_tool(tool, wire)
        self.assertEqual(self.hook("PostToolUse", {**payload, "error": str(reply.content) if reply.isError else ""}), {})
        return reply

    async def checked(self, client, payload):
        decision, arguments = self.prepare(payload)
        reply = await self.execute(client, payload, arguments)
        self.assertFalse(reply.isError, reply.content)
        return decision, reply.structuredContent

    async def test_ordinary_calls_and_read_only_panel(self):
        async with self.server() as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            self.assertEqual(set(tools["run_code"].inputSchema["properties"]), {"code", "timeout_seconds", "cwd"})
            self.assertEqual(set(tools["kernel_state"].inputSchema["properties"]), {"action", "cwd"})
            for n, (conv, ws) in enumerate(((CONV_A, self.ws_a), (CONV_B, self.ws_b))):
                payload = self.payload(conv, n, "run_code", {"code": "region = Path('region.txt').read_text()"},
                                       workspace=ws, deferred=bool(n))
                decision, result = await self.checked(client, payload)
                self.assertEqual(decision, {"decision": "allow"})
                self.assertEqual(result["status"], "ok")
                decision, result = await self.checked(client, self.payload(conv, n + 2, "run_code", {"code": "region"}))
                self.assertEqual(decision, {"decision": "allow"})
                self.assertEqual(result["result"], repr(ws.name))
            for name in ("open_kernel_panel", "app_kernel_overview"):
                overview = await client.call_tool(name, {})
                self.assertEqual({k["name"] for k in overview.structuredContent["kernels"]}, {CONV_A, CONV_B})
            self.assertNotIn("PostInvocation", self.hooks)

    async def test_old_explicit_kernel_reads_and_restores_its_own_values(self):
        for cycle in range(2):
            async with self.server() as client:
                if cycle == 0:
                    await self.checked(client, self.payload(CONV_A, 0, "run_code", {"code": "total = 5"}))
                    await self.checked(client, self.payload(CONV_A, 1, "run_code", {"code": "total = 23", "kernel": "counts"}))
                for deferred in (False, True):
                    payload = self.payload(CONV_A, 2, "run_code", {"code": "total", "kernel": "counts"}, deferred=deferred)
                    decision, wire = self.prepare(payload)
                    self.assertIn("overwrite", decision)
                    # A stale caller may have its legacy selector removed by the advertised schema.
                    wire.pop("kernel")
                    reply = await self.execute(client, payload, wire)
                    self.assertFalse(reply.isError, reply.content)
                    self.assertEqual(reply.structuredContent["result"], "23")
                    _, state = await self.checked(client, self.payload(CONV_A, 3, "kernel_state", {"action": "vars", "kernel": "counts"}, deferred=deferred))
                    self.assertEqual(state["kernel"], f"{CONV_A}:counts")
                _, default = await self.checked(client, self.payload(CONV_A, 4, "run_code", {"code": "total"}))
                self.assertEqual(default["result"], "5")

    async def test_identical_requests_can_finish_backwards_in_one_conversation(self):
        args = {"code": "Path('region.txt').read_text()"}
        first = self.payload(CONV_A, 1, "run_code", args, workspace=self.ws_a)
        second = self.payload(CONV_A, 2, "run_code", args, workspace=self.ws_b, deferred=True)
        plain, left = self.prepare(first)
        extra, right = self.prepare(second)
        self.assertEqual(plain, {"decision": "allow"})
        self.assertEqual(set(extra["overwrite"]), {"Arguments"})
        async with self.server() as client:
            for payload, wire, expected in ((second, right, "south"), (first, left, "north")):
                reply = await self.execute(client, payload, wire)
                self.assertFalse(reply.isError, reply.content)
                self.assertEqual(reply.structuredContent["result"], repr(expected))
            for wire in (right, left):
                self.assertTrue((await client.call_tool("run_code", wire)).isError)
            decision, result = await self.checked(client, self.payload(CONV_A, 3, "run_code", args))
            self.assertEqual(decision, {"decision": "allow"})
            self.assertEqual(result["result"], repr("north"))

    async def test_concurrent_hooks_on_two_managed_connections_share_only_one_plain_claim(self):
        args = {"code": "Path('region.txt').read_text()"}
        calls = [self.payload(CONV_A, 1, "run_code", args),
                 self.payload(CONV_B, 1, "run_code", args, workspace=self.ws_b, deferred=True)]
        async with self.server() as north, self.server() as south:
            prepared = await asyncio.gather(*(asyncio.to_thread(self.prepare, call) for call in calls))
            tagged = [i for i, (decision, _) in enumerate(prepared) if "overwrite" in decision]
            self.assertEqual(len(tagged), 1)
            for i in (tagged[0], 1 - tagged[0]):
                reply = await self.execute((north, south)[i], calls[i], prepared[i][1])
                self.assertFalse(reply.isError, reply.content)
                self.assertEqual(reply.structuredContent["result"], repr(("north", "south")[i]))

    async def test_late_approval_after_restart_and_missing_stop_never_blocks_a_new_request(self):
        args = {"code": "[Path('region.txt').read_text(), 7 * 3]"}
        first = self.payload(CONV_A, 1, "run_code", args)
        second = self.payload(CONV_B, 1, "run_code", args, workspace=self.ws_b, deferred=True)
        async with self.server():
            plain, late = self.prepare(first, hours_ago=1)
            self.assertEqual(plain, {"decision": "allow"})
        async with self.server() as restarted:
            tagged, wire = self.prepare(second)
            self.assertIn("overwrite", tagged)
            changed = {**wire, "code": "Path('incorrect').touch()"}
            wrong = await restarted.call_tool("run_code", changed)
            self.assertTrue(wrong.isError)
            rejected = self.payload(CONV_B, 1, "run_code", changed, deferred=True)
            self.assertEqual(self.hook("PostToolUse", {**rejected, "error": "arguments changed"}), {})
            self.assertFalse((self.ws_b / "incorrect").exists())
            now = await self.execute(restarted, second, wire)
            self.assertEqual(now.structuredContent["result"], "['south', 21]")
            original = await self.execute(restarted, first, late)
            self.assertEqual(original.structuredContent["result"], "['north', 21]")

    async def test_cancelled_and_idle_requests_cannot_spend_the_next_registration(self):
        for step, event in enumerate(("PostToolUse", "Stop")):
            args = {"code": f"Path('invoice-{step}').write_text('paid')"}
            first = self.payload(CONV_A, step, "run_code", args)
            clean, old = self.prepare(first)
            self.assertNotIn("overwrite", clean)
            self.hook(event, {**first, "fullyIdle": True, "error": "cancelled"})
            next_call = self.payload(CONV_B, step, "run_code", args, workspace=self.ws_b)
            decision, new = self.prepare(next_call)
            self.assertIn("overwrite", decision)
            async with self.server() as client:
                self.assertTrue((await client.call_tool("run_code", old)).isError)
                self.assertFalse((self.ws_a / f"invoice-{step}").exists())
                self.assertFalse((self.ws_b / f"invoice-{step}").exists())
                reply = await self.execute(client, next_call, new)
                self.assertFalse(reply.isError, reply.content)
                self.assertEqual((self.ws_b / f"invoice-{step}").read_text(), "paid")

    async def test_duplicate_or_absent_step_id_cannot_claim_another_attempt(self):
        ordinary = self.payload(CONV_A, 4, "kernel_state", {"action": "vars"})
        _, first = self.prepare(ordinary)
        tagged, second = self.prepare(ordinary)
        self.assertIn("overwrite", tagged)
        unknown = self.payload(CONV_B, None, "kernel_state", {"action": "vars"})
        _, third = self.prepare(unknown)
        self.assertNotEqual(third, second)
        async with self.server() as client:
            self.assertTrue((await self.execute(client, ordinary, first)).isError)
            for payload, wire, conv in ((unknown, third, CONV_B), (ordinary, second, CONV_A)):
                reply = await self.execute(client, payload, wire)
                self.assertEqual(reply.structuredContent["kernel"], conv)

    async def test_unmatched_and_independent_clients_cannot_claim_a_managed_call(self):
        args = {"code": "Path('report').write_text('ok')"}
        payload = self.payload(CONV_A, 0, "run_code", args)
        async with self.server() as desktop:
            self.assertTrue((await desktop.call_tool("run_code", args)).isError)
            self.assertTrue((await desktop.call_tool("kernel_state", {"action": "reset"})).isError)
            _, intended = self.prepare(payload)
            for variable in ("PLUGIN_DATA", "AGY_PYTHON_REPL_DATA"):
                async with self.server(managed=False, variable=variable) as independent:
                    for tool, request in (("run_code", args), ("app_kernel_overview", {}),
                                          ("app_kernel_action", {"kernel": CONV_A, "action": "reset"})):
                        refused = await independent.call_tool(tool, request)
                        self.assertTrue(refused.isError, refused.content)
                        self.assertIn("separate", refused.content[0].text)
            self.assertFalse((self.ws_a / "report").exists())
            self.assertFalse((await self.execute(desktop, payload, intended)).isError)
            self.assertTrue((self.ws_a / "report").is_file())
        async with self.server(managed=False, data=self.root / "standalone") as independent:
            for name, count in (("default", 3), ("counts", 19)):
                result = await independent.call_tool("run_code", {"kernel": name, "code": f"value = {count}"})
                self.assertFalse(result.isError, result.content)
            for name, count in (("default", 3), ("counts", 19)):
                result = await independent.call_tool("run_code", {"kernel": name, "code": "value"})
                self.assertEqual(result.structuredContent["result"], str(count))

    def test_legacy_server_and_invalid_identity_are_denied_before_dispatch(self):
        for deferred in (False, True):
            for tool, args in (("run_code", {"code": "total = 17"}), ("kernel_state", {"action": "reset"})):
                payload = self.payload(CONV_A, 1, tool, args, deferred=deferred, server=LEGACY_SERVER_NAME)
                decision = self.hook("PreToolUse", payload)
                self.assertEqual(decision["decision"], "deny")
                self.assertIn("Reload", decision["reason"])
                decision = self.hook("PreToolUse", self.payload("default", 1, tool, args, deferred=deferred))
                self.assertEqual(decision["decision"], "deny")
            other = self.payload(None, 2, "run_code", {}, deferred=deferred, server="another-service")
            self.assertEqual(self.hook("PreToolUse", other), {"decision": "allow"})
        self.assertFalse(self.data.exists())

    async def test_damaged_route_storage_stops_before_execution(self):
        path = self.data / "session-routing"
        path.mkdir(parents=True)
        (path / "conversation.sqlite3").write_text("partial", encoding="utf-8")
        decision = self.hook("PreToolUse", self.payload(CONV_A, 1, "run_code", {"code": "total = 4"}))
        self.assertEqual(decision["decision"], "deny")
        async with self.server() as client:
            refused = await client.call_tool("kernel_state", {"action": "reset"})
            self.assertTrue(refused.isError, refused.content)
            overview = await client.call_tool("app_kernel_overview", {})
            self.assertEqual(overview.structuredContent["kernels"], [])
        self.assertFalse((self.data / "snapshots").exists())
