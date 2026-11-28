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
            self.assertEqual(
                (bundle / "_bundled/vendor/PROVENANCE.md").read_bytes(),
                (ROOT.parent / "dsh-python-repl/vendor/PROVENANCE.md").read_bytes(),
            )
            sidecar = bundle / "sidecars" / "app-bridge"
            manifest = json.loads((sidecar / "sidecar.json").read_text(encoding="utf-8"))
            self.assertTrue((sidecar / manifest["args"][0]).is_file())
            config = json.loads((bundle / "mcp_config.json").read_text(encoding="utf-8"))
            server_name, = config["mcpServers"]
            server = config["mcpServers"][server_name]
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
                tools = {tool.name: tool for tool in (await session.list_tools()).tools}
                self.assertIn("run_code", tools)
                self.assertNotIn("kernel", tools["run_code"].inputSchema["properties"])
                self.assertNotIn("kernel", tools["kernel_state"].inputSchema["properties"])

                def run_bundle_hook(event: str, payload: dict) -> dict:
                    cmd = ["python3", str(bundle / "hooks" / "inject_session.py")]
                    if event == "PostToolUse":
                        cmd.append("--post-tool-use")
                    proc = subprocess.run(
                        cmd,
                        cwd=bundle,
                        input=json.dumps(payload),
                        env={**os.environ, **variables},
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    return json.loads(proc.stdout)

                code = "from pathlib import Path\nunits = int(Path('units.txt').read_text())\nunits"
                call_1 = {"id": "bundle-1", "name": f"mcp_agy-python-repl_{server_name}_run_code", "args": {"code": code}}
                self.assertEqual(run_bundle_hook("PreToolUse", {"conversationId": "sample-session", "toolCall": call_1}), {"decision": "allow"})
                result = await session.call_tool("run_code", {"code": code})
                self.assertFalse(result.isError, result.content)
                self.assertEqual(result.structuredContent["result"], "42")
                self.assertEqual(run_bundle_hook("PostToolUse", {"conversationId": "sample-session", "toolCall": call_1}), {})

                followup = "[units + 1, any(s['import_name'] == 'agy_use' for s in await skills.list())]"
                call_2 = {"id": "bundle-2", "name": f"mcp_agy-python-repl_{server_name}_run_code", "args": {"code": followup}}
                self.assertEqual(run_bundle_hook("PreToolUse", {"conversationId": "sample-session", "toolCall": call_2}), {"decision": "allow"})
                result = await session.call_tool("run_code", {"code": followup})
                self.assertEqual(result.structuredContent["result"], "[43, True]")
                self.assertEqual(run_bundle_hook("PostToolUse", {"conversationId": "sample-session", "toolCall": call_2}), {})
            self.assertTrue((root / "plugin data" / "snapshots" / "sample-session.dill").is_file())

            separate = root / "independent data"
            client_env = {k: v for k, v in env.items() if k not in variables}
            client_env["AGY_PYTHON_REPL_DATA"] = str(separate)
            independent = StdioServerParameters(command="sh", args=[str(bundle / "scripts" / "start_mcp.sh")],
                                                cwd=workspace, env=client_env)
            async with stdio_client(independent) as streams, ClientSession(*streams) as client:
                await client.initialize()
                reply = await client.call_tool("run_code", {"code": "sum([3, 5])", "kernel": "counts"})
                self.assertFalse(reply.isError, reply.content)
                self.assertEqual(reply.structuredContent["result"], "8")
                state = await client.call_tool("kernel_state", {"action": "vars", "kernel": "counts"})
                self.assertEqual(state.structuredContent["kernel"], "counts")
            self.assertTrue((separate / "snapshots" / "counts.dill").is_file())
            self.assertFalse(any(bundle.rglob("__pycache__")))
            self.assertFalse(any(bundle.rglob("*.egg-info")))
