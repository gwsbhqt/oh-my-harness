"""Exercise the MCP App resource, its real kernel tools, and the iframe transport."""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp.shared.memory import create_connected_server_and_client_session

from agy_python_repl import server, session_routing
from agy_python_repl.manager import KernelManager

PANEL = Path(__file__).resolve().parents[1] / "ui" / "panel.html"


class PanelTests(unittest.IsolatedAsyncioTestCase):
    async def test_registered_panel_and_real_kernel_actions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            skill = root / "skills" / "fixture-reader"
            package = skill / "src" / "fixture_reader"
            package.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: fixture-reader\ndescription: Fixture\n---\n")
            (package / "__init__.py").write_text("import fixture_dependency")
            manager = KernelManager(data_dir=root / "data", skill_roots=[skill.parent], project_skill_roots=[])
            with patch.object(server, "_manager", manager):
                async with create_connected_server_and_client_session(server.mcp) as client:
                    tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                    for name in ("kernel_state", "app_kernel_action"):
                        self.assertIn("restart", tools[name].inputSchema["properties"]["action"]["enum"])
                    entry = tools["open_kernel_panel"].meta
                    uri = entry["ui"]["resourceUri"]
                    self.assertEqual(entry["com.google.antigravity/ui"]["entrypoints"][0]["type"], "aux_pane")
                    for name in ("app_kernel_overview", "app_kernel_action"):
                        self.assertEqual(tools[name].meta["ui"]["visibility"], ["app"])
                    resource, = (await client.read_resource(uri)).contents
                    self.assertEqual(resource.mimeType, "text/html;profile=mcp-app")
                    self.assertEqual(resource.text, PANEL.read_text(encoding="utf-8"))

                    async def call(name, **args):
                        if name in ("run_code", "kernel_state") and "kernel" in args:
                            target_kernel = args.pop("kernel")
                            session_routing.enqueue_call(manager.data_dir, name, args, target_kernel)
                        reply = await client.call_tool(name, args)
                        self.assertFalse(reply.isError, reply.content)
                        return reply.structuredContent

                    code = 'sample = "<mark> & text"'
                    await call("run_code", kernel="sample", cwd=folder, code=code)
                    overview = await call("app_kernel_overview")
                    self.assertEqual(await call("open_kernel_panel"), overview)
                    initial_kernel = overview["kernels"][0]
                    self.assertEqual(initial_kernel["name"], "sample")
                    self.assertIn("fixture_dependency", initial_kernel["skills_failed"]["fixture_reader"])
                    self.assertEqual(overview["history"][0]["code_preview"], code)
                    (skill / "src" / "fixture_dependency.py").touch()
                    await call("run_code", kernel="sample", code="await skills.retry('fixture-reader')")
                    refreshed = (await call("app_kernel_overview"))["kernels"][0]
                    self.assertIn("fixture_reader", refreshed["skills_loaded"])
                    self.assertNotIn("skills_failed", refreshed)
                    for action, field in (("vars", "names"), ("snapshot", "saved"), ("restore", "restored")):
                        result = await call("app_kernel_action", kernel="sample", action=action)
                        self.assertIn("sample", result[field])
                    stopped = await call("kernel_state", kernel="inactive", action="restart")
                    self.assertEqual(stopped["status"], "error")
                    self.assertFalse(stopped["original_kept"])
                    await call("run_code", kernel="sample", code="blocked = (x for x in [7])")
                    refused = await call("app_kernel_action", kernel="sample", action="restart")
                    self.assertEqual(refused["status"], "error")
                    self.assertTrue(refused["original_kept"])
                    self.assertIn("blocked", [item["name"] for item in refused["skipped"]])
                    self.assertEqual((await call("run_code", kernel="sample", code="next(blocked)"))["result"], "7")
                    await call("run_code", kernel="sample", code="del blocked\nprevious_pid = os.getpid()")
                    restarted = await call("app_kernel_action", kernel="sample", action="restart")
                    self.assertEqual(restarted["status"], "ok")
                    self.assertIn("sample", restarted["restored"])
                    checked = await call("run_code", kernel="sample", code="(previous_pid != os.getpid(), sample)")
                    self.assertEqual(checked["result"], str((True, "<mark> & text")))
                    await call("app_kernel_action", kernel="sample", action="reset")
                    self.assertEqual((await call("app_kernel_overview"))["kernels"], [])

    @unittest.skipUnless(shutil.which("node"), "Node.js runs the panel's kernel card renderer")
    def test_kernel_card_shows_loaded_skills_and_bounds_each_failure(self):
        html = PANEL.read_text(encoding="utf-8")
        renderer = re.search(r"    function kernelCard\(kernel\) \{.*?\n    \}", html, re.S)[0]
        checks = r"""
const assert = require('node:assert/strict');
const host = {supports: () => false};
function element(tag, text) {
  return {text, children: [], append(...nodes) { this.children.push(...nodes); }};
}
const kernel = {name: 'fixture', alive: true, python: '3', skills_loaded: ['ready']};
const failed = kernelCard({...kernel, skills_failed: {reader: 'x'.repeat(250)}});
assert.equal(failed.children[1].text, 'Loaded skills: ready');
assert.equal(failed.children[2].text, 'Failed to import reader: ' + 'x'.repeat(199) + '…');
const recovered = kernelCard({...kernel, skills_loaded: ['reader', 'ready']});
assert.equal(recovered.children[1].text, 'Loaded skills: reader, ready');
assert.equal(recovered.children.length, 2);
"""
        result = subprocess.run(["node", "-"], input=renderer + checks, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js runs the panel's restart control")
    def test_restart_button_reports_only_the_selected_kernels_completed_restart(self):
        html = PANEL.read_text(encoding="utf-8")
        functions = [re.search(rf"    function {name}\(.*?\n    \}}", html, re.S)[0]
                     for name in ("restartMessage", "kernelCard")]
        checks = r"""
const assert = require('node:assert/strict');
let reply, request;
const busy = new Set(), status = {};
const host = {supports: () => true, tool: async (...args) => { request = args; return reply; }};
const byId = () => status, unpack = value => value, refresh = async () => {};
function element(tag, text) {
  return {text, dataset: {}, children: [], append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}};
}
function button(label, click) { return {...element('button', label), click}; }
function controls(alive) {
  const card = kernelCard({name: 'analysis', alive, python: '3', skills_loaded: []});
  return card.children.at(-2).children;
}
async function check() {
  assert.equal(controls(false).some(control => control.text === 'Restart'), false);
  const restart = controls(true).find(control => control.text === 'Restart');
  reply = {kernel: 'analysis', status: 'ok', restored: ['rows', 'total']};
  await restart.click();
  assert.deepEqual(request, ['app_kernel_action', {action: 'restart', kernel: 'analysis'}]);
  assert.match(status.textContent, /Restarted analysis.*2 variables/);
  assert.equal(restartMessage("analysis", {...reply, restored: ["rows"]}), "Restarted analysis. Restored 1 variable.");
  for (const field of ['skipped', 'failed']) {
    reply = {kernel: 'analysis', status: 'error', original_kept: true, error: 'Restart stopped.',
             [field]: [{name: 'unfinished', reason: 'fixture reason'}]};
    await assert.rejects(restart.click(), /Restart stopped.*original kernel is still running.*unfinished.*fixture reason/);
    assert.equal(status.textContent, '');
  }
  reply = {kernel: 'analysis', status: 'partial', failed: [{name: 'rows', reason: 'missing'}]};
  await assert.rejects(restart.click(), /complete restart.*rows.*missing/);
  reply = {kernel: 'analysis', status: 'accepted'};
  await assert.rejects(restart.click(), /confirm a complete restart/);
}
check().catch(error => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(["node", "-"], input="\n".join(functions) + checks, text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

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
