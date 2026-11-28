"""Contract and integration tests for the Antigravity App Sidecar bridge and agy-use App client."""
from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SKILL = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = SKILL.parents[1]
BRIDGE_PATH = PLUGIN_ROOT / "sidecars" / "app-bridge" / "bridge.py"
sys.path.insert(0, str(SKILL / "src"))
import agy_use  # noqa: E402


def _load_bridge_module():
    spec = importlib.util.spec_from_file_location("agy_app_bridge", BRIDGE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FAKE_AGENTAPI = r"""
import json, os, sys, time
from pathlib import Path

state_dir = Path(os.environ["FAKE_STATE_DIR"])
log_path = state_dir / "agentapi_calls.jsonl"
with log_path.open("a", encoding="utf-8") as fh:
    fh.write(json.dumps({"args": sys.argv[1:], "csrf": os.environ.get("ANTIGRAVITY_CSRF_TOKEN")}) + "\n")

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "get-conversation-metadata":
    cid = sys.argv[2]
    print(json.dumps({"response": {"conversationMetadata": {"metadata": {"rootConversationId": cid}}}}))
    sys.exit(0)
if cmd == "send-message":
    args = sys.argv[2:]
    title = None
    while args and args[0].startswith("--"):
        if args[0] == "--":
            args = args[1:]
            break
        if args[0].startswith("--title="):
            title = args[0].split("=", 1)[1]
        args = args[1:]
    cid, content = args[0], args[1]
    if content == "SLEEP":
        time.sleep(1.5)
    mode = os.environ.get("FAKE_SEND_MODE", "fast")
    convs_file = state_dir / "convs.json"
    convs = json.loads(convs_file.read_text(encoding="utf-8"))
    if cid in convs:
        logs = Path(os.environ["ANTIGRAVITY_APP_DATA_DIR"]) / "brain" / cid / ".system_generated" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        tfile = logs / "transcript.jsonl"
        existing = [json.loads(l) for l in tfile.read_text(encoding="utf-8").splitlines() if l.strip()] if tfile.exists() else []
        next_idx = (existing[-1]["step_index"] + 1) if existing else 0
        steps = list(existing)
        wrapped = (
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user. "
            "It is provided by the system as important information to pay attention to.\n\n"
            "<SYSTEM_MESSAGE>\n"
            f"[Message] timestamp=2026-01-01T00:00:05Z sender=peer priority=MESSAGE_PRIORITY_HIGH content={content}\n"
            "</SYSTEM_MESSAGE>"
        )
        if mode == "unrelated_only":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped.replace(content, "UNRELATED_MSG")})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": "UNRELATED_REPLY"})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "tool_then_reply":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "model": "demo-model",
                          "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a"}}]})
            convs[cid]["state"]["runState"] = "RUN_STATE_RUNNING"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:05Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
            import subprocess
            subprocess.Popen([sys.executable, "-c", (
                f"import json, time; from pathlib import Path; time.sleep(0.25); "
                f"cf=Path({str(convs_file)!r}); c=json.loads(cf.read_text()); "
                f"c[{cid!r}]['state']['runState']='RUN_STATE_IDLE'; c[{cid!r}]['state']['updateTime']='2026-01-01T00:00:06Z'; "
                f"cf.write_text(json.dumps(c)); "
                f"tf=Path({str(tfile)!r}); "
                f"tf.open('a').write("
                f"json.dumps({{'step_index': {next_idx + 2}, 'source': 'MODEL', 'type': 'GENERIC', 'status': 'DONE', 'content': 'ok'}})+'\\n'+"
                f"json.dumps({{'step_index': {next_idx + 3}, 'source': 'MODEL', 'type': 'PLANNER_RESPONSE', 'status': 'DONE', 'model': 'demo-model', 'content': {('ECHO:' + content)!r}}})+'\\n')"
            )])
        elif mode == "cancelled_tool_only":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "model": "demo-model",
                          "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a"}}]})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "empty_reply":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": "   "})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "duplicate_same_body":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": f"ECHO:{content}"})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "unrelated_before_and_after":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped.replace(content, "BEFORE_MSG")})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "model": "demo-model", "content": "BEFORE_REPLY"})
            steps.append({"step_index": next_idx + 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "content": wrapped})
            steps.append({"step_index": next_idx + 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": f"ECHO:{content}"})
            steps.append({"step_index": next_idx + 4, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:07Z", "content": wrapped.replace(content, "AFTER_MSG")})
            steps.append({"step_index": next_idx + 5, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:07Z", "model": "demo-model", "content": "AFTER_REPLY"})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:07Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "truncated_long":
            full_steps = list(steps)
            short_wrap = wrapped[:120] + "...(truncated)"
            full_reply = "LONG_REPLY:" + content
            short_reply = full_reply[:80] + "...(truncated)"
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": short_wrap, "truncated_fields": ["content"]})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": short_reply,
                          "truncated_fields": ["content"]})
            full_steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                               "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            full_steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                               "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": full_reply})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
            (logs / "transcript_full.jsonl").write_text("\n".join(json.dumps(s) for s in full_steps) + "\n", encoding="utf-8")
        elif mode == "delayed":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            convs[cid]["state"]["runState"] = "RUN_STATE_RUNNING"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:05Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
            import subprocess
            subprocess.Popen([sys.executable, "-c", (
                f"import json, time; from pathlib import Path; time.sleep(0.25); "
                f"cf=Path({str(convs_file)!r}); c=json.loads(cf.read_text()); "
                f"c[{cid!r}]['state']['runState']='RUN_STATE_IDLE'; c[{cid!r}]['state']['updateTime']='2026-01-01T00:00:06Z'; "
                f"cf.write_text(json.dumps(c)); "
                f"tf=Path({str(tfile)!r}); "
                f"tf.open('a').write(json.dumps({{'step_index': {next_idx + 1}, 'source': 'MODEL', 'type': 'PLANNER_RESPONSE', 'status': 'DONE', 'created_at': '2026-01-01T00:00:06Z', 'model': 'demo-model', 'content': {('ECHO:' + content)!r}}})+'\\n')"
            )])
        elif mode == "stays_running":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            convs[cid]["state"]["runState"] = "RUN_STATE_RUNNING"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:05Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        else:
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            if mode == "background_progress":
                steps.append({"step_index": next_idx + 1, "type": "SYSTEM_MESSAGE", "source": "SYSTEM",
                              "content": "<SYSTEM_MESSAGE>\nKeep working with the available inputs.\n</SYSTEM_MESSAGE>"})
                steps.append({"step_index": next_idx + 2, "type": "SYSTEM_MESSAGE", "source": "SYSTEM",
                              "content": wrapped.replace("sender=peer", f"sender={cid}/task-12").replace(content, "Task completed.")})
            steps.append({"step_index": steps[-1]["step_index"] + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "model": "demo-model", "content": f"ECHO:{content}"})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
    recipient = "unexpected-id" if mode == "wrong-receipt" else cid
    print(json.dumps({"response": {"sendMessage": {"recipientId": recipient, "content": content, "title": title}}}))
    sys.exit(0)
sys.exit(2)
"""


class SkillInterfaceTests(unittest.TestCase):
    def test_desktop_actions_are_available_from_python_and_the_launcher(self) -> None:
        help_text = subprocess.check_output(
            [sys.executable, str(SKILL / "scripts/agy-use"), "--help"], text=True
        )
        actions = set(agy_use.__all__)
        self.assertTrue({"sessions", "get", "send", "wait", "read"} <= actions)
        self.assertEqual(set(re.findall(r"^    ([\w-]+)\s", help_text, re.MULTILINE)), actions)
        self.assertFalse(any(name.startswith("cli_") for name in dir(agy_use)))


class AppBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        # Keep socket path well under macOS 104-byte sun_path limit.
        self.tmpdir = tempfile.TemporaryDirectory(dir="/tmp", prefix="agybr-")
        self.addCleanup(self.tmpdir.cleanup)
        self.root = Path(self.tmpdir.name).resolve()
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.app_data = self.root / "app_data"
        self.app_data.mkdir()
        self.sock_path = self.root / "bridge.sock"
        self.convs_file = self.state_dir / "convs.json"

        self.seed_conversations()
        self._start_fake_ls()
        self._install_fake_agentapi()

    def seed_conversations(self) -> None:
        convs = {
            "11111111-aaaa-0000-0000-000000000001": {
                "id": "11111111-aaaa-0000-0000-000000000001",
                "metadata": {"createTime": "2026-01-01T00:00:01Z", "projectId": "proj-1",
                             "rootConversationId": "11111111-aaaa-0000-0000-000000000001"},
                "annotations": {"title": "Alpha Review", "archived": False},
                "state": {"summary": "First task", "runState": "RUN_STATE_IDLE", "updateTime": "2026-01-01T00:00:02Z"},
            },
            "11112222-bbbb-0000-0000-000000000002": {
                "id": "11112222-bbbb-0000-0000-000000000002",
                "metadata": {"createTime": "2026-01-01T00:00:02Z", "projectId": "proj-1",
                             "rootConversationId": "11112222-bbbb-0000-0000-000000000002"},
                "annotations": {"title": "Beta Build", "archived": False},
                "state": {"summary": "Second task", "runState": "RUN_STATE_IDLE", "updateTime": "2026-01-01T00:00:03Z"},
            },
            "33333333-cccc-0000-0000-000000000003": {
                "id": "33333333-cccc-0000-0000-000000000003",
                "metadata": {"createTime": "2026-01-01T00:00:00Z", "projectId": "proj-2",
                             "rootConversationId": "33333333-cccc-0000-0000-000000000003"},
                "annotations": {"title": "Archived Task", "archived": True},
                "state": {"summary": "Old archive", "runState": "RUN_STATE_IDLE", "updateTime": "2026-01-01T00:00:01Z"},
            },
        }
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")
        logs = self.app_data / "brain" / "11112222-bbbb-0000-0000-000000000002" / ".system_generated" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "transcript_full.jsonl").unlink(missing_ok=True)
        (logs / "transcript.jsonl").write_text(
            "\n".join([
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
                            "created_at": "2026-01-01T00:00:02Z", "content": "hi"}),
                json.dumps({"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "created_at": "2026-01-01T00:00:03Z", "model": "demo-model", "content": "INITIAL_REPLY"}),
            ]) + "\n",
            encoding="utf-8",
        )

    def _start_fake_ls(self) -> None:
        convs_file = self.convs_file
        app_data = self.app_data
        expected_csrf = "secret-csrf-token"

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):  # noqa: A002
                pass

            def do_POST(self):
                if self.headers.get("x-antigravity-csrf-token") != expected_csrf:
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b'{"message":"invalid csrf"}')
                    return
                length = int(self.headers.get("Content-Length") or "0")
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                method = self.path.rsplit("/", 1)[-1]
                convs = json.loads(convs_file.read_text(encoding="utf-8"))

                if method == "ListConversations":
                    include_archived = bool(body.get("includeArchived", False))
                    items = [
                        c for c in convs.values()
                        if (include_archived or not c["annotations"].get("archived"))
                        and (not body.get("projectId") or c["metadata"].get("projectId") == body["projectId"])
                    ]
                    page_size = int(body.get("pageSize") or 20)
                    offset = int(body.get("pageToken") or 0)
                    batch = items[offset: offset + page_size]
                    next_tok = str(offset + page_size) if offset + page_size < len(items) else ""
                    resp = {"conversations": batch}
                    if next_tok:
                        resp["nextPageToken"] = next_tok
                    self._json(200, resp)
                elif method == "GetConversation":
                    cid = body.get("conversationId", "")
                    if cid not in convs:
                        self._json(404, {"message": f"not found: {cid}"})
                        return
                    self._json(200, convs[cid])
                elif method == "CreateConversation":
                    cid = "44444444-dddd-0000-0000-000000000004"
                    prompt_items = body.get("prompt") or []
                    prompt_text = prompt_items[0].get("text", "") if prompt_items else ""
                    conv = {
                        "id": cid,
                        "metadata": {"createTime": "2026-01-01T00:00:10Z",
                                     "projectId": body.get("projectId") or "proj-1",
                                     "rootConversationId": cid},
                        "annotations": {"title": body.get("title") or "", "tags": body.get("tags") or []},
                        "state": {"summary": prompt_text, "runState": "RUN_STATE_IDLE", "updateTime": "2026-01-01T00:00:10Z"},
                    }
                    convs[cid] = conv
                    convs_file.write_text(json.dumps(convs), encoding="utf-8")
                    if prompt_text:
                        logs = app_data / "brain" / cid / ".system_generated" / "logs"
                        logs.mkdir(parents=True, exist_ok=True)
                        (logs / "transcript.jsonl").write_text(
                            "\n".join([
                                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT",
                                            "status": "DONE", "content": prompt_text}),
                                json.dumps({"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE",
                                            "status": "DONE", "model": body.get("model") or "flash",
                                            "content": f"CREATED:{prompt_text}"}),
                            ]) + "\n",
                            encoding="utf-8",
                        )
                    self._json(200, {"conversation": conv})
                elif method == "UpdateConversation":
                    cid = body.get("conversationId", "")
                    if cid not in convs:
                        self._json(404, {"message": "not found"})
                        return
                    convs[cid]["annotations"].update(body.get("annotations") or {})
                    convs_file.write_text(json.dumps(convs), encoding="utf-8")
                    self._json(200, convs[cid])
                elif method == "DeleteConversation":
                    cid = body.get("conversationId", "")
                    if cid not in convs:
                        self._json(404, {"message": "not found"})
                        return
                    del convs[cid]
                    convs_file.write_text(json.dumps(convs), encoding="utf-8")
                    self._json(200, {})
                else:
                    self._json(404, {"message": "unknown method"})

            def _json(self, code: int, payload: dict):
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.ls_address = f"127.0.0.1:{self.httpd.server_address[1]}"
        self.http_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.http_thread.start()
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(self.httpd.server_close)

    def _install_fake_agentapi(self) -> None:
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        script = self.root / "fake_agentapi.py"
        script.write_text(FAKE_AGENTAPI, encoding="utf-8")
        wrapper = self.bin_dir / "agentapi"
        wrapper.write_text(f"#!/bin/sh\nexec {shlex.join([sys.executable, str(script)])} \"$@\"\n", encoding="utf-8")
        wrapper.chmod(0o755)

    async def _start_bridge(self, *, extra_env: dict[str, str] | None = None):
        env = {
            **os.environ,
            "AGY_USE_SOCKET": str(self.sock_path),
            "ANTIGRAVITY_LS_ADDRESS": self.ls_address,
            "ANTIGRAVITY_CSRF_TOKEN": "secret-csrf-token",
            "ANTIGRAVITY_APP_DATA_DIR": str(self.app_data),
            "ANTIGRAVITY_PROJECT_ID": "proj-1",
            "FAKE_STATE_DIR": str(self.state_dir),
            "PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"],
            **(extra_env or {}),
        }
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(BRIDGE_PATH),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def cleanup():
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()

        self.addAsyncCleanup(cleanup)
        async with asyncio.timeout(5):
            while not self.sock_path.exists():
                if proc.returncode is not None:
                    out, err = await proc.communicate()
                    self.fail(f"bridge exited early ({proc.returncode}): {out} {err}")
                await asyncio.sleep(0.02)
        return proc

    def _agentapi_calls(self) -> list[dict]:
        log_path = self.state_dir / "agentapi_calls.jsonl"
        if not log_path.exists():
            return []
        return [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    async def test_health_and_secret_hygiene(self) -> None:
        down = await agy_use.health(socket_path=self.sock_path)
        self.assertFalse(down["ok"])
        self.assertEqual(down["error_code"], "sidecar-unavailable")

        cli_down = subprocess.run(
            [sys.executable, str(SKILL / "scripts/agy-use"), "health", "--socket", str(self.sock_path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_down.returncode, 69)

        await self._start_bridge()
        up = await agy_use.health(socket_path=self.sock_path)
        self.assertTrue(up["ok"], up)
        self.assertEqual(up["transport"], "sidecar")
        self.assertTrue(up["ls_reachable"])
        self.assertTrue(up["agentapi_available"])
        self.assertNotIn("secret-csrf-token", json.dumps(up))
        meta = json.loads(self.sock_path.with_suffix(".json").read_text(encoding="utf-8"))
        self.assertNotIn("secret-csrf-token", json.dumps(meta))

    async def test_sessions_pagination_query_and_target_resolution(self) -> None:
        await self._start_bridge()
        all_active = await agy_use.sessions(limit=0, socket_path=self.sock_path)
        self.assertTrue(all_active["ok"])
        self.assertEqual(len(all_active["sessions"]), 2)

        filtered = await agy_use.sessions(query="Archived", include_archived=True, socket_path=self.sock_path)
        self.assertEqual([s["id"] for s in filtered["sessions"]], ["33333333-cccc-0000-0000-000000000003"])

        prefix = await agy_use.get("11112222", socket_path=self.sock_path)
        self.assertTrue(prefix["ok"])
        self.assertEqual(prefix["conversation_id"], "11112222-bbbb-0000-0000-000000000002")
        self.assertEqual(prefix["transcript"]["last_response_preview"], "INITIAL_REPLY")

        ambiguous = await agy_use.get("1111", socket_path=self.sock_path)
        self.assertFalse(ambiguous["ok"])
        self.assertEqual(ambiguous["error_code"], "ambiguous-target")
        self.assertEqual(len(ambiguous["candidates"]), 2)

        too_short = await agy_use.get("111", socket_path=self.sock_path)
        self.assertFalse(too_short["ok"])
        self.assertEqual(too_short["error_code"], "target-not-found")

    async def test_send_verifies_target_first_and_waits_for_fast_and_delayed_turns(self) -> None:
        await self._start_bridge(extra_env={"FAKE_SEND_MODE": "delayed"})
        missing = await agy_use.send("99999999", "hello", socket_path=self.sock_path)
        self.assertFalse(missing["ok"])
        self.assertFalse(missing["sent"])
        self.assertEqual(missing["error_code"], "target-not-found")
        self.assertEqual(self._agentapi_calls(), [])

        sent = await agy_use.send(
            "11112222",
            "-leading-dash prompt",
            title="sync",
            wait=True,
            timeout=10,
            poll_interval=0.05,
            socket_path=self.sock_path,
        )
        self.assertTrue(sent["ok"], sent)
        self.assertTrue(sent["sent"])
        self.assertEqual(sent["status"], "completed")
        self.assertEqual(sent["conversation_id"], "11112222-bbbb-0000-0000-000000000002")
        self.assertEqual(sent["response"], "ECHO:-leading-dash prompt")
        self.assertEqual(sent["receipt"]["since_step"], 1)
        self.assertEqual([e["type"] for e in sent["events"]], ["SYSTEM_MESSAGE", "PLANNER_RESPONSE"])
        calls = self._agentapi_calls()
        self.assertEqual(calls[0]["args"], ["send-message", "--title=sync", "--",
                                            "11112222-bbbb-0000-0000-000000000002", "-leading-dash prompt"])

    async def test_send_wait_timeout_preserves_receipt_and_no_auto_retry(self) -> None:
        await self._start_bridge(extra_env={"FAKE_SEND_MODE": "stays_running"})
        res = await agy_use.send(
            "11112222",
            "stay running",
            wait=True,
            timeout=0.2,
            poll_interval=0.05,
            socket_path=self.sock_path,
        )
        self.assertFalse(res["ok"])
        self.assertTrue(res["timed_out"])
        self.assertTrue(res["sent"])
        self.assertEqual(res["receipt"]["since_step"], 1)
        self.assertEqual(res["run_state"], "RUN_STATE_RUNNING")
        self.assertEqual(len(self._agentapi_calls()), 1)

    async def test_send_bridge_timeout_marks_uncertain_without_retry(self) -> None:
        await self._start_bridge()
        res = await agy_use.send(
            "11112222",
            "SLEEP",
            timeout=0.5,
            socket_path=self.sock_path,
        )
        self.assertFalse(res["ok"])
        self.assertTrue(res["timed_out"])
        self.assertTrue(res["uncertain"])
        self.assertIsNone(res["sent"])
        self.assertIn(res["error_code"], ("bridge-timeout", "agentapi-timeout"))
        # Wait briefly for fake agentapi to finish or log its single invocation.
        await asyncio.sleep(0.2)
        self.assertEqual(len(self._agentapi_calls()), 1)

    async def test_new_read_last_update_rename_archive_delete_and_cli(self) -> None:
        await self._start_bridge()
        created = await agy_use.new("hello new", title="Fresh", model="flash", wait=True,
                                    timeout=5, poll_interval=0.05, socket_path=self.sock_path)
        self.assertTrue(created["ok"], created)
        self.assertEqual(created["response"], "CREATED:hello new")
        cid = created["conversation_id"]

        read_res = await agy_use.read(cid, from_step=0, limit=1, socket_path=self.sock_path)
        self.assertTrue(read_res["has_more"])
        self.assertEqual(len(read_res["steps"]), 1)

        last_res = await agy_use.last(cid, chars=7, socket_path=self.sock_path)
        self.assertEqual(last_res["response"], "CREATED")
        self.assertTrue(last_res["truncated"])

        cli_rename = subprocess.run(
            [sys.executable, str(SKILL / "scripts/agy-use"), "rename", cid[:8], "Renamed Title",
             "--socket", str(self.sock_path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_rename.returncode, 0, cli_rename.stderr)
        self.assertEqual(json.loads(cli_rename.stdout)["conversation"]["custom_title"], "Renamed Title")

        archived = await agy_use.archive(cid[:8], socket_path=self.sock_path)
        self.assertTrue(archived["conversation"]["archived"])

        deleted = await agy_use.delete(cid[:8], socket_path=self.sock_path)
        self.assertTrue(deleted["ok"])
        self.assertTrue(deleted["deleted"])

    async def test_wait_cancellation_preserves_receipt_and_transcript_blocks_traversal(self) -> None:
        await self._start_bridge(extra_env={"FAKE_SEND_MODE": "stays_running"})
        await agy_use.send("11112222", "hang", socket_path=self.sock_path)
        task = asyncio.create_task(agy_use.wait("11112222", since_step=1, timeout=10,
                                                poll_interval=0.05, socket_path=self.sock_path))
        await asyncio.sleep(0.15)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught:
            await task
        self.assertTrue(caught.exception.receipt["cancelled"])
        self.assertEqual(caught.exception.receipt["conversation_id"], "11112222-bbbb-0000-0000-000000000002")

        mod = _load_bridge_module()
        with patch.dict(os.environ, {"ANTIGRAVITY_APP_DATA_DIR": str(self.app_data)}):
            bad = mod._read_transcript_sync("../etc/passwd", False)
            self.assertFalse(bad["ok"])
            self.assertEqual(bad["error_code"], "invalid-argument")

    async def test_large_transcript_exceeding_64kib_reads_cleanly(self) -> None:
        await self._start_bridge()
        cid = "11112222-bbbb-0000-0000-000000000002"
        tfile = self.app_data / "brain" / cid / ".system_generated" / "logs" / "transcript.jsonl"
        big_text = "A" * 150000
        tfile.write_text(
            "\n".join([
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "content": "big"}),
                json.dumps({"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": big_text}),
            ]) + "\n",
            encoding="utf-8",
        )
        got = await agy_use.get("11112222", socket_path=self.sock_path)
        self.assertTrue(got["ok"], got)
        self.assertEqual(len(got["transcript"]["last_response_preview"]), 400)
        read_res = await agy_use.read("11112222", limit=0, socket_path=self.sock_path)
        self.assertTrue(read_res["ok"], read_res)
        self.assertEqual(len(read_res["steps"][1]["content"]), 150000)
        last_res = await agy_use.last("11112222", chars=0, socket_path=self.sock_path)
        self.assertTrue(last_res["ok"], last_res)
        self.assertEqual(len(last_res["response"]), 150000)

    async def test_send_wait_ignores_tool_calls_and_unrelated_inputs_and_isolates_reply(self) -> None:
        await self._start_bridge(extra_env={"FAKE_SEND_MODE": "tool_then_reply"})
        res = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "tool task",
            wait=True,
            timeout=5,
            poll_interval=0.05,
            socket_path=self.sock_path,
        )
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["response"], "ECHO:tool task")
        self.assertEqual(res["receipt_step_index"], 2)
        self.assertEqual(res["reply_step_index"], 5)

    async def _start_bridge_with_new_socket(self, mode: str) -> Path:
        sock = self.root / f"{mode}.sock"
        env = {
            **os.environ,
            "AGY_USE_SOCKET": str(sock),
            "ANTIGRAVITY_LS_ADDRESS": self.ls_address,
            "ANTIGRAVITY_CSRF_TOKEN": "secret-csrf-token",
            "ANTIGRAVITY_APP_DATA_DIR": str(self.app_data),
            "ANTIGRAVITY_PROJECT_ID": "proj-1",
            "FAKE_STATE_DIR": str(self.state_dir),
            "FAKE_SEND_MODE": mode,
            "PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"],
        }
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(BRIDGE_PATH), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )

        async def cleanup():
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()

        self.addAsyncCleanup(cleanup)
        async with asyncio.timeout(5):
            while not sock.exists():
                await asyncio.sleep(0.02)
        return sock

    async def test_send_wait_rejects_unrelated_only_cancelled_empty_and_duplicate_bodies(self) -> None:
        # 1. Unrelated message + reply while IDLE must NOT confirm our send; times out keeping receipt.
        sock_unrel = await self._start_bridge_with_new_socket("unrelated_only")
        unrel = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "MY_PROMPT",
            wait=True,
            timeout=0.3,
            poll_interval=0.05,
            socket_path=sock_unrel,
        )
        self.assertFalse(unrel["ok"])
        self.assertTrue(unrel["timed_out"])
        self.assertTrue(unrel["sent"])
        self.assertEqual(unrel["receipt"]["prompt"], "MY_PROMPT")
        self.assertEqual(len(self._agentapi_calls()), 1)

        # 2. Unrelated messages before AND after our receipt: extracts only our reply.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_scoped = await self._start_bridge_with_new_socket("unrelated_before_and_after")
        scoped = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "SCOPED_MSG",
            wait=True,
            timeout=5,
            poll_interval=0.05,
            socket_path=sock_scoped,
        )
        self.assertTrue(scoped["ok"], scoped)
        self.assertEqual(scoped["response"], "ECHO:SCOPED_MSG")

        # 3. Cancelled turn with only tool_calls and no final PLANNER_RESPONSE -> cancelled-without-response.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_cancel = await self._start_bridge_with_new_socket("cancelled_tool_only")
        cancelled = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "ABORT_ME",
            wait=True,
            timeout=3,
            poll_interval=0.05,
            socket_path=sock_cancel,
        )
        self.assertFalse(cancelled["ok"])
        self.assertFalse(cancelled["timed_out"])
        self.assertTrue(cancelled["sent"])
        self.assertEqual(cancelled["error_code"], "cancelled-without-response")
        self.assertEqual(cancelled["receipt"]["prompt"], "ABORT_ME")
        self.assertEqual(len(self._agentapi_calls()), 1)

        # 4. Empty final PLANNER_RESPONSE -> empty-response, preserves receipt, no retry.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_empty = await self._start_bridge_with_new_socket("empty_reply")
        empty = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "EMPTY_ME",
            wait=True,
            timeout=3,
            poll_interval=0.05,
            socket_path=sock_empty,
        )
        self.assertFalse(empty["ok"])
        self.assertTrue(empty["sent"])
        self.assertEqual(empty["error_code"], "empty-response")
        self.assertEqual(empty["receipt"]["prompt"], "EMPTY_ME")
        self.assertEqual(len(self._agentapi_calls()), 1)

        # 5. Concurrent duplicate identical prompt bodies -> ambiguous-reply, preserves receipt, no retry.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_dup = await self._start_bridge_with_new_socket("duplicate_same_body")
        dup = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            "DUP_BODY",
            wait=True,
            timeout=3,
            poll_interval=0.05,
            socket_path=sock_dup,
        )
        self.assertFalse(dup["ok"])
        self.assertTrue(dup["sent"])
        self.assertEqual(dup["error_code"], "ambiguous-reply")
        self.assertEqual(dup["matching_receipt_steps"], [2, 3])
        self.assertEqual(len(self._agentapi_calls()), 1)

    async def test_inbox_reply_survives_background_progress_and_requires_matching_ack(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        progress = await self._start_bridge_with_new_socket("background_progress")
        sent = await agy_use.send(target, "Review both files", socket_path=progress, wait=True, timeout=5)
        self.assertTrue(sent["ok"], sent)
        self.assertEqual(sent["reply_step_index"], sent["receipt_step_index"] + 3)
        self.assertEqual(sent["response"], "ECHO:Review both files")
        wrong = await self._start_bridge_with_new_socket("wrong-receipt")
        uncertain = await agy_use.send(target, "confirm receipt", socket_path=wrong, wait=True, timeout=5)
        self.assertFalse(uncertain["ok"])
        self.assertEqual(uncertain["error_code"], "unconfirmed-delivery")
        self.assertTrue(uncertain["uncertain"])
        self.assertIsNone(uncertain["sent"])

    async def test_truncated_long_transcript_falls_back_to_full_transcript(self) -> None:
        sock = await self._start_bridge_with_new_socket("truncated_long")
        long_prompt = "P" * 90000
        res = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002",
            long_prompt,
            wait=True,
            timeout=5,
            poll_interval=0.05,
            socket_path=sock,
        )
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["response"], "LONG_REPLY:" + long_prompt)
        last_res = await agy_use.last("11112222-bbbb-0000-0000-000000000002", chars=0, socket_path=sock)
        self.assertTrue(last_res["ok"], last_res)
        self.assertEqual(last_res["response"], "LONG_REPLY:" + long_prompt)

    async def test_incomplete_prefix_scan_refuses_uniqueness_while_full_uuid_checks_directly(self) -> None:
        await self._start_bridge()
        real_call = agy_use._client.call_bridge

        async def partial_scan(op, params=None, *, socket_path=None, timeout=15.0):
            res = await real_call(op, params, socket_path=socket_path, timeout=timeout)
            if op == "list_conversations":
                res["conversations"] = [c for c in res["conversations"] if c["id"].startswith("11112222")]
                res["next_page_token"] = "more-pages-unscanned"
            return res

        with patch("agy_use._client.call_bridge", side_effect=partial_scan):
            # Incomplete prefix scan finds 1 match, yet MUST refuse to declare it unique.
            pref = await agy_use.get("11112222", socket_path=self.sock_path)
            self.assertFalse(pref["ok"])
            self.assertEqual(pref["error_code"], "incomplete-prefix-scan")
            self.assertTrue(pref["scan_incomplete"])

            # Full UUID bypasses list scan and verifies directly via GetConversation.
            full = await agy_use.get("11112222-bbbb-0000-0000-000000000002", socket_path=self.sock_path)
            self.assertTrue(full["ok"], full)
            self.assertEqual(full["conversation_id"], "11112222-bbbb-0000-0000-000000000002")

            # Missing full UUID fails directly with target-not-found without scanning.
            missing = await agy_use.get("99999999-9999-9999-9999-999999999999", socket_path=self.sock_path)
            self.assertFalse(missing["ok"])
            self.assertEqual(missing["error_code"], "target-not-found")

    def test_skill_and_pyskill_are_isomorphic_and_sidecar_valid(self) -> None:
        def skeleton(text: str) -> str:
            return re.sub(r"```[^\n]*\n.*?```", "```CODE```", text, flags=re.DOTALL)

        s_doc = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        p_doc = (SKILL / "PYSKILL.md").read_text(encoding="utf-8")
        self.assertEqual(skeleton(s_doc), skeleton(p_doc))
        sidecar = json.loads((PLUGIN_ROOT / "sidecars" / "app-bridge" / "sidecar.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["command"], "python3")
        self.assertEqual(sidecar["args"], ["bridge.py"])
        self.assertTrue((PLUGIN_ROOT / "sidecars" / "app-bridge" / "bridge.py").is_file())


if __name__ == "__main__":
    unittest.main()
