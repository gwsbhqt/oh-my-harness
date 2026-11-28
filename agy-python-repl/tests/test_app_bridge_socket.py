"""Exercise the desktop sidecar's socket lifecycle in a disposable directory."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import patch


BRIDGE = Path(__file__).resolve().parents[1] / "sidecars/app-bridge/bridge.py"
spec = importlib.util.spec_from_file_location("app_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeSocketTests(unittest.TestCase):
    def test_existing_configuration_and_directory_permissions_are_preserved(self):
        # AF_UNIX needs a short path even when the caller's TMPDIR is long.
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="agy-sock-") as dirname:
            root = Path(dirname) / "config"
            root.mkdir()
            root.chmod(0o755)
            server = bridge.AppBridgeServer(root / "control.sock")
            server.sock_path.write_text("existing file", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unused socket path"):
                asyncio.run(server.serve())
            self.assertEqual(server.sock_path.read_text(encoding="utf-8"), "existing file")
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o755)
            server.sock_path.unlink()
            server.meta_path.write_text("existing note", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unused metadata path"):
                asyncio.run(server.serve())
            self.assertEqual(server.meta_path.read_text(encoding="utf-8"), "existing note")
            self.assertFalse(server.sock_path.exists())

    def test_stale_socket_restarts_and_live_socket_keeps_its_owner(self):
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="agy-sock-") as dirname:
            path = Path(dirname) / "control.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
                stale.bind(str(path))
            first = bridge.AppBridgeServer(path)
            with first._listen():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                second = bridge.AppBridgeServer(path)
                with self.assertRaisesRegex(RuntimeError, "already listening"):
                    second._listen()
                path.unlink()
                with second._listen():
                    first._cleanup()
                    self.assertTrue(path.is_socket())
                    second._cleanup()

    def test_long_transcript_window_preserves_global_counts_and_ignores_incomplete_tail(self):
        with tempfile.TemporaryDirectory() as dirname, patch.dict(os.environ, {"ANTIGRAVITY_APP_DATA_DIR": dirname}):
            logs = Path(dirname) / "brain/sample/.system_generated/logs"
            logs.mkdir(parents=True)
            records = [
                {"step_index": 0, "type": "USER_INPUT", "content": "x" * 200_000},
                {"step_index": 1, "type": "PLANNER_RESPONSE", "content": "first answer"},
                {"step_index": 2, "type": "SYSTEM_MESSAGE", "content": "next question"},
                {"step_index": 3, "type": "PLANNER_RESPONSE", "content": "last answer"},
            ]
            path = logs / "transcript.jsonl"
            path.write_text("".join(json.dumps(r) + "\n" for r in records) + '{"step', encoding="utf-8")
            page = bridge._read_transcript_sync("sample", False, from_step=2, limit=1)
            self.assertEqual(page["steps"], records[2:3])
            self.assertEqual((page["total_steps"], page["last_step_index"], page["has_more"]), (4, 3, True))
            self.assertEqual(bridge._read_transcript_sync("sample", False, last_reply_only=True)["steps"], records[-1:])
            self.assertEqual(bridge._read_transcript_sync("sample", False, include_steps=False)["steps"], [])

