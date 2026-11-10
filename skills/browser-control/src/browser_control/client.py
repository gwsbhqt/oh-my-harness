"""独立 Unix socket RPC 客户端；动作发出后不自动重发。"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time

from agentkit.remote import target

from .checks import number
from .browsers import lookup
from .errors import BrowserControlError

from .contexts import PROCESS_SESSION, choose_session
from .server import source_fingerprint

DEFAULT_SESSION = PROCESS_SESSION
LAUNCHER = Path(__file__).resolve().parents[2] / "scripts" / "browser-control"
if not LAUNCHER.is_file():
    LAUNCHER = Path(__file__).with_name("_launcher.py")
MAX_REPLY = 64 * 1024 * 1024
DRAIN_WAIT = 30


def default_socket() -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))).expanduser()
    if not base.is_absolute():
        raise BrowserControlError("XDG_CACHE_HOME 必须是绝对路径", 2)
    return base / "browser-control" / "daemon.sock"


def routing():
    """共用选机实现。"""
    return target


def resolve_host(host=None):
    try:
        return routing().resolve_target("browser-control", host)
    except (ValueError, OSError) as exc:
        raise BrowserControlError(str(exc), 2, host=host, outcome="not_sent") from exc


def validate_context(session=None, browser="Chrome", host=None):
    session = choose_session(session, allow_process_default=True)
    if not isinstance(session, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", session):
        raise BrowserControlError("session 只允许 1~64 位字母、数字、下划线和连字符", 2)
    lookup(browser)
    host = resolve_host(host)
    return session, browser, host


def prepare_socket_directory(path: Path):
    parent = path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = parent.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BrowserControlError("socket 目录必须是当前用户拥有的真实目录", 5)
    if stat.S_IMODE(info.st_mode) != 0o700:
        if path == default_socket():
            parent.chmod(0o700)
        else:
            raise BrowserControlError("自定义 socket 目录权限必须为 700，请使用专用私有目录", 5)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise BrowserControlError("socket 路径已被非 socket 文件或其他用户占用，未删除", 5)


class Client:
    def __init__(self, socket_path=None, *, autostart=True, startup_timeout=15):
        self.socket_path = Path(socket_path).expanduser().absolute() if socket_path is not None else default_socket()
        self.autostart = autostart
        self.startup_timeout = float(number(startup_timeout, 'timeout', 0, low_open=True))
        self._process = None
        self._checked = None

    def _roundtrip(self, conn, payload, deadline):
        conn.sendall(payload)
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("等待完整响应超时")
            conn.settimeout(remaining)
            chunk = conn.recv(min(65536, MAX_REPLY+1-size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if b"\n" in chunk or size > MAX_REPLY:
                break
        line = b"".join(chunks)
        if not line or len(line) > MAX_REPLY or not line.endswith(b"\n"):
            raise ValueError("服务返回为空、过长或不完整")
        reply = json.loads(line)
        if not isinstance(reply, dict) or not isinstance(reply.get("ok"), bool):
            raise ValueError("服务响应不是有效 RPC 对象")
        return reply

    def service(self, op="info", *, timeout=10):
        """查询或排空本机服务；不发浏览器动作。旧服务不认识这个请求时如实返回 supported=False。"""
        if op not in ("info", "drain"):
            raise BrowserControlError("service 只支持 info / drain", 2)
        payload = (json.dumps({"action": "service", "params": {"op": op}}) + "\n").encode()
        conn = self._ensure(float(number(timeout, 'timeout', 0, low_open=True)))
        with conn:
            try:
                reply = self._roundtrip(conn, payload, time.monotonic() + timeout)
            except (OSError, ValueError, UnicodeError) as exc:
                raise BrowserControlError(f"查询 browser-control 服务版本失败：{exc}", 4, outcome="unknown") from exc
        if not reply["ok"]:
            return {"supported": False, "error": reply.get("error")}
        return {"supported": True, **reply["result"]}

    def _check_version(self):
        """默认服务跑的是旧代码就请求排空；不强停、不改连别的服务。每次调用都重算本地指纹，源码改了的同一个客户端也能发现。"""
        local = source_fingerprint()
        if self._checked == local:
            return
        info = self.service("info")
        if not info["supported"]:
            raise BrowserControlError("本机 browser-control 服务是不支持安全更新的旧版本；不能排空切换，也不会强停它。等它空闲 30 分钟自己退出后再试，或由用户决定是否手动重启", 5,
                          outcome="not_sent", data={"localFingerprint": local, "serviceError": info.get("error")})
        if info["fingerprint"] == local:
            self._checked = local
            return
        if not info["draining"]:
            self.service("drain")

    def _service_gone(self):
        """旧服务进程是否已彻底结束：它退出前一直持有服务锁，进程号可能变成僵尸仍在，锁不会。"""
        startup = self.socket_path.with_name(self.socket_path.name + ".startup.lock")
        service = self.socket_path.with_name(self.socket_path.name + ".lock")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            startup_fd = os.open(startup, flags | os.O_CREAT, 0o600)
        except OSError:
            return False
        try:
            # 持启动锁再探服务锁，免得短暂的共享锁撞上别的客户端正拉起的新服务。
            try:
                fcntl.flock(startup_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            try:
                service_fd = os.open(service, flags)
            except FileNotFoundError:
                return True
            except OSError:
                return False
            try:
                fcntl.flock(service_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            finally:
                os.close(service_fd)
            return True
        finally:
            os.close(startup_fd)

    def _peek_info(self):
        """不拉起服务地读一次版本与持有情况；读不到返回 None。"""
        try:
            with self._connect(2) as conn:
                reply = self._roundtrip(conn, b'{"action": "service", "params": {"op": "info"}}\n', time.monotonic() + 2)
        except (OSError, ValueError, UnicodeError):
            return None
        return reply.get("result") if reply["ok"] else None

    def _wait_for_drained(self, refusal, deadline):
        """新任务被排空中的旧服务拒绝后，等它退出；动作还没发出，等到了由调用方重新核对版本再发。"""
        started = time.monotonic()
        while time.monotonic() < deadline:
            if self._service_gone():
                self._checked = None
                return
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        data = dict(refusal.get("data") or {})
        info = self._peek_info()
        if info:
            data.update(pid=info.get("pid"), holdings=info.get("holdings"), waitingFor=info.get("waitingFor"))
        who = "、".join(data.get("waitingFor") or []) or "它自己收尾"
        raise BrowserControlError(f"等了 {time.monotonic() - started:.0f} 秒，旧版 browser-control 服务（进程 {data.get('pid', '未知')}）还没退出，本次未执行。"
                      f"它在等这些任务 release：{who}。名单里有你自己的任务就先对它 release，否则稍后重试；不要 kill 服务",
                      5, outcome="not_sent", data={**data, "draining": True, "waited": round(time.monotonic() - started, 1)})

    def _connect(self, timeout):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(timeout)
        try:
            conn.connect(str(self.socket_path))
        except BaseException:
            conn.close()
            raise
        return conn

    def _ensure(self, timeout):
        prepare_socket_directory(self.socket_path)
        try:
            return self._connect(timeout)
        except OSError as exc:
            if exc.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                raise BrowserControlError(f"无法连接 browser-control 服务：{exc}", 5) from exc
            if not self.autostart:
                raise BrowserControlError("browser-control 服务未运行；请运行 scripts/browser-control serve --socket PATH", 5) from exc
        lock_path = self.socket_path.with_name(self.socket_path.name + ".startup.lock")
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise BrowserControlError(f"无法打开启动锁：{exc}", 5) from exc
        deadline = time.monotonic() + min(timeout, self.startup_timeout)
        with os.fdopen(fd, "a+") as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise BrowserControlError("启动锁必须是当前用户拥有的普通文件", 5)
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise BrowserControlError("等待 browser-control 启动锁超时；本次动作尚未发出", 4)
                    time.sleep(0.03)
            try:
                return self._connect(timeout)
            except OSError as exc:
                if exc.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                    raise BrowserControlError(f"无法连接 browser-control 服务：{exc}", 5) from exc
            if not LAUNCHER.is_file():
                raise BrowserControlError(f"缺少 browser-control 启动器：{LAUNCHER}", 5)
            log_path = self.socket_path.with_name(self.socket_path.name + ".log")
            log_fd = os.open(log_path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(log_fd, "ab") as log:
                os.fchmod(log.fileno(), 0o600)
                self._process = subprocess.Popen([sys.executable, str(LAUNCHER), "serve", "--socket", str(self.socket_path)],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            while time.monotonic() < deadline:
                try:
                    return self._connect(timeout)
                except OSError as exc:
                    if exc.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                        raise BrowserControlError(f"browser-control 启动后连接失败：{exc}", 5) from exc
                if self._process.poll() is not None:
                    detail = log_path.read_text(errors="replace")[-4000:]
                    raise BrowserControlError(f"browser-control 服务启动失败（退出 {self._process.returncode}）：{detail}", 5)
                time.sleep(0.03)
            raise BrowserControlError(f"browser-control 服务未在 {self.startup_timeout:g} 秒内就绪；动作未发出，诊断见 {log_path}", 4)

    def call(self, action, params=None, *, target=None, session=None, browser="Chrome", host=None, timeout=60, remote_stages=None):
        timeout = float(number(timeout, 'timeout', 0, low_open=True))
        session, browser, host = validate_context(session, browser, host)
        if not isinstance(action, str) or not action:
            raise BrowserControlError("action 不能为空", 2)
        if target is not None and (not isinstance(target, str) or not target):
            raise BrowserControlError("target 必须是非空标签页 ID", 2)
        request = dict(session=session, browser=browser, host=host, action=action, params=params or {})
        if target is not None:
            request["target"] = target
        if remote_stages is not None:
            request["remoteStages"] = remote_stages
        try:
            payload = (json.dumps(request, ensure_ascii=False, allow_nan=False) + "\n").encode()
        except (ValueError, TypeError) as exc:
            raise BrowserControlError(f"参数不能转换成 JSON：{exc}", 2) from exc
        if host != "local":
            if self.socket_path != default_socket():
                raise BrowserControlError("--socket 是本机连接参数，不能与远程主机混用", 2, command=action, host=host, outcome="not_sent")
            from .transport import RemoteTransport
            return RemoteTransport().call(request, timeout=timeout)
        started = time.monotonic()
        drain_deadline = None
        while True:
            self._check_version()
            payload = (json.dumps({**request, "expectFingerprint": self._checked}, ensure_ascii=False, allow_nan=False) + "\n").encode()
            conn = self._ensure(timeout)
            with conn:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise BrowserControlError("连接准备超过 timeout；本次动作尚未发出", 4)
                conn.settimeout(remaining)
                try:
                    reply = self._roundtrip(conn, payload, started + timeout)
                except (OSError, ValueError, UnicodeError) as exc:
                    raise BrowserControlError(f"browser-control 请求发出后断连或超时：{exc}；执行结果未知，未重发，请先取态核对", 4,
                                  outcome="unknown") from exc
            data = reply.get("data") or {}
            if reply["ok"] or not data.get("draining") or reply.get("outcome") != "not_sent":
                break
            if drain_deadline is None:
                drain_deadline = min(time.monotonic() + DRAIN_WAIT, started + timeout)
            self._wait_for_drained(reply, drain_deadline)
        if not reply["ok"]:
            if (reply.get("data") or {}).get("versionMismatch"):
                self._checked = None
            raise BrowserControlError(reply.get("error", "browser-control 服务执行失败"), reply.get("code", 1),
                          outcome=reply.get("outcome"), data=reply.get("data"), command=reply.get("command", action), host=reply.get("host", host))
        if "result" not in reply:
            raise BrowserControlError("服务缺少 result；执行结果未知，未重发", 4, outcome="unknown")
        return reply["result"]

    async def acall(self, *args, **kwargs):
        """取消只停止等待；线程里的已发动作可能继续，调用方必须核对。"""
        return await asyncio.to_thread(self.call, *args, **kwargs)


_default_client = None


def get_client():
    global _default_client
    if _default_client is None:
        _default_client = Client()
    return _default_client
