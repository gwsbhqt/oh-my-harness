"""Exercise side-channel session/workspace routing, collision serialization, and post-execution verification."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl import session_routing

ROOT = Path(__file__).resolve().parents[1]
SERVER_NAME = session_routing.SERVER_NAME
CONV_A = "00000000-0000-4000-8000-0000000000aa"
CONV_B = "00000000-0000-4000-8000-0000000000bb"


class SessionRoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.data = self.root / "plugin_data"
        self.ws_a = self.root / "ws_a"
        self.ws_b = self.root / "ws_b"
        self.ws_a.mkdir()
        self.ws_b.mkdir()
        (self.ws_a / "origin.txt").write_text("from-a", encoding="utf-8")
        (self.ws_b / "origin.txt").write_text("from-b", encoding="utf-8")

    @asynccontextmanager
    async def server(self, *, standalone_data: str | None = None):
        env = {
            "HOME": str(self.root),
            standalone_data or "PLUGIN_DATA": str(self.data),
            "PYTHONPATH": str(ROOT / "src"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        if standalone_data is None:
            env["PLUGIN_ROOT"] = str(ROOT)
        params = StdioServerParameters(command=sys.executable, args=["-m", "agy_python_repl.server"], cwd=self.root, env=env)
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield client

    def run_hook(self, event: str, payload: dict, *, data_dir: Path | None = None) -> dict:
        group = json.loads((ROOT / "hooks.json").read_text(encoding="utf-8"))["agy-python-repl-session"][event][0]
        handler = group["hooks"][0] if event in ("PreToolUse", "PostToolUse") else group
        env = {
            "HOME": str(self.root),
            "PLUGIN_DATA": str(data_dir or self.data),
            "PATH": os.pathsep.join((str(Path(sys.executable).parent), os.defpath)),
        }
        proc = subprocess.run(
            shlex.split(handler["command"]),
            cwd=ROOT,
            input=json.dumps(payload),
            env=env,
            text=True,
            capture_output=True,
            check=True,
            timeout=handler["timeout"],
        )
        return json.loads(proc.stdout)

    async def test_schema_hides_kernel_and_keeps_cwd_optional(self) -> None:
        async with self.server() as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            for name in ("run_code", "kernel_state"):
                schema = tools[name].inputSchema
                self.assertNotIn("kernel", schema["properties"])
                self.assertIn("cwd", schema["properties"])
                self.assertNotIn("cwd", schema.get("required", []))

    async def test_managed_calls_stop_before_code_or_state_when_unassigned(self) -> None:
        marker = self.ws_a / "unassigned-marker"
        args = {"code": f"from pathlib import Path\nPath({str(marker)!r}).touch()"}
        async with self.server() as client:
            for stage in ("fresh", "registered", "other tool arguments"):
                with self.subTest(stage=stage):
                    if stage == "registered":
                        session_routing.record_workspace(self.data, CONV_A, str(self.ws_a))
                    if stage == "other tool arguments":
                        session_routing.enqueue_call(self.data, "run_code", {"code": "fixture_value = 7"}, CONV_A)
                    result = await client.call_tool("run_code", args)
                    self.assertTrue(result.isError, result.content)
                    self.assertIn("conversation route", result.content[0].text)
                    self.assertFalse(marker.exists())
            result = await client.call_tool("kernel_state", {"action": "reset"})
            self.assertTrue(result.isError, result.content)
            overview = await client.call_tool("app_kernel_overview", {})
            self.assertEqual(overview.structuredContent["kernels"], [])

    async def test_assignment_receipt_failure_stops_before_code(self) -> None:
        marker = self.ws_a / "receipt-marker"
        args = {"code": f"from pathlib import Path\nPath({str(marker)!r}).touch()"}
        session_routing.enqueue_call(self.data, "run_code", args, CONV_A, "receipt-fixture")
        (self.data / "session-routing" / "receipts").write_text("fixture", encoding="utf-8")
        async with self.server() as client:
            result = await client.call_tool("run_code", args)
            self.assertTrue(result.isError, result.content)
            self.assertIn("route before execution", result.content[0].text)
            self.assertFalse(marker.exists())

    async def test_standalone_uses_a_separate_directory_and_keeps_its_default(self) -> None:
        async with self.server(standalone_data="PLUGIN_DATA") as client:
            code = "from pathlib import Path\nfixture = 9\nPath('standalone-marker').touch()"
            result = await client.call_tool("run_code", {"code": code, "cwd": str(self.ws_a)})
            self.assertFalse(result.isError, result.content)
            self.assertTrue((self.ws_a / "standalone-marker").exists())
            result = await client.call_tool("run_code", {"code": "fixture + 1"})
            self.assertEqual(result.structuredContent["result"], "10")
            state = await client.call_tool("kernel_state", {"action": "vars"})
            self.assertEqual(state.structuredContent["kernel"], "default")

        async with self.server() as plugin:
            refused = await plugin.call_tool("kernel_state", {"action": "reset"})
            self.assertTrue(refused.isError, refused.content)
        async with self.server(standalone_data="AGY_PYTHON_REPL_DATA") as client:
            restored = await client.call_tool("run_code", {"code": "fixture"})
            self.assertEqual(restored.structuredContent["result"], "9")

        # Both direct client conventions require a matching route once the directory has hosted a conversation.
        args = {"code": "from pathlib import Path\nPath('managed-marker').touch()", "cwd": str(self.ws_b)}
        session_routing.enqueue_call(self.data, "run_code", args, CONV_B, "managed-call")
        for variable in ("PLUGIN_DATA", "AGY_PYTHON_REPL_DATA"):
            async with self.server(standalone_data=variable) as client:
                unassigned = {**args, "code": "from pathlib import Path\nPath('unassigned').touch()"}
                result = await client.call_tool("run_code", unassigned)
                self.assertTrue(result.isError, result.content)
                self.assertFalse((self.ws_b / "unassigned").exists())
        self.assertEqual(session_routing.claim_call_with_id(self.data, "run_code", args), (CONV_B, "managed-call"))

    async def test_documented_steps_and_workspaces_bind_direct_and_deferred_calls(self) -> None:
        calls = []
        for step, workspace in enumerate((self.ws_a, self.ws_b)):
            args = {"code": f"from pathlib import Path\nPath('step-{step}').touch()"}
            call = {"name": f"mcp_{SERVER_NAME}_run_code", "args": args} if step == 0 else {
                "name": "call_mcp_tool", "args": {"ServerName": SERVER_NAME, "ToolName": "run_code", "Arguments": args},
            }
            payload = {"stepIdx": step, "conversationId": CONV_A, "workspacePaths": [str(workspace)], "toolCall": call}
            self.assertEqual(self.run_hook("PreToolUse", payload), {"decision": "allow"})
            calls.append((args, payload, workspace))
        async with self.server() as client:
            for step, (args, payload, workspace) in enumerate(calls):
                result = await client.call_tool("run_code", args)
                self.assertFalse(result.isError, result.content)
                self.assertTrue((workspace / f"step-{step}").is_file())
                self.assertEqual(self.run_hook("PostToolUse", payload), {})
        self.assertEqual(list((self.data / "session-routing" / "receipts").glob("*.json")), [])
        self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_A}), {})

    def test_missing_settings_or_managed_locations_cannot_fall_back(self) -> None:
        args = {"action": "vars"}
        with patch.dict(os.environ, {"HOME": str(self.root)}, clear=True):
            with self.assertRaisesRegex(session_routing.SessionRoutingError, "own absolute"):
                session_routing.resolve_execution_context(self.data, "kernel_state", args, cwd=None)
            configured = {"PLUGIN_DATA": str(self.data)}
            with patch.dict(os.environ, {**configured, "ANTIGRAVITY_CONVERSATION_ID": CONV_A}):
                with self.assertRaisesRegex(session_routing.SessionRoutingError, "No matching"):
                    session_routing.resolve_execution_context(self.data, "kernel_state", args, cwd=None)
            (self.data / "routing-guidance").mkdir(parents=True)
            with patch.dict(os.environ, configured):
                with self.assertRaisesRegex(session_routing.SessionRoutingError, "No matching"):
                    session_routing.resolve_execution_context(self.data, "kernel_state", args, cwd=None)
            for app in ("antigravity", "antigravity-cli", "antigravity-ide"):
                managed = self.root / ".gemini" / app / "plugin_data" / "agy-python-repl"
                managed.mkdir(parents=True)
                alias = self.root / app
                alias.symlink_to(managed, target_is_directory=True)
                with patch.dict(os.environ, {"AGY_PYTHON_REPL_DATA": str(alias)}):
                    with self.assertRaisesRegex(session_routing.SessionRoutingError, "No matching"):
                        session_routing.resolve_execution_context(alias, "kernel_state", args, cwd=None)

    def test_existing_queue_format_keeps_its_workspace_and_damaged_queue_stops(self) -> None:
        args = {"action": "vars"}
        key = session_routing.call_key("kernel_state", args)
        queue = self.data / "session-routing" / "queues" / f"{key}.json"
        queue.parent.mkdir(parents=True)
        original = {"tool_call_id": "before-update", "conversation_id": CONV_A, "created_at": time.time()}
        queue.write_text(json.dumps([original]), encoding="utf-8")
        session_routing.record_workspace(self.data, CONV_A, str(self.ws_a))
        with patch.dict(os.environ, {"PLUGIN_DATA": str(self.data)}, clear=True):
            self.assertEqual(session_routing.resolve_execution_context(self.data, "kernel_state", args, cwd=None),
                             (CONV_A, self.ws_a))
            queue.write_text("incomplete fixture", encoding="utf-8")
            with self.assertRaisesRegex(session_routing.SessionRoutingError, "could not read"):
                session_routing.resolve_execution_context(self.data, "kernel_state", args, cwd=None)
            rejected = self.run_hook("PreToolUse", {"conversationId": CONV_B, "stepIdx": 7, "toolCall": {
                "name": f"mcp_{SERVER_NAME}_kernel_state", "args": args,
            }})
            self.assertEqual(rejected["decision"], "deny")
            self.assertEqual(queue.read_text(encoding="utf-8"), "incomplete fixture")

    def test_ambiguous_identity_denies_only_this_plugins_scoped_tools(self) -> None:
        call = {"name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": "pass"}}
        wrapped = {"name": "call_mcp_tool", "args": {"ServerName": SERVER_NAME, "ToolName": "run_code",
                                                    "Arguments": call["args"]}}
        for conversation in (None, "", " ", "default"):
            for target in (call, wrapped):
                result = self.run_hook("PreToolUse", {"conversationId": conversation, "toolCall": target})
                self.assertEqual(result["decision"], "deny")
                self.assertIn("conversation ID", result["reason"])
        other = {"toolCall": {"name": "call_mcp_tool", "args": {"ServerName": "other", "ToolName": "run_code"}}}
        self.assertEqual(self.run_hook("PreToolUse", other), {"decision": "allow"})
        self.assertFalse(self.data.exists())

    async def test_hook_routes_sessions_and_verifies_silently(self) -> None:
        async with self.server() as client:
            for conv, ws, val in ((CONV_A, self.ws_a, 10), (CONV_B, self.ws_b, 20)):
                call = {
                    "id": f"init-{conv}",
                    "name": f"mcp_{SERVER_NAME}_run_code",
                    "args": {
                        "code": f"from pathlib import Path\nval = {val}\nPath('origin.txt').read_text()",
                        "toolSummary": "Init",
                    },
                }
                hook = self.run_hook("PreToolUse", {"conversationId": conv, "workspacePaths": [str(ws)], "toolCall": call})
                self.assertEqual(hook, {"decision": "allow"})
                reply = await client.call_tool("run_code", {"code": call["args"]["code"]})
                self.assertFalse(reply.isError, reply.content)
                expected_origin = "from-a" if conv == CONV_A else "from-b"
                self.assertEqual(reply.structuredContent["result"], repr(expected_origin))
                self.assertEqual(self.run_hook("PostToolUse", {"conversationId": conv, "toolCall": call}), {})
                self.assertEqual(self.run_hook("PostInvocation", {"conversationId": conv}), {})

            for conv, ws, expected in ((CONV_A, self.ws_a, 10), (CONV_B, self.ws_b, 20)):
                check_call = {
                    "id": f"check-{conv}",
                    "name": f"mcp_{SERVER_NAME}_run_code",
                    "args": {"code": "val", "toolSummary": f"Check {conv[-2:]}"},
                }
                self.assertEqual(
                    self.run_hook("PreToolUse", {"conversationId": conv, "workspacePaths": [str(ws)], "toolCall": check_call}),
                    {"decision": "allow"},
                )
                reply = await client.call_tool("run_code", {"code": "val"})
                self.assertEqual(reply.structuredContent["result"], repr(expected))
                self.assertEqual(self.run_hook("PostToolUse", {"conversationId": conv, "toolCall": check_call}), {})
                self.assertEqual(self.run_hook("PostInvocation", {"conversationId": conv}), {})

            vars_call = {
                "id": "vars-b",
                "name": f"mcp_{SERVER_NAME}_kernel_state",
                "args": {"action": "vars"},
            }
            self.assertEqual(
                self.run_hook("PreToolUse", {"conversationId": CONV_B, "workspacePaths": [str(self.ws_b)], "toolCall": vars_call}),
                {"decision": "allow"},
            )
            listed_b = await client.call_tool("kernel_state", {"action": "vars"})
            self.assertEqual(listed_b.structuredContent["kernel"], CONV_B)
            self.assertIn("val", listed_b.structuredContent["names"])
            self.assertEqual(self.run_hook("PostToolUse", {"conversationId": CONV_B, "toolCall": vars_call}), {})
            self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_B}), {})

    async def test_concurrent_identical_call_waits_and_routes_without_overwrite(self) -> None:
        shared_code = "identical_probe = 123"
        call_a = {"id": "same-a", "name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": shared_code}}
        call_b = {"id": "same-b", "name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": shared_code}}

        self.assertEqual(
            self.run_hook("PreToolUse", {"conversationId": CONV_A, "workspacePaths": [str(self.ws_a)], "toolCall": call_a}),
            {"decision": "allow"},
        )

        hook_b_result: dict = {}

        def run_b_hook() -> None:
            hook_b_result["res"] = self.run_hook(
                "PreToolUse",
                {"conversationId": CONV_B, "workspacePaths": [str(self.ws_b)], "toolCall": call_b},
            )

        thread = threading.Thread(target=run_b_hook)
        thread.start()
        time.sleep(0.08)
        self.assertTrue(thread.is_alive())

        async with self.server() as client:
            res_a = await client.call_tool("run_code", {"code": shared_code})
            self.assertEqual(res_a.structuredContent["status"], "ok")
            thread.join(timeout=3.0)
            self.assertFalse(thread.is_alive())
            self.assertEqual(hook_b_result["res"], {"decision": "allow"})

            res_b = await client.call_tool("run_code", {"code": shared_code})
            self.assertEqual(res_b.structuredContent["status"], "ok")

            self.assertEqual(self.run_hook("PostToolUse", {"conversationId": CONV_A, "toolCall": call_a}), {})
            self.assertEqual(self.run_hook("PostToolUse", {"conversationId": CONV_B, "toolCall": call_b}), {})
            self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_A}), {})
            self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_B}), {})

            for conv, ws in ((CONV_A, self.ws_a), (CONV_B, self.ws_b)):
                verify_call = {
                    "id": f"verify-{conv}",
                    "name": f"mcp_{SERVER_NAME}_run_code",
                    "args": {"code": "from pathlib import Path\n(identical_probe, Path('origin.txt').read_text())"},
                }
                self.run_hook("PreToolUse", {"conversationId": conv, "workspacePaths": [str(ws)], "toolCall": verify_call})
                r = await client.call_tool("run_code", {"code": verify_call["args"]["code"]})
                expected_origin = "from-a" if conv == CONV_A else "from-b"
                self.assertEqual(r.structuredContent["result"], repr((123, expected_origin)))
                self.assertEqual(self.run_hook("PostToolUse", {"conversationId": conv, "toolCall": verify_call}), {})
                self.assertEqual(self.run_hook("PostInvocation", {"conversationId": conv}), {})

    def test_collision_timeout_and_expiry_preserve_the_owner_until_cleanup(self) -> None:
        args = {"code": "pending_marker = 1"}
        self.assertTrue(session_routing.enqueue_call(self.data, "run_code", args, CONV_A, "first"))
        self.assertFalse(session_routing.enqueue_call(self.data, "run_code", args, CONV_B, "second", wait_seconds=0))
        self.assertEqual(session_routing.claim_call_with_id(self.data, "run_code", args), (CONV_A, "first"))

        with patch.object(time, "time", return_value=time.time() - session_routing.PENDING_TTL_SECONDS - 1):
            session_routing.enqueue_call(self.data, "run_code", args, CONV_A, "delayed")
        call = {"name": f"mcp_{SERVER_NAME}_run_code", "id": "delayed", "args": args}
        self.assertIsNone(session_routing.claim_call(self.data, "run_code", args))
        refused = self.run_hook("PreToolUse", {"conversationId": CONV_B, "toolCall": call})
        self.assertEqual(refused["decision"], "deny")
        # A denial/cancellation for the other conversation cannot retire the delayed claim.
        self.run_hook("PostToolUse", {"conversationId": CONV_B, "toolCall": call, "error": "denied"})
        self.assertFalse(session_routing.enqueue_call(self.data, "run_code", args, CONV_B, "third", wait_seconds=0))
        for event, extra in (("PostInvocation", {}), ("Stop", {"fullyIdle": False}), ("Stop", {})):
            self.assertEqual(self.run_hook(event, {"conversationId": CONV_A, **extra}), {})
            self.assertFalse(session_routing.enqueue_call(self.data, "run_code", args, CONV_B, "third", wait_seconds=0))
        self.assertEqual(self.run_hook("Stop", {"conversationId": CONV_A, "fullyIdle": True}), {})
        self.assertTrue(session_routing.enqueue_call(self.data, "run_code", args, CONV_B, "third", wait_seconds=0))
        self.assertEqual(session_routing.claim_call_with_id(self.data, "run_code", args), (CONV_B, "third"))

    def test_success_without_an_assignment_receipt_reports_the_old_server_boundary(self) -> None:
        call = {"name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": "fixture_value = 7"}}
        payload = {"conversationId": CONV_A, "stepIdx": 4, "toolCall": call}
        self.assertEqual(self.run_hook("PreToolUse", payload), {"decision": "allow"})
        # A server that never consumed the reservation cannot confirm this returned result.
        self.assertEqual(self.run_hook("PostToolUse", payload), {})
        post = self.run_hook("PostInvocation", {"conversationId": CONV_A})
        self.assertIn("without a receipt", post["injectSteps"][0]["systemMessage"]["systemMessage"])

    def test_equal_hook_ids_in_different_conversations_have_separate_receipts(self) -> None:
        args = {"action": "vars"}
        for conv in (CONV_A, CONV_B):
            session_routing.record_execution_receipt(self.data, "same-step", conv, conv)
        for conv in (CONV_B, CONV_A):
            self.assertTrue(session_routing.verify_post_tool_execution(
                self.data, "kernel_state", args, conv_id=conv, tool_call_id="same-step"))
            self.assertEqual(session_routing.consume_routing_alerts(self.data, conv), [])

    def test_post_tool_use_and_post_invocation_intercept_mismatched_execution(self) -> None:
        # The receipt selected the wrong kernel for this conversation.
        call_1 = {"id": "mismatch-1", "name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": "x = 1"}}
        session_routing.record_execution_receipt(self.data, "mismatch-1", CONV_A, CONV_B)
        self.assertEqual(self.run_hook("PostToolUse", {"conversationId": CONV_A, "toolCall": call_1}), {})
        post_inv = self.run_hook("PostInvocation", {"conversationId": CONV_A})
        self.assertEqual(post_inv["terminationBehavior"], "force_continue")
        msg = post_inv["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("mismatch-1", msg)
        self.assertIn(CONV_B, msg)
        # Alert is consumed once so subsequent invocations proceed cleanly.
        self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_A}), {})

        # Case 2: claim was evicted/missing and server executed unmatched on 'default'.
        call_2 = {"id": "unmatched-2", "name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": "y = 2"}}
        session_routing.record_unmatched_execution(self.data, "run_code", {"code": "y = 2"}, "default")
        self.assertEqual(self.run_hook("PostToolUse", {"conversationId": CONV_A, "toolCall": call_2}), {})
        post_inv_2 = self.run_hook("PostInvocation", {"conversationId": CONV_A})
        self.assertEqual(post_inv_2["terminationBehavior"], "force_continue")
        msg_2 = post_inv_2["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("unmatched-2", msg_2)
        self.assertIn("default", msg_2)

    def test_post_tool_use_cleans_unconsumed_claim_and_unwritable_data_denies(self) -> None:
        call = {"id": "cancelled-call", "name": f"mcp_{SERVER_NAME}_kernel_state", "args": {"action": "vars"}}
        self.assertEqual(
            self.run_hook("PreToolUse", {"conversationId": CONV_A, "workspacePaths": [str(self.ws_a)], "toolCall": call}),
            {"decision": "allow"},
        )
        self.assertEqual(
            self.run_hook("PostToolUse", {"conversationId": CONV_A, "toolCall": call, "error": "cancelled"}),
            {},
        )
        self.assertIsNone(session_routing.claim_call(self.data, "kernel_state", {"action": "vars"}))
        self.assertEqual(self.run_hook("PostInvocation", {"conversationId": CONV_A}), {})

        blocked_data = self.root / "not_a_dir"
        blocked_data.write_text("file", encoding="utf-8")
        res = self.run_hook(
            "PreToolUse",
            {
                "conversationId": CONV_A,
                "workspacePaths": [str(self.ws_a)],
                "toolCall": {"id": "ro-call", "name": f"mcp_{SERVER_NAME}_run_code", "args": {"code": "1 + 1"}},
            },
            data_dir=blocked_data,
        )
        self.assertEqual(res["decision"], "deny")
        self.assertIn("plugin data", res["reason"])
