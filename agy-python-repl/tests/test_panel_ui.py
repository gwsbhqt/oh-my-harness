"""Exercise the MCP App resource, its real kernel tools, and the iframe transport."""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp.shared.memory import create_connected_server_and_client_session

from agy_python_repl import server
from agy_python_repl.manager import KernelManager

PANEL = Path(__file__).resolve().parents[1] / "ui" / "panel.html"


class PanelTests(unittest.IsolatedAsyncioTestCase):
    async def test_registered_panel_and_real_kernel_actions(self):
        with tempfile.TemporaryDirectory() as folder:
            manager = KernelManager(data_dir=Path(folder) / "data", skill_roots=[], project_skill_roots=[])
            with patch.object(server, "_manager", manager):
                async with create_connected_server_and_client_session(server.mcp) as client:
                    tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                    entry = tools["open_kernel_panel"].meta
                    uri = entry["ui"]["resourceUri"]
                    self.assertEqual(entry["com.google.antigravity/ui"]["entrypoints"][0]["type"], "aux_pane")
                    for name in ("app_kernel_overview", "app_kernel_action"):
                        self.assertEqual(tools[name].meta["ui"]["visibility"], ["app"])
                    resource, = (await client.read_resource(uri)).contents
                    self.assertEqual(resource.mimeType, "text/html;profile=mcp-app")
                    self.assertEqual(resource.text, PANEL.read_text(encoding="utf-8"))

                    async def call(name, **args):
                        reply = await client.call_tool(name, args)
                        self.assertFalse(reply.isError, reply.content)
                        return reply.structuredContent

                    code = 'sample = "<mark> & text"'
                    await call("run_code", kernel="sample", cwd=folder, code=code)
                    overview = await call("app_kernel_overview")
                    self.assertEqual(await call("open_kernel_panel"), overview)
                    self.assertEqual(overview["kernels"][0]["name"], "sample")
                    self.assertEqual(overview["history"][0]["code_preview"], code)
                    for action, field in (("vars", "names"), ("snapshot", "saved"), ("restore", "restored")):
                        result = await call("app_kernel_action", kernel="sample", action=action)
                        self.assertIn("sample", result[field])
                    await call("app_kernel_action", kernel="sample", action="reset")
                    self.assertEqual((await call("app_kernel_overview"))["kernels"], [])

    @unittest.skipUnless(shutil.which("node"), "Node.js runs the panel's browser-independent message transport")
    def test_parent_protocol_and_advertised_capabilities(self):
        bridge = re.search(r'<script id="mcp-bridge">(.*?)</script>', PANEL.read_text(encoding="utf-8"), re.S)[1]
        checks = r"""
const assert = require('node:assert/strict');
async function check() {
  const sent = [], seen = [];
  const parent = {postMessage: (msg, target) => sent.push({msg, target})};
  let receive;
  const view = {parent, addEventListener: (_, listener) => { receive = listener; }};
  const connection = panelHost(view, (method) => seen.push(method));
  const origin = 'https://host.invalid';
  function deliver(data, source = parent, from = origin) { receive({source, origin: from, data}); }
  const starting = connection.initialize();
  const init = sent[0].msg;
  assert.equal(init.method, 'ui/initialize');
  const result = {protocolVersion: init.params.protocolVersion, hostCapabilities: {message: {image: {}}}};
  const reply = {jsonrpc: '2.0', id: init.id, result};
  deliver(reply, {});
  deliver({...reply, jsonrpc: '1.0'});
  deliver({...reply, error: {message: 'ambiguous reply'}});
  await Promise.resolve();
  assert.equal(sent.length, 1);
  deliver(reply);
  await starting;
  assert.equal(sent[1].msg.method, 'ui/notifications/initialized');
  assert.equal(sent[1].target, origin);
  const event = {jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {}};
  deliver(event, {}, origin);
  deliver(event, parent, 'https://other.invalid');
  deliver({...event, jsonrpc: '1.0'});
  deliver(event);
  assert.deepEqual(seen, [event.method]);
  assert.throws(() => connection.tool('app_kernel_overview'), /kernel controls/);
  assert.throws(() => connection.sendText('message', 'ui/message', 'sample'), /text/);
  assert.equal(sent.length, 2);
  const other = panelHost(view, () => {});
  const incompatible = other.initialize();
  deliver({jsonrpc: '2.0', id: sent.at(-1).msg.id, result: {...result, protocolVersion: 'unsupported'}});
  await assert.rejects(incompatible, /protocol version/);
  for (const frame of [{}, {parent: null}]) {
    frame.addEventListener = () => {};
    if (!('parent' in frame)) frame.parent = frame;
    await assert.rejects(panelHost(frame, () => {}).initialize(), /inside an MCP Apps host/);
  }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(["node", "-"], input=bridge + checks, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
