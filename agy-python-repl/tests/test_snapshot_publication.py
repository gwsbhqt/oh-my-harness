"""Exercise committed snapshots through AGY's stdio tools and session-start hook."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

import dill
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.manager import KernelManager
from python_repl_core.kernel_client import KernelClient


ROOT = Path(__file__).resolve().parents[1]


class SnapshotPublicationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.data = self.root / "data"
        self.snapshots = self.data / "snapshots"

    @asynccontextmanager
    async def server(self, *, watchdog_pid=None):
        env = {"HOME": str(self.root), "PLUGIN_DATA": str(self.data), "PYTHONPATH": str(ROOT / "src"),
               "PYTHONDONTWRITEBYTECODE": "1"}
        if watchdog_pid is not None:
            env["PRIME_AGENT_KERNEL_OWNER_PID"] = str(watchdog_pid)
        params = StdioServerParameters(command=sys.executable, args=["-m", "agy_python_repl.server"],
                                       cwd=self.root, env=env)
        async with stdio_client(params) as streams, ClientSession(*streams) as client:
            await client.initialize()
            yield client

    async def call(self, client, tool, **args):
        reply = await client.call_tool(tool, args)
        self.assertFalse(reply.isError, reply.content)
        self.assertEqual(json.loads(reply.content[0].text), reply.structuredContent)
        return reply.structuredContent

    async def cell(self, client, code, kernel="default"):
        result = await self.call(client, "run_code", kernel=kernel, code=code)
        self.assertEqual(result["status"], "ok", result)
        return result

    def hook(self, kernel):
        proc = subprocess.run([sys.executable, str(ROOT / "hooks" / "session_start.py")], check=True,
                              input=json.dumps({"conversationId": kernel}), capture_output=True, text=True,
                              env={"HOME": str(self.root), "PLUGIN_DATA": str(self.data), "PYTHONDONTWRITEBYTECODE": "1"})
        return json.loads(proc.stdout)["injectSteps"][0]["systemMessage"]["systemMessage"]

    def fail_publication(self):
        # Deny just the final publish on each layout. Encoding and writes to private temps still succeed.
        install = textwrap.dedent(f"""\
            import os
            from pathlib import Path
            replace = os.replace
            def fault(src, dst, *args, **kwargs):
                target = Path(dst)
                if (target == Path({str(self.snapshots / 'default.manifest.json')!r}) and not Path(src).is_symlink()
                    or target.name == 'current' and Path(src).is_symlink() and len(os.readlink(src)) == 32):
                    raise OSError('fixture refused publication')
                return replace(src, dst, *args, **kwargs)
            os.replace = fault
        """)
        return f"exec({install!r}, {{}})\n"

    async def test_failed_publication_preserves_the_previous_bytes_and_value(self):
        async with self.server() as writer:
            await self.cell(writer, "counter = 7")
            state = await self.call(writer, "kernel_state", action="snapshot")
            payload = Path(state["snapshot_path"])
            manifest = payload.with_suffix(".manifest.json")
            old = payload.read_bytes(), manifest.read_bytes()
            failed = await self.cell(writer, self.fail_publication() + "counter = 9")
            self.assertIn("fixture refused publication", failed["snapshot_error"])
            explicit = await self.call(writer, "kernel_state", action="snapshot")
            self.assertEqual(explicit["status"], "error", explicit)
        async with self.server() as reader:
            self.assertEqual((payload.read_bytes(), manifest.read_bytes()), old)
            recovered = await self.cell(reader, "counter")
            self.assertEqual(recovered["result"], "7")
            self.assertEqual(recovered["restored"]["snapshot_path"], str(payload))
            self.assertEqual(recovered["restored"]["saved_names"], ["counter"])

    async def test_failed_publication_keeps_the_previous_names_and_skip_reasons(self):
        async with self.server() as writer:
            await self.cell(writer, "counter=7\nold_only=11\nold_skip=(i for i in range(2))")
            await self.cell(writer, self.fail_publication() +
                            "counter=99\ndel old_only, old_skip\nnew_only=42\nnew_skip=(i for i in range(2))")
        async with self.server() as reader:
            restored = await self.cell(reader, "(counter, old_only, 'new_only' in globals())")
            self.assertEqual(restored["result"], "(7, 11, False)")
            report = restored["restored"]
            self.assertEqual(report["saved_names"], ["counter", "old_only"])
            self.assertEqual([entry["name"] for entry in report["skipped"]], ["old_skip"])
            self.assertIn("generator", report["skipped"][0]["reason"])

    async def test_legacy_writer_replacing_public_links_protects_both_versions(self):
        async with self.server() as writer:
            await self.cell(writer, "counter=7")
            path = Path((await self.call(writer, "kernel_state", action="snapshot"))["snapshot_path"])
            manifest = path.with_suffix(".manifest.json")
            committed = path.resolve(), manifest.resolve()
            previous = tuple(p.read_bytes() for p in committed)
        # The previous AGY writer used Prime's ordinary two-step replacement of the public paths.
        layout = KernelManager(data_dir=self.data)
        legacy = KernelClient(python_exe=sys.executable, vendor_dir=layout.vendor_dir,
                              compat_dir=layout.compat_dir, cwd=self.root)
        await legacy.start()
        try:
            self.assertEqual((await legacy.execute("counter=9")).status, "ok")
            self.assertEqual((await legacy.snapshot(path, manifest))["status"], "ok")
        finally:
            await legacy.shutdown()
        self.assertFalse(path.is_symlink() or manifest.is_symlink())
        replacement = path.read_bytes(), manifest.read_bytes()
        self.assertNotEqual(replacement[0], previous[0])
        self.assertNotIn("snapshot ready", self.hook("default"))
        async with self.server() as reader:
            probe = await self.cell(reader, "'counter' in globals()")
            self.assertEqual(probe["result"], "False")
            self.assertIn("snapshot_warning", probe)
            self.assertEqual(probe["restored"]["status"], "error")
            explicit = await self.call(reader, "kernel_state", action="snapshot")
            self.assertEqual(explicit["status"], "error")
        self.assertEqual((path.read_bytes(), manifest.read_bytes()), replacement)
        self.assertEqual(tuple(p.read_bytes() for p in committed), previous)

    async def test_failed_explicit_restore_disarms_the_kernel_eof_write(self):
        async with self.server() as next_host, self.server(watchdog_pid=os.getpid()) as writer:
            session = await self.cell(writer, "counter=7\n__import__('os').getppid()")
            host_pid = int(session["result"])
            self.assertNotEqual(host_pid, os.getpid())
            payload = Path((await self.call(writer, "kernel_state", action="snapshot"))["snapshot_path"])
            before = b"!" * payload.stat().st_size
            payload.write_bytes(before)
            error = await self.call(writer, "kernel_state", action="restore")
            self.assertEqual(error["status"], "error")
            pending = await self.cell(writer, "counter = 99")
            self.assertIn("snapshot_warning", pending)
            os.kill(host_pid, signal.SIGKILL)
            async with asyncio.timeout(10):
                while True:
                    response = await next_host.call_tool("run_code", {"code": "'counter' in globals()"})
                    if not response.isError:
                        break
                    self.assertIn("in use", response.content[0].text.lower())
                    await asyncio.sleep(0.02)
            self.assertEqual(response.structuredContent["result"], "False")
            self.assertEqual(response.structuredContent["restored"]["status"], "error")
            self.assertEqual(payload.read_bytes(), before)

    async def test_interrupted_first_publication_is_not_a_legacy_snapshot(self):
        async with self.server() as first:
            failed = await self.cell(first, self.fail_publication() + "unpublished = 42")
            self.assertIn("fixture refused publication", failed["snapshot_error"])
        async with self.server() as reader:
            names = await self.call(reader, "kernel_state", action="list")
            self.assertNotIn("default", names["saved_snapshots"])
            self.assertNotIn("snapshot ready", self.hook("default"))
            restored = await self.cell(reader, "'unpublished' in globals()")
            self.assertEqual(restored["result"], "False")
            self.assertNotIn("restored", restored)

    async def test_damaged_named_commit_stays_visible_and_protected_until_reset(self):
        name = "Quarter Report"
        async with self.server() as writer:
            await self.cell(writer, "quarter_total = 73", name)
            receipt = await self.call(writer, "kernel_state", kernel=name, action="snapshot")
            payload = Path(receipt["snapshot_path"])
            before = payload.read_bytes()
            manifest = payload.with_suffix(".manifest.json")
            store = payload.parent / (".snapshot-" + hashlib.sha256(payload.name.encode()).hexdigest())
        self.assertIn("quarter_total", self.hook(name))
        self.assertTrue(payload.is_symlink() and manifest.is_symlink())
        self.assertEqual(payload.resolve().parent, manifest.resolve().parent)
        manifest.resolve(strict=True).unlink()
        self.assertNotIn("snapshot ready", self.hook(name))
        async with self.server() as reader:
            listing = await self.call(reader, "kernel_state", action="list")
            self.assertIn(name, listing["saved_snapshots"])
            overview = await self.call(reader, "app_kernel_overview")
            self.assertIn(name, {row["name"] for row in overview["kernels"]})
            probe = await self.cell(reader, "'quarter_total' in globals()", name)
            self.assertEqual(probe["result"], "False")
            self.assertEqual(probe["restored"]["status"], "error")
            self.assertIn("snapshot_warning", probe)
            for action in ("snapshot", "restore"):
                state = await self.call(reader, "kernel_state", action=action, kernel=name)
                self.assertEqual(state["status"], "error", state)
            self.assertEqual(payload.read_bytes(), before)
            await self.cell(reader, "neighbor = 4", "another")
            await self.call(reader, "app_kernel_action", kernel=name, action="reset")
            self.assertTrue(all(not os.path.lexists(path) for path in (payload, manifest, store, payload.with_suffix(".name"))))
        async with self.server() as successor:
            self.assertEqual((await self.cell(successor, "neighbor", "another"))["result"], "4")
            self.assertNotIn("restored", await self.cell(successor, "1", name))

    async def test_old_manifestless_flat_name_restores_and_keeps_its_path(self):
        self.snapshots.mkdir(parents=True)
        payload = self.snapshots / "scope__history.dill"
        payload.write_bytes(dill.dumps({"dsh_user_old": dill.dumps(31)}))
        async with self.server() as upgraded:
            restored = await self.cell(upgraded, "dsh_user_old", "scope:history")
            self.assertEqual(restored["result"], "31")
            report = restored["restored"]
            self.assertEqual((report["saved_names"], report["skipped"]), ([], []))
            self.assertEqual(report["snapshot_path"], str(payload))
            self.assertIn("legacy_name_warning", report)
            self.assertTrue(payload.is_file())
        async with self.server() as successor:
            explicit = await self.call(successor, "kernel_state", kernel="scope__history", action="restore")
            self.assertEqual((explicit["status"], explicit["restored"]), ("ok", ["dsh_user_old"]))
            self.assertEqual(Path(explicit["snapshot_path"]), payload)

    async def test_parallel_restore_save_and_reset_of_different_flat_kernels(self):
        async with self.server() as seed:
            for name in ("north", "south", "west"):
                await self.cell(seed, f"region = {name!r}", name)
        async with self.server() as client:
            async def restore_north():
                for _ in range(6):
                    result = await self.call(client, "kernel_state", kernel="north", action="restore")
                    self.assertEqual((result["status"], result["restored"]), ("ok", ["region"]))

            async def save_south():
                for i in range(6):
                    result = await self.cell(client, f"balance = {i}", "south")
                    self.assertNotIn("snapshot_error", result)

            async def reset_west():
                for i in range(6):
                    await self.call(client, "kernel_state", kernel="west", action="reset")
                    clean = await self.cell(client, "'previous' in globals()", "west")
                    self.assertEqual(clean["result"], "False")
                    await self.cell(client, f"previous = {i}", "west")

            async with asyncio.timeout(15):
                await asyncio.gather(restore_north(), save_south(), reset_west())
        async with self.server() as restored:
            self.assertEqual((await self.cell(restored, "region", "north"))["result"], "'north'")
            self.assertEqual((await self.cell(restored, "balance", "south"))["result"], "5")
            self.assertEqual((await self.cell(restored, "previous", "west"))["result"], "5")
