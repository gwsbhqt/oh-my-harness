"""Chrome 远程调试授权的识别与点击测试，不操作真实应用。"""
import asyncio
import unittest
from unittest.mock import patch

import computer_use


REF = {"id": 42, "pid": 123, "startedAt": 123.5, "bundleId": "com.google.Chrome"}


def prompt(**extra):
    return {"snapshot": "fixture", "window": REF, "elements": [
        {"idx": 1, "role": "AXStaticText", "label": "允许远程调试"},
        {"idx": 2, "role": "AXButton", "label": "允许"}], **extra}


class DebugApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_unique_prompt_stays_bound_without_claim_activation_or_restore(self):
        from unittest.mock import AsyncMock
        contexts = []
        replies = iter([prompt(), prompt(), {}, {"windows": []}])
        async def native(*args, **kwargs):
            contexts.append((args, computer_use._window_ref.get()))
            return next(replies)
        with patch("computer_use.cli", side_effect=native), patch("computer_use.asyncio.create_subprocess_exec", new=AsyncMock(side_effect=AssertionError("不得激活或恢复桌面"))):
            result = await computer_use.approve_chrome_debugging(watch=0)
        self.assertTrue(result["approved"])
        self.assertFalse(result["connectionVerified"])
        self.assertEqual(contexts[0][1], None)
        self.assertEqual(contexts[1][1], REF)
        self.assertEqual(contexts[2][1], REF)
        self.assertIn("--require-focus", contexts[2][0])
        self.assertEqual(contexts[3][1], None)
        self.assertFalse(any(c[0][0] == "owner" for c in contexts))

    async def test_settings_and_incomplete_non_prompt_are_observation_only(self):
        from unittest.mock import AsyncMock
        settings = {"elements": [{"role": "AXCheckBox", "label": "Allow remote debugging for this browser instance"}], "truncated": True}
        with patch("computer_use.cli", new=AsyncMock(return_value=settings)) as native:
            result = await computer_use.approve_chrome_debugging(watch=0)
        self.assertEqual(result, {"approved": False, "reason": "no_prompt"})
        self.assertEqual(native.await_count, 1)

    async def test_incomplete_ambiguous_or_changed_prompt_refuses_before_click(self):
        from unittest.mock import AsyncMock
        ambiguous = prompt()
        ambiguous["elements"] = ambiguous["elements"] + [{"idx": 3, "role": "AXButton", "label": "Allow"}]
        for replies in ([prompt(truncated=True)], [ambiguous], [prompt(), {"elements": []}], [prompt(), prompt(timedOut=True)]):
            with self.subTest(replies=replies), patch("computer_use.cli", new=AsyncMock(side_effect=replies)) as native:
                with self.assertRaises(computer_use.ComputerUseError) as caught:
                    await computer_use.approve_chrome_debugging(watch=0)
                self.assertEqual(caught.exception.outcome, "not_sent")
                self.assertTrue(all(call.args[0] == "snap" for call in native.await_args_list))

    async def test_focus_change_or_unknown_click_is_propagated_without_replay(self):
        from unittest.mock import AsyncMock
        for outcome in ("not_sent", "unknown"):
            failure = computer_use.ComputerUseError("目标窗口必须在前台；不会自动激活", 4, "click", outcome=outcome)
            with patch("computer_use.cli", new=AsyncMock(side_effect=[prompt(), prompt(), failure])) as native:
                with self.assertRaises(computer_use.ComputerUseError) as caught:
                    await computer_use.approve_chrome_debugging(watch=0)
                self.assertIs(caught.exception, failure)
                self.assertEqual(native.await_count, 3)

    async def test_ready_callback_happens_before_observation(self):
        from unittest.mock import AsyncMock
        events = []
        async def native(*args, **kwargs):
            events.append("observe")
            return {"elements": []}
        with patch("computer_use.cli", side_effect=native):
            await computer_use.approve_chrome_debugging(watch=0, on_ready=lambda: events.append("ready"))
        self.assertEqual(events, ["ready", "observe"])


if __name__ == "__main__":
    unittest.main()
