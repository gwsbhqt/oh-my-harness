"""Publish Prime's two files through a single POSIX symlink and keep their original public names."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import tempfile
import uuid
from datetime import datetime
from contextlib import ExitStack, contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path

_GENERATION = re.compile(r"[0-9a-f]{32}")
_registered = None


class SnapshotStoreError(OSError):
    """A stored pair cannot be resolved without risking a different generation."""


@dataclass(frozen=True)
class SnapshotPair:
    payload: Path
    manifest: Path
    generation: str | None = None


def register_snapshot(payload: Path, manifest: Path) -> None:
    """Register the stable session snapshot in this kernel; explicit copies stay separate."""
    global _registered
    _registered = _paths(payload, manifest)


def managed_pair(path) -> SnapshotPair | None:
    payload = Path(path).absolute()
    if _registered is not None and payload == _registered.payload:
        return _registered
    directory = os.environ.get("DSH_PYTHON_REPL_STATE_DIR")
    if directory and payload == Path(directory).absolute() / "kernel-state.dill":
        return SnapshotPair(payload, payload.with_name("kernel-state.json"))
    return None


def _paths(payload, manifest) -> SnapshotPair:
    payload, manifest = Path(payload).absolute(), Path(manifest).absolute()
    if payload.parent != manifest.parent or payload == manifest:
        raise SnapshotStoreError("snapshot data and manifest must be different names in the same directory")
    return SnapshotPair(payload, manifest)


def _store(pair: SnapshotPair) -> Path:
    key = hashlib.sha256(pair.payload.name.encode("utf-8")).hexdigest()
    return pair.payload.parent / (".snapshot-" + key)


def _mode(path: Path) -> int:
    try:
        return path.lstat().st_mode
    except FileNotFoundError:
        return 0


def _public_kind(path: Path, store: Path) -> str:
    mode = _mode(path)
    if not mode:
        return "absent"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode) and os.readlink(path) == f"{store.name}/current/{path.name}":
        return "alias"
    raise SnapshotStoreError(f"invalid snapshot file: {path}")


def _selected(store: Path) -> str | None:
    mode = _mode(store)
    if not mode:
        return None
    if not stat.S_ISDIR(mode):
        raise SnapshotStoreError(f"invalid snapshot store directory: {store}")
    current = store / "current"
    mode = _mode(current)
    if not mode:
        return None
    if not stat.S_ISLNK(mode):
        raise SnapshotStoreError("snapshot current is not a symlink")
    name = os.readlink(current)
    if (name not in ("legacy", "empty") and not _GENERATION.fullmatch(name)) or not stat.S_ISDIR(_mode(store / name)):
        raise SnapshotStoreError("invalid or missing snapshot generation")
    return name


def resolve_snapshot(payload: Path, manifest: Path) -> SnapshotPair | None:
    """Resolve one pair without writing. Use open_snapshot to retain that selection while reading it."""
    pair = _paths(payload, manifest)
    store = _store(pair)
    name = _selected(store)
    kinds = (_public_kind(pair.payload, store), _public_kind(pair.manifest, store))
    if name is None:
        if "alias" in kinds:
            raise SnapshotStoreError("snapshot current is missing")
        if kinds[0] == "file":
            return pair
        if kinds[1] != "absent":
            raise SnapshotStoreError("snapshot manifest has no data file")
        return None
    if name == "empty":
        if "file" in kinds:
            raise SnapshotStoreError("empty snapshot has conflicting public files")
        return None
    generation = store / name
    physical = SnapshotPair(generation / pair.payload.name, generation / pair.manifest.name, name)
    data_mode, meta_mode = _mode(physical.payload), _mode(physical.manifest)
    if name != "legacy" and kinds != ("alias", "alias"):
        raise SnapshotStoreError("published snapshot has missing or replaced public links")
    if not stat.S_ISREG(data_mode) or not (stat.S_ISREG(meta_mode) or (not meta_mode and name == "legacy")):
        raise SnapshotStoreError("incomplete or invalid published snapshot pair")
    if name == "legacy":
        for public, saved, kind in zip((pair.payload, pair.manifest), (physical.payload, physical.manifest), kinds):
            if (kind == "absent" and _mode(saved)) or (kind == "file" and not (_mode(saved) and public.samefile(saved))):
                raise SnapshotStoreError("legacy public file conflicts with the migrating snapshot")
    return physical


@contextmanager
def _locked_dir(path: Path, operation: int, *, nofollow: bool = True):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | (os.O_NOFOLLOW if nofollow else 0))
    try:
        fcntl.flock(fd, operation)
        yield fd
    finally:
        os.close(fd)


@contextmanager
def open_snapshot(payload: Path, manifest: Path, *, wait: bool = True):
    """Hold the selected generation against collection or reset. With wait=False, a busy lock raises BlockingIOError."""
    pair = _paths(payload, manifest)
    operation = fcntl.LOCK_SH if wait else fcntl.LOCK_SH | fcntl.LOCK_NB
    with ExitStack() as generation, ExitStack() as parent:
        try:
            parent.enter_context(_locked_dir(pair.payload.parent, operation, nofollow=False))
        except FileNotFoundError:
            yield None
            return
        selected = resolve_snapshot(pair.payload, pair.manifest)
        if selected is not None and selected.generation is not None:
            generation.enter_context(_locked_dir(selected.payload.parent, operation))
        if selected is None or selected.generation is not None:
            parent.close()
        yield selected


def read_manifest(pair: SnapshotPair) -> dict:
    legacy = pair.generation in (None, "legacy")
    try:
        data = json.loads(pair.manifest.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("not an object")
        if not legacy:
            if (data.get("version") != 1 or data.get("bytes") != pair.payload.stat().st_size
                    or not isinstance(data.get("timestamp"), str)
                    or not all(isinstance(data.get(key), list) and all(isinstance(n, str) for n in data[key])
                               for key in ("savedNames", "pruned"))
                    or not isinstance(data.get("skipped"), list)
                    or not all(isinstance(i, dict) and isinstance(i.get("name"), str) and isinstance(i.get("reason"), str)
                               for i in data["skipped"])):
                raise ValueError("invalid fields or size")
            datetime.fromisoformat(data["timestamp"].removesuffix("Z"))
        return data
    except (OSError, ValueError) as exc:
        if legacy:
            return {}
        raise SnapshotStoreError(f"invalid published snapshot manifest: {exc}") from exc


@contextmanager
def _writer(store: Path, operation=fcntl.LOCK_EX):
    # Reset can unlink the lock directory while another process is opening it. Check the inode after flock.
    while True:
        with _locked_dir(store.parent, operation, nofollow=False):
            store.mkdir(mode=0o700, exist_ok=True)
        with ExitStack() as owner:
            try:
                fd = owner.enter_context(_locked_dir(store, operation))
                current = store.lstat()
            except FileNotFoundError:
                continue
            if os.path.samestat(os.fstat(fd), current):
                yield
                return


def _link(target: str, name: Path, store: Path) -> None:
    temp = store / ".next-link"
    temp.unlink(missing_ok=True)
    try:
        temp.symlink_to(target)
        os.replace(temp, name)
    finally:
        temp.unlink(missing_ok=True)


def _initial_generation(pair: SnapshotPair, store: Path, old: SnapshotPair | None) -> str:
    name = "legacy" if old is not None else "empty"
    directory = store / name
    if directory.exists():  # A previous first save died before publishing this baseline.
        shutil.rmtree(directory)
    directory.mkdir(mode=0o700)
    if old is not None:
        for path in (pair.payload, pair.manifest):
            if _mode(path):
                os.link(path, directory / path.name, follow_symlinks=False)
    _link(name, store / "current", store)
    return name


def _install_public_links(pair: SnapshotPair, store: Path, changed: list) -> None:
    for path in (pair.payload, pair.manifest):
        kind = _public_kind(path, store)
        if kind != "alias":
            _link(f"{store.name}/current/{path.name}", path, store)
            changed.append((path, kind))


def _undo_links(store: Path, changed: list) -> None:
    for path, kind in reversed(changed):
        if kind == "file":
            temp = store / ".next-original"
            temp.unlink(missing_ok=True)
            os.link(store / "legacy" / path.name, temp)
            os.replace(temp, path)
        else:
            path.unlink(missing_ok=True)


def _discard_unpublished(store: Path) -> None:
    # This record's writer lock excludes every other staging writer, including prior processes that died.
    for path in store.glob(".writing-*"):
        if stat.S_ISDIR(_mode(path)):
            shutil.rmtree(path)
    pending = store / ".publishing"
    if _mode(pending):
        generation = os.readlink(pending)
        if not _GENERATION.fullmatch(generation):
            raise SnapshotStoreError("invalid pending snapshot generation")
        candidate = store / generation
        if generation != _selected(store) and stat.S_ISDIR(_mode(candidate)):
            shutil.rmtree(candidate)
        pending.unlink()


def _collect(store: Path, keep: set[str]) -> None:
    for path in store.iterdir():
        if path.name in keep or not (_GENERATION.fullmatch(path.name) or path.name in ("legacy", "empty") or path.name.startswith(".writing-")):
            continue
        try:
            with _locked_dir(path, fcntl.LOCK_EX | fcntl.LOCK_NB):
                shutil.rmtree(path)
        except (BlockingIOError, FileNotFoundError):
            continue


def publish_snapshot(pair: SnapshotPair, write_pair, committed=None, *, wait=True) -> dict:
    """Stage Prime's pair, then switch current; only the outer commit may acknowledge or prune."""
    store = _store(pair)
    store.parent.mkdir(parents=True, exist_ok=True)
    operation = fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB
    with _writer(store, operation), ExitStack() as cleanup:
        _discard_unpublished(store)
        staging = Path(cleanup.enter_context(tempfile.TemporaryDirectory(dir=store, prefix=".writing-")))
        data, meta = staging / pair.payload.name, staging / pair.manifest.name
        result = write_pair(data, meta)
        if "error" in result:
            return result
        generation = uuid.uuid4().hex
        read_manifest(SnapshotPair(data, meta, generation))
        with _locked_dir(store.parent, operation, nofollow=False):
            old = resolve_snapshot(pair.payload, pair.manifest)
            if old is not None and old.generation not in (None, "legacy"):
                read_manifest(old)
            previous = _selected(store)
            if previous is None:
                previous = _initial_generation(pair, store, old)
            changed = []
            _link(generation, store / ".publishing", store)
            staging.rename(store / generation)
            try:
                _install_public_links(pair, store, changed)
                # The local pointer and its receipt are one commit even when the host interrupts after rename.
                with ExitStack() as receipt:
                    if committed is not None:
                        handler = signal.signal(signal.SIGINT, lambda *_: None)
                        receipt.callback(signal.signal, signal.SIGINT, handler)
                    _link(generation, store / "current", store)
                    if committed is not None:
                        committed(result)
            except BaseException:
                if os.readlink(store / "current") != generation:
                    _undo_links(store, changed)
                raise
            finally:
                with suppress(OSError):
                    _discard_unpublished(store)
                    if os.readlink(store / "current") == generation:
                        _collect(store, {generation, previous})
        return result


