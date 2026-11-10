#!/usr/bin/env python3
"""watchdog.py 的回归测试：断线只通知一次、恢复、重复失败、卡死判定。

只替换 dsh-control 调用，不连网、不发真实通知；真实只读检查在
`python3 -I watchdog.py --once ...` 里单独跑。

运行：`python3 test_watchdog.py`，或仓库根目录 `mise run test:skills`。
"""
import contextlib
import importlib.util
import io
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("watchdog", os.path.join(HERE, "watchdog.py"))
w = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(w)


class FakeCtl:
    """按命令返回预设结果，并记下所有 notice 正文。"""

    def __init__(self):
        self.quit = (0, {"ok": True, "data": {"jobs": []}}, True)
        self.health = (0, {"ok": True}, True)
        self.statuses = {}
        self.goals = {}
        self.notices = []
        self.calls = []

    def __call__(self, *args, host=None):
        self.calls.append((args, host))
        cmd = args[0]
        if cmd == "notice":
            self.notices.append({"text": args[2], "summary": args[4] if len(args) > 4 else ""})
            return 0, {"ok": True}, True
        if cmd == "quit-check":
            return self.quit
        if cmd == "health":
            return self.health
        if cmd == "status":
            return self.statuses[args[1]]
        if cmd == "goal":
            return self.goals.get(args[1], (1, {"ok": False, "error": {"code": "not-found", "message": "没有目标"}}, True))
        raise AssertionError(f"unexpected dsh-control {args}")


def ok(data):
    return 0, {"ok": True, "data": data}, True


def failed(code, message="boom", exit_code=1):
    return exit_code, {"ok": False, "error": {"code": code, "message": message}}, True


