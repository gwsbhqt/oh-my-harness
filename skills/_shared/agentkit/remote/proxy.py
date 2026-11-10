"""Task-owned reverse SSH forwarding of an explicit caller-side HTTP proxy."""

import asyncio
import ipaddress
import math
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .ssh import PRELUDE, SSH_OPTS
from .target import resolve_target


def _proxy_target(url):
    if not isinstance(url, str) or any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise ValueError("local_proxy must be an HTTP URL without whitespace")
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or not parsed.hostname or not parsed.port
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("local_proxy must be http://LOOPBACK:PORT without credentials or path")
    name = parsed.hostname
    if name != "localhost" and not ipaddress.ip_address(name).is_loopback:
        raise ValueError("local_proxy must address a proxy on this machine's loopback")
    target = f"[{name}]" if ":" in name else name
    return name, parsed.port, f"{target}:{parsed.port}"


def _loopback_listeners(text, port):
    names = [line[1:] for line in text.splitlines() if line.startswith("n")]
    allowed = {f"127.0.0.1:{port}", f"[::1]:{port}"}
    if not names or not set(names).issubset(allowed):
        raise RuntimeError("reverse proxy listener is missing or not loopback-only: " + repr(names))


class ReverseProxy:
    """One-shot async context; open/close own one SSH process and its private socket."""

    def __init__(self, *, host, local_proxy, timeout=30):
        if not isinstance(host, str) or not host or "," in host or host == "local":
            raise ValueError("reverse_proxy requires one explicit remote SSH alias")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a finite positive number of seconds")
        self.host = resolve_target("remote-host", host)
        self._local_host, self._local_port, self._target = _proxy_target(local_proxy)
        self.timeout = timeout
        self.port = None
        self._proc = None
        self._directory = None
        self._log = None
        self._socket = None
        self._used = False
        self.closed = False

    @property
    def alive(self):
        return not self.closed and self.port is not None and self._proc is not None and self._proc.returncode is None

    @property
    def url(self):
        if not self.alive:
            raise RuntimeError("reverse proxy is not open")
        return f"http://127.0.0.1:{self.port}"

    @property
    def env(self):
        """Environment for a remote child only; never modifies either machine's globals."""
        url = self.url
        return {**{key: url for key in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")},
                "no_proxy": "", "NO_PROXY": ""}

    async def _command(self, *args, script=None):
        proc = await asyncio.create_subprocess_exec(
            # The private master already resolved authentication/routing. Do not load configured
            # forwards again, and never fall back to a second connection if its socket vanishes.
            "ssh", "-F", "/dev/null", *SSH_OPTS, "-S", str(self._socket),
            "-o", "ControlMaster=no", "-o", "ProxyCommand=false",
            "-o", "ForwardAgent=no", "-o", "ForkAfterAuthentication=no",
            *args, stdin=asyncio.subprocess.PIPE if script is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(None if script is None else script.encode()), self.timeout)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
        if proc.returncode:
            raise RuntimeError(f"reverse proxy SSH command exited {proc.returncode}: {err.decode(errors='replace')}")
        return out.decode(errors="replace")

    async def open(self):
        if self._used:
            raise RuntimeError("reverse proxy handles cannot be reopened")
        self._used = True
        opened = False
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(self._local_host, self._local_port), self.timeout)
            writer.close()
            await writer.wait_closed()
            # Keep the control socket below Unix-domain path limits on macOS.
            self._directory = Path(tempfile.mkdtemp(prefix="remote-host-proxy-", dir="/tmp"))
            self._socket = self._directory / "ssh"
            self._log = (self._directory / "ssh.log").open("w+b")
            self._proc = await asyncio.create_subprocess_exec(
                "ssh", *SSH_OPTS, "-M", "-S", str(self._socket), "-N", "-T",
                "-o", "ControlPersist=no", "-o", "ForkAfterAuthentication=no",
                "-o", "ClearAllForwardings=yes",
                "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes",
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", self.host,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=self._log)
            deadline = asyncio.get_running_loop().time() + self.timeout
            while not self._socket.exists():
                if self._proc.returncode is not None:
                    self._log.seek(0)
                    raise RuntimeError("reverse proxy SSH exited: " + self._log.read().decode(errors="replace"))
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError("reverse proxy SSH startup timed out")
                await asyncio.sleep(0.05)
            allocated = (await self._command("-O", "forward", "-R", f"127.0.0.1:0:{self._target}", self.host)).strip()
            if not allocated.isascii() or not allocated.isdecimal() or not 1 <= int(allocated) <= 65535:
                raise RuntimeError("SSH did not return an allocated remote port: " + repr(allocated))
            self.port = int(allocated)
            listeners = await self._command(self.host, "exec /bin/sh -s", script=PRELUDE +
                f"exec lsof -nP -a -iTCP:{self.port} -sTCP:LISTEN -Fn\n")
            _loopback_listeners(listeners, self.port)
            if self._proc.returncode is not None:
                raise RuntimeError("reverse proxy SSH exited during startup")
            opened = True
            return self
        finally:
            # Also runs for cancellation; a partial startup never escapes as a usable handle.
            if not opened:
                await self.close()

    async def close(self):
        """Terminate and reap only our master; repeat calls are safe."""
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), 5)
            except asyncio.TimeoutError:
                self._proc.kill()
                await self._proc.wait()
        if self._log is not None:
            self._log.close()
            self._log = None
        if self._directory is not None:
            shutil.rmtree(self._directory)
            self._directory = None
        self.closed = True

    async def __aenter__(self):
        return await self.open()

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()
