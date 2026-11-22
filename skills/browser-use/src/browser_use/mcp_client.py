"""Newline-delimited MCP over a client-owned local subprocess."""
from __future__ import annotations

import asyncio
import atexit
from contextlib import suppress
from functools import partial
import ipaddress
from itertools import count
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import threading
from urllib.parse import urlsplit

from .protocol import BrowserError


_GOOGLE_VERSION = "1.13.0"
_PROTOCOL = "2025-11-25"
_SUPPORTED_PROTOCOLS = {_PROTOCOL, "2025-06-18", "2025-03-26", "2024-11-05"}
_MAX_FRAME = 32 * 1024 * 1024
_STDERR_LIMIT = 8192
_loop_lock = threading.Lock()
_io_loop = None


def cra_command(*, socket=None, executable=None) -> list[str]:
    """Connect Cra's stdio bridge to an already-running profile's Unix socket."""
    if executable is None:
        bundles = (Path("/Applications/Cra.app"), Path.home() / "Applications/Cra.app")
        executable = next((p for p in bundles if p.is_dir()), bundles[0])
    if not os.fspath(executable):
        raise BrowserError("invalid_arguments", "The Cra executable cannot be empty")
    program = Path(executable).expanduser()
    if program.suffix == ".app":
        program = program / "Contents/MacOS/Cra"
    if socket is None:
        socket = Path.home() / "Library/Application Support/Cra/mcp.sock"
    if not os.fspath(socket):
        raise BrowserError("invalid_arguments", "The Cra socket path cannot be empty")
    return [str(program), "--mcp", str(Path(socket).expanduser())]


def google_command(endpoint, *, executable=None) -> list[str]:
    """Attach to a loopback Chrome endpoint using an installed binary or the offline npm cache."""
    try:
        if not isinstance(endpoint, str) or re.search(r"[\s\x00-\x1f\\]", endpoint):
            raise ValueError
        url = urlsplit(endpoint)
        host = url.hostname
        if not host or not url.port or url.username is not None or url.password is not None or url.fragment:
            raise ValueError
        authority_host = f"[{host}]" if ":" in host else host
        if url.netloc.rpartition(":")[0].lower() != authority_host:
            raise ValueError
        if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
            raise ValueError
        if url.scheme in ("http", "https") and url.path in ("", "/") and not url.query:
            option = "--browser-url"
        elif url.scheme in ("ws", "wss") and re.fullmatch(r"/devtools/browser/[^/]+", url.path):
            option = "--ws-endpoint"
        else:
            raise ValueError
    except ValueError:
        raise BrowserError(
            "invalid_arguments", "Expected a loopback Chrome debugging URL with an explicit port (HTTP origin or browser WebSocket)",
        ) from None

    if executable is not None and not os.fspath(executable):
        raise BrowserError("invalid_arguments", "The MCP executable cannot be empty")
    program = executable if executable is not None else shutil.which("chrome-devtools-mcp") or shutil.which("npx")
    if not program:
        raise BrowserError("connection_failed", f"Install chrome-devtools-mcp {_GOOGLE_VERSION} or provide npx")
    program = str(Path(program).expanduser())
    command = [program]
    if Path(program).name in ("npx", "npx.cmd"):
        command += ["--offline", "--yes", f"chrome-devtools-mcp@{_GOOGLE_VERSION}"]
    return [
        *command, f"{option}={endpoint}", "--page-id-routing", "--experimental-structured-content",
        "--category-network-mocks", "--experimental-vision", "--screenshot-max-width=1280", "--screenshot-max-height=1280",
        "--no-usage-statistics", "--no-performance-crux",
    ]


def _reset_after_fork():
    global _io_loop, _loop_lock
    _io_loop = None
    _loop_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)


def _submit(coro):
    # A notebook can replace its event loop between cells. All pipes and futures
    # stay on one I/O loop for the lifetime of this interpreter.
    global _io_loop
    with _loop_lock:
        if _io_loop is None:
            _io_loop = asyncio.new_event_loop()
            threading.Thread(target=_io_loop.run_forever, name="browser-use-stdio", daemon=True).start()
    return asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, _io_loop))


