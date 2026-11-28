"""Check on-disk file mutations across independent workbench kernels."""
from __future__ import annotations

import ast
import asyncio
import fcntl
from pathlib import Path
import tempfile
import textwrap
import unittest

from agy_python_repl.manager import KernelManager


class ConcurrentFileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.workspace = self.root / "work"
        self.workspace.mkdir()
        self.manager = KernelManager(data_dir=self.root / "data", skill_roots=[], project_skill_roots=[],
                                     auto_snapshot=False)
        self.addAsyncCleanup(self.manager.shutdown_all)
        self.target = self.workspace / "order.txt"
        self.original = "review=pending\nshipping=pending\n"
        self.target.write_text(self.original, encoding="utf-8")
        (self.workspace / "order-link").symlink_to(self.target.name)

    async def cell(self, kernel, code):
        reply = await self.manager.run_code(code, kernel=kernel, cwd=self.workspace)
        self.assertEqual(reply["status"], "ok", reply)
        return reply.get("result")

    def waiting_call(self, kernel, expression):
        # Observe real OS lock contention without changing its result or the file being edited.
        code = textwrap.dedent(f"""\
            import fcntl
            from unittest.mock import patch
            flock = fcntl.flock
            def observe(fd, flags):
                try:
                    return flock(fd, flags)
                except BlockingIOError:
                    if os.path.samestat(os.fstat(fd), Path('order.txt').stat()):
                        Path({kernel + '.waiting'!r}).touch()
                    raise
            with patch.object(fcntl, 'flock', observe):
                receipt = {expression}
            (os.getpid(), receipt.before, receipt.after)
        """)
        return asyncio.create_task(self.cell(kernel, code))

    async def wait_for(self, *files):
        async with asyncio.timeout(10):
            while not all((self.workspace / name).exists() for name in files):
                await asyncio.sleep(0.01)

    async def test_two_kernels_keep_both_edits_through_a_symlink(self):
        with self.target.open("r+b") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            review = self.waiting_call("review", "(await asyncio.gather("
                                       "edit('order-link', 'review=pending', 'review=ready'), "
                                       "write('invoice.txt', 'prepared')))[0]")
            shipping = self.waiting_call("shipping", "await edit('order.txt', 'shipping=pending', 'shipping=sent')")
            try:
                await self.wait_for("review.waiting", "shipping.waiting", "invoice.txt")
                self.assertEqual(self.target.read_bytes(), self.original.encode())
            finally:
                fcntl.flock(held, fcntl.LOCK_UN)
                changes = [ast.literal_eval(row) for row in await asyncio.gather(review, shipping)]
        final = "review=ready\nshipping=sent\n"
        self.assertNotEqual(changes[0][0], changes[1][0])
        self.assertCountEqual([self.original, *(after for _, _, after in changes)],
                              [final, *(before for _, before, _ in changes)])
        self.assertEqual(self.target.read_bytes(), final.encode())
        self.assertTrue((self.workspace / "order-link").is_symlink())
        self.assertEqual((self.workspace / "invoice.txt").read_bytes(), b"prepared")

    async def test_cancelled_write_and_edit_never_reach_disk_after_unlock(self):
        with self.target.open("r+b") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            write = self.waiting_call("writer", "await write('order.txt', 'replaced')")
            edit = self.waiting_call("editor", "await edit('order-link', 'shipping=pending', 'shipping=sent')")
            try:
                await self.wait_for("writer.waiting", "editor.waiting")
                for operation in (write, edit):
                    operation.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await operation
                # A subsequent cell confirms that each kernel has handled its interrupt.
                pids = await asyncio.gather(*(self.cell(name, "os.getpid()") for name in ("writer", "editor")))
                self.assertNotEqual(*pids)
            finally:
                fcntl.flock(held, fcntl.LOCK_UN)
                await asyncio.gather(write, edit, return_exceptions=True)
        # Join any outstanding file worker before inspecting the final bytes.
        await asyncio.gather(*(self.cell(name, "await asyncio.get_running_loop().shutdown_default_executor()")
                               for name in ("writer", "editor")))
        self.assertEqual(self.target.read_bytes(), self.original.encode())
        self.assertTrue((self.workspace / "order-link").is_symlink())

    async def test_cancelled_calls_in_worker_queue_cannot_create_or_edit_files(self):
        code = textwrap.dedent("""\
            import threading
            from concurrent.futures import ThreadPoolExecutor
            loop = asyncio.get_running_loop()
            loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
            release = threading.Event()
            occupied = loop.run_in_executor(None, release.wait)
            try:
                calls = [asyncio.create_task(write('invoice.txt', 'created')),
                         asyncio.create_task(edit('order.txt', 'review=pending', 'review=ready'))]
                await asyncio.sleep(0)
                for call in calls:
                    call.cancel()
                await asyncio.gather(*calls, return_exceptions=True)
            finally:
                release.set()
                await occupied
                await loop.shutdown_default_executor()
            all(call.cancelled() for call in calls)
        """)
        self.assertEqual(await self.cell("clerk", code), "True")
        self.assertFalse((self.workspace / "invoice.txt").exists())
        self.assertEqual(self.target.read_bytes(), self.original.encode())

    async def test_concurrent_creation_returns_one_create_and_one_matching_update(self):
        async def write(name):
            result = await self.cell(name, f"r = await write('new/order.txt', {name!r})\n"
                                          "(r.operation, r.before, r.after)")
            return ast.literal_eval(result)

        created, updated = sorted(await asyncio.gather(write("draft"), write("ready")))
        self.assertEqual(created[:2], ("create", None))
        self.assertEqual(updated[:2], ("update", created[2]))
        self.assertEqual((self.workspace / "new/order.txt").read_text(encoding="utf-8"), updated[2])
