"""Check the actual model text returned by the stdio MCP server and its kernel."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import agy_python_repl


# A preloaded AGY call adds its hook and timestamps before the MCP JSON.
_PRELOADED_HEADER = (
    "A pre-tool hook changed the arguments of this tool call before it ran. Changed: cwd, kernel.\n\n"
    "Created At: 2000-01-01T00:00:00Z\nCompleted At: 2000-01-01T00:00:01Z\n"
).encode()


class HostOutputTests(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def server(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "agy_python_repl.server"],
                cwd=root,
                env={
                    "HOME": str(root),
                    "PLUGIN_DATA": str(root / "data"),
                    "PYTHONPATH": str(Path(agy_python_repl.__file__).resolve().parents[1]),
                    "PYTHONDONTWRITEBYTECODE": "1",
                },
            )
            async with stdio_client(params) as streams, ClientSession(*streams) as client:
                await client.initialize()
                yield root, client

    async def cell(self, client: ClientSession, code: str) -> tuple[dict, bytes]:
        reply = await client.call_tool("run_code", {"code": code})
        self.assertFalse(reply.isError, reply.content)
        text, = reply.content
        payload = json.loads(text.text)
        self.assertEqual(reply.structuredContent, payload)
        return payload, text.text.encode("utf-8")

    def check_captures(self, root: Path, payload: dict, text: bytes, expected: dict[str, str]) -> None:
        self.assertEqual(next(iter(payload)), "overflow_files")
        self.assertTrue(payload["truncated"])
        self.assertLess(len(_PRELOADED_HEADER + text), 6 * 1024)
        visible = (_PRELOADED_HEADER + text)[:10 * 1024]
        files = {}
        for name in payload["overflow_files"]:
            path = Path(name)
            self.assertTrue(path.resolve().is_relative_to((root / "data").resolve()))
            self.assertIn(json.dumps(name, ensure_ascii=False).encode(), visible)
            key = path.stem.split("_")[-1]
            files[key] = path.read_text(encoding="utf-8")
        self.assertEqual(files, expected)

    async def test_large_mixed_unicode_puts_the_three_actual_files_first(self) -> None:
        async with self.server() as (root, client):
            cell = "import sys\nprint('甲'*26000)\nprint('乙'*14000, file=sys.stderr)\n'丙'*28000"
            payload, text = await self.cell(client, cell)
            self.check_captures(root, payload, text, {
                "stdout": "甲" * 26000 + "\n", "stderr": "乙" * 14000 + "\n", "result": repr("丙" * 28000),
            })
            self.assertIn("captured", payload["output_note"].lower())
            self.assertIn("display", payload["output_note"].lower())

    async def test_utf8_and_json_escaping_share_one_budget(self) -> None:
        async with self.server() as (root, client):
            # Every channel fits its own old limit, even its on-wire byte limit, in isolation.
            streams = {"stdout": '雪"\\\n' * 650, "stderr": "\x01" * 650, "result": "終" * 1500}
            code = f"import sys\nsys.stdout.write({streams['stdout']!r})\nsys.stderr.write({streams['stderr']!r})\n{streams['result']!r}"
            payload, text = await self.cell(client, code)
            self.check_captures(root, payload, text, {**streams, "result": repr(streams["result"])})

    async def test_small_results_and_short_channels_stay_readable(self) -> None:
        async with self.server() as (_, client):
            small, _ = await self.cell(client, "import sys\nprint('短')\nprint('提示', file=sys.stderr)\n6*7")
            self.assertEqual(small, {"status": "ok", "stdout": "短\n", "stderr": "提示\n", "result": "42"})
            mixed, text = await self.cell(client, "print('甲'*9000)\nprint('提示', file=sys.stderr)\n6*7")
            self.assertEqual((mixed["stderr"], mixed["result"]), ("提示\n", "42"))
            self.assertLess(len(_PRELOADED_HEADER + text), 6 * 1024)

    async def test_failed_writes_are_visible_before_the_preview_and_cell_runs_once(self) -> None:
        async with self.server() as (root, client):
            data = root / "data"
            data.mkdir(exist_ok=True)
            (data / "overflow").touch()
            code = "import sys\nruns = globals().get('runs', 0) + 1\nprint('甲'*9000)\nprint('乙'*9000, file=sys.stderr)\n'丙'*9000"
            payload, text = await self.cell(client, code)
            self.assertEqual(payload["status"], "ok")
            self.assertNotIn("overflow_files", payload)
            self.assertEqual(next(iter(payload)), "overflow_errors")
            self.assertEqual(set(payload["overflow_errors"]), {"stdout", "stderr", "result"})
            self.assertLess(len(_PRELOADED_HEADER + text), 6 * 1024)
            self.assertEqual((await self.cell(client, "runs"))[0]["result"], "1")

    async def test_large_exception_retains_error_and_captured_diagnostics(self) -> None:
        async with self.server() as (_, client):
            payload, text = await self.cell(client, "print('先'*9000)\nraise ValueError('错'*9000)")
            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["error"]["ename"], "ValueError")
            self.assertEqual(next(iter(payload)), "overflow_files")
            self.assertLess(len(_PRELOADED_HEADER + text), 6 * 1024)
            details, = (Path(name) for name in payload["overflow_files"] if name.endswith(".json"))
            self.assertEqual(json.loads(details.read_text(encoding="utf-8"))["error"]["evalue"], "错" * 9000)
