"""本机私有 Unix socket 服务；不会接管其他 browser-use 服务的 socket。"""
from __future__ import annotations
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import stat
import threading
import time
from .engine import Engine
from .errors import BrowserUseError

MAX_REQUEST = 2 * 1024 * 1024
IDLE_TIMEOUT = 30 * 60
# 没人占着页面或自启 Chrome 时，留着服务只省一次重连；2 分钟盖得住同一任务两次调用之间模型思考的空档，
# 又不会让用完的空服务或代码已更新的旧服务多挂半小时。
EMPTY_IDLE_TIMEOUT = 2 * 60
SOURCE_ROOT = Path(__file__).resolve().parent
SHARED_ROOT = SOURCE_ROOT.parents[2] / "_shared" / "agentkit"


def source_fingerprint(roots=(SOURCE_ROOT, SHARED_ROOT)):
    """src/browser_use 与共用 agentkit 下全部 .py 内容的哈希；服务和客户端各算一次，不同就说明服务跑的是旧代码。"""
    import hashlib
    digest = hashlib.sha256()
    for root in roots:
        for file in sorted(root.rglob("*.py")):
            if "__pycache__" in file.parts:
                continue
            digest.update(root.name.encode() + b"/" + file.relative_to(root).as_posix().encode() + b"\0" + file.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def draining_message(engine):
    """排空拒绝时说清在等谁、怎么解开；占用者通常就是调用方自己早先开的任务。"""
    waiting = engine.blockers()
    who = "、".join(waiting) if waiting else "正在收尾，马上退出"
    return (f"旧版 browser-use 服务（进程 {os.getpid()}）正在排空，本次未执行。还在等：{who}。"
            "这些任务 release 后它就退出，新版服务接手；名单里如果有你自己的任务，先对它 release。"
            "不要 kill 服务，也不用等别的会话")


def serve(socket_path, *, idle_timeout=IDLE_TIMEOUT, empty_idle_timeout=EMPTY_IDLE_TIMEOUT):
    path = Path(socket_path).expanduser().absolute()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink() or path.parent.stat().st_uid != os.getuid():
        raise BrowserUseError("browser-use socket 目录归属不安全", 6)
    if stat.S_IMODE(path.parent.stat().st_mode) != 0o700:
        raise BrowserUseError("browser-use 服务需要独立的700权限私有目录，不修改其他目录权限", 6)
    lock_path = path.with_suffix(path.suffix + ".lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "a") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise BrowserUseError("服务锁必须是当前用户普通文件", 6)
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BrowserUseError("同一地址已有 browser-use 服务在运行", 6)
        if path.exists() or path.is_symlink():
            if path.is_symlink() or not path.is_socket() or path.stat().st_uid != os.getuid():
                raise BrowserUseError("现有 socket 路径不是本用户 socket，拒绝覆盖", 6)
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.5)
                probe.connect(str(path))
            except (ConnectionRefusedError, FileNotFoundError):
                path.unlink()
            else:
                raise BrowserUseError("已有可连接服务，拒绝覆盖 socket", 6)
            finally:
                probe.close()
        engine = Engine(sweep=True)
        fingerprint = source_fingerprint()
        started_at = time.time()
        draining = engine.draining
        connections = set()
        connections_lock = threading.Lock()
        last_activity = [time.monotonic()]
        def control(request):
            """服务级请求：查版本与持有情况、请求排空；其余返回 None 交给引擎。"""
            if not isinstance(request, dict) or request.get("action") != "service":
                return None
            op = (request.get("params") or {}).get("op", "info")
            if op == "drain":
                draining.set()
            elif op != "info":
                return BrowserUseError("service 只支持 info / drain", 2, outcome="not_sent").as_dict()
            return {"ok": True, "result": {"fingerprint": fingerprint, "pid": os.getpid(), "parentPid": os.getppid(), "startedAt": started_at,
                                           "draining": draining.is_set(), "holdings": engine.holdings(), "waitingFor": engine.blockers()}}
        class Handler(socketserver.StreamRequestHandler):
            def setup(self):
                super().setup()
                self.served = False
                with connections_lock:
                    connections.add(self.request)

            def finish(self):
                with connections_lock:
                    connections.discard(self.request)
                    if self.served:
                        last_activity[0] = time.monotonic()
                super().finish()

            def handle(self):
                self.request.settimeout(5)
                try:
                    line = self.rfile.readline(MAX_REQUEST + 1)
                except (TimeoutError, OSError):
                    return
                self.request.settimeout(180)
                if not line:
                    return
                if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                    reply = BrowserUseError("请求过大或未完整换行", 2).as_dict()
                else:
                    try:
                        request = json.loads(line)
                        reply = control(request)
                        expected = request.get("expectFingerprint") if isinstance(request, dict) else None
                        if reply is None and expected is not None and expected != fingerprint:
                            # 客户端以为连的是另一版服务（期间服务被换过）；不执行，让客户端重新核对版本。
                            reply = BrowserUseError("browser-use 服务版本和客户端记住的不一致；本次未执行，请重试", 5, outcome="not_sent",
                                            data={"fingerprint": fingerprint, "expected": expected, "versionMismatch": True}).as_dict()
                        if reply is None and draining.is_set() and not engine.holds(request):
                            reply = BrowserUseError(draining_message(engine), 5, outcome="not_sent",
                                            data={"draining": True, "fingerprint": fingerprint, "pid": os.getpid(), "holdings": engine.holdings(),
                                                  "waitingFor": engine.blockers()}).as_dict()
                        if reply is None:
                            self.served = True
                            reply = engine.dispatch(request)
                    except (UnicodeError, json.JSONDecodeError) as exc:
                        reply = BrowserUseError(f"JSON 格式错误：{exc}", 2).as_dict()
                try:
                    self.wfile.write(json.dumps(reply, ensure_ascii=False).encode() + b"\n")
                except (BrokenPipeError, ConnectionResetError):
                    # 调用者离开不重放动作；终态仅由新调用观察。
                    pass
        class Server(socketserver.ThreadingUnixStreamServer):
            daemon_threads = False
            block_on_close = True

            def service_actions(self):
                with connections_lock:
                    quiet = not connections
                    quiet_for = time.monotonic() - last_activity[0]
                if (getattr(engine, "attach_lost", lambda: False)()
                        and not getattr(engine, "has_live_browser", lambda: False)() and not stopping.is_set()):
                    stopping.set()
                    threading.Thread(target=self.shutdown, daemon=True).start()
                    return
                idle = engine.idle()
                limits = [idle_timeout, empty_idle_timeout] if idle else [idle_timeout]
                expired = quiet and (not getattr(engine, "keep_shared_alive", lambda: False)() or draining.is_set()) and (any(0 < limit <= quiet_for for limit in limits) or (draining.is_set() and idle))
                if expired and not stopping.is_set():
                    stopping.set()
                    threading.Thread(target=self.shutdown, daemon=True).start()
        old_mask = os.umask(0o077)
        try:
            server = Server(str(path), Handler)
        finally:
            os.umask(old_mask)
        os.chmod(path, 0o600)
        socket_inode = path.stat().st_ino
        stopping = threading.Event()
        def stop(signum, frame):
            if not stopping.is_set():
                stopping.set()
                with connections_lock:
                    for conn in tuple(connections):
                        try:
                            conn.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            server.server_close()
            try:
                engine.close()
            finally:
                if path.exists() and path.is_socket() and path.stat().st_ino == socket_inode:
                    path.unlink()
