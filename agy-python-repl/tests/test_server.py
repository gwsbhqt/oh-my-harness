"""End-to-end tests for agy-python-repl and python-repl-core."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from agy_python_repl.manager import KernelManager
from agy_python_repl.session_routing import resolve_execution_context


class AgyPythonReplTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_dir = Path(self._tmp.name)
        self.skill_root = self.tmp_dir / "skills"
        demo_skill = self.skill_root / "demo-math"
        (demo_skill / "src" / "demo_math").mkdir(parents=True)
        (demo_skill / "SKILL.md").write_text(
            "---\nname: demo-math\ndescription: Demo math helper\n---\n# Demo Math\nUse add(a, b).\n",
            encoding="utf-8",
        )
        (demo_skill / "src" / "demo_math" / "__init__.py").write_text(
            "def add(a: int, b: int) -> int:\n    return a + b\n",
            encoding="utf-8",
        )

        self.manager = KernelManager(
            data_dir=self.tmp_dir / "data",
            skill_roots=[self.skill_root],
            project_skill_roots=[],
            max_output_chars=400,
        )

    async def asyncTearDown(self) -> None:
        await self.manager.shutdown_all()
        self._tmp.cleanup()

    async def test_state_persists_and_top_level_await_works(self) -> None:
        r1 = await self.manager.run_code("import asyncio\nawait asyncio.sleep(0)\nx = 40 + 2")
        self.assertEqual(r1["status"], "ok")

        r2 = await self.manager.run_code("x * 2")
        self.assertEqual(r2["status"], "ok")
        self.assertEqual(r2["result"], "84")

    async def test_named_kernels_are_isolated(self) -> None:
        await self.manager.run_code("secret = 'alpha'", kernel="k1")
        r = await self.manager.run_code("'secret' in globals()", kernel="k2")
        self.assertEqual(r["result"], "False")

    async def test_skills_namespace_and_import_guard(self) -> None:
        r_list = await self.manager.run_code(
            "any(skill['import_name'] == 'demo_math' for skill in await skills.list())"
        )
        self.assertEqual(r_list["status"], "ok")
        self.assertEqual(r_list["result"], "True")

        r_call = await self.manager.run_code("from skills import demo_math\ndemo_math.add(19, 23)")
        self.assertEqual(r_call["status"], "ok")
        self.assertEqual(r_call["result"], "42")

    async def test_output_budget_spills_overflow_to_disk(self) -> None:
        r = await self.manager.run_code("print('A' * 1000)")
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["truncated"])
        self.assertEqual(len(r["overflow_files"]), 1)
        overflow_path = Path(r["overflow_files"][0])
        self.assertTrue(overflow_path.is_file())
        self.assertEqual(len(overflow_path.read_text(encoding="utf-8").strip()), 1000)

    async def test_snapshot_reset_and_restore (self) -> None:
        await self.manager.run_code("payload = {'count': 7}")
        snap = await self.manager.kernel_state("snapshot", kernel="default")
        self.assertEqual(snap["status"], "ok")

        # Mutate state, then restore from the saved snapshot.
        await self.manager.run_code("payload = {'count': 99}")
        restored = await self.manager.kernel_state("restore", kernel="default")
        self.assertEqual(restored["status"], "ok")

        # Reset clears both the live kernel and its persisted snapshot.
        await self.manager.kernel_state("reset", kernel="default")
        r_missing = await self.manager.run_code("'payload' in globals()", kernel="default")
        self.assertEqual(r_missing["result"], "False")

    async def test_auto_snapshot_and_auto_restore_across_manager_restart(self) -> None:
        session_id = "conv-1234"
        await self.manager.run_code("state_val = {'step': 99}", kernel=session_id)
        await self.manager.shutdown_all()

        fresh_manager = KernelManager(
            data_dir=self.tmp_dir / "data",
            skill_roots=[self.skill_root],
            project_skill_roots=[],
            max_output_chars=400,
        )
        try:
            res = await fresh_manager.run_code("state_val['step'] + 1", kernel=session_id)
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["result"], "100")
            self.assertIn("restored", res)
            self.assertTrue(res["restored"]["restored"])
            self.assertIn("state_val", res["restored"]["saved_names"])
        finally:
            await fresh_manager.shutdown_all()

    async def test_timeout_returns_timeout_result_without_cancelled_error(self) -> None:
        import time
        started = time.monotonic()
        r = await self.manager.run_code("import asyncio\nawait asyncio.sleep(10)", timeout_seconds=0.05)
        elapsed = time.monotonic() - started
        self.assertEqual(r["status"], "timeout")
        self.assertLess(elapsed, 2.0)

    async def test_concurrent_first_cells_preserve_both_variables(self) -> None:
        import asyncio
        r1, r2 = await asyncio.gather(
            self.manager.run_code("x = 1", kernel="conv-race"),
            self.manager.run_code("y = 2", kernel="conv-race"),
        )
        self.assertEqual(r1["status"], "ok")
        self.assertEqual(r2["status"], "ok")
        r3 = await self.manager.run_code("x + y", kernel="conv-race")
        self.assertEqual(r3["result"], "3")

    async def test_kernel_state_list_is_scoped_to_session(self) -> None:
        await self.manager.run_code("a = 1", kernel="conv-a")
        await self.manager.run_code("b = 2", kernel="conv-b")
        listed = await self.manager.kernel_state("list", kernel="conv-a")
        active_names = [k["name"] for k in listed["active_kernels"]]
        self.assertEqual(active_names, ["conv-a"])
        self.assertEqual(listed["saved_snapshots"], ["conv-a"])

    def run_hook(self, event: str, payload: dict) -> dict:
        root = Path(__file__).resolve().parents[1]
        group = json.loads((root / "hooks.json").read_text())["agy-python-repl-session"][event][0]
        handler = group["hooks"][0] if event in ("PreToolUse", "PostToolUse") else group
        env = {**os.environ, "PLUGIN_DATA": str(self.tmp_dir / "hook_data"),
               "PATH": os.pathsep.join((str(Path(sys.executable).parent), os.defpath))}
        result = subprocess.run(shlex.split(handler["command"]), cwd=root, input=json.dumps(payload),
                                env=env, text=True, capture_output=True, check=True, timeout=handler["timeout"])
        return json.loads(result.stdout)

    def resolve_hook_call(self, tool, args):
        data = self.tmp_dir / "hook_data"
        with patch.dict(os.environ, {"PLUGIN_DATA": str(data)}):
            return resolve_execution_context(data, tool, args, cwd=args.get("cwd"))

    def test_hook_matcher_selects_the_repl_and_deferred_dispatch(self) -> None:
        config = Path(__file__).resolve().parents[1] / "hooks.json"
        group = json.loads(config.read_text(encoding="utf-8"))["agy-python-repl-session"]["PreToolUse"][0]
        matcher = re.compile(group["matcher"])
        for name in (
            "mcp_agy-python-repl_agy-python-repl_run_code",
            "mcp_agy-python-repl_agy-python-repl_kernel_state",
            "call_mcp_tool",
        ):
            self.assertIsNotNone(matcher.search(name), name)
        for name in ("mcp_other_run_code", "run_code", "run_command", "other_call_mcp_tool"):
            self.assertIsNone(matcher.search(name), name)

    def test_session_binding_for_direct_and_deferred_repl_tools(self) -> None:
        server = "agy-python-repl_agy-python-repl"
        workspace = str(self.tmp_dir / "workspace")
        for tool, original in (("run_code", {"code": "1 + 1"}), ("kernel_state", {"action": "vars"}),
                               ("kernel_state", {"action": "restart"})):
            direct = f"mcp_{server}_{tool}"
            calls = (
                {"id": f"direct-{tool}", "name": direct, "args": original},
                {
                    "id": f"deferred-{tool}",
                    "name": "call_mcp_tool",
                    "args": {"ServerName": server, "ToolName": tool, "Arguments": original},
                },
            )
            for call in calls:
                with self.subTest(tool=tool, form=call["name"]):
                    result = self.run_hook("PreToolUse", {
                        "conversationId": "conv-abc", "workspacePaths": [workspace], "toolCall": call,
                    })
                    self.assertEqual(result, {"decision": "allow"})
                    self.assertEqual(self.resolve_hook_call(tool, original)[1], Path(workspace))
                    post = self.run_hook("PostToolUse", {
                        "conversationId": "conv-abc", "workspacePaths": [workspace], "toolCall": call,
                    })
                    self.assertEqual(post, {})

    def test_session_binding_preserves_explicit_args_without_overwrite(self) -> None:
        for idx, cwd in enumerate(("/workspace/data", "/workspace/other")):
            with self.subTest(cwd=cwd):
                call = {
                    "id": f"explicit-{idx}",
                    "name": "mcp_agy-python-repl_agy-python-repl_run_code",
                    "args": {"code": "2 + 2", "cwd": cwd},
                }
                result = self.run_hook("PreToolUse", {
                    "conversationId": "conv-abc", "cwd": "/workspace", "toolCall": call,
                })
                self.assertEqual(result, {"decision": "allow"})
                self.assertEqual(self.resolve_hook_call("run_code", call["args"])[1], Path(cwd))
                self.assertEqual(self.run_hook("PostToolUse", {"conversationId": "conv-abc", "toolCall": call}), {})
                self.assertEqual(self.run_hook("PostInvocation", {"conversationId": "conv-abc"}), {})

    def test_other_mcp_tools_keep_their_original_arguments(self) -> None:
        server = "agy-python-repl_agy-python-repl"
        for call in (
            {"name": "run_code", "args": {}},
            {"name": "mcp_other_plugin_run_code", "args": {}},
            {"name": "call_mcp_tool", "args": {"ServerName": f"other-{server}", "ToolName": "run_code"}},
            {"name": "call_mcp_tool", "args": {"ServerName": server, "ToolName": "open_kernel_panel"}},
        ):
            with self.subTest(call=call):
                result = self.run_hook("PreToolUse", {"conversationId": "conv-abc", "toolCall": call})
                self.assertEqual(result, {"decision": "allow"})

    def test_source_review_guidance_reaches_new_and_open_conversations_once(self) -> None:
        def invocation(conversation, number, steps, prompt):
            return self.run_hook("PreInvocation", {"conversationId": conversation, "invocationNum": number,
                                 "initialNumSteps": steps, "lastUserInput": prompt})

        start = self.run_hook("SessionStart", {"conversationId": "new-review"})
        msg = start["injectSteps"][0]["systemMessage"]["systemMessage"]
        for word in ("run_code", "source", "SKILL.md", "read_file", "follow-up"):
            self.assertIn(word, msg)
        self.assertEqual(invocation("new-review", 0, 2, "Compare the three implementations."), {})
        self.assertEqual(invocation("new-review", 21, 51, "Compare the three implementations."), {})
        self.assertEqual(invocation("new-review", 0, 53, "请从上次的文件核对这一点。"), {})

        old = invocation("existing-review", 17, 42, "請比較這些實作。")
        self.assertEqual(old, start)
        self.assertEqual(self.run_hook("SessionStart", {"conversationId": "existing-review"}), {})
        self.assertEqual(invocation("existing-review", 0, 73, "Check that again."), {})
        markers = [p for p in (self.tmp_dir / "hook_data").rglob("*") if p.is_file()]
        self.assertEqual(len(markers), 2)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", p.name) for p in markers))
        self.assertTrue(all(p.read_bytes() == b"" for p in markers))

    def test_concurrent_session_start_and_model_calls_share_one_reminder(self) -> None:
        payload = {"conversationId": "parallel-review", "invocationNum": 0, "initialNumSteps": 1}
        with ThreadPoolExecutor(max_workers=6) as jobs:
            results = list(jobs.map(lambda event: self.run_hook(event, payload),
                                    ["SessionStart", *(["PreInvocation"] * 5)]))
        self.assertEqual(sum("injectSteps" in reply for reply in results), 1)

    def test_unwritable_receipt_still_guides_start_and_keeps_model_calls_quiet(self) -> None:
        (self.tmp_dir / "hook_data").write_text("unavailable")
        request = {"conversationId": "read-only", "lastUserInput": "Compare these files."}
        self.assertIn("injectSteps", self.run_hook("SessionStart", request))
        for number in (0, 1, 23, 0):
            self.assertEqual(self.run_hook("PreInvocation", {**request, "invocationNum": number}), {})

    def test_session_start_announces_tool_access_and_any_saved_state(self) -> None:
        request = {"conversationId": "conv-xyz"}
        fresh = self.run_hook("SessionStart", request)
        msg = fresh["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("run_code", msg)
        self.assertIn("call_mcp_tool", msg)
        self.assertNotIn("snapshot", msg.lower())

        snap_dir = self.tmp_dir / "hook_data" / "snapshots"
        snap_dir.mkdir(parents=True)
        (snap_dir / "conv-xyz.dill").write_bytes(b"stub")
        (snap_dir / "conv-xyz.manifest.json").write_text(
            json.dumps({"savedNames": ["df", "records", "glob"]}), encoding="utf-8",
        )
        resumed = self.run_hook("SessionStart", request)
        msg = resumed["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("run_code", msg)
        self.assertIn("snapshot", msg)
        self.assertIn("df, records", msg)
        self.assertIn("await repl.restore_binding('glob')", msg)


if __name__ == "__main__":
    unittest.main()
