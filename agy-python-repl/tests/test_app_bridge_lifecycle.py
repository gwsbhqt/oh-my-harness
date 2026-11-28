"""Integration coverage for sidecar ownership across a host replacement."""

from dataclasses import dataclass, field
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


BRIDGE = Path(__file__).resolve().parents[1] / "sidecars" / "app-bridge" / "bridge.py"
PARENT_FIXTURE = r"""
import os
import subprocess
import sys

channel_fd, wrapper, bridge, stdout_path, stderr_path = sys.argv[1:]
channel_fd = int(channel_fd)
try:
    with open(stdout_path, "w", encoding="utf-8") as stdout, open(stderr_path, "w", encoding="utf-8") as stderr:
        child = subprocess.Popen(
            [sys.executable, "-c", wrapper, str(channel_fd), bridge],
            pass_fds=(channel_fd,),
            stdout=stdout,
            stderr=stderr,
        )
finally:
    os.close(channel_fd)
sys.stdin.read()
"""
BRIDGE_WRAPPER = r"""
import os
import runpy
import signal
import sys
import threading

channel_fd = int(sys.argv[1])
bridge = sys.argv[2]
sys.argv = [bridge]


def control_channel():
    try:
        while os.read(channel_fd, 4096):
            pass
    except OSError:
        return
    timer = threading.Timer(2.0, lambda: signal.raise_signal(signal.SIGKILL))
    timer.daemon = True
    timer.start()
    signal.raise_signal(signal.SIGTERM)


threading.Thread(target=control_channel, name="fixture-control", daemon=True).start()
try:
    runpy.run_path(bridge, run_name="__main__")
except SystemExit as exc:
    code = exc.code if exc.code is not None else 0
    if not isinstance(code, int):
        code = 1
    os.write(channel_fd, f"{code}\n".encode("ascii"))
    raise
except BaseException:
    os.write(channel_fd, b"error\n")
    raise
else:
    os.write(channel_fd, b"0\n")
"""
KERNEL_FIXTURE = "import sys; sys.stdin.read()"
AGENTAPI_FIXTURE = """#!/usr/bin/env python3
import os
from pathlib import Path
Path(os.environ['AGY_FIXTURE_AGENTAPI_LOG']).write_text('unexpected invocation', encoding='utf-8')
"""


