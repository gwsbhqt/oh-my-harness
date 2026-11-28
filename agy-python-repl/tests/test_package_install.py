"""Install local wheels through the same launcher and MCP tool that Antigravity uses."""
from __future__ import annotations

import ast
import base64
from contextlib import asynccontextmanager
import hashlib
from itertools import count
import json
import os
from pathlib import Path
import shutil
from string import Template
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agy_python_repl.session_routing import SERVER_NAME
from agy_python_repl.bootstrap import _ReplHelper


ROOT = Path(__file__).resolve().parents[1]
PRIMARY_SESSION = "00000000-0000-4000-8000-000000000001"


def make_wheel(directory: Path, name: str, version: str, requires: str = "", *, with_assets: bool = False) -> Path:
    info = f"{name}-{version}.dist-info"
    metadata = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    if requires:
        metadata += f"Requires-Dist: {requires}\n"
    files = {
        f"{name}/__init__.py": f"VALUE = {version!r}\n",
        f"{info}/METADATA": metadata,
        f"{info}/WHEEL": "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    if with_assets:
        files[f"{name}/__init__.py"] += "def main():\n    print(VALUE)\n"
        files[f"{info}/entry_points.txt"] = f"[console_scripts]\n{name}-tool = {name}:main\n"
        files[f"{name}-{version}.data/data/share/{name}/value.txt"] = version
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


def launcher(root: Path, workspace: Path) -> tuple[StdioServerParameters, Path]:
    bundle, data = root / "bundle", root / "plugin data"
    subprocess.run(["sh", ROOT / "scripts/bundle.sh", bundle], check=True, capture_output=True)
    server, = json.loads((bundle / "mcp_config.json").read_text())["mcpServers"].values()
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
    return params, data


class PackageInstallTests(unittest.IsolatedAsyncioTestCase):
    async def test_other_interpreter_refuses_before_installing(self):
        with tempfile.TemporaryDirectory() as data:
            with patch.dict(os.environ, {"PLUGIN_DATA": data, "AGY_PYTHON_REPL_CONSTRAINTS": "dill==0"}):
                with self.assertRaisesRegex(RuntimeError, "PLUGIN_DATA/venv"):
                    await _ReplHelper(kernel="default").install("unused.whl")

    @asynccontextmanager
    async def plugin_session(self, params):
        bundle = Path(params.env["PLUGIN_ROOT"])
        steps = count()

        def hook(payload, *flags):
            completed = subprocess.run(
                [sys.executable, bundle / "hooks" / "inject_session.py", *flags],
                cwd=bundle, env=params.env, input=json.dumps(payload), text=True, capture_output=True, check=True, timeout=15,
            )
            return json.loads(completed.stdout)

        async with stdio_client(params) as streams, ClientSession(*streams) as session:
            await session.initialize()

            async def call_tool(name, args, kernel=PRIMARY_SESSION):
                payload = {
                    "conversationId": kernel, "stepIdx": next(steps), "workspacePaths": [str(params.cwd)],
                    "toolCall": {"name": f"mcp_{SERVER_NAME}_{name}", "args": args},
                }
                decision = hook(payload)
                self.assertEqual(decision["decision"], "allow", decision)
                reply = await session.call_tool(name, {**args, **decision.get("overwrite", {})})
                if reply.isError:
                    payload["error"] = str(reply.content)
                self.assertEqual(hook(payload, "--post-tool-use"), {})
                return reply

            yield call_tool

    async def cell(self, call_tool, code, kernel=PRIMARY_SESSION):
        reply = await call_tool("run_code", {"code": code}, kernel)
        self.assertFalse(reply.isError, reply.content)
        result = reply.structuredContent
        self.assertEqual(result["status"], "ok", result.get("error"))
        return ast.literal_eval(result["result"])

    @unittest.skipUnless(shutil.which("uv"), "the plugin launcher requires uv")
    async def test_analysis_packages_persist_and_host_versions_stay_locked(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        workspace = root / "workspace"
        workspace.mkdir()
        wrong_target = root / "project-only"
        (workspace / "uv.toml").write_text(f"[pip]\ntarget = {json.dumps(str(wrong_target))}\n")
        params, data = launcher(root, workspace)
        first = make_wheel(workspace, "sample_analysis_lib", "1.0")
        update = make_wheel(workspace, "sample_analysis_lib", "2.0")
        latest = make_wheel(workspace, "sample_analysis_lib", "3.0")
        conflict = make_wheel(workspace, "dill", "9999.0")
        indirect = make_wheel(workspace, "sample_conflict", "1.0", f"dill @ {conflict.as_uri()}")
        async with self.plugin_session(params) as call_tool:
            initial = await self.cell(call_tool, "import importlib.util, os\nfrom importlib.metadata import version\n"
                                      "(importlib.util.find_spec('sample_analysis_lib') is None, version('dill'), os.getpid())")
            self.assertTrue(initial[0])
            installed = await self.cell(call_tool, f"await repl.install({first.name!r})")
            self.assertEqual(set(installed), {"environment", "changed", "importable_now", "stale"})
            self.assertEqual((installed["environment"], installed["importable_now"], installed["stale"]),
                             (str(data / "venv"), ["sample_analysis_lib"], []))
            named = "报表 '甲组'"
            probe = "(sample_analysis_lib.VALUE, os.getpid(), kept)"
            for kernel, kept in ((named, 41), (PRIMARY_SESSION, 79)):
                await self.cell(call_tool, f"import os, sample_analysis_lib\nkept = {kept}\n{probe}", kernel=kernel)
            for kernel, neighbor, wheel, expected in ((named, PRIMARY_SESSION, update, "2.0"),
                                                      (PRIMARY_SESSION, named, latest, "3.0")):
                with self.subTest(kernel=kernel):
                    before = await self.cell(call_tool, probe, kernel=kernel)
                    untouched = await self.cell(call_tool, probe, kernel=neighbor)
                    self.assertNotEqual(before[1], untouched[1])
                    upgrade_args = {"code": f"await repl.install({wheel.name!r}, upgrade=True)"}
                    upgraded = await call_tool("run_code", upgrade_args, kernel)
                    self.assertFalse(upgraded.isError, upgraded.content)
                    self.assertEqual(upgraded.structuredContent["status"], "ok", upgraded.structuredContent)
                    receipt = ast.literal_eval(upgraded.structuredContent["result"])
                    self.assertEqual(ast.literal_eval(upgraded.content[0].text), receipt)
                    self.assertEqual(receipt["stale"], ["sample_analysis_lib"])
                    self.assertEqual(await self.cell(call_tool, probe, kernel=kernel), before)
                    step = receipt["next_step"]
                    self.assertEqual(step["tool"], "kernel_state")
                    self.assertIn("restart", step["instruction"].lower())
                    self.assertEqual(step["arguments"], {"action": "restart"})
                    restart = await call_tool(step["tool"], step["arguments"], kernel)
                    self.assertEqual(restart.structuredContent["status"], "ok", restart.content)
                    self.assertEqual(restart.structuredContent["kernel"], kernel)
                    version, pid, kept = await self.cell(call_tool, probe, kernel=kernel)
                    self.assertEqual((version, kept), (expected, before[2]))
                    self.assertNotEqual(pid, before[1])
                    self.assertEqual(await self.cell(call_tool, probe, kernel=neighbor), untouched)
            unchanged = await self.cell(call_tool, f"await repl.install({latest.name!r})")
            self.assertEqual(set(unchanged), set(installed))
            self.assertEqual((unchanged["changed"], unchanged["stale"]), ([], []))
            for wheel in (conflict, indirect):
                with self.subTest(wheel=wheel.name):
                    error = await self.cell(call_tool, f"try:\n    await repl.install({wheel.name!r})\n    failure = ''\n"
                                            "except RuntimeError as exc:\n    failure = str(exc)\n(failure, version('dill'))")
                    self.assertIn("uv failed", error[0])
                    self.assertIn(f"dill=={initial[1]}", error[0])
                    self.assertEqual(error[1], initial[1])
        async with self.plugin_session(params) as call_tool:
            reopened = await self.cell(call_tool, "import os, sample_analysis_lib\nfrom importlib.metadata import version\n"
                                       "(sample_analysis_lib.VALUE, version('dill'), os.getpid())", kernel="fresh")
        self.assertEqual(reopened[:2], ("3.0", initial[1]))
        self.assertNotEqual(reopened[2], initial[2])
        self.assertFalse(wrong_target.exists())

    async def assert_installed_layout(self, call_tool, name, venv, outside):
        receipt = await self.cell(call_tool, f"dict(await repl.install({name!r}))")
        self.assertFalse(outside.exists(), f"installation created {outside}")
        self.assertEqual((receipt["environment"], receipt["importable_now"]), (str(venv), [name]))
        version, source, purelib = await self.cell(call_tool, f"import {name} as module\n"
                                                   "(module.VALUE, module.__file__, __import__('sysconfig').get_path('purelib'))")
        self.assertEqual(version, "1.0")
        self.assertTrue(Path(purelib).is_relative_to(venv), purelib)
        self.assertEqual(Path(source), Path(purelib) / name / "__init__.py")
        output = subprocess.check_output([venv / "bin" / f"{name}-tool"], text=True)
        self.assertEqual(output.strip(), version)
        self.assertEqual((venv / "share" / name / "value.txt").read_text(), version)

    @unittest.skipUnless(shutil.which("uv"), "the plugin launcher requires uv")
    async def test_user_and_explicit_sources_keep_the_kernel_install_layout(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        workspace = root / "workspace"
        workspace.mkdir()
        user_wheels, explicit_wheels = root / "user wheels", root / "explicit wheels"
        for directory, name in ((user_wheels, "sample_user_source"), (explicit_wheels, "sample_explicit_source")):
            directory.mkdir()
            make_wheel(directory, name, "1.0", with_assets=True)
        blocked = make_wheel(explicit_wheels, "sample_blocked_source", "1.0")
        project_target, wrong_prefix, explicit_target = root / "project-target", root / "prefix", root / "target"
        user_config = root / ".config/uv/uv.toml"
        chosen = root / "explicit configs"
        configs = {
            workspace / "uv.toml": f"[pip]\ntarget = {json.dumps(str(project_target))}\n",
            user_config: f"[pip]\nno-index = true\nfind-links = [{json.dumps(str(user_wheels))}]\n",
            chosen / "with-prefix.toml": (f"[pip]\nno-index = true\nfind-links = [{json.dumps(str(explicit_wheels))}]\n"
                                          f"prefix = {json.dumps(str(wrong_prefix))}\n"),
            chosen / "with-target.toml": f"[pip]\ntarget = {json.dumps(str(explicit_target))}\n",
        }
        for path, contents in configs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)

        params, data = launcher(root, workspace)
        async with self.plugin_session(params) as call_tool:
            pid = await self.cell(call_tool, "import os\nos.getpid()")
            with self.subTest(config="user find-links"):
                await self.assert_installed_layout(call_tool, "sample_user_source", data / "venv", project_target)
            self.assertEqual(await self.cell(call_tool, f"os.environ.update(UV_CONFIG_FILE='with-prefix.toml', "
                                             f"UV_WORKING_DIR={str(chosen)!r})\nos.getpid()"), pid)
            with self.subTest(config="explicit find-links and prefix"):
                await self.assert_installed_layout(call_tool, "sample_explicit_source", data / "venv", wrong_prefix)
            with self.subTest(config="explicit target"):
                failure, module_visible, distribution_visible = await self.cell(
                    call_tool, "os.environ['UV_CONFIG_FILE'] = 'with-target.toml'\n"
                    f"try:\n    await repl.install({str(blocked)!r})\n    failure = ''\n"
                    "except RuntimeError as exc:\n    failure = str(exc)\n"
                    "from importlib import metadata, util\n"
                    "(failure, util.find_spec('sample_blocked_source') is not None, "
                    "bool(list(metadata.distributions(name='sample_blocked_source'))))",
                )
                locations = {
                    "target_created": explicit_target.exists(),
                    "module_in_target": (explicit_target / "sample_blocked_source/__init__.py").is_file(),
                    "distribution_in_target": (explicit_target / "sample_blocked_source-1.0.dist-info/METADATA").is_file(),
                    "module_visible_in_kernel": module_visible,
                    "distribution_visible_in_kernel": distribution_visible,
                }
                self.assertFalse(any(locations.values()), locations)
                self.assertIn("[pip].target", failure)
                self.assertIn("UV_CONFIG_FILE", failure)
        for path, original in configs.items():
            self.assertEqual(path.read_bytes(), original.encode())
