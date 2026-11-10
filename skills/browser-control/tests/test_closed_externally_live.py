"""BROWSER_CONTROL_CLOSED_LIVE=1：隔离服务 + browser-control 自启的 Chrome，验证页面在 browser-control 之外被关掉后 release、tab close、disconnect 都能收尾。"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request

from browser_control.cdp import CDP

ROOT = Path(__file__).resolve().parents[1]
PAGE = "data:text/html,<p id=p>hi</p>"


@unittest.skipUnless(os.environ.get("BROWSER_CONTROL_CLOSED_LIVE") == "1", "需显式 BROWSER_CONTROL_CLOSED_LIVE=1 启动隔离 browser-control 服务和它自己的 Chrome")
class ClosedExternallyLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="browser-control-closed-live-")
        self.root = Path(self.temp.name).resolve()
        # 资源账固定放在 HOME 下；换成临时 HOME 才能断言账里没有残留，也不碰用户的账。
        (self.root / "home").mkdir()
        cache = self.root / "cache" / "browser-control"
        cache.mkdir(parents=True)
        venv = Path.home() / ".cache" / "browser-control" / "venv"
        if venv.is_dir():
            (cache / "venv").symlink_to(venv)
        self.socket = self.root / "sock" / "daemon.sock"
        self.socket.parent.mkdir(mode=0o700)
        self.env = {**os.environ, "HOME": str(self.root / "home"), "XDG_STATE_HOME": str(self.root / "state"),
                    "XDG_CACHE_HOME": str(self.root / "cache"), "BROWSER_CONTROL_CONTEXT_ID": "", "DSH_SESSION_ID": ""}
        self.log = tempfile.TemporaryFile()
        self.service = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "browser-control"), "serve", "--socket", str(self.socket)],
                                        env=self.env, stdout=self.log, stderr=self.log)
        deadline = asyncio.get_running_loop().time() + 10
        while not self.socket.exists():
            if self.service.poll() is not None or asyncio.get_running_loop().time() > deadline:
                self.log.seek(0)
                raise RuntimeError("隔离服务未就绪：" + self.log.read().decode(errors="replace"))
            await asyncio.sleep(.05)
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        try:
            await self.cli("release")
        finally:
            if self.service.poll() is None:
                self.service.terminate()
            await asyncio.to_thread(self.service.wait, 10)
            self.log.close()
            self.temp.cleanup()

    async def cli(self, *args):
        command = [sys.executable, str(ROOT / "scripts" / "browser-control"), "--socket", str(self.socket), "--session", "closed_live",
                   "--browser", "Chrome", "--json", *args]
        proc = await asyncio.create_subprocess_exec(*command, env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await proc.communicate()
        return proc.returncode, json.loads(out), err.decode()

    def ledger(self):
        path = self.root / "home" / ".local" / "state" / "browser-control" / "resources.json"
        return json.loads(path.read_text()) if path.exists() else []

    def close_outside_browser_control(self, target):
        """像用户手动关标签一样，从 browser-control 之外直接让 Chrome 关掉页面。"""
        kids = subprocess.run(["pgrep", "-P", str(self.service.pid)], capture_output=True, text=True, check=True).stdout.split()
        for pid in kids:
            command = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True, text=True).stdout
            profile = next((part.split("=", 1)[1] for part in command.split() if part.startswith("--user-data-dir=")), None)
            if profile:
                break
        else:
            self.fail("没找到隔离服务自启的 Chrome")
        port = (Path(profile) / "DevToolsActivePort").read_text().splitlines()[0]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as response:
            cdp = CDP(json.load(response)["webSocketDebuggerUrl"])
        try:
            self.assertTrue(cdp.call("Target.closeTarget", {"targetId": target})["success"])
            for _ in range(100):
                if not any(t["targetId"] == target for t in cdp.call("Target.getTargets")["targetInfos"]):
                    return
                cdp.call("Target.getTargets")
            self.fail("外部关闭后页面仍在")
        finally:
            cdp.close()

    async def open_page_with_debug_changes(self):
        """开页并留下 browser-control 收尾时要撤的东西：调试器、断点和一个元素句柄。"""
        code, created, err = await self.cli("tab", "new", PAGE)
        self.assertEqual(code, 0, (created, err))
        target = created["targetId"]
        for args in (("debug", target, "enable"),
                     ("debug", target, "breakpoint", "--params", json.dumps({"url_regex": ".*", "line": 0})),
                     ("element", target, "resolve", "--selector", json.dumps({"css": "#p"}))):
            code, result, err = await self.cli(*args)
            self.assertEqual(code, 0, (args, result, err))
        self.assertEqual([r["targetId"] for r in self.ledger()], [target])
        return target

    async def test_release_after_external_close(self):
        target = await self.open_page_with_debug_changes()
        await asyncio.to_thread(self.close_outside_browser_control, target)
        code, released, err = await self.cli("release")
        self.assertEqual(code, 0, (released, err))
        result = released["browsers"]["Chrome"]["result"]
        self.assertEqual(result["closedExternally"], [target])
        self.assertEqual(result["released"], [])
        self.assertEqual(self.ledger(), [])
        code, again, err = await self.cli("release")
        self.assertEqual(code, 0, (again, err))
        self.assertEqual(again["browsers"]["Chrome"]["result"], {"released": []})

    async def test_tab_close_after_external_close(self):
        target = await self.open_page_with_debug_changes()
        await asyncio.to_thread(self.close_outside_browser_control, target)
        code, closed, err = await self.cli("tab", "close", target)
        self.assertEqual(code, 0, (closed, err))
        self.assertTrue(closed["closedExternally"])
        self.assertEqual(self.ledger(), [])
        code, released, err = await self.cli("release")
        self.assertEqual(code, 0, (released, err))

    async def test_disconnect_after_external_close(self):
        target = await self.open_page_with_debug_changes()
        await asyncio.to_thread(self.close_outside_browser_control, target)
        code, disconnected, err = await self.cli("disconnect")
        self.assertEqual(code, 0, (disconnected, err))
        self.assertEqual(disconnected["browsers"]["Chrome"]["result"]["closedExternally"], [target])
        self.assertEqual(self.ledger(), [])
        code, released, err = await self.cli("release")
        self.assertEqual(code, 0, (released, err))

    async def test_real_undo_failure_on_live_page_still_fails(self):
        """浏览器和页面都在，只是元素修改没还原：仍要报失败，不能当成外部关闭吞掉。"""
        code, created, err = await self.cli("tab", "new", PAGE)
        target = created["targetId"]
        code, resolved, err = await self.cli("element", target, "resolve", "--selector", json.dumps({"css": "#p"}))
        self.assertEqual(code, 0, (resolved, err))
        code, patched, err = await self.cli("element", target, "patch", "--params",
                                            json.dumps({"handle": resolved["handle"], "styles": {"color": "red"}}))
        self.assertEqual(code, 0, (patched, err))
        code, released, err = await self.cli("release")
        self.assertEqual(code, 1, (released, err))
        chrome = released["data"]["browsers"]["Chrome"]
        self.assertEqual(chrome["error"], "部分资源未能清理，保留记录供再次核对")
        self.assertNotIn("closedExternally", chrome["data"])
        self.assertIn("页面已解除绑定，但部分调试修改需要核对", json.dumps(chrome["data"]["errors"], ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
