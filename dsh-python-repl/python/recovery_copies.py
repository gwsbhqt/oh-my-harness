"""Explicit, session-local copies of selected live variables."""
from __future__ import annotations

import json
import re
import sys
import tempfile
import uuid
from pathlib import Path

import lifecycle
import snapshot_refs

_ID = re.compile(r"[0-9a-f]{32}")
_PAYLOAD = "values.dill"
_MANIFEST = "manifest.json"


def _root() -> Path:
    location = lifecycle.state().dir
    if not location:
        raise RuntimeError("this kernel has no session state directory for copies")
    session = Path(location)
    root = session / "copies"
    if not session.is_absolute() or session.is_symlink() or root.is_symlink():
        raise ValueError("invalid session recovery copy directory")
    return root


def _manifest(folder: Path) -> dict:
    import rlm.repl as prime

    files = (folder / _PAYLOAD, folder / _MANIFEST)
    if (folder.is_symlink() or not folder.is_dir()
            or any(file.is_symlink() or not file.is_file() for file in files)):
        raise FileNotFoundError("no completed recovery copy with this ID in this session")
    if any(file.stat().st_size > prime.DEFAULT_SNAPSHOT_MAX_BYTES for file in files):
        raise ValueError("recovery copy exceeds the snapshot size cap")
    data = json.loads((folder / _MANIFEST).read_text(encoding="utf-8"))
    if (not isinstance(data, dict) or data.get("version") != 1 or data.get("copyId") != folder.name
            or data.get("session") != folder.parent.parent.name):
        raise ValueError("invalid recovery copy manifest for this session")
    names, skipped = data.get("savedNames"), data.get("skipped")
    if (not isinstance(names, list) or not all(type(name) is str for name in names) or len(set(names)) != len(names)
            or not isinstance(skipped, list) or not all(isinstance(item, dict) and type(item.get("name")) is str
                and type(item.get("reason")) is str for item in skipped)
            or data.get("bytes") != (folder / _PAYLOAD).stat().st_size):
        raise ValueError("invalid recovery copy manifest")
    return data


def list_copies() -> list[str]:
    root = _root()
    if not root.exists():
        return []
    ids = []
    for folder in root.iterdir():
        if _ID.fullmatch(folder.name):
            try:
                _manifest(folder)
            except (FileNotFoundError, ValueError):
                continue
            ids.append(folder.name)
    return sorted(ids)


def save(names: tuple[str, ...]) -> dict:
    import rlm.repl as prime

    if not names or any(type(name) is not str or not name for name in names):
        raise TypeError("repl.save_copy() needs one or more user variable names as strings")
    root = _root()
    if not snapshot_refs.install():
        raise RuntimeError("dill is unavailable for recovery copies")
    state = lifecycle.state()
    namespace = sys.modules["__main__"].__dict__
    selected = {}
    skipped = []
    for name in dict.fromkeys(names):
        if name == "_" or name.startswith("__") or name in prime._ALWAYS_SKIP or name in prime._RESTORE_SKIP:
            reason = "reserved kernel name"
        elif name in namespace:
            if namespace[name] is not namespace and namespace[name] is not sys.modules["__main__"]:
                selected[name] = namespace[name]
                continue
            reason = "the live global namespace cannot be copied as a value"
        elif name in state.archived:
            reason = "archived; explicitly unarchive it before saving a copy"
        elif state.protected:
            reason = "not in this kernel; check the failed names in the restore notice"
        else:
            reason = "not in this kernel"
        skipped.append({"name": name, "reason": reason})
    receipt = {"copy_id": None, "saved": [], "skipped": skipped}
    if not selected:
        return receipt

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".writing-", dir=root) as tmp:
        staging = Path(tmp)
        manifest_path = staging / _MANIFEST
        result = prime._snapshot_state(
            selected, str(staging / _PAYLOAD), str(manifest_path), prime.DEFAULT_SNAPSHOT_MAX_BYTES,
            prime.DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES, prune_oversized=False,
        )
        if "error" in result:
            raise OSError(result["error"])
        skipped.extend(result["skipped"])
        if not result["saved"]:
            return receipt
        copy_id = uuid.uuid4().hex
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(copyId=copy_id, session=root.parent.name, skipped=skipped)
        with manifest_path.open("w", encoding="utf-8") as stream:
            json.dump(manifest, stream)
        if manifest_path.stat().st_size > prime.DEFAULT_SNAPSHOT_MAX_BYTES:
            raise ValueError("recovery copy manifest exceeds the snapshot size cap")
        staging.rename(root / copy_id)
        return {"copy_id": copy_id, "saved": result["saved"], "skipped": skipped}


def read(copy_id: str) -> dict:
    if type(copy_id) is not str or not _ID.fullmatch(copy_id):
        raise ValueError("expected a copy ID returned by repl.save_copy() in this session")
    folder = _root() / copy_id
    manifest = _manifest(folder)
    if not snapshot_refs.install():
        raise RuntimeError("dill is unavailable for recovery copies")
    from python_repl_core.snapshot_names import read_snapshot_values

    with (folder / _PAYLOAD).open("rb") as stream:
        values, failed = read_snapshot_values(stream, manifest["savedNames"])
    return {"values": values, "failed": failed, "skipped": manifest["skipped"]}
