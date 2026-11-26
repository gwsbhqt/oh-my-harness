"""Locate a conversation's on-disk snapshot without starting a kernel."""

from __future__ import annotations

import hashlib
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


def flat_names(data_dir: Path) -> set[str]:
    directory = data_dir / "snapshots"
    candidates = {p.stem for p in directory.glob("*.dill")}
    candidates.update(p.name.removesuffix(".manifest.json") for p in directory.glob("*.manifest.json"))
    return {
        name for name in candidates if name and all(ch.isalnum() or ch in "-_" for ch in name)
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
    if old in flat_names(data_dir):
        return old, Path(old)
    if ("__" not in name and len(name) + len(".manifest.json") <= 255
            and re.fullmatch(r"[a-z0-9_-]+", name)):
        plain = Path(name)
        plain_snapshot, manifest = snapshot_paths(data_dir, plain)
        # A different spelling may exist on a case- or normalization-insensitive volume.
        if not plain_snapshot.exists() and (
            not manifest.exists() or any(p.name == manifest.name for p in manifest.parent.glob("*.manifest.json"))
        ):
            return name, plain
    return name, storage
