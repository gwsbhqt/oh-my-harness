"""What a job that is still running tells the model, in a root session and in a subagent.

DSH wakes an idle root session when one of its jobs ends. A subagent is
different: the moment its turn ends DSH releases it, stops every job it
started and sends no notice (dsh-subagent watchLocalSettlement, dsh-jobs-local
cancelForTeardown). "End this turn, DSH wakes you" is true for the first and
loses the work for the second, so every such note has two versions.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import background  # noqa: E402
import detours  # noqa: E402
import dsh_kernel  # noqa: E402
from test_bridge import reply_with, use_cell  # noqa: E402

RUNNING = {"text": "", "job": {"id": "j1", "status": "running"}}
WAKES = "DSH wakes you when it finishes"
SUBAGENT = "You are a subagent"


class Mode(unittest.IsolatedAsyncioTestCase):
    subagent = False

    def setUp(self) -> None:
        saved = getattr(dsh_kernel, "_SUBAGENT", False)
        dsh_kernel._SUBAGENT = self.subagent
        self.addCleanup(setattr, dsh_kernel, "_SUBAGENT", saved)

    def assert_mode(self, text: str) -> None:
        if self.subagent:
            self.assertIn(SUBAGENT, text)
            self.assertIn("no notice", text)
            self.assertNotIn(WAKES, text)
            self.assertNotIn("end this turn", text)
        else:
            self.assertIn(WAKES, text)
            self.assertNotIn(SUBAGENT, text)

    async def call(self, tool, value):
        use_cell("cell-1", host=reply_with(value))
        return await dsh_kernel.call_tool(tool, {})

    async def test_background_receipt(self) -> None:
        self.assert_mode(repr(await self.call("bash", {"kind": "background", "jobId": "bash-7"})))

    async def test_promoted_result_has_no_stdout_yet(self) -> None:
        result = await self.call("bash", {"kind": "promoted", "jobId": "job-7", "timeoutMs": 5000, "output": ""})
        with self.assertRaises(KeyError) as caught:
            result["stdout"]
        self.assert_mode(str(caught.exception))

    async def test_job_output_still_running(self) -> None:
        self.assert_mode(repr(await self.call("job_output", RUNNING)))

    async def test_await_job_past_the_wait(self) -> None:
        use_cell("cell-2", host=reply_with(RUNNING))
        with self.assertRaises(dsh_kernel.JobStillRunning) as caught:
            await dsh_kernel.BashJob("j1", "make").wait(1)
        self.assert_mode(str(caught.exception))

    async def test_wait_ended_by_a_user_message(self) -> None:
        use_cell("cell-3", host=reply_with({"text": "", "job": {"id": "j1", "status": "running", "detail": "user steered"}}))
        with self.assertRaises(dsh_kernel.JobStillRunning) as caught:
            await dsh_kernel.BashJob("j1", "make").wait()
        self.assert_mode(str(caught.exception))

    async def test_background_work_past_the_wait(self) -> None:
        import asyncio

        saved = dsh_kernel._WAIT_MS
        dsh_kernel._WAIT_MS = 10
        self.addCleanup(setattr, dsh_kernel, "_WAIT_MS", saved)
        task = asyncio.ensure_future(asyncio.sleep(5))
        self.addCleanup(task.cancel)
        handle = background.BackgroundJob("python-1", "work", task, False)
        with self.assertRaises(dsh_kernel.JobStillRunning) as caught:
            await handle
        self.assert_mode(str(caught.exception))

    def test_sleep_poll_note(self) -> None:
        notes = detours._sleep_poll(__import__("ast").parse("while True:\n    time.sleep(5)\n"))
        self.assertEqual(len(notes), 1)
        if self.subagent:
            self.assertIn(SUBAGENT, notes[0])
            self.assertNotIn("end the turn", notes[0])
        else:
            self.assertIn("end the turn instead. DSH wakes you", notes[0])

    def test_repl_background_docstring(self) -> None:
        import bootstrap

        doc = bootstrap._background_doc(self.subagent)
        if self.subagent:
            self.assertIn(SUBAGENT, doc)
            self.assertNotIn(WAKES, doc)
        else:
            self.assertEqual(doc, "Run long work after this cell ends, as a DSH background job; DSH wakes you when it finishes.")


class SubagentMode(Mode):
    subagent = True


if __name__ == "__main__":
    unittest.main()
