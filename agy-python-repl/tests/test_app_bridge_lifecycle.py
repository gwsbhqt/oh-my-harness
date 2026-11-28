"""Integration coverage for sidecar ownership across a host replacement."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


BRIDGE = Path(__file__).resolve().parents[1] / "sidecars" / "app-bridge" / "bridge.py"
PARENT_FIXTURE = r"""
import pathlib
import subprocess
import sys

bridge, pid_file, stdout_path, stderr_path = sys.argv[1:]
with open(stdout_path, "w", encoding="utf-8") as stdout, open(stderr_path, "w", encoding="utf-8") as stderr:
    child = subprocess.Popen([sys.executable, bridge], stdout=stdout, stderr=stderr)
pathlib.Path(pid_file).write_text(str(child.pid), encoding="utf-8")
sys.stdin.read()
"""
KERNEL_FIXTURE = "import sys; sys.stdin.read()"
AGENTAPI_FIXTURE = """#!/usr/bin/env python3
import os
from pathlib import Path
Path(os.environ['AGY_FIXTURE_AGENTAPI_LOG']).write_text('unexpected invocation', encoding='utf-8')
"""


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def close_process_pipes(process: subprocess.Popen) -> None:
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None and not stream.closed:
            stream.close()


def socket_accepts(path: Path) -> bool:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.2)
            client.connect(str(path))
        return True
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout, OSError):
        return False


class AppBridgeLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="agy-bridge-")
        self.root = Path(self.tempdir.name)
        self.socket_path = self.root / "bridge.sock"
        self.pid_sequence = 0
        self.hosts = []
        self.bridge_pids = []
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.agentapi_log = self.root / "agentapi-invoked.txt"
        agentapi = self.bin_dir / "agentapi"
        agentapi.write_text(AGENTAPI_FIXTURE, encoding="utf-8")
        agentapi.chmod(0o755)
        (self.bin_dir / "python3").symlink_to(sys.executable)
        self.env = {
            "PATH": f"{self.bin_dir}:/usr/bin:/bin",
            "HOME": str(self.root / "home"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "AGY_USE_SOCKET": str(self.socket_path),
            "ANTIGRAVITY_APP_DATA_DIR": str(self.root / "app-data"),
            "AGY_FIXTURE_AGENTAPI_LOG": str(self.agentapi_log),
        }
        self.kernel = subprocess.Popen(
            [sys.executable, "-c", KERNEL_FIXTURE],
            stdin=subprocess.PIPE,
            env=self.env,
        )

    def tearDown(self) -> None:
        for host in self.hosts:
            if host.poll() is None:
                try:
                    host.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                try:
                    host.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    host.terminate()
                    host.wait(timeout=2)
            close_process_pipes(host)
        for pid in self.bridge_pids:
            if pid_alive(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    continue
                deadline = time.monotonic() + 2
                while pid_alive(pid) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if pid_alive(pid):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        if self.kernel.poll() is None:
            self.kernel.stdin.close()
            try:
                self.kernel.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.kernel.terminate()
                self.kernel.wait(timeout=2)
        close_process_pipes(self.kernel)
        self.tempdir.cleanup()

    def _wait_for_socket(self, timeout: float = 5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if socket_accepts(self.socket_path):
                return True
            time.sleep(0.05)
        return socket_accepts(self.socket_path)

    def _wait_for_exit(self, pid: int, timeout: float = 5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not pid_alive(pid):
                return True
            time.sleep(0.05)
        return not pid_alive(pid)

    def _launch_host_and_bridge(self):
        self.pid_sequence += 1
        pid_file = self.root / f"bridge-{self.pid_sequence}.pid"
        host = subprocess.Popen(
            [
                sys.executable,
                "-c",
                PARENT_FIXTURE,
                str(BRIDGE),
                str(pid_file),
                str(self.root / f"bridge-{self.pid_sequence}.stdout"),
                str(self.root / f"bridge-{self.pid_sequence}.stderr"),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
            text=True,
        )
        self.hosts.append(host)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if pid_file.exists():
                try:
                    pid = int(pid_file.read_text(encoding="utf-8"))
                except ValueError:
                    pid = 0
                if pid > 0:
                    self.bridge_pids.append(pid)
                    self.assertTrue(self._wait_for_socket(), "fixture bridge did not bind its Unix socket")
                    return host, pid
            if host.poll() is not None:
                self.fail(f"fixture host exited early: {host.stderr.read()}")
            time.sleep(0.05)
        self.fail("fixture host did not publish its bridge pid")

    def _exit_host_normally(self, host) -> None:
        self.assertIsNone(host.poll())
        host.stdin.close()
        self.assertEqual(host.wait(timeout=5), 0)
        close_process_pipes(host)

    def _duplicate_start(self):
        return subprocess.run(
            [sys.executable, str(BRIDGE)],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    def test_host_exit_cleans_only_own_bridge_and_allows_handover(self) -> None:
        old_host, old_pid = self._launch_host_and_bridge()
        self.assertIsNone(old_host.poll())
        self.assertTrue(pid_alive(old_pid))

        duplicate = self._duplicate_start()
        self.assertEqual(duplicate.returncode, 1)
        self.assertIn("already listening", duplicate.stderr)
        self.assertTrue(pid_alive(old_pid), "duplicate startup interrupted the healthy bridge")

        for _ in range(2):
            self.assertTrue(socket_accepts(self.socket_path))
        time.sleep(1.2)
        self.assertTrue(pid_alive(old_pid), "a live parent or short client disconnect stopped the bridge")
        self.assertIsNone(self.kernel.poll())

        self._exit_host_normally(old_host)
        exited = self._wait_for_exit(old_pid, timeout=5)
        self.assertTrue(
            exited,
            json.dumps({
                "orphan_bridge_alive": pid_alive(old_pid),
                "orphan_socket_accepts": socket_accepts(self.socket_path),
                "parent_alive": old_host.poll() is None,
            }),
        )
        self.assertFalse(self.socket_path.exists())
        self.assertFalse(self.socket_path.with_suffix(".json").exists())
        self.assertIsNone(self.kernel.poll(), "bridge cleanup changed the independent kernel fixture")
        self.assertFalse(self.agentapi_log.exists(), "bridge cleanup invoked an operation or automatic resend")

        new_host, new_pid = self._launch_host_and_bridge()
        self.assertNotEqual(new_pid, old_pid)
        self.assertTrue(pid_alive(new_pid))
        self.assertTrue(socket_accepts(self.socket_path))
        duplicate_after_handover = self._duplicate_start()
        self.assertEqual(duplicate_after_handover.returncode, 1)
        self.assertTrue(pid_alive(new_pid))
        self.assertIsNone(self.kernel.poll())
        self.assertFalse(self.agentapi_log.exists())

        self._exit_host_normally(new_host)
        self.assertTrue(self._wait_for_exit(new_pid))
        self.assertIsNone(self.kernel.poll())
        self.assertFalse(self.agentapi_log.exists())


if __name__ == "__main__":
    unittest.main()
