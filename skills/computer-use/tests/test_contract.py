import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
import computer_use

def el(idx,label,role="AXButton",**kw):
    return dict(idx=idx,label=label,role=role,w=40,h=20,enabled=True,actions=["Press"],**kw)
def snap(*els):
    return computer_use.Snap(dict(snapshot="tok",app={"pid":123},window={"id":4},elements=list(els)))

class Contract(unittest.IsolatedAsyncioTestCase):
    async def test_lifecycle_version(self):
        with patch.object(computer_use._server,"stop",AsyncMock()) as stop:
            self.assertFalse((await computer_use.disconnect())["targets_closed"]); stop.assert_awaited_once()
        self.assertEqual((await computer_use.release())["released"],[])
        with patch.object(computer_use,"cli",AsyncMock(return_value={"version":"x"})):
            self.assertEqual((await computer_use.version(host="local"))["version"],"x")
        target=computer_use.app("Calc",host="local",scope="task-close")
        with self.assertRaises(computer_use.ComputerUseError) as error: await target.close()
        self.assertEqual(error.exception.code,6)
        with patch.object(computer_use,"cli",AsyncMock(return_value={"terminated":True})) as call:
            self.assertTrue((await target.close(authorized=True))["terminated"])
            call.assert_awaited_once_with("quit","Calc","--authorized","--timeout",10.0,
                                          host="local",scope="task-close",lease=None)
        self.assertFalse(hasattr(computer_use,"close"))

    def test_probe_reports_implemented_capabilities_without_deleted_stubs(self):
        capabilities = computer_use.probe()["capabilities"]
        implemented = {"menu", "drag", "paste", "clip", "screens", "open_app", "winmove", "winsize",
                       "webmode", "autofill", "act", "target.close"}
        self.assertTrue(all(capabilities[name]["supported"] for name in implemented))
        removed = {"styles", "html", "focus", "hover", "check", "select", "patch", "restore", "element.shot"}
        self.assertTrue(removed.isdisjoint(capabilities))
        for name in removed:
            self.assertFalse(hasattr(computer_use.Element, name.removeprefix("element.")))
        self.assertTrue(hasattr(computer_use.Element, "act"))

    async def test_element_fixed_token(self):
        target=computer_use.app("Calc",host="local")
        with patch.object(target,"snap",AsyncMock(return_value=snap(el(1,"Seven",axid="Seven")))) as read:
            element=target.element(id="Seven"); h=await element.resolve()
            with patch.object(target,"click",AsyncMock()) as click:
                await element.click(); click.assert_awaited_once_with(1,snapshot="tok")
            read.assert_awaited_once()
        with self.assertRaises(computer_use.ComputerUseError): computer_use.Element(computer_use.app("Other",host="local"),handle=h)
        with self.assertRaises(computer_use.ComputerUseError): target.element(css="#x")

    async def test_handle_rejects_other_task_window_and_lease(self):
        ref = {"id": 42, "pid": 123, "startedAt": 123.5}
        target = computer_use.app("Chrome", host="local", scope="task-a", window=ref)
        with patch.object(target, "snap", AsyncMock(return_value=snap(el(1,"Save",axid="Save")))):
            element = target.element(id="Save")
            handle = await element.resolve()
        for other in (computer_use.app("Chrome",host="local",scope="task-b",window=ref),
                      computer_use.app("Chrome",host="local",scope="task-a",window={**ref,"id":99})):
            with self.assertRaises(computer_use.ComputerUseError):
                computer_use.Element(other, handle=handle)
        target.lease = "new-generation"
        with self.assertRaises(computer_use.ComputerUseError):
            await element.read()

    async def test_element_incomplete_ambiguous(self):
        target=computer_use.app("Calc",host="local"); s=snap(el(1,"Twin"),el(2,"Twin"))
        with patch.object(target,"snap",AsyncMock(return_value=s)):
            with self.assertRaises(computer_use.ComputerUseError): await target.element(label="Twin").resolve()
        s.truncated=True
        with patch.object(target,"snap",AsyncMock(return_value=s)):
            with self.assertRaises(computer_use.ComputerUseError): await target.element(idx=1).resolve()

    async def test_autofill_binds_the_observed_number_and_token(self):
        data = {"snapshot": "observed", "window": {"id": 42, "pid": 123, "startedAt": 123.5}, "elements": [
            {"idx": 1, "role": "AXWebArea", "label": "1Password", "depth": 1},
            el(2, "Example — alice", depth=2)]}
        with patch.object(computer_use, "cli", AsyncMock(side_effect=[data, {}])) as call:
            result = await computer_use.autofill("Chrome", host="local", window={"id":42,"pid":123,"startedAt":123.5})
            self.assertEqual(result["clicked"], "Example — alice")
            self.assertEqual(call.await_args.args, ("click", "Chrome", 2, "--snapshot", "observed", "--require-focus"))

    async def test_autofill_without_explicit_task_window_is_rejected(self):
        with patch.object(computer_use,"cli",AsyncMock()) as native:
            with self.assertRaises(computer_use.ComputerUseError) as caught:
                await computer_use.autofill("Chrome",host="local")
            self.assertEqual(caught.exception.outcome,"not_sent")
            native.assert_not_awaited()

    async def test_autofill_requires_a_unique_account(self):
        data = {"snapshot": "observed", "window": {"id": 42, "pid": 123, "startedAt": 123.5}, "elements": [
            {"idx": 1, "role": "AXWebArea", "label": "1Password", "depth": 1},
            el(2, "Example — alice", depth=2), el(3, "Example — bob", depth=2)]}
        with patch.object(computer_use, "cli", AsyncMock(return_value=data)) as call:
            with self.assertRaises(computer_use.ComputerUseError) as caught:
                await computer_use.autofill("Chrome", host="local", window={"id":42,"pid":123,"startedAt":123.5})
            self.assertEqual(caught.exception.code, 2)
            call.assert_awaited_once()
        with patch.object(computer_use, "cli", AsyncMock(side_effect=[data, {}])) as call:
            await computer_use.autofill("Chrome", account="bob", host="local", window={"id":42,"pid":123,"startedAt":123.5})
            self.assertEqual(call.await_args.args, ("click", "Chrome", 3, "--snapshot", "observed", "--require-focus"))

    async def test_autofill_never_replays_a_stale_click(self):
        data = {"snapshot": "observed", "window": {"id": 42, "pid": 123, "startedAt": 123.5}, "elements": [
            {"idx": 1, "role": "AXWebArea", "label": "1Password", "depth": 1},
            el(2, "Example — alice", depth=2)]}
        stale = computer_use.ComputerUseError("stale", 4, "click", outcome="not_sent")
        with patch.object(computer_use, "cli", AsyncMock(side_effect=[data, stale])) as call:
            with self.assertRaises(computer_use.ComputerUseError) as caught:
                await computer_use.autofill("Chrome", host="local", window={"id":42,"pid":123,"startedAt":123.5})
            self.assertIs(caught.exception, stale)
            self.assertEqual(call.await_count, 2)

    async def test_autofill_rejects_incomplete_or_unbound_observations(self):
        for metadata in ({"truncated": True}, {"timedOut": True}, {"snapshot": None}):
            data = {"snapshot": "observed", "window": {"id": 42, "pid": 123, "startedAt": 123.5}, "elements": [], **metadata}
            with patch.object(computer_use, "cli", AsyncMock(return_value=data)) as call:
                with self.assertRaises(computer_use.ComputerUseError) as caught:
                    await computer_use.autofill("Chrome", host="local", window={"id":42,"pid":123,"startedAt":123.5})
                self.assertEqual(caught.exception.code, 4)
                self.assertEqual(caught.exception.outcome, "not_sent")
                call.assert_awaited_once()

    def test_cli_removed_element_actions_are_usage_errors(self):
        launcher=str(Path(__file__).resolve().parents[1]/"scripts"/"computer-use")
        for action in ("styles", "html", "focus", "hover", "check", "select", "patch", "restore", "shot"):
            with self.subTest(action=action):
                p=subprocess.run([launcher,"--local","element","Calc",action,"--selector",'{"id":"x"}',"--json"],capture_output=True,text=True)
                self.assertEqual(p.returncode,2,p.stderr)
                self.assertEqual(json.loads(p.stdout)["outcome"],"not_sent")

    def test_cli_probe_error(self):
        launcher=str(Path(__file__).resolve().parents[1]/"scripts"/"computer-use")
        p=subprocess.run([launcher,"--local","--capabilities","--json"],capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr); self.assertEqual(json.loads(p.stdout)["protocol"],1)
        p=subprocess.run([launcher,"--local","element","Calc","resolve","--selector",'{"css":"#x"}',"--json"],capture_output=True,text=True)
        self.assertEqual(p.returncode,5,p.stderr); self.assertEqual(json.loads(p.stdout)["command"],"element")
        p=subprocess.run([launcher,"--local","element","Calc","resolve","--selector","bad","--json"],capture_output=True,text=True)
        self.assertEqual(p.returncode,2,p.stderr); self.assertEqual(json.loads(p.stdout)["outcome"],"not_sent")
