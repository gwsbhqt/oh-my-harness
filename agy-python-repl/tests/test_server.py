"""End-to-end tests for agy-python-repl and python-repl-core."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agy_python_repl.manager import KernelManager


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

    def run_hook(self, name: str, payload: dict) -> dict:
        script = Path(__file__).resolve().parents[1] / "hooks" / name
        env = {**os.environ, "PLUGIN_DATA": str(self.tmp_dir / "hook_data")}
        result = subprocess.run(
            [sys.executable, str(script)],
            input=json.dumps(payload),
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )
        return json.loads(result.stdout)

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
                {"name": direct, "args": original},
                {"name": "call_mcp_tool", "args": {"ServerName": server, "ToolName": tool, "Arguments": original}},
            )
            for call in calls:
                with self.subTest(tool=tool, form=call["name"]):
                    result = self.run_hook("inject_session.py", {
                        "conversationId": "conv-abc", "workspacePaths": [workspace], "toolCall": call,
                    })
                    updates = {"kernel": "conv-abc", "cwd": workspace}
                    if call["name"] == "call_mcp_tool":
                        updates = {"Arguments": {**original, **updates}}
                    self.assertEqual(result, {"decision": "allow", "overwrite": updates})

    def test_session_binding_preserves_scoped_kernels_and_an_explicit_workspace(self) -> None:
        kernels = (
            ("tables", "conv-abc:tables"),
            ("conv-abc:tables", "conv-abc:tables"),
            ("conv-abc__tables", "conv-abc:tables"),
            ("conv-abc", "conv-abc"),
        )
        for kernel, expected in kernels:
            with self.subTest(kernel=kernel):
                result = self.run_hook("inject_session.py", {
                    "conversationId": "conv-abc", "cwd": "/workspace",
                    "toolCall": {
                        "name": "mcp_agy-python-repl_agy-python-repl_run_code",
                        "args": {"code": "2 + 2", "kernel": kernel, "cwd": "/workspace/data"},
                    },
                })
                self.assertEqual(result["overwrite"], {"kernel": expected})

    def test_other_mcp_tools_keep_their_original_arguments(self) -> None:
        server = "agy-python-repl_agy-python-repl"
        for call in (
            {"name": "run_code", "args": {}},
            {"name": "mcp_other_plugin_run_code", "args": {}},
            {"name": "call_mcp_tool", "args": {"ServerName": f"other-{server}", "ToolName": "run_code"}},
            {"name": "call_mcp_tool", "args": {"ServerName": server, "ToolName": "open_kernel_panel"}},
        ):
            with self.subTest(call=call):
                result = self.run_hook("inject_session.py", {"conversationId": "conv-abc", "toolCall": call})
                self.assertEqual(result, {"decision": "allow"})

    def test_session_start_announces_tool_access_and_any_saved_state(self) -> None:
        request = {"conversationId": "conv-xyz"}
        fresh = self.run_hook("session_start.py", request)
        msg = fresh["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("run_code", msg)
        self.assertIn("call_mcp_tool", msg)
        self.assertNotIn("snapshot", msg.lower())

        snap_dir = self.tmp_dir / "hook_data" / "snapshots"
        snap_dir.mkdir(parents=True)
        (snap_dir / "conv-xyz.dill").write_bytes(b"stub")
        (snap_dir / "conv-xyz.manifest.json").write_text(
            json.dumps({"savedNames": ["df", "records"]}), encoding="utf-8",
        )
        resumed = self.run_hook("session_start.py", request)
        msg = resumed["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("run_code", msg)
        self.assertIn("snapshot", msg)
        self.assertIn("df, records", msg)


if __name__ == "__main__":
    unittest.main()
