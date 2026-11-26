"""Read real Prime snapshots through independently started AGY MCP servers."""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import agy_python_repl
from agy_python_repl.manager import KernelManager
from python_repl_core.kernel_client import KernelClient


class SnapshotReferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.data = self.workspace / "data"
        self.server = StdioServerParameters(
            command=sys.executable,
            args=["-m", "agy_python_repl.server"],
            cwd=self.workspace,
            env={
                "HOME": str(self.workspace),
                "PLUGIN_DATA": str(self.data),
                "PYTHONPATH": str(Path(agy_python_repl.__file__).resolve().parents[1]),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )

    async def cell_in_new_server(self, code: str) -> dict:
        async with stdio_client(self.server) as streams, ClientSession(*streams) as client:
            await client.initialize()
            reply = await client.call_tool("run_code", {"code": code})
        self.assertFalse(reply.isError, reply.content)
        result = reply.structuredContent
        self.assertEqual(result["status"], "ok", result.get("error"))
        self.assertNotIn("snapshot_error", result)
        return result

    async def test_shared_list_and_underscore_name_survive_server_restart(self) -> None:
        first = await self.cell_in_new_server(
            "a = [1]\nb = a\nholder = {'item': a}\n_ordinary = 37\n"
            "def read_a():\n    return a\n"
            "a.append(2)\n(a is b is holder['item'] is read_a(), b, holder['item'], _ordinary)"
        )
        self.assertEqual(ast.literal_eval(first["result"]), (True, [1, 2], [1, 2], 37))

        second = await self.cell_in_new_server(
            "a.append(3)\noriginal = a\na = [9]\n"
            "(original is b, original is holder['item'], read_a() is a, "
            "original, b, holder['item'], globals().get('_ordinary'))"
        )
        report = second["restored"]
        self.assertTrue(report["restored"], report)
        direct, nested, from_function, a, b, item, ordinary = ast.literal_eval(second["result"])
        with self.subTest("shared list"):
            expected = [1, 2, 3]
            self.assertEqual((direct, nested, a, b, item), (True, True, expected, expected, expected))
        with self.subTest("function reads the live global"):
            self.assertTrue(from_function)
        with self.subTest("single underscore"):
            self.assertEqual(ordinary, 37)
            self.assertIn("_ordinary", report["saved_names"])
            self.assertIn("_ordinary", report["restored_names"])

    async def test_unmodified_prime_snapshot_preserves_values_and_public_names(self) -> None:
        # Bare Prime writes the format used before AGY tracked references and underscore names.
        layout = KernelManager(data_dir=self.data)
        prime = KernelClient(
            python_exe=sys.executable, vendor_dir=layout.vendor_dir, compat_dir=layout.compat_dir, cwd=self.workspace,
        )
        await prime.start()
        try:
            seeded = await prime.execute("a = [1, 2]\nb = a\ndsh_user_total = 23")
            self.assertEqual(seeded.status, "ok", seeded.error)
            snapshots = self.data / "snapshots"
            saved = await prime.snapshot(snapshots / "default.dill", snapshots / "default.manifest.json")
            self.assertEqual(saved["status"], "ok", saved)
        finally:
            await prime.shutdown()

        restored = await self.cell_in_new_server("(a, b, globals().get('dsh_user_total'), '_total' in globals())")
        self.assertTrue(restored["restored"]["restored"], restored["restored"])
        self.assertEqual(ast.literal_eval(restored["result"]), ([1, 2], [1, 2], 23, False))
        self.assertIn("dsh_user_total", restored["restored"]["restored_names"])