@dataclass
class BridgeFixture:
    host: subprocess.Popen
    channel: socket.socket
    stdout_path: Path
    stderr_path: Path
    exit_data: bytearray = field(default_factory=bytearray)
    exit_eof: bool = False


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
        self.bridge_sequence = 0
        self.bridges = []
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
        for fixture in self.bridges:
            host = fixture.host
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
        for fixture in self.bridges:
            if not self._poll_exit(fixture):
                try:
                    fixture.channel.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                self._wait_for_exit(fixture, timeout=4)
            fixture.channel.close()
        if self.kernel.poll() is None:
            self.kernel.stdin.close()
            try:
                self.kernel.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.kernel.terminate()
                self.kernel.wait(timeout=2)
        close_process_pipes(self.kernel)
        self.tempdir.cleanup()

    def _poll_exit(self, fixture: BridgeFixture) -> bool:
        if fixture.exit_eof:
            return True
        while True:
            try:
                chunk = fixture.channel.recv(64)
            except BlockingIOError:
                return False
            if not chunk:
                fixture.exit_eof = True
                return True
            fixture.exit_data.extend(chunk)
            if len(fixture.exit_data) > 64:
                self.fail("fixture bridge returned an invalid lifecycle report")

    def _wait_for_exit(self, fixture: BridgeFixture, timeout: float = 5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._poll_exit(fixture):
                return True
            time.sleep(0.05)
        return self._poll_exit(fixture)

    def _wait_for_socket(self, fixture: BridgeFixture, timeout: float = 5) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if socket_accepts(self.socket_path):
                return True
            if self._poll_exit(fixture) or fixture.host.poll() is not None:
                break
            time.sleep(0.05)
        return socket_accepts(self.socket_path)

    def _launch_host_and_bridge(self) -> BridgeFixture:
        self.bridge_sequence += 1
        channel, child_channel = socket.socketpair()
        channel.setblocking(False)
        stdout_path = self.root / f"bridge-{self.bridge_sequence}.stdout"
        stderr_path = self.root / f"bridge-{self.bridge_sequence}.stderr"
        try:
            host = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    PARENT_FIXTURE,
                    str(child_channel.fileno()),
                    BRIDGE_WRAPPER,
                    str(BRIDGE),
                    str(stdout_path),
                    str(stderr_path),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(child_channel.fileno(),),
                env=self.env,
                text=True,
            )
        except BaseException:
            channel.close()
            raise
        finally:
            child_channel.close()
        fixture = BridgeFixture(host, channel, stdout_path, stderr_path)
        self.bridges.append(fixture)
        self.assertTrue(
            self._wait_for_socket(fixture),
            f"fixture bridge did not bind its Unix socket; "
            f"exit report={bytes(fixture.exit_data)!r}; stderr={stderr_path.read_text(encoding='utf-8')}",
        )
        return fixture

    def _exit_host_normally(self, host: subprocess.Popen) -> None:
        self.assertIsNone(host.poll())
        host.stdin.close()
        self.assertEqual(host.wait(timeout=5), 0)
        close_process_pipes(host)

    def _duplicate_start(self) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(BRIDGE)],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    def _assert_clean_bridge_exit(self, fixture: BridgeFixture) -> None:
        self.assertTrue(self._wait_for_exit(fixture))
        self.assertEqual(bytes(fixture.exit_data), b"0\n")

    def test_host_exit_cleans_only_own_bridge_and_allows_handover(self) -> None:
        old_bridge = self._launch_host_and_bridge()
        self.assertIsNone(old_bridge.host.poll())
        self.assertFalse(self._poll_exit(old_bridge))

        duplicate = self._duplicate_start()
        self.assertEqual(duplicate.returncode, 1)
        self.assertIn("already listening", duplicate.stderr)
        self.assertFalse(self._poll_exit(old_bridge), "duplicate startup interrupted the healthy bridge")

        for _ in range(2):
            self.assertTrue(socket_accepts(self.socket_path))
        time.sleep(1.2)
        self.assertFalse(self._poll_exit(old_bridge), "a live parent or short client disconnect stopped the bridge")
        self.assertIsNone(self.kernel.poll())

        self._exit_host_normally(old_bridge.host)
        exited = self._wait_for_exit(old_bridge, timeout=5)
        self.assertTrue(
            exited,
            json.dumps({
                "orphan_bridge_alive": not self._poll_exit(old_bridge),
                "orphan_socket_accepts": socket_accepts(self.socket_path),
                "orphan_exit_report": bytes(old_bridge.exit_data).decode("ascii", errors="replace"),
                "parent_alive": old_bridge.host.poll() is None,
            }),
        )
        self.assertEqual(bytes(old_bridge.exit_data), b"0\n")
        self.assertFalse(self.socket_path.exists())
        self.assertFalse(self.socket_path.with_suffix(".json").exists())
        self.assertIsNone(self.kernel.poll(), "bridge cleanup changed the independent kernel fixture")
        self.assertFalse(self.agentapi_log.exists(), "bridge cleanup invoked an operation or automatic resend")

        new_bridge = self._launch_host_and_bridge()
        self.assertFalse(self._poll_exit(new_bridge))
        self.assertTrue(socket_accepts(self.socket_path))
        duplicate_after_handover = self._duplicate_start()
        self.assertEqual(duplicate_after_handover.returncode, 1)
        self.assertFalse(self._poll_exit(new_bridge))
        self.assertIsNone(self.kernel.poll())
        self.assertFalse(self.agentapi_log.exists())

        self._exit_host_normally(new_bridge.host)
        self._assert_clean_bridge_exit(new_bridge)
        self.assertFalse(self.socket_path.exists())
        self.assertFalse(self.socket_path.with_suffix(".json").exists())
        self.assertIsNone(self.kernel.poll())
        self.assertFalse(self.agentapi_log.exists())


if __name__ == "__main__":
    unittest.main()
