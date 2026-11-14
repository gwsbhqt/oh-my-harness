"""Minimal crash-recovery metadata; never persist page content or infer ownership.

The caller records immediately after createTarget, before attaching or navigating.
Only owned records in the current browser UUID may be used for release recovery;
this ledger never restores an action binding or closes a browser target itself.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit
import uuid

from .browsers import NAMES as BROWSER_NAMES
from .errors import BrowserUseError


_FIELDS = {"scope", "owner", "targetId", "owned", "browser"}
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_OWNER = re.compile(r"[a-zA-Z0-9_-]{1,64}")
_TARGET = re.compile(r"[a-zA-Z0-9_-]{1,256}")
_MAX_BYTES = 8 * 1024 * 1024


def _scope(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise BrowserUseError("资源 scope 必须是实际 browser WebSocket 中的 UUID，不能只用端口", 2)
    return str(uuid.UUID(value))


def scope_from_websocket(url):
    """Return the canonical browser UUID, not an endpoint/port or page UUID."""
    if not isinstance(url, str):
        raise BrowserUseError("需要实际 browser WebSocket URL", 2)
    try:
        parsed = urlsplit(url)
        port = parsed.port
        valid = (parsed.scheme in {"ws", "wss"} and parsed.hostname
                 and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment)
        prefix = "/devtools/browser/"
        if not valid or not parsed.path.startswith(prefix):
            raise ValueError("not a browser WebSocket")
        return _scope(parsed.path[len(prefix):])
    except (ValueError, TypeError) as exc:
        raise BrowserUseError("需要包含 /devtools/browser/<UUID> 的实际 browser WebSocket URL", 2) from exc


def _record(scope, owner, target_id, owned, browser):
    scope = _scope(scope)
    if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
        raise BrowserUseError("资源 owner 需要 1~64 个字母、数字、下划线或短横线", 2)
    if not isinstance(target_id, str) or not _TARGET.fullmatch(target_id):
        raise BrowserUseError("资源 target_id 必须是准确页面 ID", 2)
    if type(owned) is not bool or browser not in BROWSER_NAMES:
        raise BrowserUseError(f"资源 owned 必须是 bool，browser 必须是 {'、'.join(BROWSER_NAMES)}", 2)
    return {"scope": scope, "owner": owner, "targetId": target_id,
            "owned": owned, "browser": browser}


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class ResourceLedger:
    """Private, locked JSON ledger. Unsafe or corrupt existing state fails closed.

    path is a JSON file, defaulting to ~/.local/state/browser-use/resources.json.
    Existing parent must be owned by this UID and exactly 0700; files must be
    singly linked regular files owned by this UID and exactly 0600. Existing
    unsafe permissions are rejected, not repaired. All operations reopen and
    validate state under a separate stable .lock inode before read-modify-write.
    """

    scope_from_websocket = staticmethod(scope_from_websocket)

    def __init__(self, path=None):
        self.path = Path(path) if path is not None else Path.home() / ".local/state/browser-use/resources.json"
        self.path = self.path.expanduser()
        if ".." in self.path.parts:
            raise BrowserUseError("资源账路径不能包含 ..", 5)
        self.path = Path(os.path.abspath(self.path))
        if not self.path.name or self.path.name in {".", ".."}:
            raise BrowserUseError("资源账需要 JSON 文件路径", 5)
        self._name = self.path.name
        self._lock_name = self._name + ".lock"
        with self._transaction():
            pass

    @staticmethod
    def _check_file(info):
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise BrowserUseError("资源账及锁必须是当前用户拥有的单链接普通文件，权限精确为 600", 5)

    @staticmethod
    def _check_dir(info, final):
        mode = stat.S_IMODE(info.st_mode)
        if not stat.S_ISDIR(info.st_mode):
            raise BrowserUseError("资源账路径不是目录", 5)
        if final:
            if info.st_uid != os.getuid() or mode != 0o700:
                raise BrowserUseError("资源账目录必须由当前用户拥有，权限精确为 700", 5)
        elif (info.st_uid not in {0, os.getuid()}
              or (mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX))):
            raise BrowserUseError("资源账祖先目录归属或写权限不安全", 5)

    def _directory(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(self.path.anchor, flags)
        try:
            parts = self.path.parent.parts[1:]
            for index, part in enumerate(parts):
                try:
                    child = os.open(part, flags, dir_fd=fd)
                except FileNotFoundError:
                    created = False
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                        created = True
                    except FileExistsError:
                        pass
                    if created:
                        # A restrictive umask can remove read/search permission before open.
                        os.chmod(part, 0o700, dir_fd=fd, follow_symlinks=False)
                    child = os.open(part, flags, dir_fd=fd)
                try:
                    self._check_dir(os.fstat(child), index == len(parts) - 1)
                except Exception:
                    os.close(child)
                    raise
                os.close(fd)
                fd = child
            if not parts:
                self._check_dir(os.fstat(fd), True)
            return fd
        except Exception:
            os.close(fd)
            raise

    def _open_file(self, directory, name, *, create=False):
        flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        created = False
        if create:
            try:
                fd = os.open(name, flags | os.O_RDWR | os.O_CREAT | os.O_EXCL,
                             0o600, dir_fd=directory)
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
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _read(self, directory):
        try:
            fd = self._open_file(directory, self._name)
        except FileNotFoundError:
            return [], None
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            raw = source.read(_MAX_BYTES + 1)
        try:
            if len(raw) > _MAX_BYTES:
                raise ValueError("ledger too large")
            records = json.loads(raw, object_pairs_hook=_pairs)
            if not isinstance(records, list):
                raise ValueError("ledger root must be a list")
            keys = set()
            targets = set()
            for item in records:
                if not isinstance(item, dict) or set(item) != _FIELDS:
                    raise ValueError("unexpected metadata fields")
                checked = _record(item["scope"], item["owner"], item["targetId"],
                                  item["owned"], item["browser"])
                if item != checked:
                    raise ValueError("noncanonical metadata")
                key = (item["scope"], item["owner"], item["targetId"])
                target = (item["scope"], item["targetId"])
                if key in keys or target in targets:
                    raise ValueError("duplicate target ownership")
                keys.add(key)
                targets.add(target)
            return records, self._identity(info)
        except (ValueError, TypeError, KeyError, BrowserUseError) as exc:
            raise BrowserUseError("资源账损坏或包含非许可 metadata；拒绝恢复，也未重置", 5) from exc

    def _current(self, directory):
        try:
            info = os.stat(self._name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        self._check_file(info)
        return self._identity(info)

    @contextmanager
    def _transaction(self):
        directory = lock = None
        try:
            directory = self._directory()
            lock = self._open_file(directory, self._lock_name, create=True)
            fcntl.flock(lock, fcntl.LOCK_EX)
            info = os.stat(self._lock_name, dir_fd=directory, follow_symlinks=False)
            self._check_file(info)
            locked = os.fstat(lock)
            if (info.st_dev, info.st_ino) != (locked.st_dev, locked.st_ino):
                raise BrowserUseError("资源账锁发生替换，拒绝继续", 5)
            records, previous = self._read(directory)
            yield directory, records, previous
        except OSError as exc:
            raise BrowserUseError(f"资源账不可安全读写：{exc}", 5) from exc
        finally:
            if lock is not None:
                os.close(lock)
            if directory is not None:
                os.close(directory)

    def _write(self, directory, records, previous):
        raw = (json.dumps(records, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        if len(raw) > _MAX_BYTES:
            raise BrowserUseError("资源账超过安全大小限制，未写入", 5)
        temporary = "." + self._name + "." + uuid.uuid4().hex + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as destination:
                os.fchmod(destination.fileno(), 0o600)
                destination.write(raw)
                destination.flush()
                os.fsync(destination.fileno())
            if self._current(directory) != previous:
                raise BrowserUseError("资源账在锁外被更改，拒绝覆盖", 5)
            os.replace(temporary, self._name, src_dir_fd=directory, dst_dir_fd=directory)
            try:
                os.fsync(directory)
            except OSError as exc:
                raise BrowserUseError("资源账已替换但目录同步失败，持久化结果未知", 5, outcome="unknown") from exc
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass

    def record(self, scope, owner, target_id, owned, browser):
        """Upsert one exact ownership record and return an independent copy."""
        item = _record(scope, owner, target_id, owned, browser)
        with self._transaction() as (directory, records, previous):
            for index, existing in enumerate(records):
                if (existing["scope"], existing["targetId"]) != (item["scope"], target_id):
                    continue
                if existing["owner"] != owner or existing["browser"] != browser:
                    raise BrowserUseError("页面已有其他归属记录，拒绝覆盖", 6)
                records[index] = item
                break
            else:
                records.append(item)
            self._write(directory, records, previous)
        return dict(item)

    def remove(self, scope, owner, target_id):
        """Remove only the exact scope/owner/target tuple; return whether it existed."""
        key = _record(scope, owner, target_id, False, "Chrome")
        with self._transaction() as (directory, records, previous):
            remaining = [item for item in records if not all(item[name] == key[name]
                         for name in ("scope", "owner", "targetId"))]
            if len(remaining) == len(records):
                return False
            self._write(directory, remaining, previous)
            return True

    def prune(self, select):
        """Remove the records chosen by select(records) and return them.

        select runs under the ledger lock, so liveness checks inside it see every
        record written before the lock and none written while it decides.
        """
        with self._transaction() as (directory, records, previous):
            chosen = select([dict(item) for item in records])
            keys = {(item["scope"], item["owner"], item["targetId"]) for item in chosen}
            remaining = [item for item in records if (item["scope"], item["owner"], item["targetId"]) not in keys]
            removed = [dict(item) for item in records if (item["scope"], item["owner"], item["targetId"]) in keys]
            if removed:
                self._write(directory, remaining, previous)
            return removed

    def list(self, scope, owner=None):
        """Return metadata copies from one browser instance, optionally one owner."""
        scope = _scope(scope)
        if owner is not None and (not isinstance(owner, str) or not _OWNER.fullmatch(owner)):
            raise BrowserUseError("资源 owner 无效", 2)
        with self._transaction() as (_, records, _previous):
            return [dict(item) for item in records if item["scope"] == scope
                    and (owner is None or item["owner"] == owner)]
