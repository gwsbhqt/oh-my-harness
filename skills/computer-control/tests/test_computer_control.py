"""computer-control Python 包的离线测试：用假程序顶替真的 computer-control，不碰真实界面。

Run:  python3 -m unittest discover -s tests -p "test_*.py" -v   (from the skill directory)
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import computer_control  # noqa: E402
from computer_control import build  # noqa: E402

STUB = r"""#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_RECORD"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
reply = os.environ.get("STUB_REPLY", '{"ok": true, "mode": "x"}')
sys.stderr.write(os.environ.get("STUB_ERR", ""))
print(reply)
sys.exit(int(os.environ.get("STUB_CODE", "0")))
"""

SNAP = {"snapshot": "fixture-token", "ok": True, "mode": "snap", "app": {"name": "计算器"}, "window": {"title": "计算器"}, "truncated": False,
        "elements": [
            {"idx": 1, "role": "AXButton", "label": "7", "axid": "Seven", "actions": ["Press"], "enabled": True},
            {"idx": 2, "role": "AXButton", "label": "清除", "axid": "Clear", "actions": ["Press"], "enabled": True},
            {"idx": 3, "role": "AXButton", "label": "全部清除", "axid": "AllClear", "actions": ["Press"], "enabled": False},
            {"idx": 4, "role": "AXTextField", "label": "搜索", "value": "abc", "actions": [], "enabled": True},
        ]}


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.stub = d / "stub"
        self.stub.write_text(STUB)
        self.stub.chmod(0o755)
        self.record = d / "calls.jsonl"
        self.env(STUB_RECORD=str(self.record), COMPUTER_CONTROL_CONTEXT_ID="test-task")
        patch = mock.patch.object(computer_control, "_program", mock.AsyncMock(return_value=self.stub))
        patch.start()
        self.addCleanup(patch.stop)
        target = mock.Mock()
        target.resolve_target.return_value = "local"
        transport = mock.patch.object(computer_control, "_transport", return_value=target)
        transport.start()
        self.target = target
        self.addCleanup(transport.stop)
        # 这组测试核对的是每条命令拼出来的参数，走单次进程那条路（也是常驻进程起不来时的兜底）
        serve = mock.patch.object(computer_control, "_USE_SERVE", False)
        serve.start()
        self.addCleanup(serve.stop)

    def env(self, **values):
        patch = mock.patch.dict(os.environ, values)
        patch.start()
        self.addCleanup(patch.stop)

    def reply(self, data, code=0, err=""):
        self.env(STUB_REPLY=json.dumps(data, ensure_ascii=False), STUB_CODE=str(code), STUB_ERR=err)

    def calls(self):
        return [json.loads(line) for line in self.record.read_text().splitlines()] if self.record.exists() else []

    def run_(self, coro):
        return asyncio.run(coro)




class WindowBinding(Case):
    REF = {"id": 42, "pid": 123, "startedAt": 123.5, "bundleId": "com.google.Chrome"}

    def test_complete_snapshot_binds_first_window_and_all_later_actions(self):
        target = computer_control.app("Chrome", host="local", scope="a")
        self.reply({**SNAP, "window": self.REF})
        self.run_(target.snap())
        self.reply({"ok": True})
        self.run_(target.click(id="Seven"))
        self.run_(target.key("Escape"))
        for call in self.calls()[1:]:
            self.assertEqual(json.loads(call[call.index("--window-ref") + 1]), self.REF)
        self.assertEqual(target.window, self.REF)
        self.assertIsNone(target.lease)
        self.assertTrue(self.run_(target.release())["released"])

    def test_incomplete_snapshot_does_not_bind_or_retarget(self):
        target = computer_control.app("Chrome", host="local")
        self.reply({**SNAP, "window": self.REF, "truncated": True})
        self.run_(target.snap())
        self.assertIsNone(target.window)
        bound = computer_control.app("Chrome", host="local", window=self.REF)
        self.reply({**SNAP, "window": {**self.REF, "id": 99}})
        self.run_(bound.snap())
        self.assertEqual(bound.window, self.REF)

    def test_different_tasks_keep_separate_window_arguments(self):
        self.reply({"ok": True})
        a = computer_control.app("Chrome", host="local", scope="a", window=self.REF)
        b = computer_control.app("Chrome", host="local", scope="b", window={**self.REF, "id": 99})
        async def go():
            await asyncio.gather(a.click(id="Save"), b.click(id="Save"))
        self.run_(go())
        pairs = {(c[c.index("--scope") + 1], json.loads(c[c.index("--window-ref") + 1])["id"]) for c in self.calls()}
        self.assertEqual(pairs, {("a", 42), ("b", 99)})
        self.assertIsNone(computer_control._window_ref.get())

    def test_bound_window_cannot_be_overridden_and_is_copied(self):
        ref = dict(self.REF)
        target = computer_control.app("Chrome", host="local", window=ref)
        ref["id"] = 999
        self.assertEqual(target.window["id"], 42)
        with self.assertRaises(ValueError):
            self.run_(target.click(id="Save", window={**self.REF, "id": 99}))
        self.assertEqual(self.calls(), [])

    def test_close_bound_window_never_requests_application_quit(self):
        self.reply({"ok": True, "closed": True})
        target = computer_control.app("Chrome", host="local", window=self.REF)
        self.run_(target.close(authorized=True))
        self.assertEqual(self.calls()[0][0], "window-close")
        self.assertIn("--window-ref", self.calls()[0])

    def test_windows_discovery_does_not_claim_and_bad_refs_fail_locally(self):
        self.reply({"ok": True, "windows": [self.REF]})
        self.assertEqual(self.run_(computer_control.windows("Chrome"))["windows"], [self.REF])
        self.assertEqual(self.calls()[0][0], "windows")
        for ref in ({"id": 42}, {**self.REF, "pid": True}, {**self.REF, "startedAt": float("nan")}):
            with self.assertRaises((TypeError, ValueError)):
                computer_control.app("Chrome", host="local", window=ref)


class Arguments(Case):
    def test_click_by_id_label_idx_and_point(self):
        self.run_(computer_control.click("计算器", id="Seven"))
        self.run_(computer_control.click("计算器", label="7", count=2))
        self.run_(computer_control.click("计算器", 5, button="right"))
        self.run_(computer_control.click("计算器", at=(10.6, 20)))
        self.assertEqual(self.calls(), [
            ["click", "计算器", "--id", "Seven", "--scope", "test-task", "--json"],
            ["click", "计算器", "--label", "7", "--count", "2", "--scope", "test-task", "--json"],
            ["click", "计算器", "5", "--button", "right", "--scope", "test-task", "--json"],
            ["click", "计算器", "--at", "10,20", "--scope", "test-task", "--json"],
        ])

    def test_click_needs_exactly_one_target(self):
        with self.assertRaises(TypeError):
            self.run_(computer_control.click("计算器"))
        with self.assertRaises(TypeError):
            self.run_(computer_control.click("计算器", 1, id="Seven"))
        self.assertEqual(self.calls(), [])

    def test_snap_defaults_to_no_screenshot(self):
        self.reply(SNAP)
        self.run_(computer_control.snap("计算器"))
        self.run_(computer_control.snap("计算器", shot=True, diff=True, all=True, window=2, max=50))
        first, second = self.calls()
        self.assertNotIn("--shot", first)
        self.assertIn("--shot", second)
        self.assertNotIn("--no-shot", first + second)
        self.assertTrue({"--diff", "--all"} <= set(second))
        self.assertEqual(second[second.index("--window") + 1], "2")
        self.assertEqual(second[second.index("--max") + 1], "50")
        self.assertNotIn("--no-webmode", first)

    def test_snap_can_skip_auto_webmode(self):
        self.reply(SNAP)
        self.run_(computer_control.snap("com.google.Chrome", webmode=False))
        self.assertIn("--no-webmode", self.calls()[0])

    def test_sensitive_app_refusal_carries_code_6(self):
        self.reply({"ok": False, "error": "『终端』属于敏感应用", "code": 6}, code=6)
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(computer_control.type_text("com.apple.Terminal", "ls"))
        self.assertEqual(caught.exception.code, computer_control.SENSITIVE)

    def test_text_with_spaces_stays_one_argument(self):
        self.run_(computer_control.type_text("备忘录", "hello  world"))
        self.run_(computer_control.paste("备忘录", "第一行\n第二行", settle=800))
        self.assertEqual(self.calls()[0], ["type", "备忘录", "--scope", "test-task", "--json", "--", "hello  world"])
        self.assertEqual(self.calls()[1], ["paste", "备忘录", "--settle", "800", "--scope", "test-task", "--json", "--", "第一行\n第二行"])

    def test_text_that_is_an_option_name_is_literal(self):
        self.run_(computer_control.type_text("备忘录", "--json"))
        self.assertEqual(self.calls(), [["type", "备忘录", "--scope", "test-task", "--json", "--", "--json"]])

    def test_permissions_request_is_explicit(self):
        self.run_(computer_control.perms())
        self.run_(computer_control.perms(request=True))
        self.assertEqual(self.calls(), [["perms", "--json"], ["perms", "--request", "--json"]])
        with self.assertRaises(TypeError):
            self.run_(computer_control.perms(request="yes"))

    def test_wake_defaults_and_options(self):
        self.reply({"ok": True, "mode": "wake", "state": "desktop", "reachedDesktop": True})
        self.run_(computer_control.wake())
        self.run_(computer_control.wake(hold=5, input="space"))
        self.assertEqual(self.calls(), [
            ["wake", "--hold", "3", "--json"],
            ["wake", "--hold", "5", "--input", "space", "--json"],
        ])
        for bad in (0.1, 31):
            with self.assertRaises(ValueError):
                self.run_(computer_control.wake(hold=bad))
        with self.assertRaises(ValueError):
            self.run_(computer_control.wake(input="password"))

    def test_menu_levels(self):
        self.reply({"ok": True, "mode": "menu", "level": "bar", "menus": ["文件", "编辑"]})
        self.assertEqual(self.run_(computer_control.menu("计算器")), ["文件", "编辑"])
        self.reply({"ok": True, "mode": "menu", "level": "items", "items": [{"label": "基础"}]})
        self.assertEqual(self.run_(computer_control.menu("计算器", "显示")), [{"label": "基础"}])
        with self.assertRaises(TypeError):
            self.run_(computer_control.menu("计算器", item="基础"))

    def test_bound_app_passes_its_name(self):
        calc = computer_control.app("计算器")
        self.run_(calc.key("cmd+c"))
        calc.snapshot = "fixture-token"
        self.run_(calc.scroll(3, "up", pages=2))
        self.assertEqual(self.calls(), [["key", "计算器", "--scope", "test-task", "--json", "--", "cmd+c"],
                                        ["scroll", "计算器", "3", "up", "--pages", "2", "--snapshot", "fixture-token", "--scope", "test-task", "--json"]])
        with self.assertRaises(ValueError):
            self.run_(calc.scroll(3, "sideways"))

    def test_key_default_and_system_mode(self):
        self.run_(computer_control.key("Raycast", "ctrl+space"))
        self.run_(computer_control.key("Raycast", "ctrl+space", system=True))
        self.assertEqual(self.calls(), [
            ["key", "Raycast", "--scope", "test-task", "--json", "--", "ctrl+space"],
            ["key", "Raycast", "--system", "--scope", "test-task", "--json", "--", "ctrl+space"],
        ])
        with self.assertRaises(TypeError):
            self.run_(computer_control.key("Raycast", "space", system="yes"))

    def test_open_app_lease_and_app_binding(self):
        self.reply({"ok": True, "mode": "open"})
        self.run_(computer_control.open_app("Raycast"))
        self.run_(computer_control.open_app("Raycast", lease="lease-1"))
        self.assertEqual(self.calls(), [
            ["open", "Raycast", "--scope", "test-task", "--json"],
            ["open", "Raycast", "--scope", "test-task", "--lease", "lease-1", "--json"],
        ])
        with self.assertRaises(ValueError):
            self.run_(computer_control.open_app("Raycast", lease=""))
        raycast = computer_control.app("Raycast", scope="task-a")
        raycast.lease = "lease-2"
        self.run_(raycast.open_app())
        args = self.calls()[-1]
        self.assertEqual(args[:2], ["open", "Raycast"])
        self.assertEqual(args[args.index("--scope") + 1], "task-a")
        self.assertEqual(args[args.index("--lease") + 1], "lease-2")


class SnapshotBinding(Case):
    def test_app_tracks_token_and_rejects_missing_snapshot(self):
        calc = computer_control.app("计算器")
        with self.assertRaises(computer_control.ComputerControlError):
            self.run_(calc.click(1))
        self.reply(SNAP)
        self.run_(calc.snap())
        self.run_(calc.click(1))
        self.assertEqual(calc.snapshot, SNAP["snapshot"])
        self.assertIn("--snapshot", self.calls()[-1])
        self.assertEqual(self.calls()[-1][self.calls()[-1].index("--snapshot"):][:2], ["--snapshot", SNAP["snapshot"]])

    def test_partial_snap_or_diff_clears_bound_snapshot(self):
        for metadata in ({"mode": "snap", "truncated": True}, {"mode": "diff", "timedOut": True}):
            calc = computer_control.app("计算器")
            calc.snapshot = "previous"
            self.reply({**SNAP, **metadata})
            self.run_(calc.snap())
            self.assertIsNone(calc.snapshot)
            with self.assertRaises(computer_control.ComputerControlError):
                self.run_(calc.click(1))

    def test_error_preserves_remote_context(self):
        self.target.resolve_target.return_value = "laptop"
        failure = {"ok": False, "error": "unknown", "code": 1, "hostContext": {"host": "laptop"}, "remotePath": "/remote/a.png", "outcome": "unknown"}
        self.reply(failure, code=1)
        with mock.patch.object(computer_control, "_LAUNCHER", self.stub), self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(computer_control.cli("snap", "Finder", host="laptop"))
        self.assertEqual(caught.exception.data, failure)
        self.assertEqual(caught.exception.host, "laptop")
        self.assertEqual(caught.exception.outcome, "unknown")


class TaskOwnership(Case):
    def test_release_uses_identity_from_snapshot_after_alias_resolution(self):
        target = computer_control.app("Chrome", scope="task-a")
        self.reply({**SNAP, "app": {"bundleId": "com.google.chrome.for.testing"},
                    "ownership": {"owner": "task-a", "lease": "lease-a"}})
        self.run_(target.snap())
        self.reply({"ok": True, "ownership": {"owner": None, "lease": "released"}})
        self.run_(target.release())
        self.assertIn("com.google.chrome.for.testing", self.calls()[-1])
        self.assertNotIn("Chrome", self.calls()[-1])

    def test_close_keeps_actual_identity_for_release_without_prior_snapshot(self):
        target = computer_control.app("Chrome", scope="task-a")
        self.reply({"ok": True, "terminated": True, "appKey": "com.google.chrome.for.testing",
                    "ownership": {"owner": "task-a", "lease": "lease-a"}})
        self.run_(target.close(authorized=True))
        self.reply({"ok": True, "ownership": {"owner": None, "lease": "released"}})
        self.run_(target.release())
        self.assertIn("com.google.chrome.for.testing", self.calls()[-1])

    def test_app_pins_scope_and_lease_across_environment_changes(self):
        target = computer_control.app("Calc", scope="task-a")
        self.reply({**SNAP, "ownership": {"owner": "task-a", "lease": "lease-a"}})
        self.run_(target.snap())
        self.assertEqual(target.lease, "lease-a")
        self.env(COMPUTER_CONTROL_CONTEXT_ID="task-b")
        self.reply({"ok": True})
        self.run_(target.key("Escape"))
        args = self.calls()[-1]
        self.assertEqual(args[args.index("--scope")+1], "task-a")
        self.assertEqual(args[args.index("--lease")+1], "lease-a")
        self.assertLess(args.index("--lease"), args.index("--"))
        with self.assertRaises(ValueError):
            self.run_(target.key("Escape", scope="task-b"))

    def test_handoff_does_not_allow_old_app_to_auto_reclaim(self):
        target = computer_control.app("Calc", scope="task-a")
        target.lease = "old"
        self.reply({"ok": True, "ownership": {"owner": "task-b", "lease": "new"}})
        result = self.run_(target.handoff("task-b"))
        self.assertEqual(result["ownership"]["owner"], "task-b")
        before = len(self.calls())
        with self.assertRaises(computer_control.ComputerControlError):
            self.run_(target.snap())
        self.assertEqual(len(self.calls()), before)
        self.reply({"ok": True, "ownership": {"owner": "task-a", "lease": "fresh"}})
        self.run_(target.claim())
        self.assertFalse(target._released)
        self.assertEqual(target.lease, "fresh")

    def test_projected_shot_response_still_keeps_app_lease(self):
        target = computer_control.app("Calc", scope="task-a")
        self.reply({"ok": True, "path": "/fixture.png", "ownership": {"owner": "task-a", "lease": "lease-a"}})
        self.assertEqual(self.run_(target.shot()), "/fixture.png")
        self.assertEqual(target.lease, "lease-a")
        self.assertIsNone(computer_control._observed_ownership.get())
        self.reply({"ok": True, "ownership": {"owner": None, "lease": "released"}})
        self.run_(target.release())
        self.assertTrue(target._released)

    def test_wrapper_lease_context_survives_new_app_binding(self):
        target = computer_control.app("Calc", scope="task-a")
        token = computer_control._task_lease.set("old-wrapper-lease")
        try:
            self.run_(target.key("Escape"))
        finally:
            computer_control._task_lease.reset(token)
        args = self.calls()[-1]
        self.assertEqual(args[args.index("--lease")+1], "old-wrapper-lease")

    def test_unheld_app_cannot_release_or_handoff(self):
        target = computer_control.app("Calc", scope="task-a")
        with self.assertRaises(computer_control.ComputerControlError): self.run_(target.release())
        with self.assertRaises(computer_control.ComputerControlError): self.run_(target.handoff("task-b"))
        self.assertEqual(self.calls(), [])

    def test_low_level_scope_parameters_cannot_duplicate_authority(self):
        with self.assertRaises(ValueError):
            self.run_(computer_control.cli("click", "Calc", "--scope", "other"))
        self.assertEqual(self.calls(), [])
        self.run_(computer_control.type_text("Calc", "--scope", scope="task-a"))
        args = self.calls()[-1]
        self.assertEqual(args[-1], "--scope")
        self.assertEqual(args[args.index("--scope") + 1], "task-a")

    def test_concurrent_task_contexts_do_not_leak(self):
        async def go():
            await asyncio.gather(computer_control.key("Calc", "a", scope="task-a"),
                                 computer_control.key("Calc", "b", scope="task-b"))
        self.run_(go())
        self.assertEqual({args[args.index("--scope")+1] for args in self.calls()}, {"task-a", "task-b"})
        self.assertIsNone(computer_control._task_scope.get())
        self.assertIsNone(computer_control._task_lease.get())


class Results(Case):
    def test_success_drops_ok_and_keeps_warnings(self):
        self.reply({"ok": True, "mode": "shot", "path": "/tmp/a.png"}, err="computer-control: 已回退为按坐标截图\n")
        data = self.run_(computer_control.cli("shot", "访达"))
        self.assertEqual(data, {"mode": "shot", "path": "/tmp/a.png", "warnings": ["已回退为按坐标截图"]})

    def test_failure_raises_with_code(self):
        self.reply({"ok": False, "error": "找不到元素", "code": 3}, code=3)
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(computer_control.click("计算器", id="Nope"))
        self.assertEqual((caught.exception.code, str(caught.exception), caught.exception.command), (3, "找不到元素", "click"))

    def test_non_json_output_is_an_error_not_a_crash(self):
        self.env(STUB_REPLY="not json", STUB_CODE="1", STUB_ERR="boom\n")
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(computer_control.version())
        self.assertIn("boom", str(caught.exception))

    def test_timeout_kills_and_raises(self):
        self.stub.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n")
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(computer_control.cli("snap", "x", timeout=0.3))
        self.assertIsNone(caught.exception.code)

    def test_read_returns_text(self):
        self.reply({"ok": True, "mode": "read", "text": "全文"})
        self.assertEqual(self.run_(computer_control.read("备忘录", 7)), "全文")



SERVE_STUB = r"""#!/usr/bin/env python3
import json, os, sys
assert sys.argv[1:] == ["serve"], sys.argv
record = os.environ["STUB_RECORD"]
with open(record, "a") as f:
    f.write(json.dumps(["<start>"]) + "\n")