def _frame(message):
    try:
        raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise BrowserError("invalid_arguments", f"Invalid JSON for MCP: {exc}") from exc
    if len(raw) > _MAX_FRAME:
        raise BrowserError("invalid_arguments", f"MCP message exceeds {_MAX_FRAME} bytes")
    return raw + b"\n"


def _invalid_number(value):
    raise ValueError(f"Invalid JSON number {value}")


def _signal_owned(process, *, force, owner):
    if os.getpid() != owner:
        return
    with suppress(ProcessLookupError):
        if os.name == "posix":
            # npx may start a second process that inherits both pipes.
            os.killpg(process.get_pid(), signal.SIGKILL if force else signal.SIGTERM)
        elif process.get_returncode() is None:
            (process.kill if force else process.terminate)()


class _Pipes(asyncio.SubprocessProtocol):
    def __init__(self, client):
        self.client = client
        self.writable = asyncio.Event()
        self.writable.set()
        self.closed = asyncio.get_running_loop().create_future()
        self.partial = bytearray()
        self.exit_timer = None

    def connection_made(self, transport):
        self.transport = transport
        self.stdin = transport.get_pipe_transport(0)

    def pause_writing(self):
        self.writable.clear()

    def resume_writing(self):
        self.writable.set()

    def pipe_data_received(self, fd, data):
        if fd == 2:
            self.client._stderr = (self.client._stderr + data)[-_STDERR_LIMIT:]
            return
        if self.client._terminal:
            return
        try:
            for index, part in enumerate(data.split(b"\n")):
                if index:
                    self.client._receive(self.partial)
                    self.partial.clear()
                if len(self.partial) + len(part) > _MAX_FRAME:
                    raise ValueError(f"MCP response exceeds {_MAX_FRAME} bytes")
                self.partial.extend(part)
        except (ValueError, RecursionError, BrowserError) as exc:
            self.client._end("protocol_error", f"Invalid MCP response: {exc}")
        except OSError as exc:
            self.client._end("connection_lost", f"MCP pipe failed: {exc}")

    def pipe_connection_lost(self, fd, exc):
        if fd == 1:
            if self.partial:
                self.client._end("protocol_error", "Incomplete MCP frame at end of stdout")
            else:
                self.client._end("connection_lost", "MCP server closed stdout")
        elif fd == 0:
            self.writable.set()

    def process_exited(self):
        # A final reply may already be in the pipe. Give it time to drain even
        # when a surviving launcher child keeps the file descriptors open.
        if not self.client._terminal:
            message = f"MCP process exited with status {self.transport.get_returncode()}"
            self.exit_timer = asyncio.get_running_loop().call_later(0.25, self.client._end, "connection_lost", message)

    def connection_lost(self, exc):
        if self.exit_timer:
            self.exit_timer.cancel()
        self.closed.set_result(None)


