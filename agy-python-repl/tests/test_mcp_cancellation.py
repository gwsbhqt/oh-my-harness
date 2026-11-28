"""Cancellation over the official MCP stdio transport and a real Prime kernel."""
from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.shared.exceptions import McpError

import agy_python_repl
import python_repl_core
from agy_python_repl.manager import KernelManager
from python_repl_core.kernel_client import KernelProtocolError


class McpCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_interrupts_only_its_cell_and_keeps_the_kernel(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            source_dirs = [Path(module.__file__).resolve().parents[1]
                           for module in (agy_python_repl, python_repl_core)]
            params = StdioServerParameters(
                command=sys.executable, args=["-m", "agy_python_repl.server"], cwd=workspace,
                env={"HOME": directory, "PLUGIN_DATA": str(workspace / "data"),
                     "PYTHONPATH": os.pathsep.join(map(str, source_dirs)), "PYTHONDONTWRITEBYTECODE": "1"},
            )
            async with stdio_client(params) as (reader, writer), ClientSession(reader, writer) as session:
                await session.initialize()

                async def call(code, kernel="primary"):
                    return await session.call_tool("run_code", {"code": code, "cwd": str(workspace), "kernel": kernel})

                first = await call("import os\nos.getpid()")
                self.assertFalse(first.isError)
                pid = int(first.structuredContent["result"])
                request_ids = asyncio.Queue()
                send = writer.send

                async def observe(message):
                    packet = message.message.root
                    await send(message)
                    if isinstance(packet, types.JSONRPCRequest) and packet.method == "tools/call":
                        request_ids.put_nowait(packet.id)

                async def cancel(request_id, running):
                    notification = types.CancelledNotification(params=types.CancelledNotificationParams(
                        requestId=request_id, reason="Test cancelled this cell"))
                    await session.send_notification(types.ClientNotification(notification))
                    with self.assertRaisesRegex(McpError, "Request cancelled"):
                        await running

                started = workspace / "started"
                release = workspace / "release"
                code = ("import asyncio\nvalue = 40\nPath('started').touch()\n"
                        "while not Path('release').exists():\n    await asyncio.sleep(0.01)\n"
                        "Path('late').touch()\nvalue = 99")
                with patch.object(writer, "send", observe):
                    async with asyncio.timeout(15):
                        active = asyncio.create_task(call(code))
                        active_id = await request_ids.get()
                        try:
                            while not started.exists():
                                await asyncio.sleep(0.01)
                            queued = asyncio.create_task(call("Path('queued').touch()"))
                            queued_id = await request_ids.get()
                            other = await call("import os\nos.getpid()", kernel="other")
                            self.assertNotEqual(int(other.structuredContent["result"]), pid)
                            await cancel(queued_id, queued)
                            self.assertFalse(active.done())
                            await cancel(active_id, active)
                            # Let an uncancelled cell finish so the next cell exposes the late write.
                            wake = asyncio.get_running_loop().call_later(0.4, release.touch)
                            try:
                                following = await call("[value, Path('late').exists(), os.getpid()]")
                            finally:
                                wake.cancel()
                            self.assertEqual(following.structuredContent.get("result"), str([40, False, pid]))
                            self.assertFalse((workspace / "queued").exists())
                        finally:
                            release.touch()

    async def test_asyncio_task_cancel_preserves_reason_and_prior_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = KernelManager(data_dir=root / "data", skill_roots=[], project_skill_roots=[], auto_snapshot=False)
            try:
                original = await manager.run_code("import os\nos.getpid()", cwd=root)
                cell = asyncio.create_task(manager.run_code(
                    "import asyncio\nvalue = 40\nPath('started').touch()\n"
                    "while not Path('release').exists():\n    await asyncio.sleep(0.01)\nvalue = 99", cwd=root))
                async with asyncio.timeout(5):
                    while not (root / "started").exists():
                        await asyncio.sleep(0.01)
                    cell.cancel("cancel only this request")
                    with self.assertRaises(asyncio.CancelledError) as cancelled:
                        await cell
                    self.assertEqual(cancelled.exception.args, ("cancel only this request",))
                    next_cell = await manager.run_code("[value, os.getpid()]", cwd=root)
                    self.assertEqual(next_cell.get("result"), str([40, int(original["result"])]))
            finally:
                (root / "release").touch()
                await manager.shutdown_all()

    async def test_uninterruptible_cell_reaps_before_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = KernelManager(data_dir=root / "data", skill_roots=[], project_skill_roots=[])
            try:
                await manager.run_code("saved = 40", cwd=root)
                client = manager._kernels["default"].client
                process = client._proc
                cell = asyncio.create_task(manager.run_code(
                    "import asyncio, signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nPath('started').touch()\n"
                    "while not Path('release').exists():\n    try:\n        await asyncio.sleep(0.01)\n"
                    "    except (KeyboardInterrupt, asyncio.CancelledError):\n        continue", cwd=root))
                async with asyncio.timeout(20):
                    while not (root / "started").exists():
                        await asyncio.sleep(0.01)
                    cell.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await cell
                    queued = asyncio.create_task(manager.run_code("Path('queued').touch()", cwd=root))
                    while client.alive:
                        await asyncio.sleep(0.01)
                    await client.shutdown()
                    self.assertEqual(process.returncode, -signal.SIGKILL)
                    with self.assertRaisesRegex(KernelProtocolError, "before the queued cell could run"):
                        await queued
                    self.assertFalse((root / "queued").exists())
                    fresh = await manager.run_code("[saved, 'skills' in globals()]", cwd=root)
                    self.assertEqual(fresh["result"], "[40, True]")
                    self.assertTrue(fresh["restored"]["restored"])
            finally:
                (root / "release").touch()
                await manager.shutdown_all()
