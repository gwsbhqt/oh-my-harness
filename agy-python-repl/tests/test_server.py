"""End-to-end tests for agy-python-repl and python-repl-core."""

from __future__ import annotations

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
        r_list = await self.manager.run_code("await skills.list()")
        self.assertEqual(r_list["status"], "ok")
        self.assertIn("demo_math", r_list["result"])

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
        r = await self.manager.run_code("import asyncio\nawait asyncio.sleep(2)", timeout_seconds=0.05)
        self.assertEqual(r["status"], "timeout")

    def test_pretooluse_hook_scopes_kernel_by_conversation_id(self) -> None:
        import json
        import subprocess

        hook_script = Path(__file__).resolve().parents[1] / "hooks" / "inject_session.py"
        lazy_payload = {
            "conversationId": "conv-abc",
            "workspacePaths": ["/tmp/ws-from-paths"],
            "toolCall": {
                "name": "call_mcp_tool",
                "args": {
                    "ServerName": "agy-python-repl_agy-python-repl",
                    "ToolName": "run_code",
                    "Arguments": {"code": "1+1"},
                },
            },
        }
        proc = subprocess.run(
            ["python3", str(hook_script)],
            input=json.dumps(lazy_payload),
            text=True,
            capture_output=True,
            check=True,
        )
        out = json.loads(proc.stdout)
        self.assertEqual(out["decision"], "allow")
        self.assertEqual(out["overwrite"]["Arguments"]["kernel"], "conv-abc")
        self.assertEqual(out["overwrite"]["Arguments"]["cwd"], "/tmp/ws-from-paths")

    def test_session_start_hook_reports_snapshot_only_when_present(self) -> None:
        import json
        import os
        import subprocess

        data_dir = self.tmp_dir / "hook_data"
        hook_script = Path(__file__).resolve().parents[1] / "hooks" / "session_start.py"
        env = os.environ.copy()
        env["PLUGIN_DATA"] = str(data_dir)

        # No snapshot -> empty JSON (zero extra tokens).
        empty_proc = subprocess.run(
            ["python3", str(hook_script)],
            input=json.dumps({"conversationId": "conv-xyz"}),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        self.assertEqual(json.loads(empty_proc.stdout), {})

        snap_dir = data_dir / "snapshots"
        snap_dir.mkdir(parents=True)
        (snap_dir / "conv-xyz.dill").write_bytes(b"stub")
        (snap_dir / "conv-xyz.manifest.json").write_text(
            json.dumps({"savedNames": ["df", "records"]}),
            encoding="utf-8",
        )

        proc = subprocess.run(
            ["python3", str(hook_script)],
            input=json.dumps({"conversationId": "conv-xyz"}),
            text=True,
            capture_output=True,
            env=env,
            check=True,
        )
        out = json.loads(proc.stdout)
        msg = out["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("df, records", msg)


if __name__ == "__main__":
    unittest.main()