class StdioMcp:
    """One MCP connection, owned until aclose(), across calls and caller loops.

    The timeout is in seconds, including handshake and writes. A timeout,
    cancellation or broken stream closes this connection and all pending calls.
    After a tool request enters the pipe its outcome may be unknown. Create a new
    instance to open a new session. env, when given, replaces the inherited env.
    """

    def __init__(self, argv, *, env=None, timeout=60.0):
        if isinstance(argv, (str, bytes, os.PathLike)) or not argv:
            raise BrowserError("invalid_arguments", "Expected an MCP command and its arguments as a sequence")
        if type(timeout) not in (int, float) or not 0 < timeout < math.inf:
            raise BrowserError("invalid_arguments", "MCP timeout must be a positive finite number of seconds")
        try:
            self._argv = tuple(os.fspath(part) for part in argv)
        except TypeError as exc:
            raise BrowserError("invalid_arguments", "MCP arguments must be strings or paths") from exc
        if not self._argv or not self._argv[0]:
            raise BrowserError("invalid_arguments", "The MCP command cannot be empty")
        self._env = dict(os.environ if env is None else env)
        self._env.update(
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS="1",
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS="1",
            CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY="1",
        )
        self._timeout = timeout
        self._starting = asyncio.Lock()
        self._writing = asyncio.Lock()
        self._ids = count(1)
        self._pending = {}
        self._owner = os.getpid()
        self._spawn = self._pipes = None
        self._stderr = b""
        self._initialized = False
        self._terminal = self._closing = self._exit_hook = None

    async def call(self, name: str, arguments: dict) -> dict:
        """Return the native CallToolResult, including any isError or image blocks."""
        if os.getpid() != self._owner:
            raise BrowserError("connection_lost", "MCP connection belongs to another process")
        if not isinstance(name, str) or not name or not isinstance(arguments, dict):
            raise BrowserError("invalid_arguments", "Expected a tool name and an arguments object")
        try:
            return await _submit(self._call(name, arguments))
        except asyncio.CancelledError:
            await self.aclose()
            raise

    async def aclose(self):
        """Close the owned MCP process and reap its process group on POSIX."""
        if os.getpid() == self._owner:
            await asyncio.shield(_submit(self._close()))

    async def _close(self):
        await asyncio.shield(self._end("connection_lost", "MCP connection closed", graceful=not self._pending))

    def _end(self, code, message, *, graceful=False):
        if self._closing is None:
            self._terminal = (code, message)
            if self._pipes:
                self._pipes.writable.set()
                self._pipes.partial.clear()
            for reply in self._pending.values():
                if not reply.done():
                    reply.set_result(None)
            self._closing = asyncio.create_task(self._shutdown(graceful))
        return self._closing

    def _closed_error(self, outcome="not_sent"):
        data = {"stderr": self._stderr.decode("utf-8", "replace")} if self._stderr else None
        return BrowserError(*self._terminal, outcome=outcome, data=data)

    async def _call(self, name, arguments):
        deadline = asyncio.get_running_loop().time() + self._timeout
        try:
            async with asyncio.timeout_at(deadline):
                async with self._starting:
                    if self._terminal:
                        raise self._closed_error()
                    if not self._initialized:
                        await self._initialize(deadline)
        except asyncio.CancelledError:
            self._end("connection_lost", "MCP initialization cancelled")
            raise
        except TimeoutError as exc:
            await asyncio.shield(self._end("timeout", "MCP initialization timed out"))
            raise self._closed_error() from exc
        except (OSError, ValueError, TypeError) as exc:
            await asyncio.shield(self._end("connection_failed", f"Cannot start MCP process: {exc}"))
            raise self._closed_error() from exc
        except BrowserError as exc:
            await asyncio.shield(self._end(exc.code, str(exc)))
            raise
        result = await self._request("tools/call", {"name": name, "arguments": arguments}, deadline)
        if not isinstance(result.get("content"), list):
            await asyncio.shield(self._end("protocol_error", "MCP tool result has no content array"))
            raise self._closed_error("unknown")
        return result

    async def _initialize(self, deadline):
        loop = asyncio.get_running_loop()
        self._pipes = _Pipes(self)
        self._spawn = asyncio.create_task(loop.subprocess_exec(
            lambda: self._pipes, *self._argv, env=self._env, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=os.name == "posix",
        ))
        process, _ = await asyncio.shield(self._spawn)
        if self._terminal:
            raise self._closed_error()
        self._exit_hook = partial(_signal_owned, process, owner=self._owner, force=True)
        atexit.register(self._exit_hook)
        result = await self._request("initialize", {
            "protocolVersion": _PROTOCOL, "capabilities": {}, "clientInfo": {"name": "browser-use", "version": "1"},
        }, deadline)
        version = result.get("protocolVersion")
        capabilities = result.get("capabilities")
        if not isinstance(version, str) or version not in _SUPPORTED_PROTOCOLS:
            raise BrowserError("protocol_error", "MCP server did not negotiate a supported protocol version")
        if not isinstance(capabilities, dict) or not isinstance(capabilities.get("tools"), dict):
            raise BrowserError("protocol_error", "MCP server did not advertise a tools capability")
        info = result.get("serverInfo")
        if not isinstance(info, dict) or not isinstance(info.get("name"), str) or not isinstance(info.get("version"), str):
            raise BrowserError("protocol_error", "MCP initialize result has no server identity")
        if info["name"] == "chrome_devtools" and info["version"] != _GOOGLE_VERSION:
            raise BrowserError("protocol_error", f"Expected chrome-devtools-mcp {_GOOGLE_VERSION}, received {info['version']}")
        await self._pipes.writable.wait()
        if self._terminal:
            raise self._closed_error()
        self._pipes.stdin.write(_frame({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self._initialized = True

    async def _request(self, method, params, deadline):
        request_id = next(self._ids)
        raw = _frame({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        reply = asyncio.get_running_loop().create_future()
        outcome = "not_sent"
        try:
            async with asyncio.timeout_at(deadline):
                async with self._writing:
                    await self._pipes.writable.wait()
                    if self._pipes.transport.get_returncode() is not None:
                        raise BrowserError("connection_lost", "MCP process has already exited")
                    if self._pipes.stdin.is_closing():
                        self._end("connection_lost", "MCP server closed stdin")
                    if self._terminal:
                        raise self._closed_error()
                    if asyncio.get_running_loop().time() >= deadline:
                        raise TimeoutError
                    self._pending[request_id] = reply
                    if method == "tools/call":
                        outcome = "unknown"
                    self._pipes.stdin.write(raw)
                response = await reply
        except TimeoutError as exc:
            await asyncio.shield(self._end("timeout", f"MCP {method} timed out"))
            raise self._closed_error(outcome) from exc
        except asyncio.CancelledError:
            if method == "tools/call":
                self._end("connection_lost", "MCP tools/call cancelled")
            raise
        except OSError as exc:
            await asyncio.shield(self._end("connection_lost", f"MCP pipe write failed: {exc}"))
            raise self._closed_error(outcome) from exc
        finally:
            self._pending.pop(request_id, None)
        if response is None:
            await asyncio.shield(self._closing)
            raise self._closed_error(outcome)
        if "error" in response:
            error = response["error"]
            raise BrowserError("protocol_error", error["message"], outcome=outcome, data=error)
        return response["result"]

    def _receive(self, frame):
        message = json.loads(frame.decode("utf-8"), parse_constant=_invalid_number)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise ValueError("invalid JSON-RPC envelope")
        if "method" in message:
            if not isinstance(message["method"], str):
                raise ValueError("invalid JSON-RPC method")
            if "id" in message:
                if message["method"] == "ping":
                    response = {"result": {}}
                else:
                    response = {"error": {"code": -32601, "message": "Method not found"}}
                if self._pipes.stdin.get_write_buffer_size() > _MAX_FRAME:
                    raise ValueError("MCP peer is not reading client responses")
                self._pipes.stdin.write(_frame({"jsonrpc": "2.0", "id": message["id"], **response}))
            return
        request_id = message.get("id")
        if type(request_id) is not int or request_id not in self._pending:
            raise ValueError("unexpected MCP response ID")
        reply = self._pending[request_id]
        if reply.cancelled():
            return
        if reply.done():
            raise ValueError("duplicate MCP response ID")
        if "error" in message:
            error = message["error"]
            if "result" in message or not isinstance(error, dict):
                raise ValueError("invalid JSON-RPC error")
            if type(error.get("code")) is not int or not isinstance(error.get("message"), str):
                raise ValueError("invalid JSON-RPC error code or message")
        elif not isinstance(message.get("result"), dict):
            raise ValueError("invalid MCP response result")
        reply.set_result(message)

    async def _shutdown(self, graceful):
        if self._spawn is None:
            return
        try:
            process, pipes = await self._spawn
        except (OSError, ValueError, TypeError):
            return
        try:
            if not pipes.stdin.is_closing():
                if graceful:
                    pipes.stdin.close()
                    with suppress(TimeoutError):
                        await asyncio.wait_for(asyncio.shield(pipes.closed), 0.5)
                else:
                    pipes.stdin.abort()
            _signal_owned(process, owner=self._owner, force=False)
            with suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(pipes.closed), 0.5)
            _signal_owned(process, owner=self._owner, force=True)
            process.close()
            await pipes.closed
        finally:
            if self._exit_hook:
                atexit.unregister(self._exit_hook)
