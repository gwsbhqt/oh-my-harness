"""Start the standalone plugin the way Antigravity starts an MCP server."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
from string import Template
import subprocess
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


ROOT = Path(__file__).resolve().parents[1]


class StandaloneBundleTests(unittest.IsolatedAsyncioTestCase):
    def test_bundle_preserves_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as dirname:
            dest = Path(dirname)
            sentinel = dest / "existing.txt"
            sentinel.write_text("keep", encoding="utf-8")
            result = subprocess.run(["sh", str(ROOT / "scripts/bundle.sh"), str(dest)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    @unittest.skipUnless(shutil.which("uv"), "the standalone launcher requires uv")
    async def test_manifest_starts_server_from_another_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname).resolve()
            bundle = root / "installed plugin"
            workspace = root / "example project"
            workspace.mkdir()
            (workspace / "units.txt").write_text("42", encoding="utf-8")
            subprocess.run(["sh", str(ROOT / "scripts/bundle.sh"), str(bundle)], check=True, capture_output=True)
            self.assertEqual((bundle / "LICENSE").read_bytes(), (ROOT.parent / "LICENSE").read_bytes())
            self.assertTrue((bundle / "_bundled/vendor/prime/LICENSE").is_file())
            sidecar = bundle / "sidecars" / "app-bridge"
            manifest = json.loads((sidecar / "sidecar.json").read_text(encoding="utf-8"))
            self.assertTrue((sidecar / manifest["args"][0]).is_file())
            config = json.loads((bundle / "mcp_config.json").read_text(encoding="utf-8"))
            server = config["mcpServers"]["agy-python-repl"]
            local_uv = root / ".local" / "bin" / "uv"
            local_uv.parent.mkdir(parents=True)
            local_uv.symlink_to(Path(shutil.which("uv")).resolve())
            variables = {"PLUGIN_ROOT": str(bundle), "PLUGIN_DATA": str(root / "plugin data")}
            env = {
                **variables,
                "HOME": str(root),
                "PATH": os.defpath,
                "UV_CACHE_DIR": subprocess.check_output(["uv", "cache", "dir"], text=True).strip(),
                "UV_PYTHON_INSTALL_DIR": subprocess.check_output(["uv", "python", "dir"], text=True).strip(),
            }
            params = StdioServerParameters(command=server["command"], cwd=workspace, env=env,
                                          args=[Template(arg).substitute(variables) for arg in server["args"]])
            async with stdio_client(params) as (reader, writer), ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                self.assertIn("run_code", [tool.name for tool in tools.tools])
                code = "from pathlib import Path\nunits = int(Path('units.txt').read_text())\nunits"
                result = await session.call_tool("run_code", {"code": code, "kernel": "sample-session"})
                self.assertFalse(result.isError, result.content)
                self.assertEqual(result.structuredContent["result"], "42")
                followup = "[units + 1, any(s['import_name'] == 'agy_use' for s in await skills.list())]"
                result = await session.call_tool("run_code", {"code": followup, "kernel": "sample-session"})
                self.assertEqual(result.structuredContent["result"], "[43, True]")
            self.assertTrue((root / "plugin data" / "snapshots" / "sample-session.dill").is_file())
            self.assertFalse(any(bundle.rglob("__pycache__")))
            self.assertFalse(any(bundle.rglob("*.egg-info")))