def status(running=True, seq=1, title="长工", queued=0):
    return {"sessionId": "s", "title": title, "running": running, "queued": queued,
            "lastSeq": seq, "turns": 1, "questions": []}


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCtl()
        self._old_ctl = w.ctl
        w.ctl = self.fake

    def tearDown(self):
        w.ctl = self._old_ctl

    def round(self, workers, state, now, host=None, stall=1800, outage=900):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = w.check("lead", workers, state, stall, outage, now, host)
        events = [json.loads(x) for x in out.getvalue().splitlines() if x.strip()]
        logs = [json.loads(x) for x in err.getvalue().splitlines() if x.strip()]
        return result, events, logs

    def kinds(self, events):
        return [e["kind"] for e in events]

    # ---- 断线：一次中断只通知一次，到期提醒一次，恢复补查 ----

    def test_host_outage_notifies_once_then_deadline_then_recovery(self):
        self.fake.quit = failed("255", exit_code=255)
        self.fake.health = failed("255", exit_code=255)
        state, workers = {}, ["w1", "w2"]

        result, events, logs = self.round(workers, state, 0, host="alpha")
        self.assertEqual(result, "host-down")
        self.assertEqual(self.kinds(events), ["host-down"])
        self.assertEqual(len(self.fake.notices), 1)
        self.assertIn("w1、w2", self.fake.notices[0]["text"])
        self.assertIn("不等于失败或丢失", self.fake.notices[0]["text"])

        # 同一原因继续失败：只记 stderr，不再通知
        result, events, logs = self.round(workers, state, 120, host="alpha")
        self.assertEqual(result, "host-down")
        self.assertEqual(events, [])
        self.assertEqual(len(self.fake.notices), 1)
        self.assertEqual(self.kinds(logs), ["host-down-repeat"])

        # 到期仍未恢复：明确提醒一次
        result, events, logs = self.round(workers, state, 900, host="alpha")
        self.assertEqual(self.kinds(events), ["host-down-still"])
        self.assertEqual(len(self.fake.notices), 2)
        self.assertIn("15 分钟", self.fake.notices[1]["text"])

        # 恢复：通知一次，并请主控补查中断期间的结果
        self.fake.health = (0, {"ok": True}, True)
        self.fake.quit = (0, {"ok": True, "data": {"jobs": []}}, True)
        self.fake.statuses = {"w1": ok(status(running=False)), "w2": ok(status(running=False))}
        result, events, logs = self.round(workers, state, 960, host="alpha")
        self.assertEqual(self.kinds(events), ["host-recovered"])
        self.assertEqual(len(self.fake.notices), 3)
        self.assertIn("补查", self.fake.notices[2]["text"])
        self.assertIn("16 分钟", self.fake.notices[2]["text"])

    def test_host_reason_change_notifies_again(self):
        self.fake.quit = failed("255", exit_code=255)
        self.fake.health = failed("255", exit_code=255)
        state, workers = {}, ["w1"]
        self.round(workers, state, 0, host="alpha")
        self.assertEqual(len(self.fake.notices), 1)

        # SSH 通了但对面 DSH 没在运行：原因类别变了，要再说一次
        self.fake.health = failed("69", exit_code=69)
        result, events, logs = self.round(workers, state, 120, host="alpha")
        self.assertEqual(self.kinds(events), ["host-down"])
        self.assertEqual(len(self.fake.notices), 2)
        self.assertIn("DSH 没在运行", self.fake.notices[1]["text"])

        # 同一类别重复：不再通知
        self.round(workers, state, 240, host="alpha")
        self.assertEqual(len(self.fake.notices), 2)

    def test_outage_does_not_trigger_false_stall(self):
        self.fake.statuses = {"w1": ok(status(running=True, seq=5))}
        self.fake.goals = {"w1": ok({"phase": "active", "activation": "armed",
                                     "roundsStarted": 1, "maxGoalRounds": 10})}
        state, workers = {}, ["w1"]

        # 长工本来就在忙，计时从 0 开始
        result, events, logs = self.round(workers, state, 0, host="alpha")
        self.assertEqual(result, "ok")
        self.assertEqual(events, [])

        # 断线一小时：期间不判断卡死
        self.fake.quit = failed("255", exit_code=255)
        self.fake.health = failed("255", exit_code=255)
        self.round(workers, state, 120, host="alpha")
        self.assertEqual(len(self.fake.notices), 1)  # 断线开始只通知一次
        self.assertNotIn("stall", self.kinds(events))
        self.round(workers, state, 3600, host="alpha")
        self.assertEqual(len(self.fake.notices), 2)  # 到期未恢复提醒一次
        self.assertNotIn("stall", self.kinds(events))

        # 恢复后先补回中断时长，不能立刻报卡死
        self.fake.health = (0, {"ok": True}, True)
        self.fake.quit = (0, {"ok": True, "data": {"jobs": []}}, True)
        result, events, logs = self.round(workers, state, 3720, host="alpha")
        self.assertEqual(result, "ok")
        self.assertEqual(self.kinds(events), ["host-recovered"])
        self.assertNotIn("stall", self.kinds(events))

        # 再过半小时仍无新记录，才是真卡死；只叫一次
        result, events, logs = self.round(workers, state, 5520, host="alpha")
        self.assertEqual(self.kinds(events), ["stall"])
        self.assertEqual(len(self.fake.notices), 4)
        result, events, logs = self.round(workers, state, 5640, host="alpha")
        self.assertEqual(events, [])

        # 新记录后重新计时，再卡死再叫一次
        self.fake.statuses = {"w1": ok(status(running=True, seq=6))}
        self.round(workers, state, 5760, host="alpha")
        result, events, logs = self.round(workers, state, 7560, host="alpha")
        self.assertEqual(self.kinds(events), ["stall"])
        self.assertEqual(len(self.fake.notices), 5)

    # ---- 单个会话的检查失败：同一类只通知一次，恢复提示一次 ----

    def test_worker_check_failure_notifies_once_and_recovers(self):
        self.fake.statuses = {"w1": failed("internal", exit_code=1)}
        state, workers = {}, ["w1"]
        result, events, logs = self.round(workers, state, 0, host="alpha")
        self.assertEqual(result, "ok")
        self.assertEqual(self.kinds(events), ["worker-fault"])
        self.assertEqual(len(self.fake.notices), 1)
        self.assertIn("不一定", self.fake.notices[0]["text"])

        result, events, logs = self.round(workers, state, 120, host="alpha")
        self.assertEqual(events, [])
        self.assertEqual(self.kinds(logs), ["worker-fault-repeat"])
        self.assertEqual(len(self.fake.notices), 1)

        # 到期仍未恢复：提醒一次
        result, events, logs = self.round(workers, state, 900, host="alpha")
        self.assertEqual(self.kinds(events), ["worker-fault-still"])
        self.assertEqual(len(self.fake.notices), 2)

        # 恢复：补查提示
        self.fake.statuses = {"w1": ok(status(running=False))}
        result, events, logs = self.round(workers, state, 1020, host="alpha")
        self.assertEqual(self.kinds(events), ["worker-recovered"])
        self.assertEqual(len(self.fake.notices), 3)
        self.assertIn("补查", self.fake.notices[2]["text"])

    def test_missing_worker_notifies_once_and_stops_watching(self):
        self.fake.statuses = {"w1": failed("not-found", "找不到会话", exit_code=1)}
        state, workers = {}, ["w1"]
        result, events, logs = self.round(workers, state, 0, host="alpha")
        self.assertEqual(self.kinds(events), ["worker-fault"])
        self.assertEqual(len(self.fake.notices), 1)
        self.assertEqual(workers, [])

        before = len([c for c in self.fake.calls if c[0][0] != "notice"])
        result, events, logs = self.round(workers, state, 120, host="alpha")
        self.assertEqual(result, "ok")
        self.assertEqual(len(self.fake.notices), 1)
        after = len([c for c in self.fake.calls if c[0][0] != "notice"])
        self.assertEqual(after, before + 1, "会话查不到后只该剩每轮 quit-check，不再查它")

    # ---- 检查器自身出错 ----

    def checker(self, state, exc, now):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            w.checker_fault(state, exc, now, "lead", 900)

    def test_checker_error_notifies_once_then_recovers(self):
        state = {}
        self.checker(state, RuntimeError("dsh-control 输出坏了"), 0)
        self.assertEqual(len(self.fake.notices), 1)
        self.assertIn("兜底检查自己出错", self.fake.notices[0]["text"])

        self.checker(state, RuntimeError("dsh-control 输出坏了"), 120)
        self.assertEqual(len(self.fake.notices), 1)

        self.checker(state, RuntimeError("另一种错"), 240)
        self.assertEqual(len(self.fake.notices), 2, "错误类别变了要再说一次")

        self.checker(state, RuntimeError("另一种错"), 1200)
        self.assertEqual(len(self.fake.notices), 3, "到期未恢复要提醒")
        self.assertIn("16 分钟", self.fake.notices[2]["text"])

        self.checker(state, RuntimeError("另一种错"), 1320)
        self.assertEqual(len(self.fake.notices), 3)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            w.checker_recovered(state, 1440, "lead")
        self.assertEqual(len(self.fake.notices), 4)
        self.assertIn("恢复正常", self.fake.notices[3]["text"])

    def test_bad_arguments_or_transport_layer_is_checker_error(self):
        self.fake.statuses = {"w1": failed("2", "unknown host 'x'", exit_code=2)}
        state, workers = {}, ["w1"]
        with self.assertRaises(w.CheckError):
            self.round(workers, state, 0, host="x")
        self.assertEqual(self.fake.notices, [])

        self.fake.statuses = {"w1": failed("transport-failed", "远端控制层坏了", exit_code=1)}
        with self.assertRaises(w.CheckError):
            self.round(workers, state, 120, host="alpha")
        self.assertEqual(self.fake.notices, [])

    def test_broken_status_output_is_checker_error_not_task_failure(self):
        self.fake.statuses = {"w1": (0, {}, False)}
        state, workers = {}, ["w1"]
        with self.assertRaises(w.CheckError):
            self.round(workers, state, 0, host="alpha")
        self.assertEqual(self.fake.notices, [])

    # ---- 目标暂停/完成与真实无进展 ----

    def test_paused_or_complete_goal_is_not_a_stall(self):
        self.fake.statuses = {"w1": ok(status(running=False))}
        self.fake.goals = {"w1": ok({"phase": "paused", "roundsStarted": 3, "maxGoalRounds": 10})}
        state, workers = {}, ["w1"]
        self.round(workers, state, 0, host="alpha")
        result, events, logs = self.round(workers, state, 10_000, host="alpha")
        self.assertEqual(events, [])
        self.assertEqual(self.fake.notices, [])

        self.fake.goals = {"w1": ok({"phase": "complete", "roundsStarted": 4, "maxGoalRounds": 10})}
        result, events, logs = self.round(workers, state, 20_000, host="alpha")
        self.assertEqual(events, [])
        self.assertEqual(self.fake.notices, [])

    def test_active_but_disarmed_goal_is_not_a_stall(self):
        real_goal = {"phase": "active", "activation": "disarmed",
                     "roundsStarted": 0, "maxGoalRounds": 4}
        self.assertEqual(w.busy_reasons({"running": False, "queued": 0}, real_goal, []), [])
        # 旧宿主没有 activation 字段时不猜成 armed
        self.assertEqual(w.busy_reasons({"running": False, "queued": 0},
                                        {"phase": "active", "roundsStarted": 0, "maxGoalRounds": 4}, []), [])

        self.fake.statuses = {"w1": ok(status(running=False))}
        self.fake.goals = {"w1": ok(real_goal)}
        state, workers = {}, ["w1"]
        self.round(workers, state, 0, host="alpha")
        result, events, logs = self.round(workers, state, 1801, host="alpha")  # 跨过 30 分钟
        self.assertEqual(result, "ok")
        self.assertEqual(events, [])
        self.assertEqual(self.fake.notices, [])

    def test_active_and_armed_goal_stall_still_alerts(self):
        self.fake.statuses = {"w1": ok(status(running=False))}
        self.fake.goals = {"w1": ok({"phase": "active", "activation": "armed",
                                     "roundsStarted": 3, "maxGoalRounds": 10})}
        state, workers = {}, ["w1"]
        self.round(workers, state, 0, host="alpha")
        result, events, logs = self.round(workers, state, 1801, host="alpha")  # 跨过 30 分钟
        self.assertEqual(self.kinds(events), ["stall"])
        self.assertEqual(len(self.fake.notices), 1)
        self.assertIn("目标开着", self.fake.notices[0]["text"])

    def test_disarmed_goal_does_not_hide_running_queue_or_jobs(self):
        goal = {"phase": "active", "activation": "disarmed",
                "roundsStarted": 0, "maxGoalRounds": 4}
        self.assertEqual(w.busy_reasons({"running": True, "queued": 0}, goal, []), ["在跑"])
        self.assertEqual(w.busy_reasons({"running": False, "queued": 2}, goal, []), ["排队 2 条"])
        self.assertEqual(w.busy_reasons({"running": False, "queued": 0}, goal,
                                        [{"id": "j1", "label": "构建"}]), ["后台任务 构建"])

        self.fake.statuses = {
            "w_run": ok(status(running=True)),
            "w_queue": ok(status(running=False, queued=2)),
            "w_job": ok(status(running=False)),
        }
        self.fake.goals = {sid: ok(goal) for sid in ("w_run", "w_queue", "w_job")}
        self.fake.quit = (0, {"ok": True, "data": {"jobs": [{"owner": "w_job", "label": "构建"}]}}, True)
        state, workers = {}, ["w_run", "w_queue", "w_job"]
        self.round(workers, state, 0, host="alpha")
        result, events, logs = self.round(workers, state, 1801, host="alpha")  # 跨过 30 分钟
        self.assertEqual(self.kinds(events), ["stall", "stall", "stall"])
        self.assertEqual(len(self.fake.notices), 3)
        self.assertIn("在跑", self.fake.notices[0]["text"])
        self.assertIn("排队 2 条", self.fake.notices[1]["text"])
        self.assertIn("后台任务 构建", self.fake.notices[2]["text"])

    def test_background_job_stall_uses_status_fields(self):
        self.fake.statuses = {"w1": ok(status(running=False))}
        self.fake.quit = (0, {"ok": True, "data": {"jobs": [{"owner": "w1", "label": "构建"}]}}, True)
        state, workers = {}, ["w1"]
        self.round(workers, state, 0, host="alpha")
        result, events, logs = self.round(workers, state, 1800, host="alpha")
        self.assertEqual(self.kinds(events), ["stall"])
        self.assertIn("后台任务", self.fake.notices[0]["text"])

    def test_local_dsh_down_never_notifies(self):
        self.fake.quit = failed("69", exit_code=69)
        self.fake.health = failed("69", exit_code=69)
        state, workers = {}, ["w1"]
        result, events, logs = self.round(workers, state, 0)
        self.assertEqual(result, "host-down")
        self.assertEqual(self.kinds(events), ["host-down"])
        result, events, logs = self.round(workers, state, 900)
        self.assertEqual(self.kinds(events), ["host-down-still"])
        self.assertEqual(self.fake.notices, [], "本机 DSH 没起来时 notice 也发不出去，不假装发了")

        self.fake.health = (0, {"ok": True}, True)
        self.fake.quit = (0, {"ok": True, "data": {"jobs": []}}, True)
        self.fake.statuses = {"w1": ok(status(running=False))}
        result, events, logs = self.round(workers, state, 960)
        self.assertEqual(self.kinds(events), ["host-recovered"])
        self.assertEqual(self.fake.notices, [])


if __name__ == "__main__":
    unittest.main()