def write_restart_snapshot(namespace: dict, payload: str, manifest: str) -> None:
    """Run Prime's installed serializer in the original kernel without arming its EOF save."""
    from rlm import repl

    result = repl._snapshot_state(namespace, payload, manifest, repl.DEFAULT_SNAPSHOT_MAX_BYTES,
                                  repl.DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES, False)
    if "error" in result:
        raise SnapshotStoreError(result["error"])


def try_publish_prepared_snapshot(pair: SnapshotPair, prepared: SnapshotPair) -> bool:
    """Publish the verified files without serializing again, or let an async host yield to another lock holder."""
    def link_files(data, manifest):
        os.link(prepared.payload, data)
        os.link(prepared.manifest, manifest)
        return {}

    try:
        publish_snapshot(pair, link_files, wait=False)
    except BlockingIOError:
        return False
    return True


def reset_snapshot(payload: Path, manifest: Path) -> None:
    """Forget this snapshot, waiting for its readers; leave sibling archives and explicit copies alone."""
    pair = _paths(payload, manifest)
    store = _store(pair)
    if not store.parent.is_dir() or not any(_mode(p) for p in (store, pair.payload, pair.manifest)):
        return
    with _writer(store):
        with _locked_dir(store.parent, fcntl.LOCK_EX, nofollow=False):
            if (store / "current").is_symlink():
                (store / "empty").mkdir(mode=0o700, exist_ok=True)
                _link("empty", store / "current", store)
            for path in (pair.payload, pair.manifest):
                path.unlink(missing_ok=True)
        # New readers now see empty. Readers of this generation alone delay its removal.
        for path in store.iterdir():
            if stat.S_ISDIR(_mode(path)) and (path.name == "legacy" or _GENERATION.fullmatch(path.name)):
                with _locked_dir(path, fcntl.LOCK_EX):
                    shutil.rmtree(path)
        with _locked_dir(store.parent, fcntl.LOCK_EX, nofollow=False):
            shutil.rmtree(store)
