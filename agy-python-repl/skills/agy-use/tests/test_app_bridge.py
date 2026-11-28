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
        elif mode in ("idle_tool_only", "idle_receipt_only", "next_input_reply", "idle_receipt_cancelling"):
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            if mode == "idle_tool_only":
                steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                              "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a"}}]})
            if mode == "next_input_reply":
                steps.extend([
                    {"step_index": next_idx + 1, "type": "USER_INPUT", "status": "DONE", "content": "Next task"},
                    {"step_index": next_idx + 2, "type": "PLANNER_RESPONSE", "status": "DONE", "content": "Next answer"},
                ])
            convs[cid]["state"]["runState"] = (
                "RUN_STATE_CANCELLING" if mode == "idle_receipt_cancelling" else "RUN_STATE_IDLE"
            )
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:06Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode == "done_then_low_system":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "model": "demo-model", "content": "ECHO:" + content})
            notice = wrapped.replace(content, "LATER_NOTICE").replace("sender=peer", "sender=system").replace("MESSAGE_PRIORITY_HIGH", "MESSAGE_PRIORITY_LOW")
            steps.append({"step_index": next_idx + 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": notice})
            steps.append({"step_index": next_idx + 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "model": "demo-model", "content": "OTHER_REPLY"})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
        elif mode in ("system_low_notice", "system_low_work_reminder", "peer_low_next_request", "system_high_next_request", "unknown_low_next_request"):
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            notice = wrapped.replace(content, "NOTICE_OR_NEXT_TASK")
            if mode in ("system_low_notice", "system_low_work_reminder"):
                notice = notice.replace("sender=peer", "sender=system").replace("MESSAGE_PRIORITY_HIGH", "MESSAGE_PRIORITY_LOW")
            elif mode == "peer_low_next_request":
                notice = notice.replace("MESSAGE_PRIORITY_HIGH", "MESSAGE_PRIORITY_LOW")
            elif mode == "system_high_next_request":
                notice = notice.replace("sender=peer", "sender=system")
            else:
                notice = notice.replace("sender=peer", "sender=unknown").replace("MESSAGE_PRIORITY_HIGH", "MESSAGE_PRIORITY_LOW")
            steps.append({"step_index": next_idx + 1, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:06Z", "content": notice})
            steps.append({"step_index": next_idx + 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "IN_PROGRESS",
                          "created_at": "2026-01-01T00:00:07Z", "model": "demo-model", "content": "WORKING"})
            final_text = "LATER_REPLY" if mode in ("system_low_notice", "system_low_work_reminder") else "NEXT_ANSWER"
            steps.append({"step_index": next_idx + 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:08Z", "model": "demo-model", "content": final_text})
            convs[cid]["state"]["runState"] = "RUN_STATE_IDLE"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:08Z"
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
        elif mode == "large_private_same_turn":
            steps.append({"step_index": next_idx, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "content": wrapped})
            steps.append({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                          "created_at": "2026-01-01T00:00:05Z", "model": "demo-model",
                          "content": "ADJACENT_PRIVATE_SECRET_" + ("Z" * 2_500_000)})
            convs[cid]["state"]["runState"] = "RUN_STATE_RUNNING"
            convs[cid]["state"]["updateTime"] = "2026-01-01T00:00:05Z"
            convs_file.write_text(json.dumps(convs), encoding="utf-8")
            tfile.write_text("\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8")
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

    async def test_sequential_identical_prompts_use_their_own_receipts(self) -> None:
        await self._start_bridge()
        target = "11112222-bbbb-0000-0000-000000000002"
        prompt = "Review the latest draft"
        first = await agy_use.send(target, prompt, wait=True, socket_path=self.sock_path)
        self.assertTrue(first["ok"], first)

        sent = await agy_use.send(target, prompt, socket_path=self.sock_path)
        self.assertTrue(sent["ok"], sent)
        receipt = sent["receipt"]
        self.assertEqual(receipt["since_step"], first["reply_step_index"])
        second = await agy_use.wait(
            receipt["conversation_id"], since_step=receipt["since_step"],
            expected_prompt=receipt["prompt"], timeout=3, socket_path=self.sock_path,
        )
        self.assertTrue(second["ok"], second)
        self.assertLess(first["reply_step_index"], second["receipt_step_index"])
        self.assertLess(second["receipt_step_index"], second["reply_step_index"])

        history = await agy_use.wait(
            target, since_step=first["receipt"]["since_step"], expected_prompt=prompt,
            timeout=3, socket_path=self.sock_path,
        )
        self.assertEqual(history["error_code"], "ambiguous-reply")
        self.assertEqual(
            history["matching_receipt_steps"],
            [first["receipt_step_index"], second["receipt_step_index"]],
        )
        self.assertEqual(len(self._agentapi_calls()), 2)

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

    async def test_deferred_first_prompt_can_be_verified_from_its_receipt(self) -> None:
        await self._start_bridge()
        prompt = "check the first reply"
        created = await agy_use.new(prompt, socket_path=self.sock_path)
        self.assertTrue(created["ok"], created)
        receipt = created["receipt"]
        self.assertEqual(receipt["prompt"], prompt)
        self.assertEqual(receipt["since_step"], -1)
        waited = await agy_use.wait(
            receipt["conversation_id"], since_step=receipt["since_step"],
            expected_prompt=receipt["prompt"], allow_user_input=receipt["created"],
            timeout=5, poll_interval=0.05, socket_path=self.sock_path,
        )
        self.assertTrue(waited["ok"], waited)
        self.assertEqual(waited["response"], f"CREATED:{prompt}")
        cli = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "wait", receipt["conversation_id"],
             "--since-step", str(receipt["since_step"]), "--expected-prompt", receipt["prompt"],
             "--allow-user-input", "--timeout", "5", "--socket", str(self.sock_path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertEqual(json.loads(cli.stdout)["response"], waited["response"])

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
        self.assertEqual(caught.exception.receipt["cancellation_scope"], "wait")
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

    async def test_wait_resumes_after_timeout_and_preserves_explicit_wait_cancellation(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        sock = await self._start_bridge_with_new_socket("idle_receipt_cancelling")
        sent = await agy_use.send(target, "WAIT_FOR_RESULT", wait=True, timeout=0.2,
                                  poll_interval=0.05, socket_path=sock)
        self.assertEqual(sent["status"], "timeout")
        self.assertEqual(sent["run_state"], "RUN_STATE_CANCELLING")
        self.assertTrue(sent["sent"])
        self.assertTrue(sent["receipt_confirmed"])
        self.assertNotIn("cancelled", sent)
        receipt = sent["receipt"]
        wait_args = {"since_step": receipt["since_step"], "expected_prompt": receipt["prompt"],
                     "socket_path": sock, "poll_interval": 0.05}
        task = asyncio.create_task(agy_use.wait(target, timeout=5, **wait_args))
        await asyncio.sleep(0.15)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught:
            await task
        self.assertEqual(caught.exception.receipt["status"], "cancelled")
        self.assertEqual(caught.exception.receipt["cancellation_scope"], "wait")

        convs_file = self.convs_file
        convs = json.loads(convs_file.read_text())
        convs[target]["state"]["runState"] = "RUN_STATE_IDLE"
        transcript = self.app_data / "brain" / target / ".system_generated" / "logs" / "transcript.jsonl"
        with transcript.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"step_index": sent["receipt_step_index"] + 1, "type": "PLANNER_RESPONSE",
                                     "status": "DONE", "content": "Late answer"}) + "\n")
        convs_file.write_text(json.dumps(convs))
        finished = await agy_use.wait(target, timeout=1, **wait_args)
        self.assertEqual(finished["status"], "completed")
        self.assertEqual(finished["response"], "Late answer")
        self.assertEqual(len(self._agentapi_calls()), 1)

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

    def _write_transcript(self, steps: list[dict]) -> None:
        logs = self.app_data / "brain" / "11112222-bbbb-0000-0000-000000000002" / ".system_generated" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "transcript.jsonl").write_text(
            "\n".join(json.dumps(s) for s in steps) + "\n", encoding="utf-8",
        )

    @staticmethod
    def _sdk_startup_notice(step_index: int) -> dict:
        return {
            "step_index": step_index, "source": "SYSTEM_SDK", "type": "SYSTEM_MESSAGE", "status": "DONE",
            "created_at": "2026-01-01T00:00:05Z",
            "content": "<SYSTEM_MESSAGE>\nSDK startup notice: session ready.\n</SYSTEM_MESSAGE>",
        }

    async def test_sdk_startup_notice_does_not_answer_early(self) -> None:
        self.seed_conversations()
        self._write_transcript([
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
             "created_at": "2026-01-01T00:00:05Z", "content": "SDK_ONLY_PROMPT"},
            self._sdk_startup_notice(1),
        ])
        sock = await self._start_bridge_with_new_socket("baseline")
        import time
        t0 = time.monotonic()
        res = await agy_use.wait(
            "11112222-bbbb-0000-0000-000000000002", since_step=-1, expected_prompt="SDK_ONLY_PROMPT",
            allow_user_input=True, timeout=1.0, poll_interval=0.05, socket_path=sock,
        )
        elapsed = time.monotonic() - t0
        self.assertFalse(res["ok"])
        self.assertTrue(res["timed_out"])
        self.assertEqual(res["status"], "timeout")
        self.assertEqual(res["error_code"], "wait-timeout")
        self.assertTrue(res["receipt_confirmed"])
        self.assertEqual(res["receipt_step_index"], 0)
        self.assertNotIn("cancelled", res)
        self.assertGreaterEqual(elapsed, 0.8)

    async def test_sdk_startup_notice_still_completes_on_a_late_normal_reply(self) -> None:
        self.seed_conversations()
        base = [
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
             "created_at": "2026-01-01T00:00:05Z", "content": "SDK_LATE_PROMPT"},
            self._sdk_startup_notice(1),
        ]
        self._write_transcript(base)
        sock = await self._start_bridge_with_new_socket("baseline")

        async def _late() -> None:
            await asyncio.sleep(0.6)
            self._write_transcript(base + [
                {"step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                 "model": "demo-model", "created_at": "2026-01-01T00:00:07Z", "content": "LATE_NORMAL_REPLY"},
            ])

        task = asyncio.create_task(_late())
        res = await agy_use.wait(
            "11112222-bbbb-0000-0000-000000000002", since_step=-1, expected_prompt="SDK_LATE_PROMPT",
            allow_user_input=True, timeout=4, poll_interval=0.05, socket_path=sock,
        )
        await task
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["status"], "completed")
        self.assertEqual(res["response"], "LATE_NORMAL_REPLY")
        self.assertEqual(res["receipt_step_index"], 0)

    async def test_sdk_startup_notice_then_next_different_user_input_is_still_a_boundary(self) -> None:
        self.seed_conversations()
        self._write_transcript([
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
             "created_at": "2026-01-01T00:00:05Z", "content": "SDK_THEN_NEXT_PROMPT"},
            self._sdk_startup_notice(1),
            {"step_index": 2, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
             "created_at": "2026-01-01T00:00:06Z", "content": "A DIFFERENT NEXT TURN"},
        ])
        sock = await self._start_bridge_with_new_socket("baseline")
        res = await agy_use.wait(
            "11112222-bbbb-0000-0000-000000000002", since_step=-1, expected_prompt="SDK_THEN_NEXT_PROMPT",
            allow_user_input=True, timeout=2, poll_interval=0.05, socket_path=sock,
        )
        self.assertFalse(res["ok"])
        self.assertFalse(res["timed_out"])
        self.assertEqual(res["status"], "unanswered")
        self.assertEqual(res["error_code"], "no-final-response")
        self.assertTrue(res["receipt_confirmed"])
        self.assertEqual(res["receipt_step_index"], 0)

    async def test_send_wait_rejects_unrelated_only_unanswered_empty_and_duplicate_bodies(self) -> None:
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

        # 3. Idle with only tool activity or receipt, or a final from the next input.
        for mode in ("idle_tool_only", "idle_receipt_only", "next_input_reply"):
            with self.subTest(mode=mode):
                self.seed_conversations()
                (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
                sock = await self._start_bridge_with_new_socket(mode)
                unanswered = await agy_use.send(
                    "11112222-bbbb-0000-0000-000000000002",
                    "NO_FINAL", wait=True, timeout=0.4, poll_interval=0.05, socket_path=sock,
                )
                self.assertFalse(unanswered["ok"])
                only_receipt = mode == "idle_receipt_only"
                self.assertEqual(unanswered["timed_out"], only_receipt)
                self.assertTrue(unanswered["sent"])
                self.assertTrue(unanswered["receipt_confirmed"])
                self.assertEqual(unanswered["status"], "timeout" if only_receipt else "unanswered")
                self.assertEqual(unanswered["error_code"], "wait-timeout" if only_receipt else "no-final-response")
                self.assertNotIn("cancelled", unanswered)
                self.assertNotIn("response", unanswered)
                self.assertEqual(unanswered["receipt"]["prompt"], "NO_FINAL")
                self.assertGreater(unanswered["receipt_step_index"], unanswered["since_step"])
                self.assertEqual(len(self._agentapi_calls()), 1)
                if mode == "next_input_reply":
                    for baseline in (unanswered["since_step"], unanswered["receipt_step_index"]):
                        scoped = await agy_use.wait(
                            unanswered["conversation_id"], since_step=baseline,
                            timeout=1, poll_interval=0.05, socket_path=sock,
                        )
                        self.assertEqual(scoped["status"], "unanswered")
                        self.assertNotIn("response", scoped)

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

    async def test_wait_returns_final_reply_before_later_low_priority_boundary(self) -> None:
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock = await self._start_bridge_with_new_socket("done_then_low_system")
        result = await agy_use.send(
            "11112222-bbbb-0000-0000-000000000002", "ROOT_TASK", wait=True,
            timeout=0.5, poll_interval=0.05, socket_path=sock,
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["response"], "ECHO:ROOT_TASK")
        self.assertEqual(result["reply_step_index"], result["receipt_step_index"] + 1)
        self.assertNotEqual(result["response"], "OTHER_REPLY")
        self.assertEqual(len(self._agentapi_calls()), 1)

    async def test_wait_marks_low_priority_system_boundaries_ambiguous(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        for mode in ("system_low_notice", "system_low_work_reminder", "peer_low_next_request", "system_high_next_request", "unknown_low_next_request"):
            with self.subTest(mode=mode):
                self.seed_conversations()
                (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
                sock = await self._start_bridge_with_new_socket(mode)
                result = await agy_use.send(
                    target, "ROOT_TASK", wait=True, timeout=0.5, poll_interval=0.05, socket_path=sock,
                )
                self.assertEqual(len(self._agentapi_calls()), 1)
                if mode in ("system_low_notice", "system_low_work_reminder"):
                    self.assertFalse(result["ok"], result)
                    self.assertEqual(result["status"], "ambiguous")
                    self.assertEqual(result["error_code"], "ambiguous-reply")
                    self.assertEqual(result["ambiguous_step_index"], result["receipt_step_index"] + 1)
                    self.assertTrue(result["receipt_confirmed"])
                    self.assertNotIn("response", result)
                else:
                    self.assertFalse(result["ok"], result)
                    self.assertEqual(result["status"], "unanswered")
                    self.assertEqual(result["error_code"], "no-final-response")
                    self.assertTrue(result["receipt_confirmed"])
                    self.assertNotIn("response", result)

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

    async def test_wait_receipt_confirms_inbox_while_running_and_refuses_unconfirmed_without_retry(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        with self.assertRaises(ValueError):
            await agy_use.send(target, "bad", wait=True, wait_receipt=True, socket_path=self.sock_path)
        with self.assertRaises(ValueError):
            await agy_use.wait(target, receipt_only=True, socket_path=self.sock_path)

        # 1. stays_running: send(wait_receipt=True) confirms unique inbox receipt even before IDLE or reply.
        sock_running = await self._start_bridge_with_new_socket("stays_running")
        rec = await agy_use.send(
            target,
            "RECEIPT_RUNNING",
            wait_receipt=True,
            timeout=2,
            poll_interval=0.05,
            socket_path=sock_running,
        )
        self.assertTrue(rec["ok"], rec)
        self.assertTrue(rec["sent"])
        self.assertTrue(rec["receipt_confirmed"])
        self.assertEqual(rec["status"], "received")
        self.assertEqual(rec["since_step"], 1)
        self.assertEqual(rec["receipt_step_index"], 2)
        self.assertGreater(rec["receipt_step_index"], rec["since_step"])
        self.assertEqual(rec["run_state"], "RUN_STATE_RUNNING")
        self.assertEqual(len(self._agentapi_calls()), 1)

        # CLI --wait-receipt + wait --receipt-only on delayed turn.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        cli_send = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "send", target, "CLI_RECEIPT",
             "--wait-receipt", "--timeout", "2", "--poll-interval", "0.05", "--socket", str(sock_running)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_send.returncode, 0, cli_send.stderr)
        cli_send_json = json.loads(cli_send.stdout)
        self.assertTrue(cli_send_json["receipt_confirmed"])
        self.assertEqual(cli_send_json["status"], "received")

        self.seed_conversations()
        sock_delayed = await self._start_bridge_with_new_socket("delayed")
        sent_only = await agy_use.send(target, "DELAYED_RECEIPT", socket_path=sock_delayed)
        self.assertTrue(sent_only["ok"])
        cli_wait = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "wait", target,
             "--since-step", str(sent_only["receipt"]["since_step"]),
             "--expected-prompt", "DELAYED_RECEIPT", "--receipt-only",
             "--timeout", "2", "--poll-interval", "0.05", "--socket", str(sock_delayed)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_wait.returncode, 0, cli_wait.stderr)
        cli_wait_json = json.loads(cli_wait.stdout)
        self.assertTrue(cli_wait_json["receipt_confirmed"])
        self.assertEqual(cli_wait_json["status"], "received")

        # 2. agentapi accepted (sent=True), yet transcript only gets unrelated step -> unconfirmed, no resend.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_unrel = await self._start_bridge_with_new_socket("unrelated_only")
        missing_receipt = await agy_use.send(
            target,
            "MISSING_IN_TRANSCRIPT",
            wait_receipt=True,
            timeout=0.3,
            poll_interval=0.05,
            socket_path=sock_unrel,
        )
        self.assertFalse(missing_receipt["ok"])
        self.assertTrue(missing_receipt["sent"])
        self.assertFalse(missing_receipt["receipt_confirmed"])
        self.assertEqual(missing_receipt["since_step"], 1)
        self.assertNotIn("receipt_step_index", missing_receipt)
        self.assertTrue(missing_receipt["timed_out"])
        self.assertEqual(missing_receipt["status"], "timeout")
        self.assertEqual(len(self._agentapi_calls()), 1)

        # 3. agentapi accepted (sent=True), duplicate same-body steps -> ambiguous, receipt_confirmed=False, no resend.
        self.seed_conversations()
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        sock_dup = await self._start_bridge_with_new_socket("duplicate_same_body")
        dup_receipt = await agy_use.send(
            target,
            "DUP_RECEIPT",
            wait_receipt=True,
            timeout=3,
            poll_interval=0.05,
            socket_path=sock_dup,
        )
        self.assertFalse(dup_receipt["ok"])
        self.assertTrue(dup_receipt["sent"])
        self.assertFalse(dup_receipt["receipt_confirmed"])
        self.assertEqual(dup_receipt["since_step"], 1)
        self.assertNotIn("receipt_step_index", dup_receipt)
        self.assertEqual(dup_receipt["error_code"], "ambiguous-reply")
        self.assertEqual(len(self._agentapi_calls()), 1)
        forbidden = {"events", "conversation", "baseline", "receipt", "agentapi", "response", "socket"}
        for payload in (rec, cli_send_json, cli_wait_json, missing_receipt, dup_receipt):
            self.assertEqual(forbidden & set(payload.keys()), set(), payload)

        # 4. CancelledError during receipt_only preserves compact cancelled receipt without events/metadata.
        cancel_task = asyncio.create_task(
            agy_use.wait(
                target,
                since_step=1,
                expected_prompt="NEVER_ARRIVES",
                receipt_only=True,
                timeout=10,
                poll_interval=0.05,
                socket_path=sock_unrel,
            )
        )
        await asyncio.sleep(0.15)
        cancel_task.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught_cancel:
            await cancel_task
        creceipt = caught_cancel.exception.receipt
        self.assertTrue(creceipt["cancelled"])
        self.assertFalse(creceipt["receipt_confirmed"])
        self.assertEqual(creceipt["status"], "cancelled")
        self.assertEqual(creceipt["since_step"], 1)
        self.assertEqual(creceipt["conversation_id"], target)
        self.assertEqual(forbidden & set(creceipt.keys()), set(), creceipt)

    async def test_wait_receipt_strips_large_adjacent_private_payload_and_metadata(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        convs = json.loads(self.convs_file.read_text(encoding="utf-8"))
        convs[target]["annotations"]["title"] = "SECRET_CONV_TITLE_XYZ"
        convs[target]["state"]["summary"] = "SECRET_SUMMARY_XYZ"
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")

        tfile = self.app_data / "brain" / target / ".system_generated" / "logs" / "transcript.jsonl"
        tfile.write_text(
            "\n".join([
                json.dumps({"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "content": "OLD_PRIVATE_USER_XYZ"}),
                json.dumps({"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": "OLD_PRIVATE_REPLY_" + ("Q" * 300_000)}),
            ]) + "\n",
            encoding="utf-8",
        )

        sock_large = await self._start_bridge_with_new_socket("large_private_same_turn")
        cli = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "send", target, "COMPACT_NOTICE_ONLY",
             "--wait-receipt", "--timeout", "5", "--poll-interval", "0.05", "--socket", str(sock_large)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertLess(len(cli.stdout.encode("utf-8")), 2048)
        data = json.loads(cli.stdout)
        self.assertTrue(data["ok"], data)
        self.assertTrue(data["sent"])
        self.assertTrue(data["receipt_confirmed"])
        self.assertEqual(data["status"], "received")
        self.assertEqual(data["conversation_id"], target)
        self.assertEqual(data["since_step"], 1)
        self.assertEqual(data["receipt_step_index"], 2)
        self.assertEqual(data["last_step_index"], 3)
        self.assertGreater(data["receipt_step_index"], data["since_step"])
        for leak in (
            "SECRET_CONV_TITLE_XYZ",
            "SECRET_SUMMARY_XYZ",
            "OLD_PRIVATE_USER_XYZ",
            "OLD_PRIVATE_REPLY_",
            "ADJACENT_PRIVATE_SECRET_",
            "ZZZZZZ",
            '"events"',
            '"conversation"',
            '"baseline"',
            '"receipt"',
            '"agentapi"',
            '"response"',
            '"socket"',
        ):
            self.assertNotIn(leak, cli.stdout)

        # Same check for standalone wait --receipt-only CLI when large same-turn content exists.
        cli_wait = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "wait", target,
             "--since-step", "1", "--expected-prompt", "COMPACT_NOTICE_ONLY", "--receipt-only",
             "--timeout", "5", "--poll-interval", "0.05", "--socket", str(sock_large)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_wait.returncode, 0, cli_wait.stderr)
        self.assertLess(len(cli_wait.stdout.encode("utf-8")), 2048)
        wait_data = json.loads(cli_wait.stdout)
        self.assertTrue(wait_data["receipt_confirmed"])
        self.assertEqual(wait_data["since_step"], 1)
        self.assertEqual(wait_data["receipt_step_index"], 2)
        self.assertNotIn("ADJACENT_PRIVATE_SECRET_", cli_wait.stdout)
        self.assertNotIn("SECRET_CONV_TITLE_XYZ", cli_wait.stdout)

        # Empty transcript boundary (-1 -> 0): send --wait-receipt preserves since_step=-1 and receipt_step_index=0.
        self.seed_conversations()
        tfile.write_text("", encoding="utf-8")
        empty_res = await agy_use.send(
            target,
            "FIRST_STEP_ZERO",
            wait_receipt=True,
            timeout=5,
            poll_interval=0.05,
            socket_path=sock_large,
        )
        self.assertTrue(empty_res["ok"], empty_res)
        self.assertTrue(empty_res["sent"])
        self.assertTrue(empty_res["receipt_confirmed"])
        self.assertEqual(empty_res["since_step"], -1)
        self.assertEqual(empty_res["receipt_step_index"], 0)
        self.assertGreater(empty_res["receipt_step_index"], empty_res["since_step"])
        self.assertNotIn("baseline", empty_res)

        # Normal wait=True keeps existing full fields (baseline, receipt, events, conversation, response).
        self.seed_conversations()
        sock_fast = await self._start_bridge_with_new_socket("fast")
        normal = await agy_use.send(target, "NORMAL_WAIT", wait=True, timeout=5, poll_interval=0.05, socket_path=sock_fast)
        self.assertTrue(normal["ok"], normal)
        for kept in ("baseline", "receipt", "events", "conversation", "response"):
            self.assertIn(kept, normal)
        self.assertEqual(normal["baseline"]["last_step_index"], 1)

    async def test_receipt_safety_boundaries_and_synthetic_faults(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        await self._start_bridge()

        # 1. receipt_only requires integer since_step >= -1 (prevents matching historical steps).
        with self.assertRaises(ValueError):
            await agy_use.wait(target, expected_prompt="hi", receipt_only=True, socket_path=self.sock_path)
        with self.assertRaises(ValueError):
            await agy_use.wait(target, since_step=-2, expected_prompt="hi", receipt_only=True, socket_path=self.sock_path)
        cli_missing_since = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, str(SKILL / "scripts/agy-use"), "wait", target,
             "--expected-prompt", "hi", "--receipt-only", "--socket", str(self.sock_path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(cli_missing_since.returncode, 2)

        # 2. Pre-send invalid poll_interval fails BEFORE calling send_message.
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        with self.assertRaises(ValueError):
            await agy_use.send(target, "BAD_POLL", wait_receipt=True, poll_interval=0, socket_path=self.sock_path)
        self.assertEqual(len(self._agentapi_calls()), 0)

        # 3. Non-empty pre-send transcript lacking valid last_step_index -> refuses to send (sent=False).
        real_call = agy_use._client.call_bridge

        async def bad_baseline_call(op, params=None, *, socket_path=None, timeout=15.0):
            if op == "read_transcript":
                return {"ok": True, "exists": True, "total_steps": 3, "last_step_index": None, "steps": []}
            return await real_call(op, params, socket_path=socket_path, timeout=timeout)

        with patch("agy_use.call_bridge", side_effect=bad_baseline_call):
            refused = await agy_use.send(target, "REFUSE_BAD_BASELINE", wait_receipt=True, socket_path=self.sock_path)
        self.assertFalse(refused["ok"])
        self.assertFalse(refused["sent"])
        self.assertFalse(refused["receipt_confirmed"])
        self.assertEqual(refused["error_code"], "invalid-baseline")
        self.assertEqual(len(self._agentapi_calls()), 0)

        # 4. send(wait_receipt=True) CancelledError after send preserves sent=True, since_step, receipt_confirmed=False.
        sock_unrel = await self._start_bridge_with_new_socket("unrelated_only")
        (self.state_dir / "agentapi_calls.jsonl").unlink(missing_ok=True)
        cancel_send = asyncio.create_task(
            agy_use.send(
                target,
                "CANCEL_AFTER_SEND",
                wait_receipt=True,
                timeout=10,
                poll_interval=0.05,
                socket_path=sock_unrel,
            )
        )
        async with asyncio.timeout(5):
            while not (self.state_dir / "agentapi_calls.jsonl").exists():
                await asyncio.sleep(0.02)
        await asyncio.sleep(0.15)
        cancel_send.cancel()
        with self.assertRaises(asyncio.CancelledError) as caught_send_cancel:
            await cancel_send
        cancel_receipt = caught_send_cancel.exception.receipt
        self.assertTrue(cancel_receipt["cancelled"])
        self.assertTrue(cancel_receipt["sent"])
        self.assertEqual(cancel_receipt["since_step"], 1)
        self.assertFalse(cancel_receipt["receipt_confirmed"])
        self.assertEqual(cancel_receipt["conversation_id"], target)
        for hidden in ("events", "conversation", "baseline", "receipt", "agentapi"):
            self.assertNotIn(hidden, cancel_receipt)

        # 5. Truncated short transcript while full fallback lags -> must NOT confirm until full covers candidate steps.
        wrapped_match = "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:05Z sender=peer priority=MESSAGE_PRIORITY_HIGH content=LAG_CHECK\n</SYSTEM_MESSAGE>"
        wrapped_other = "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:06Z sender=peer priority=MESSAGE_PRIORITY_HIGH content=OTHER_STEP\n</SYSTEM_MESSAGE>"
        full_polls = {"n": 0}

        async def lagging_full_call(op, params=None, *, socket_path=None, timeout=15.0):
            if op == "read_transcript" and not (params or {}).get("full"):
                return {
                    "ok": True,
                    "exists": True,
                    "total_steps": 4,
                    "last_step_index": 3,
                    "steps": [
                        {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_match},
                        {"step_index": 3, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": "truncated...", "truncated_fields": ["content"]},
                    ],
                }
            if op == "read_transcript" and (params or {}).get("full"):
                full_polls["n"] += 1
                if full_polls["n"] == 1:
                    # Lags behind: missing candidate step 3 even though step 2 is present!
                    return {
                        "ok": True,
                        "exists": True,
                        "total_steps": 3,
                        "last_step_index": 2,
                        "steps": [
                            {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_match},
                        ],
                    }
                return {
                    "ok": True,
                    "exists": True,
                    "total_steps": 4,
                    "last_step_index": 3,
                    "steps": [
                        {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_match},
                        {"step_index": 3, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_other},
                    ],
                }
            return await real_call(op, params, socket_path=socket_path, timeout=timeout)

        with patch("agy_use.call_bridge", side_effect=lagging_full_call):
            caught_up = await agy_use.wait(
                target,
                since_step=1,
                expected_prompt="LAG_CHECK",
                receipt_only=True,
                timeout=2,
                poll_interval=0.05,
                socket_path=self.sock_path,
            )
        self.assertGreaterEqual(full_polls["n"], 2)
        self.assertTrue(caught_up["ok"], caught_up)
        self.assertTrue(caught_up["receipt_confirmed"])
        self.assertEqual(caught_up["receipt_step_index"], 2)

        async def permanently_lagging_full_call(op, params=None, *, socket_path=None, timeout=15.0):
            if op == "read_transcript" and not (params or {}).get("full"):
                return {
                    "ok": True,
                    "exists": True,
                    "total_steps": 4,
                    "last_step_index": 3,
                    "steps": [
                        {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_match},
                        {"step_index": 3, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": "truncated...", "truncated_fields": ["content"]},
                    ],
                }
            if op == "read_transcript" and (params or {}).get("full"):
                return {
                    "ok": True,
                    "exists": True,
                    "total_steps": 3,
                    "last_step_index": 2,
                    "steps": [
                        {"step_index": 2, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": wrapped_match},
                    ],
                }
            return await real_call(op, params, socket_path=socket_path, timeout=timeout)

        with patch("agy_use.call_bridge", side_effect=permanently_lagging_full_call):
            never_confirmed = await agy_use.wait(
                target,
                since_step=1,
                expected_prompt="LAG_CHECK",
                receipt_only=True,
                timeout=0.25,
                poll_interval=0.05,
                socket_path=self.sock_path,
            )
        self.assertFalse(never_confirmed["ok"])
        self.assertTrue(never_confirmed["timed_out"])
        self.assertFalse(never_confirmed["receipt_confirmed"])

        # 6. Socket write before drain failure marks wrote=True -> uncertain=True, sent=None (never sent=False).
        class _FakeWriter:
            def __init__(self) -> None:
                self.bytes_written = 0

            def write(self, data: bytes) -> None:
                self.bytes_written += len(data)

            async def drain(self) -> None:
                raise OSError("broken pipe during drain")

            def close(self) -> None:
                pass

            async def wait_closed(self) -> None:
                pass

        async def _fake_open_unix_connection(*_args, **_kwargs):
            return object(), _FakeWriter()

        with patch("agy_use._client.asyncio.open_unix_connection", side_effect=_fake_open_unix_connection):
            drain_fail = await agy_use._client.call_bridge(
                "send_message",
                {"conversation_id": target, "prompt": "WRITE_THEN_DRAIN_FAIL"},
                socket_path=self.sock_path,
                timeout=2,
            )
        self.assertFalse(drain_fail["ok"])
        self.assertIsNone(drain_fail["sent"])
        self.assertTrue(drain_fail["uncertain"])
        self.assertEqual(drain_fail["error_code"], "bridge-disconnected")

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

    async def test_turn_diagnosis_distinguishes_transport_error_cancel_running_and_safe_continuation(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        sock = await self._start_bridge_with_new_socket("stays_running")

        # 1. Still running with open tool call -> still_running, unsettled_tool_calls=True, wait_in_same_conversation_do_not_resend.
        sent = await agy_use.send(target, "SIDE_EFFECT_TASK", wait_receipt=True, timeout=3, poll_interval=0.05, socket_path=sock)
        self.assertTrue(sent["receipt_confirmed"])
        tfile = self.app_data / "brain" / target / ".system_generated" / "logs" / "transcript.jsonl"
        base_steps = [json.loads(line) for line in tfile.read_text(encoding="utf-8").splitlines() if line.strip()]
        next_idx = base_steps[-1]["step_index"] + 1
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "tool_calls": [{"name": "write_file", "args": {"Path": "/Users/private/secret.txt"}}]}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "GENERIC", "status": "RUNNING", "content": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        running_read = await agy_use.read(target, socket_path=sock)
        self.assertEqual(running_read["diagnosis"]["classification"], "still_running")
        self.assertTrue(running_read["diagnosis"]["unsettled_tool_calls"])
        self.assertFalse(running_read["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(running_read["diagnosis"]["next_action"], "wait_in_same_conversation_do_not_resend")
        self.assertNotIn("safe_to_auto_resend", running_read["diagnosis"])
        self.assertNotIn("/Users/private/secret.txt", json.dumps(running_read["diagnosis"]))

        running_wait = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            timeout=0.2, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(running_wait["status"], "timeout")
        self.assertEqual(running_wait["diagnosis"]["classification"], "still_running")
        self.assertTrue(running_wait["diagnosis"]["unsettled_tool_calls"])
        self.assertFalse(running_wait["diagnosis"]["can_continue_explicitly"])
        self.assertNotIn("safe_to_auto_resend", running_wait["diagnosis"])

        # 2. Simulate TRANSPORT/Connection error whose error text hides fictional secrets/paths/prompts:
        # diagnosis must classify transport_error without leaking raw error text, paths, accounts, or args.
        convs = json.loads(self.convs_file.read_text(encoding="utf-8"))
        convs[target]["state"]["runState"] = "RUN_STATE_IDLE"
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")
        secret_err = (
            "TRANSPORT/Connection error: sk-fictional-token-999 "
            "/Users/private/secret_account.json prompt=SIDE_EFFECT_TASK"
        )
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "tool_calls": [{"name": "write_file", "args": {"Path": "/Users/private/secret.txt"}}]}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "GENERIC", "status": "ERROR",
                            "error": secret_err, "content": "SECRET_CONTENT_SHOULD_NOT_LEAK"}),
            ]) + "\n",
            encoding="utf-8",
        )
        err_wait = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(err_wait["status"], "unanswered")
        self.assertEqual(err_wait["error_code"], "no-final-response")
        self.assertTrue(err_wait["receipt_confirmed"])
        diag_json = json.dumps(err_wait["diagnosis"], ensure_ascii=False)
        self.assertEqual(err_wait["diagnosis"]["classification"], "transport_error")
        self.assertTrue(err_wait["diagnosis"]["unsettled_tool_calls"])
        self.assertEqual(err_wait["diagnosis"]["tool_names"], ["write_file"])
        self.assertFalse(err_wait["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(err_wait["diagnosis"]["next_action"], "inspect_side_effects_before_explicit_follow_up")
        self.assertEqual(err_wait["diagnosis"]["error_kinds"], ["transport_error"])
        self.assertEqual(err_wait["diagnosis"]["error_step_indices"], [next_idx + 1])
        self.assertNotIn("safe_to_auto_resend", err_wait["diagnosis"])
        self.assertNotIn("errors", err_wait["diagnosis"])
        for leaked in (
            "sk-fictional-token-999",
            "/Users/private/secret_account.json",
            "/Users/private/secret.txt",
            "SIDE_EFFECT_TASK",
            "SECRET_CONTENT_SHOULD_NOT_LEAK",
        ):
            self.assertNotIn(leaked, diag_json)
        self.assertEqual(len(self._agentapi_calls()), 1)

        err_read = await agy_use.read(target, socket_path=sock)
        self.assertEqual(err_read["diagnosis"]["classification"], "transport_error")
        self.assertTrue(err_read["diagnosis"]["unsettled_tool_calls"])
        self.assertNotIn("sk-fictional-token-999", json.dumps(err_read["diagnosis"]))

        # Pure transport_error with zero tool calls -> can_continue_explicitly=True with explicit follow-up action.
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "ERROR",
                            "error": secret_err, "content": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        pure_err = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(pure_err["diagnosis"]["classification"], "transport_error")
        self.assertTrue(pure_err["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(pure_err["diagnosis"]["next_action"], "continue_explicitly_without_repeating_prompt")
        self.assertNotIn("sk-fictional-token-999", json.dumps(pure_err["diagnosis"]))

        # Receipt-only mode MUST still exclude diagnosis.
        rec_only = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            receipt_only=True, timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertTrue(rec_only["receipt_confirmed"])
        self.assertNotIn("diagnosis", rec_only)

        # 3. Cancelling / explicit user_cancelled must NEVER allow auto-continuation.
        convs[target]["state"]["runState"] = "RUN_STATE_CANCELLING"
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")
        cancelling_read = await agy_use.read(target, socket_path=sock)
        self.assertEqual(cancelling_read["diagnosis"]["classification"], "cancelling")
        self.assertFalse(cancelling_read["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(cancelling_read["diagnosis"]["next_action"], "wait_for_cancel_then_confirm_with_user")

        convs[target]["state"]["runState"] = "RUN_STATE_IDLE"
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "CANCELED", "content": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        cancelled_read = await agy_use.read(target, socket_path=sock)
        self.assertEqual(cancelled_read["diagnosis"]["classification"], "user_cancelled")
        self.assertFalse(cancelled_read["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(cancelled_read["diagnosis"]["next_action"], "do_not_auto_continue_user_cancelled")

        # Ordinary reply mentioning TRANSPORT/Connection error must stay completed and never advise resend.
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "content": "Report: yesterday saw TRANSPORT/Connection error 502 upstream."}),
            ]) + "\n",
            encoding="utf-8",
        )
        completed_read = await agy_use.read(target, socket_path=sock)
        self.assertEqual(completed_read["diagnosis"]["classification"], "completed")
        self.assertFalse(completed_read["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(completed_read["diagnosis"]["next_action"], "do_not_resend_completed_turn")
        self.assertNotIn("safe_to_auto_resend", completed_read["diagnosis"])

        # Receipt-only idle timeout & idle after completed tool call without final reply -> unknown_idle.
        tfile.write_text("\n".join(json.dumps(s) for s in base_steps) + "\n", encoding="utf-8")
        unknown_timeout = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            timeout=0.25, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(unknown_timeout["status"], "timeout")
        self.assertEqual(unknown_timeout["diagnosis"]["classification"], "unknown_idle")
        self.assertEqual(unknown_timeout["diagnosis"]["tool_calls_observed"], 0)
        self.assertFalse(unknown_timeout["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(unknown_timeout["diagnosis"]["next_action"], "inspect_conversation_then_decide_explicit_follow_up")

        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a"}}]}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "GENERIC", "status": "DONE", "content": "ok"}),
            ]) + "\n",
            encoding="utf-8",
        )
        unknown_unanswered = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SIDE_EFFECT_TASK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(unknown_unanswered["status"], "unanswered")
        self.assertEqual(unknown_unanswered["diagnosis"]["classification"], "unknown_idle")
        self.assertEqual(unknown_unanswered["diagnosis"]["tool_calls_observed"], 1)
        self.assertEqual(unknown_unanswered["diagnosis"]["completed_tool_steps"], 1)
        self.assertFalse(unknown_unanswered["diagnosis"]["unsettled_tool_calls"])
        self.assertFalse(unknown_unanswered["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(unknown_unanswered["diagnosis"]["next_action"], "inspect_side_effects_before_explicit_follow_up")

        # 4. Explicit safe continuation on original conversation without re-sending original prompt,
        # and completed wait() returns do_not_resend_completed_turn without auto-resend flag.
        sock_fast = await self._start_bridge_with_new_socket("fast")
        cont = await agy_use.send(
            target,
            "Inspect step result and continue only remaining read-only checks; do not repeat write_file.",
            wait=True,
            timeout=3,
            poll_interval=0.05,
            socket_path=sock_fast,
        )
        self.assertTrue(cont["ok"], cont)
        self.assertEqual(cont["status"], "completed")
        self.assertEqual(cont["diagnosis"]["classification"], "completed")
        self.assertEqual(cont["diagnosis"]["next_action"], "do_not_resend_completed_turn")
        self.assertFalse(cont["diagnosis"]["can_continue_explicitly"])
        self.assertNotIn("safe_to_auto_resend", cont["diagnosis"])
        self.assertIn("continue only remaining", cont["response"])
        calls = self._agentapi_calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["args"][-1], "SIDE_EFFECT_TASK")
        self.assertIn("do not repeat write_file", calls[1]["args"][-1])

    async def test_turn_sequence_counterexamples_and_paginated_read_window_scope(self) -> None:
        target = "11112222-bbbb-0000-0000-000000000002"
        sock = await self._start_bridge_with_new_socket("stays_running")
        sent = await agy_use.send(target, "SEQ_ORDER_CHECK", wait_receipt=True, timeout=3, poll_interval=0.05, socket_path=sock)
        tfile = self.app_data / "brain" / target / ".system_generated" / "logs" / "transcript.jsonl"
        base_steps = [json.loads(line) for line in tfile.read_text(encoding="utf-8").splitlines() if line.strip()]
        next_idx = base_steps[-1]["step_index"] + 1
        convs = json.loads(self.convs_file.read_text(encoding="utf-8"))
        convs[target]["state"]["runState"] = "RUN_STATE_IDLE"
        self.convs_file.write_text(json.dumps(convs), encoding="utf-8")

        # 1. Staged reply -> explicit cancel: neither read() nor wait() may report completed.
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "content": "Stage 1 complete, moving to stage 2"}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "CANCELED",
                            "content": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        r_stage_cancel = await agy_use.read(target, socket_path=sock)
        self.assertEqual(r_stage_cancel["diagnosis"]["classification"], "user_cancelled")
        self.assertEqual(r_stage_cancel["diagnosis"]["next_action"], "do_not_auto_continue_user_cancelled")
        self.assertFalse(r_stage_cancel["diagnosis"]["can_continue_explicitly"])
        self.assertEqual(r_stage_cancel["diagnosis"]["observation_scope"], "full_turn")
        self.assertTrue(r_stage_cancel["diagnosis"]["window_complete"])

        w_stage_cancel = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SEQ_ORDER_CHECK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertFalse(w_stage_cancel["ok"])
        self.assertEqual(w_stage_cancel["status"], "unanswered")
        self.assertEqual(w_stage_cancel["diagnosis"]["classification"], "user_cancelled")
        self.assertFalse(w_stage_cancel["diagnosis"]["can_continue_explicitly"])

        # 2. Error -> explicit cancel: latest terminal state is user_cancelled, never can_continue_explicitly=True.
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "GENERIC", "status": "ERROR",
                            "error": "TRANSPORT/Connection error: reset before stop"}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "CANCELED",
                            "content": ""}),
            ]) + "\n",
            encoding="utf-8",
        )
        r_err_cancel = await agy_use.read(target, socket_path=sock)
        self.assertEqual(r_err_cancel["diagnosis"]["classification"], "user_cancelled")
        self.assertEqual(r_err_cancel["diagnosis"]["next_action"], "do_not_auto_continue_user_cancelled")
        self.assertFalse(r_err_cancel["diagnosis"]["can_continue_explicitly"])

        w_err_cancel = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SEQ_ORDER_CHECK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertEqual(w_err_cancel["status"], "unanswered")
        self.assertEqual(w_err_cancel["diagnosis"]["classification"], "user_cancelled")
        self.assertFalse(w_err_cancel["diagnosis"]["can_continue_explicitly"])

        # 3. Error -> later completed: latest outcome is completed, both read() and wait() agree.
        tfile.write_text(
            "\n".join([json.dumps(s) for s in base_steps] + [
                json.dumps({"step_index": next_idx, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a"}}]}),
                json.dumps({"step_index": next_idx + 1, "source": "MODEL", "type": "GENERIC", "status": "ERROR",
                            "error": "TRANSPORT/Connection error: transient retry"}),
                json.dumps({"step_index": next_idx + 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE",
                            "content": "Recovered and completed cleanly."}),
            ]) + "\n",
            encoding="utf-8",
        )
        r_err_ok = await agy_use.read(target, socket_path=sock)
        self.assertEqual(r_err_ok["diagnosis"]["classification"], "completed")
        self.assertEqual(r_err_ok["diagnosis"]["next_action"], "do_not_resend_completed_turn")
        self.assertFalse(r_err_ok["diagnosis"]["can_continue_explicitly"])

        w_err_ok = await agy_use.wait(
            target, since_step=sent["since_step"], expected_prompt="SEQ_ORDER_CHECK",
            timeout=1, poll_interval=0.05, socket_path=sock,
        )
        self.assertTrue(w_err_ok["ok"])
        self.assertEqual(w_err_ok["status"], "completed")
        self.assertEqual(w_err_ok["response"], "Recovered and completed cleanly.")
        self.assertEqual(w_err_ok["diagnosis"]["classification"], "completed")
        self.assertEqual(w_err_ok["diagnosis"]["next_action"], "do_not_resend_completed_turn")

        # 4. Paginated read() windows MUST report partial observation scope and never claim full-turn completion.
        # (a) Truncated tail window (limit=1, has_more=True)
        head_only = await agy_use.read(target, from_step=sent["since_step"] + 1, limit=1, socket_path=sock)
        self.assertTrue(head_only["has_more"])
        self.assertEqual(head_only["diagnosis"]["classification"], "partial_window")
        self.assertFalse(head_only["diagnosis"]["window_complete"])
        self.assertEqual(head_only["diagnosis"]["observation_scope"], "partial_window_truncated_tail")
        self.assertEqual(head_only["diagnosis"]["next_action"], "read_full_turn_before_acting")
        self.assertEqual(head_only["diagnosis"]["observed_step_range"], [sent["since_step"] + 1, sent["since_step"] + 1])

        # (b) Middle window (from_step after turn start, limit=1, has_more=True)
        middle_win = await agy_use.read(target, from_step=next_idx + 1, limit=1, socket_path=sock)
        self.assertTrue(middle_win["has_more"])
        self.assertEqual(middle_win["diagnosis"]["classification"], "partial_window")
        self.assertFalse(middle_win["diagnosis"]["window_complete"])
        self.assertEqual(middle_win["diagnosis"]["observation_scope"], "partial_window_middle")
        self.assertEqual(middle_win["diagnosis"]["observed_step_range"], [next_idx + 1, next_idx + 1])

        # (c) Tail window missing turn start (from_step skips turn receipt, has_more=False)
        tail_missing_head = await agy_use.read(target, from_step=next_idx + 2, limit=0, socket_path=sock)
        self.assertFalse(tail_missing_head["has_more"])
        self.assertEqual(tail_missing_head["diagnosis"]["classification"], "partial_window")
        self.assertFalse(tail_missing_head["diagnosis"]["window_complete"])
        self.assertEqual(tail_missing_head["diagnosis"]["observation_scope"], "tail_window_missing_head")
        self.assertEqual(tail_missing_head["diagnosis"]["next_action"], "read_full_turn_before_acting")

        # (d) Empty window past transcript end (total_steps > 0, steps=[])
        past_end = await agy_use.read(target, from_step=next_idx + 100, limit=10, socket_path=sock)
        self.assertEqual(past_end["diagnosis"]["classification"], "partial_window")
        self.assertFalse(past_end["diagnosis"]["window_complete"])
        self.assertEqual(past_end["diagnosis"]["observation_scope"], "empty_window")
        self.assertIsNone(past_end["diagnosis"]["observed_step_range"])


if __name__ == "__main__":
    unittest.main()
