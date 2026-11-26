"""Locate a conversation's on-disk snapshot without starting a kernel."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from python_repl_core.snapshot_store import SnapshotStoreError, resolve_snapshot


NAMED_DIR = "named-v2"


def named_storage(name: str) -> Path:
    return Path(NAMED_DIR) / hashlib.sha256(name.encode("utf-8")).hexdigest()


def snapshot_paths(data_dir: Path, storage: Path) -> tuple[Path, Path]:
    stem = data_dir / "snapshots" / storage
    return stem.with_name(stem.name + ".dill"), stem.with_name(stem.name + ".manifest.json")


def has_snapshot(payload: Path, manifest: Path) -> bool:
    try:
        return resolve_snapshot(payload, manifest) is not None
    except (FileNotFoundError, NotADirectoryError):
        # A concurrent reset or an unavailable parent leaves no record at this spelling.
        return False
    except SnapshotStoreError:
        # A damaged commit keeps its original name so the owner can inspect or reset it.
        return True


def _flat_name(name: str) -> bool:
    return bool(name) and all(ch.isalnum() or ch in "-_" for ch in name)


def _flat_spelling(payload: Path, manifest: Path) -> bool | None:
    """True for an exact directory entry, False for a spelling collision, None if absent."""
    if os.path.lexists(payload) or os.path.lexists(manifest):
        try:
            with os.scandir(payload.parent) as entries:
                return any(entry.name == payload.name or entry.name == manifest.name for entry in entries)
        except (FileNotFoundError, NotADirectoryError):
            pass  # A concurrent reset removed the directory after the metadata check.
    return None


def flat_names(data_dir: Path) -> set[str]:
    directory = data_dir / "snapshots"
    candidates = {p.stem for p in directory.glob("*.dill")}
    candidates.update(p.name.removesuffix(".manifest.json") for p in directory.glob("*.manifest.json"))
    return {
        name for name in candidates if _flat_name(name)
        and has_snapshot(*snapshot_paths(data_dir, Path(name)))
    }


def kernel_identity(data_dir: Path, name: str) -> tuple[str, Path]:
    storage = named_storage(name)
    snapshot, manifest = snapshot_paths(data_dir, storage)
    marker = snapshot.with_suffix(".name")
    if marker.is_file() or has_snapshot(snapshot, manifest):
        if marker.read_bytes() != name.encode("utf-8"):
            raise ValueError("Snapshot name record does not match the requested kernel")
        return name, storage

    # Only the first colon is the hook's scope separator. All other characters are literal.
    old = name.replace(":", "__", 1)
    if not _flat_name(old):
        return name, storage
    plain = Path(old)
    pair = snapshot_paths(data_dir, plain)
    exact = _flat_spelling(*pair)
    if exact is True and has_snapshot(*pair):
        return old, plain
    if (exact is not False and "__" not in name and len(name) + len(".manifest.json") <= 255
            and re.fullmatch(r"[a-z0-9_-]+", name)):
        return name, plain
    return name, storage
