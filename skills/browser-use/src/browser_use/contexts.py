"""Task-scoped session defaults; never inspect or release browser resources."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from .errors import BrowserUseError


_NAME = re.compile(r"[a-zA-Z0-9_-]{1,64}")
_MAX_BYTES = 4096
PROCESS_SESSION = "py_" + uuid.uuid4().hex


def _name(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise BrowserUseError("session 需要 1~64 个字母、数字、下划线或短横线", 2)
    return value


def _resolve_scope(scope):
    if scope is None:
        scope = os.environ.get("BROWSER_USE_CONTEXT_ID") or os.environ.get("DSH_SESSION_ID") or None
    if scope is None:
        return None
    if (not isinstance(scope, str) or not scope or len(scope) > 256
            or any(ord(char) < 32 or ord(char) == 127 for char in scope)):
        raise BrowserUseError("scope 必须是 1~256 个字符的非空任务标识，不能包含控制字符", 2)
    try:
        scope.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise BrowserUseError("scope 必须是有效 UTF-8 任务标识", 2) from exc
    return scope


def _required_scope(scope):
    resolved = _resolve_scope(scope)
    if resolved is None:
        raise BrowserUseError("没有任务 scope；请显式指定 --scope 或 --session，或设置 BROWSER_USE_CONTEXT_ID/DSH_SESSION_ID", 2)
    return resolved


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


class _SessionStore:
    def __init__(self, scope):
        self.path = Path.home() / ".local/state/browser-use/contexts" / (hashlib.sha256(scope.encode("utf-8")).hexdigest() + ".json")
        self.path = Path(os.path.abspath(self.path))
        self.name = self.path.name
        self.lock_name = self.name + ".lock"

    @staticmethod
    def _check_file(info):
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise BrowserUseError("会话账及锁必须由当前用户拥有、为单链接普通文件，权限精确为 600", 5)

    @staticmethod
    def _check_directory(info, private):
        mode = stat.S_IMODE(info.st_mode)
        if not stat.S_ISDIR(info.st_mode):
            raise BrowserUseError("会话账路径不是目录", 5)
        if private:
            if info.st_uid != os.getuid() or mode != 0o700:
                raise BrowserUseError("会话账目录必须由当前用户拥有，权限精确为 700", 5)
        elif (info.st_uid not in {0, os.getuid()}
              or (mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX))):
            raise BrowserUseError("会话账祖先目录归属或写权限不安全", 5)

    def _directory(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        directory = os.open(self.path.anchor, flags)
        try:
            parts = self.path.parent.parts[1:]
            for index, part in enumerate(parts):
                try:
                    child = os.open(part, flags, dir_fd=directory)
                except FileNotFoundError:
                    try:
                        os.mkdir(part, 0o700, dir_fd=directory)
                    except FileExistsError:
                        pass
                    else:
                        os.chmod(part, 0o700, dir_fd=directory, follow_symlinks=False)
                    child = os.open(part, flags, dir_fd=directory)
                try:
                    self._check_directory(os.fstat(child), index >= len(parts) - 2)
                except Exception:
                    os.close(child)
                    raise
                os.close(directory)
                directory = child
            return directory
        except Exception:
            os.close(directory)
            raise

    def _open_file(self, directory, name, create=False):
        flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        created = False
        if create:
            try:
                fd = os.open(name, flags | os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
                created = True
            except FileExistsError:
                fd = os.open(name, flags | os.O_RDWR, dir_fd=directory)
        else:
            fd = os.open(name, flags | os.O_RDONLY, dir_fd=directory)
        try:
            if created:
                os.fchmod(fd, 0o600)
            self._check_file(os.fstat(fd))
            return fd
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def _identity(info):
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns

    def _read(self, directory):
        try:
            fd = self._open_file(directory, self.name)
        except FileNotFoundError:
            return None, None
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            raw = source.read(_MAX_BYTES + 1)
        try:
            if len(raw) > _MAX_BYTES:
                raise ValueError("session state too large")
            record = json.loads(raw, object_pairs_hook=_pairs)
            if (not isinstance(record, dict) or set(record) != {"version", "automatic", "pinned"}
                    or type(record["version"]) is not int or record["version"] != 1):
                raise ValueError("invalid session metadata")
            _name(record["automatic"])
            if record["pinned"] is not None:
                _name(record["pinned"])
            return record, self._identity(info)
        except (ValueError, TypeError, BrowserUseError) as exc:
            raise BrowserUseError("会话账损坏或包含非许可字段；拒绝读写，也未重置", 5) from exc

    def _current(self, directory):
        try:
            info = os.stat(self.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        self._check_file(info)
        return self._identity(info)

    def _check_lock(self, directory, lock):
        info = os.stat(self.lock_name, dir_fd=directory, follow_symlinks=False)
        self._check_file(info)
        locked = os.fstat(lock)
        if (info.st_dev, info.st_ino) != (locked.st_dev, locked.st_ino):
            raise BrowserUseError("会话账锁已被替换，拒绝继续", 5)

    @contextmanager
    def transaction(self):
        directory = lock = None
        try:
            directory = self._directory()
            lock = self._open_file(directory, self.lock_name, create=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
            self._check_lock(directory, lock)
            record, previous = self._read(directory)
            yield directory, lock, record, previous
        except OSError as exc:
            raise BrowserUseError("会话账无法安全读写", 5) from exc
        finally:
            if lock is not None:
                os.close(lock)
            if directory is not None:
                os.close(directory)

    def write(self, directory, lock, record, previous):
        raw = (json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        temporary = "." + self.name + "." + uuid.uuid4().hex + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as destination:
                os.fchmod(destination.fileno(), 0o600)
                destination.write(raw)
                destination.flush()
                os.fsync(destination.fileno())
            self._check_lock(directory, lock)
            if self._current(directory) != previous:
                raise BrowserUseError("会话账在锁外被更改，拒绝覆盖", 5)
            os.replace(temporary, self.name, src_dir_fd=directory, dst_dir_fd=directory)
            try:
                os.fsync(directory)
            except OSError as exc:
                raise BrowserUseError("会话账已替换但目录同步失败，持久化结果未知", 5, outcome="unknown") from exc
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass


def _control(operation, name, scope, clear):
    store = _SessionStore(scope)
    with store.transaction() as (directory, lock, record, previous):
        changed = record is None
        if record is None:
            record = {"version": 1, "automatic": "task_" + uuid.uuid4().hex, "pinned": None}
        if operation == "use":
            pin = None if clear else name
            changed = changed or record["pinned"] != pin
            record["pinned"] = pin
        if changed:
            store.write(directory, lock, record, previous)
        pinned = record["pinned"]
        return {"ok": True, "scope": scope, "session": pinned or record["automatic"],
                "source": "pinned" if pinned is not None else "automatic", "pinned": pinned}


def choose_session(explicit=None, scope=None, allow_process_default=False) -> str:
    """Return explicit, task pin, stable task automatic, or opt-in process session."""
    if type(allow_process_default) is not bool:
        raise BrowserUseError("allow_process_default 必须是 bool", 2)
    if explicit is not None:
        return _name(explicit)
    resolved = _resolve_scope(scope)
    if resolved is not None:
        return _control("current", None, resolved, False)["session"]
    if allow_process_default:
        return PROCESS_SESSION
    raise BrowserUseError("没有任务 scope；请显式指定 --scope 或 --session，或设置 BROWSER_USE_CONTEXT_ID/DSH_SESSION_ID", 2)


def session_control(operation, name=None, scope=None, clear=False) -> dict:
    """Set/query one task default; clearing its pin never releases resources."""
    if not isinstance(operation, str) or operation not in {"current", "use"} or type(clear) is not bool:
        raise BrowserUseError("session 操作仅支持 current/use，clear 必须是 bool", 2)
    if operation == "current":
        if name is not None or clear:
            raise BrowserUseError("session current 不接受 name 或 clear", 2)
    elif clear:
        if name is not None:
            raise BrowserUseError("session use --clear 不能同时指定名字", 2)
    else:
        _name(name)
    return _control(operation, name, _required_scope(scope), clear)