for line in sys.stdin:
    req = json.loads(line)
    with open(record, "a") as f:
        f.write(json.dumps(req["args"]) + "\n")
    if req["args"][0] == "hang":
        continue
    if req["args"][0] == "die":
        sys.exit(1)
    ok = req["args"][0] != "fail"
    result = {"ok": ok, "mode": req["args"][0]} if ok else {"ok": False, "error": "boom", "code": 3}
    print(json.dumps({"id": req["id"], "code": 0 if ok else 3, "result": result,
                      **({"warnings": ["heads up"]} if req["args"][0] == "warn" else {})}), flush=True)
"""


class Serve(Case):
    def setUp(self):
        super().setUp()
        self.stub.write_text(SERVE_STUB)
        on = mock.patch.object(computer_control, "_USE_SERVE", True)
        on.start()
        self.addCleanup(on.stop)
        server = mock.patch.object(computer_control, "_server", computer_control._Server())
        server.start()
        self.addCleanup(server.stop)

    def test_one_process_serves_many_commands(self):
        async def go():
            a = await computer_control.cli("snap", "计算器")
            b = await computer_control.cli("warn")
            await computer_control.disconnect()
            return a, b
        a, b = self.run_(go())
        self.assertEqual(a, {"mode": "snap"})
        self.assertEqual(b["warnings"], ["heads up"])
        self.assertEqual(self.calls(), [["<start>"], ["snap", "计算器", "--scope", "test-task"], ["warn"]])

    def test_errors_keep_their_code(self):
        async def go():
            try:
                await computer_control.cli("fail")
            finally:
                await computer_control.disconnect()
        with self.assertRaises(computer_control.ComputerControlError) as caught:
            self.run_(go())
        self.assertEqual((caught.exception.code, str(caught.exception)), (3, "boom"))

    def test_timeout_kills_the_server_and_the_next_call_restarts_it(self):
        async def go():
            with self.assertRaises(computer_control.ComputerControlError):
                await computer_control.cli("hang", timeout=0.3)
            out = await computer_control.cli("snap")
            await computer_control.disconnect()
            return out
        self.assertEqual(self.run_(go()), {"mode": "snap"})
        self.assertEqual(self.calls().count(["<start>"]), 2)

    def test_crashed_server_never_replays_a_command(self):
        async def go():
            try:
                return await computer_control.cli("die")
            finally:
                await computer_control.disconnect()
        # 已发出请求后断连，执行结果未知，不能自动重放。
        with self.assertRaises(computer_control.ComputerControlError):
            self.run_(go())
        self.assertEqual(self.calls(), [["<start>"], ["die"]])

    def test_idle_server_is_restarted_before_it_can_exit_under_a_request(self):
        async def go():
            await computer_control.cli("snap")
            computer_control._server.last_used -= computer_control._SERVE_IDLE
            out = await computer_control.cli("snap")
            await computer_control.disconnect()
            return out
        self.assertEqual(self.run_(go()), {"mode": "snap"})
        self.assertEqual(self.calls(), [["<start>"], ["snap", "--scope", "test-task"], ["<start>"], ["snap", "--scope", "test-task"]])

    def test_recent_use_keeps_the_same_server(self):
        async def go():
            await computer_control.cli("snap")
            await computer_control.cli("snap")
            await computer_control.disconnect()
        self.run_(go())
        self.assertEqual(self.calls().count(["<start>"]), 1)


class DiffCompleteness(unittest.TestCase):
    def test_partial_diff_never_claims_whole_screen_unchanged(self):
        for flag in ("truncated", "timedOut"):
            diff = computer_control.Diff({"changed": False, flag: True})
            self.assertIn("不完整", repr(diff))
            self.assertTrue(diff.truncated or diff.timed_out)
            self.assertFalse(diff.changed)


class SnapObject(unittest.TestCase):
    def setUp(self):
        self.snap = computer_control.Snap(dict(SNAP))

    def test_find_by_role_id_contains_action(self):
        self.assertEqual([e["idx"] for e in self.snap.find(role="button")], [1, 2, 3])
        self.assertEqual([e["idx"] for e in self.snap.find(role="AXButton", contains="清除")], [2, 3])
        self.assertEqual([e["idx"] for e in self.snap.find(id="Seven")], [1])
        self.assertEqual([e["idx"] for e in self.snap.find(contains="abc")], [4])
        self.assertEqual([e["idx"] for e in self.snap.find(action="AXPress")], [1, 2, 3])

    def test_one_refuses_zero_or_many(self):
        self.assertEqual(self.snap.one(id="Clear")["idx"], 2)
        with self.assertRaises(LookupError):
            self.snap.one(role="button")
        with self.assertRaises(LookupError):
            self.snap.one(id="Missing")

    def test_one_refuses_to_infer_unique_from_partial_observation(self):
        for flag in ("truncated", "timedOut"):
            s = computer_control.Snap({**SNAP, flag: True})
            with self.assertRaisesRegex(LookupError, "不完整"):
                s.one(id="Seven")

    def test_repr_and_table_are_short(self):
        self.assertIn("4 个元素", repr(self.snap))
        table = self.snap.table(limit=2)
        self.assertIn("#Seven", table)
        self.assertIn("还有 2 个", table)
        self.assertIn("(禁用)", self.snap.table(limit=None))

    def test_tree_nests_by_parent_and_folds_empty_groups(self):
        snap = computer_control.Snap({"elements": [
            {"idx": 1, "role": "AXToolbar", "label": "", "actions": [], "depth": 1},
            {"idx": 2, "role": "AXButton", "label": "返回", "actions": ["Press"], "depth": 2, "parent": 1},
            {"idx": 3, "role": "AXGroup", "label": "", "actions": ["ShowMenu"], "depth": 1},
            {"idx": 4, "role": "AXWebArea", "label": "页面", "actions": [], "depth": 3, "parent": 3},
            {"idx": 5, "role": "AXButton", "label": "搜索", "actions": ["Press"], "depth": 7, "parent": 4},
        ], "window": {}})
        self.assertEqual(snap.tree().splitlines(), [
            "  1 Toolbar ·", "    2 Button 返回", "  4 WebArea 页面", "    5 Button 搜索"])
        self.assertIn("  3 Group ·", snap.tree(keep_empty=True))
        self.assertEqual([e["idx"] for e in snap.children(4)], [5])

    def test_diff(self):
        self.assertFalse(computer_control.Diff({"mode": "diff", "changed": False}))
        self.assertEqual(repr(computer_control.Diff({"mode": "diff", "changed": True, "added": [{}], "removed": []})), "<diff 新增 1 / 消失 0>")


class Build(unittest.TestCase):
    def test_quick_path_skips_the_compiler(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_CACHE_HOME": tmp}):
            cache = build.cache_dir()
            cache.mkdir(parents=True)
            quick = cache / build._quick_key(build.SOURCE.read_bytes())
            quick.write_text("#!/bin/sh\n")
            quick.chmod(0o755)
            with mock.patch.object(build.subprocess, "run", side_effect=AssertionError("不该调编译器")):
                self.assertEqual(build.ensure_binary(), quick.resolve())

    def test_source_change_changes_the_quick_key(self):
        self.assertNotEqual(build._quick_key(b"a"), build._quick_key(b"b"))


if __name__ == "__main__":
    unittest.main()
