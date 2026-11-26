"""Exercise per-storage ownership across real stdio servers and kernel lifetimes."""

from __future__ import annotations

import ast
import asyncio
import json
import os
import signal
import sys
import tempfile
import textwrap
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.manager import KernelManager


ROOT = Path(__file__).resolve().parents[1]
REPORT = "fixture:monthly report"


class ProcessOwnershipTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.data = self.root / "data"

    @asynccontextmanager
    async def server(self, cwd=None, *, watchdog_pid=None):
        env = {"PYTHONPATH": str(ROOT / "src"), "PYTHONDONTWRITEBYTECODE": "1",
               "HOME": str(self.root), "PLUGIN_DATA": str(self.data)}
        if watchdog_pid is not None:
            env["PRIME_AGENT_KERNEL_OWNER_PID"] = str(watchdog_pid)
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "agy_python_repl.server"], cwd=cwd or self.root,
            env=env,
        )
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield client

    async def call(self, client, tool, **arguments):
        reply = await client.call_tool(tool, arguments)
        self.assertFalse(reply.isError, reply.content)
        self.assertEqual(json.loads(reply.content[0].text), reply.structuredContent)
        return reply.structuredContent

    async def cell(self, client, code, name=REPORT):
        body = await self.call(client, "run_code", kernel=name, code=code)
        self.assertEqual(body["status"], "ok", body)
        return body

    async def busy(self, client, tool, **arguments):
        reply = await client.call_tool(tool, arguments)
        self.assertTrue(reply.isError, reply.content)
        self.assertIn("in use", reply.content[0].text.lower())

    async def test_other_server_can_inspect_but_cannot_run_or_mutate_before_handoff(self):
        async with self.server() as successor:
            async with self.server() as owner:
                await self.cell(owner, "ledger = {'base':100, 'north':12}")
                receipt = await self.call(owner, "kernel_state", kernel=REPORT, action="snapshot")
                snap = Path(receipt["snapshot_path"])
                files = (snap, snap.with_suffix(".manifest.json"))
                before = [p.read_bytes() for p in files]
                await self.busy(successor, "run_code", kernel=REPORT, code="Path('unauthorized').touch()")
                self.assertFalse((self.root / "unauthorized").exists())
                for action in ("snapshot", "restore", "reset", "vars"):
                    await self.busy(successor, "app_kernel_action", kernel=REPORT, action=action)
                self.assertEqual([p.read_bytes() for p in files], before)
                listing = await self.call(successor, "kernel_state", action="list", kernel="fixture")
                self.assertIn(REPORT, listing["saved_snapshots"])
                overview = await self.call(successor, "app_kernel_overview")
                self.assertIn(REPORT, {item["name"] for item in overview["kernels"]})
                other = await self.cell(successor, "distinct = 17\ndistinct", REPORT + " other")
                self.assertEqual(other["result"], "17")
            adopted = await self.cell(successor, "ledger['south'] = 34\nledger")
            self.assertEqual(ast.literal_eval(adopted["result"]), {"base":100, "north":12, "south":34})
        async with self.server() as third:
            final = await self.cell(third, "ledger")
            self.assertTrue(final["restored"]["restored"])
            self.assertEqual(final["result"], adopted["result"])

    async def test_crash_protects_last_eof_flush_until_kernel_really_exits(self):
        code = (
            "import asyncio\nbase=100\nasync def _buffer():\n    global pending_sale\n"
            "    while not Path('go').exists():\n        await asyncio.sleep(0.01)\n"
            "    pending_sale=12\n    Path('buffered').touch()\n"
            "_pending=asyncio.create_task(_buffer())\n(os.getppid(), os.getpid())"
        )
        # Keep the watchdog owner alive to exercise the real EOF flush rather than its hard-exit race.
        async with self.server() as successor, self.server(watchdog_pid=os.getpid()) as owner:
            host_pid, kernel_pid = ast.literal_eval((await self.cell(owner, code))["result"])
            self.assertNotIn(os.getpid(), (host_pid, kernel_pid))
            original = await self.call(owner, "kernel_state", action="snapshot", kernel=REPORT)
            self.assertNotIn("pending_sale", original["saved"])
            (self.root / "go").touch()
            async with asyncio.timeout(10):
                while not (self.root / "buffered").is_file():
                    await asyncio.sleep(0.01)
            # Hold the last writer alive across coordinator death to make the EOF window deterministic.
            os.kill(kernel_pid, signal.SIGSTOP)
            try:
                os.kill(host_pid, signal.SIGKILL)
                async with asyncio.timeout(5):
                    while True:
                        try:
                            os.kill(host_pid, 0)
                        except ProcessLookupError:
                            break
                        await asyncio.sleep(0.01)
                await self.busy(successor, "run_code", kernel=REPORT, code="Path('too-early').touch()")
                self.assertFalse((self.root / "too-early").exists())
            finally:
                os.kill(kernel_pid, signal.SIGCONT)
            async with asyncio.timeout(10):
                while True:
                    reply = await successor.call_tool("run_code", {"kernel":REPORT, "code":"(base, pending_sale)"})
                    if not reply.isError:
                        break
                    self.assertIn("in use", reply.content[0].text.lower())
                    await asyncio.sleep(0.02)
            self.assertEqual(reply.structuredContent["status"], "ok", reply.structuredContent)
            self.assertEqual(reply.structuredContent["result"], "(100, 12)")
            self.assertTrue(reply.structuredContent["restored"]["restored"])

    async def test_default_watchdog_crash_releases_the_last_committed_state(self):
        async with self.server() as successor, self.server() as owner:
            committed = await self.cell(owner, "confirmed = 83\n(os.getppid(), os.getpid())")
            host_pid, kernel_pid = ast.literal_eval(committed["result"])
            self.assertNotIn(os.getpid(), (host_pid, kernel_pid))
            await self.call(owner, "kernel_state", action="snapshot", kernel=REPORT)
            os.kill(host_pid, signal.SIGKILL)
            async with asyncio.timeout(10):
                while True:
                    reply = await successor.call_tool("run_code", {"kernel": REPORT, "code": "confirmed"})
                    if not reply.isError:
                        break
                    self.assertIn("in use", reply.content[0].text.lower())
                    await asyncio.sleep(0.02)
            self.assertEqual(reply.structuredContent["result"], "83")
            self.assertTrue(reply.structuredContent["restored"]["restored"])

    async def test_old_colon_and_disk_spellings_protect_the_same_record(self):
        async with self.server() as seed:
            await self.cell(seed, "keep=41", "default")
        prefix = self.data / "snapshots"
        for suffix in (".dill", ".manifest.json"):
            (prefix / ("default" + suffix)).rename(prefix / ("fixture__legacy" + suffix))
        async with self.server() as a, self.server() as b:
            self.assertEqual((await self.cell(a, "keep", "fixture:legacy"))["result"], "41")
            await self.busy(b, "kernel_state", kernel="fixture__legacy", action="reset")
            self.assertTrue((prefix / "fixture__legacy.dill").exists())
            self.assertEqual((await self.call(a, "kernel_state", kernel="fixture:legacy", action="reset"))["status"], "reset")
            self.assertEqual((await self.cell(b, "'keep' in globals()", "fixture:legacy"))["result"], "False")

    async def test_failed_or_cancelled_bootstrap_releases_ownership(self):
        package = self.root / "agy_python_repl"
        package.mkdir()
        (package / "__init__.py").touch()
        stub = package / "bootstrap.py"
        kernel = KernelManager(data_dir=self.data, skill_roots=[], project_skill_roots=[])
        self.addAsyncCleanup(kernel.shutdown_all)
        with self.assertRaisesRegex(RuntimeError, "bootstrap"):
            await kernel.run_code("Path('never').touch()", kernel=REPORT, cwd=self.root)
        stub.write_text("import time\nfrom pathlib import Path\n"
                        "def install_antigravity_surface(entries):\n    Path('booting').touch()\n    time.sleep(30)\n")
        good = self.root / "good"
        good.mkdir()
        opening = asyncio.create_task(kernel.run_code("Path('never').touch()", kernel=REPORT, cwd=self.root))
        try:
            async with asyncio.timeout(10):
                while not (self.root / "booting").exists():
                    await asyncio.sleep(0.01)
            async with self.server(good) as contender:
                await self.busy(contender, "run_code", kernel=REPORT, code="Path('early').touch()")
            self.assertFalse((good / "early").exists())
            opening.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await opening
        finally:
            opening.cancel()
            await asyncio.gather(opening, return_exceptions=True)
        self.assertFalse((self.root / "never").exists())
        async with self.server(good) as contender:
            self.assertEqual((await self.cell(contender, "10+2"))["result"], "12")
        await kernel.run_code("value=18", kernel=REPORT, cwd=good)
        await kernel.shutdown_all()
        async with self.server(good) as contender:
            self.assertEqual((await self.cell(contender, "value"))["result"], "18")

    async def test_kernel_exclusively_owns_its_copy_across_fork_and_exec(self):
        code = textwrap.dedent("""\
            import subprocess, sys
            lock = next(Path('data/locks').rglob('*.lock'))
            identity = lock.stat()
            def same(fd, expected):
                try:
                    return os.path.samestat(os.fstat(fd), expected)
                except OSError:
                    return False
            fd = next(int(p.name) for p in Path('/dev/fd').iterdir() if same(int(p.name), identity))
            probe = "import os, sys\\ntry: same = os.path.samestat(os.fstat(int(sys.argv[1])), os.stat(sys.argv[2]))\\nexcept OSError: same = False\\nprint(same)"
            via_exec = subprocess.check_output([sys.executable, '-c', probe, str(fd), str(lock)],
                                               close_fds=False, text=True).strip()
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                try:
                    fork_inherited = same(fd, identity)
                    user_fd = os.open('child-file.txt', os.O_RDWR | os.O_CREAT, 0o600)
                    if user_fd != fd:
                        os.dup2(user_fd, fd)
                        os.close(user_fd)
                    user_identity = os.fstat(fd)
                    grandchild = os.fork()
                    if grandchild == 0:
                        try:
                            flags = [fork_inherited, same(fd, user_identity)]
                            os.write(write_fd, json.dumps(flags).encode())
                        finally:
                            os._exit(0)
                    os.waitpid(grandchild, 0)
                finally:
                    os._exit(0)
            os.close(write_fd)
            via_fork = json.loads(os.read(read_fd, 1024))
            os.close(read_fd)
            os.waitpid(child, 0)
            (via_exec, via_fork, same(fd, identity))
        """)
        async with self.server() as owner, self.server() as contender:
            result = await self.cell(owner, code)
            self.assertEqual(ast.literal_eval(result["result"]), ("False", [False, True], True))
            await self.busy(contender, "run_code", kernel=REPORT, code="Path('unexpected').touch()")

