"""Install local wheels through the same launcher and MCP tool that Antigravity uses."""
from __future__ import annotations

import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
from string import Template
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.bootstrap import _ReplHelper


ROOT = Path(__file__).resolve().parents[1]


def make_wheel(directory: Path, name: str, version: str, requires: str = "") -> Path:
    info = f"{name}-{version}.dist-info"
    metadata = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    if requires:
        metadata += f"Requires-Dist: {requires}\n"
    files = {
        f"{name}/__init__.py": f"VALUE = {version!r}\n",
        f"{info}/METADATA": metadata,
        f"{info}/WHEEL": "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    wheel = directory / f"{name}-{version}-py3-none-any.whl"
    with ZipFile(wheel, "w") as archive:
        records = []
        for path, text in files.items():
            payload = text.encode()
            digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).rstrip(b"=").decode()
            archive.writestr(path, payload)
            records.append(f"{path},sha256={digest},{len(payload)}")
        archive.writestr(f"{info}/RECORD", "\n".join([*records, f"{info}/RECORD,,", ""]))
    return wheel


class PackageInstallTests(unittest.IsolatedAsyncioTestCase):
    async def test_other_interpreter_refuses_before_installing(self):
        with tempfile.TemporaryDirectory() as data:
            with patch.dict(os.environ, {"PLUGIN_DATA": data, "AGY_PYTHON_REPL_CONSTRAINTS": "dill==0"}):
                with self.assertRaisesRegex(RuntimeError, "PLUGIN_DATA/venv"):
                    await _ReplHelper().install("unused.whl")

    async def cell(self, session, code, kernel="sample"):
        reply = await session.call_tool("run_code", {"code": code, "kernel": kernel})
        self.assertFalse(reply.isError, reply.content)
        result = reply.structuredContent
        self.assertEqual(result["status"], "ok", result.get("error"))
        return ast.literal_eval(result["result"])

    @unittest.skipUnless(shutil.which("uv"), "the plugin launcher requires uv")
    async def test_analysis_packages_persist_and_host_versions_stay_locked(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        bundle, data, workspace = root / "bundle", root / "plugin data", root / "workspace"
        workspace.mkdir()
        wrong_target = root / "project-only"
        (workspace / "uv.toml").write_text(f"[pip]\ntarget = {json.dumps(str(wrong_target))}\n")
        subprocess.run(["sh", ROOT / "scripts/bundle.sh", bundle], check=True, capture_output=True)
        server = json.loads((bundle / "mcp_config.json").read_text())["mcpServers"]["agy-python-repl"]
        uv = Path(shutil.which("uv")).resolve()
        local_uv = root / ".local/bin/uv"
        local_uv.parent.mkdir(parents=True)
        local_uv.symlink_to(uv)
        variables = {"PLUGIN_ROOT": str(bundle), "PLUGIN_DATA": str(data)}
        env = {
            **variables, "HOME": str(root), "PATH": os.defpath, "UV_OFFLINE": "1", "UV_PYTHON_DOWNLOADS": "never",
            "UV_CACHE_DIR": subprocess.check_output([uv, "cache", "dir"], text=True).strip(),
            "UV_PYTHON_INSTALL_DIR": subprocess.check_output([uv, "python", "dir"], text=True).strip(),
        }
        params = StdioServerParameters(command=server["command"], cwd=workspace, env=env,
                                      args=[Template(arg).substitute(variables) for arg in server["args"]])
        first = make_wheel(workspace, "sample_analysis_lib", "1.0")
        update = make_wheel(workspace, "sample_analysis_lib", "2.0")
        conflict = make_wheel(workspace, "dill", "9999.0")
        indirect = make_wheel(workspace, "sample_conflict", "1.0", f"dill @ {conflict.as_uri()}")
        async with stdio_client(params) as streams, ClientSession(*streams) as session:
            await session.initialize()
            initial = await self.cell(session, "import importlib.util, os\nfrom importlib.metadata import version\n"
                                      "(importlib.util.find_spec('sample_analysis_lib') is None, version('dill'), os.getpid())")
            self.assertTrue(initial[0])
            installed = await self.cell(session, f"receipt = await repl.install({first.name!r})\nimport sample_analysis_lib\n"
                                        "(receipt['environment'], receipt['importable_now'], sample_analysis_lib.VALUE)")
            self.assertEqual(installed, (str(data / "venv"), ["sample_analysis_lib"], "1.0"))
            upgraded = await self.cell(session, f"receipt = await repl.install({update.name!r}, upgrade=True)\n"
                                       "(receipt['stale'], sample_analysis_lib.VALUE)")
            self.assertEqual(upgraded, (["sample_analysis_lib"], "1.0"))
            for wheel in (conflict, indirect):
                with self.subTest(wheel=wheel.name):
                    error = await self.cell(session, f"try:\n    await repl.install({wheel.name!r})\n    failure = ''\n"
                                            "except RuntimeError as exc:\n    failure = str(exc)\n(failure, version('dill'))")
                    self.assertIn("uv failed", error[0])
                    self.assertIn(f"dill=={initial[1]}", error[0])
                    self.assertEqual(error[1], initial[1])
        async with stdio_client(params) as streams, ClientSession(*streams) as session:
            await session.initialize()
            reopened = await self.cell(session, "import os, sample_analysis_lib\nfrom importlib.metadata import version\n"
                                       "(sample_analysis_lib.VALUE, version('dill'), os.getpid())", kernel="fresh")
        self.assertEqual(reopened[:2], ("2.0", initial[1]))
        self.assertNotEqual(reopened[2], initial[2])
        self.assertFalse(wrong_target.exists())
