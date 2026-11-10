"""Name lifecycle for long sessions: archive what a user cell has not used for a while, delete it later.

Measured on 219 long sessions (2026-11-03): 96% of reuses happen within 100
cells and 98% within 200, while a long session ends with about 68% of its
names untouched for 100+ cells. So a name unused for `archive_after` user cells
leaves the namespace for its own archive file and stops being restored; one
unused for `delete_after` cells is dropped, leaving only a tombstone line.
Pinned names (repl.keep) are never touched.

"Used" is read from the cell's source before it runs: every global name it
reads or writes, plus the globals of the session's own functions it calls
(three levels). That is lexical, so an unexecuted branch counts as use — the
safe direction. A cell that reads an archived name gets it back before its
code runs.

Kernel-side, outside the frozen upstream tree. State sits next to the
namespace snapshot (DSH_PYTHON_REPL_STATE_DIR): lifecycle.json plus one dill
file per archived name under archive/. Without that directory the lifecycle
is off. Counted in user cells, never in time: an idle session keeps everything.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import sys
import types

STATE_FILE = "lifecycle.json"
ARCHIVE_DIR = "archive"
STATE_VERSION = 1
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_DELETED = 2000
_USER_CELL = re.compile(r"cell-\d+-\d+")


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value >= 0 else default


class _State:
    def __init__(self) -> None:
        self.dir = os.environ.get("DSH_PYTHON_REPL_STATE_DIR") or None
        self.archive_after = _int_env("DSH_PYTHON_REPL_ARCHIVE_AFTER", 100)
        self.delete_after = _int_env("DSH_PYTHON_REPL_DELETE_AFTER", 200)
        self.cell = 0
        #: name -> {"t": last cell that used it, "b": first cell seen, "k": kind}
        self.names: dict[str, dict] = {}
        self.pins: set[str] = set()
        #: name -> {"file", "at", "t", "b", "k", "bytes"}
        self.archived: dict[str, dict] = {}
        #: name -> {"at", "t", "b", "k"}
        self.deleted: dict[str, dict] = {}
        #: names brought back during the current cell, told once at its end
        self.back: list[str] = []
        self.loaded = False

    @property
    def active(self) -> bool:
        return self.dir is not None


_STATE = _State()


def state() -> _State:
    """The kernel's lifecycle state, loaded from disk on first use."""
    st = _STATE
    if not st.loaded:
        st.loaded = True
        if st.dir is not None:
            try:
                with open(os.path.join(st.dir, STATE_FILE), encoding="utf-8") as fh:
                    data = json.load(fh)
                if data.get("version") == STATE_VERSION:
                    st.cell = int(data.get("cell", 0))
                    st.names = {k: v for k, v in (data.get("names") or {}).items() if isinstance(v, dict)}
                    st.pins = {p for p in data.get("pins") or [] if isinstance(p, str)}
                    st.archived = {k: v for k, v in (data.get("archived") or {}).items()
                                   if isinstance(v, dict) and os.path.exists(_archive_path(v.get("file", "")))}
                    st.deleted = {k: v for k, v in (data.get("deleted") or {}).items() if isinstance(v, dict)}
            except (OSError, ValueError, TypeError):
                pass
    return st


def _archive_path(file: str) -> str:
    return os.path.join(_STATE.dir or "", ARCHIVE_DIR, file)


def save() -> None:
    st = state()
    if st.dir is None:
        return
    data = {"version": STATE_VERSION, "cell": st.cell, "archiveAfter": st.archive_after,
            "deleteAfter": st.delete_after, "names": st.names, "pins": sorted(st.pins),
            "archived": st.archived, "deleted": st.deleted}
    os.makedirs(st.dir, exist_ok=True)
    target = os.path.join(st.dir, STATE_FILE)
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.replace(tmp, target)


def _ns() -> dict:
    return sys.modules["__main__"].__dict__


def _tracked(name: object) -> bool:
    import rlm.repl as _repl

    return type(name) is str and not name.startswith("_") and name not in _repl._ALWAYS_SKIP


def _kind(value) -> str:
    import repl_info

    return repl_info._kind(value)


def _functions_of(value, ns: dict) -> list:
    """The session's own functions behind a value: itself, or a class's methods. Exact types only."""
    if type(value) is types.MethodType:
        value = types.MethodType.__dict__["__func__"].__get__(value)
    if type(value) is types.FunctionType:
        return [value] if types.FunctionType.__dict__["__globals__"].__get__(value) is ns else []
    if type(value) is type:
        members = type.__dict__["__dict__"].__get__(value)
        return [f for f in members.values() if type(f) is types.FunctionType
                and types.FunctionType.__dict__["__globals__"].__get__(f) is ns]
    return []


def _global_names(code: types.CodeType) -> set:
    names = set(code.co_names)
    for const in code.co_consts:
        if type(const) is types.CodeType:
            names |= _global_names(const)
    return names


def _cell_names(source: str, ns: dict) -> tuple[set, set]:
    """(every name the cell touches, the names it reads): its own reads and writes plus what its calls into session functions reach."""
    tree = ast.parse(source)
    reads, writes = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            (reads if isinstance(node.ctx, ast.Load) else writes).add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            writes.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            writes.update((a.asname or a.name).split(".")[0] for a in node.names if a.name != "*")
        elif isinstance(node, ast.Global):
            reads.update(node.names)
    used, frontier = set(reads), list(reads)
    for _ in range(3):
        nxt = []
        for name in frontier:
            for fn in _functions_of(ns.get(name), ns):
                for g in _global_names(types.FunctionType.__dict__["__code__"].__get__(fn)):
                    if g not in used:
                        used.add(g)
                        nxt.append(g)
        frontier = nxt
    return used | writes, used


def observe(source: str) -> None:
    """Called while a cell compiles: count a user cell, mark its names used, bring back archived ones it reads."""
    import rlm.repl as _repl

    cell_id = _repl._current_cell.get()
    if type(cell_id) is not str or not _USER_CELL.fullmatch(cell_id):
        return
    st = state()
    st.cell += 1
    st.back = []
    if not st.active:
        return
    ns = _ns()
    # Bringing a function back exposes the globals it reads, which may be archived too.
    for _ in range(3):
        try:
            touched, reads = _cell_names(source, ns)
        except SyntaxError:
            return
        wanted = sorted(n for n in reads & st.archived.keys() if n not in ns)
        if not [n for n in wanted if _bring_back(n, ns) is None]:
            break
    for name in touched:
        if not _tracked(name):
            continue
        record = st.names.get(name)
        if record is None:
            st.names[name] = {"t": st.cell, "b": st.cell}
        else:
            record["t"] = st.cell
            record.pop("stuck", None)
        if name in st.archived:
            st.archived[name]["t"] = st.cell


def _bring_back(name: str, ns: dict) -> str | None:
    """Load an archived name into ns; returns the reason on failure."""
    import dill
    import rlm.repl as _repl

    st = state()
    entry = st.archived[name]
    path = _archive_path(entry["file"])
    try:
        with open(path, "rb") as fh:
            value = _repl._snapshot_unpickler(dill)(fh).load()
        backfill: list = []
        value = _repl._revive_with_live_globals(value, ns, backfill)
    except Exception as err:  # noqa: BLE001 - one broken archive must not fail the cell
        return f"{type(err).__name__}: {str(err)[:200]}"
    ns[name] = value
    for key, extra in backfill:
        if key not in ns:
            ns[key] = extra
    del st.archived[name]
    try:
        os.remove(path)
    except OSError:
        pass
    record = st.names.setdefault(name, {"b": entry.get("b", st.cell)})
    record["t"] = st.cell
    record["k"] = entry.get("k", "data")
    st.back.append(name)
    return None


def _archive(name: str, ns: dict) -> str | None:
    """Move one name to its archive file; returns the reason it stays when it cannot be archived."""
    import dill

    st = state()
    value = ns[name]
    file = hashlib.sha256(name.encode("utf-8", "surrogatepass")).hexdigest()[:32] + ".dill"
    path = _archive_path(file)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        dill.settings["recurse"] = True
        with open(tmp, "wb") as fh:
            dill.dump(value, fh)
        size = os.path.getsize(tmp)
        if size > MAX_ARCHIVE_BYTES:
            raise ValueError(f"{size} bytes is over the {MAX_ARCHIVE_BYTES} byte archive cap")
        os.replace(tmp, path)
    except Exception as err:  # noqa: BLE001 - unpicklable values stay live
        try:
            os.remove(tmp)
        except OSError:
            pass
        return f"{type(err).__name__}: {str(err)[:200]}"
    record = st.names.pop(name, {})
    st.archived[name] = {"file": file, "at": st.cell, "t": record.get("t", st.cell), "b": record.get("b", st.cell),
                         "k": record.get("k") or _kind(value), "bytes": size}
    del ns[name]
    return None


def _delete(name: str, entry: dict) -> None:
    st = state()
    st.deleted[name] = {"at": st.cell, "t": entry.get("t", st.cell), "b": entry.get("b", st.cell), "k": entry.get("k", "data")}
    while len(st.deleted) > MAX_DELETED:
        st.deleted.pop(next(iter(st.deleted)))


def sweep() -> list[str]:
    """End of a user cell: archive and delete what has gone unused; returns notes for the model."""
    st = state()
    if not st.active:
        return []
    ns = _ns()
    live = [name for name in list(ns) if _tracked(name)]
    for name in live:
        stale = st.archived.pop(name, None)
        if stale is not None:  # the cell rebound an archived name: the new value wins
            try:
                os.remove(_archive_path(stale["file"]))
            except OSError:
                pass
        st.deleted.pop(name, None)
        record = st.names.get(name)
        if record is None:  # created indirectly, or restored from before this record existed
            record = st.names[name] = {"t": st.cell, "b": st.cell}
        record["k"] = _kind(ns[name])
    present = set(live)
    for name in [n for n in st.names if n not in present]:
        del st.names[name]
    for name in live:
        if name in st.pins:
            continue
        idle = st.cell - st.names[name]["t"]
        if st.delete_after and idle >= st.delete_after:
            _delete(name, st.names.pop(name))
            del ns[name]
        # A failed archive is retried only after a cell used the name again: dill
        # re-serializes the whole value on every attempt, up to the size cap.
        elif st.archive_after and idle >= st.archive_after and "stuck" not in st.names[name]:
            reason = _archive(name, ns)
            if reason is not None:
                st.names[name]["stuck"] = reason
    for name, entry in list(st.archived.items()):
        if name in st.pins:
            continue
        if st.delete_after and st.cell - entry.get("t", st.cell) >= st.delete_after:
            try:
                os.remove(_archive_path(entry["file"]))
            except OSError:
                pass
            del st.archived[name]
            _delete(name, entry)
    save()
    notes = []
    if st.back:
        notes.append(f"Brought back from the archive: {_names(st.back)}.")
        st.back = []
    return notes


def _names(names, limit: int = 10) -> str:
    shown = ", ".join(n[:60] for n in names[:limit])
    return shown + (f" (+{len(names) - limit} more)" if len(names) > limit else "")


def after_restore(restored: list) -> dict:
    """Reconcile with a restored namespace and summarize it for the restore notice."""
    st = state()
    ns = _ns()
    ordered = bool(st.names)
    for name in restored:
        if name in st.archived:  # restored from an older snapshot: the live value wins
            try:
                os.remove(_archive_path(st.archived.pop(name)["file"]))
            except OSError:
                pass
        if name in ns and _tracked(name):
            record = st.names.setdefault(name, {"t": st.cell, "b": st.cell})
            record["k"] = _kind(ns[name])
    if st.active:
        save()
    import builtins

    # A builtin copied into globals (e.g. by a revived function's backfill) is not the model's own name.
    back = [n for n in restored if n in ns and ns[n] is not builtins.__dict__.get(n, ns)]
    rank = lambda n: (-st.names.get(n, {}).get("t", 0), n)  # noqa: E731
    pinned = sorted(n for n in back if n in st.pins)
    groups = {"function": [], "data": [], "module": []}
    for name in sorted(back, key=rank):
        if name in st.pins:
            continue
        kind = _kind(ns[name])
        groups["function" if kind in ("function", "class") else "module" if kind == "module" else "data"].append(name)
    return {"total": len(back), "ordered": ordered, "pinned": pinned, "functions": groups["function"],
            "variables": groups["data"], "modules": groups["module"], "archived": len(st.archived),
            "archiveAfter": st.archive_after}


def name_error_hint(name: object) -> str | None:
    st = state()
    if type(name) is not str:
        return None
    if name in st.archived:
        return (f"`{name}` is archived (unused since cell {st.archived[name].get('t')}). It comes back by itself when a "
                f"cell names it directly; when reached indirectly, bring it back with await repl.unarchive({name!r}).")
    entry = st.deleted.get(name)
    if entry is not None:
        return (f"`{name}` was deleted in cell {entry.get('at')} after {st.delete_after} cells unused "
                f"(last used in cell {entry.get('t')}). Its value is gone; recompute it. "
                f"await repl.keep(name) protects a name from this.")
    return None


def op(action: str, name: str) -> dict:
    """keep / unkeep / unarchive / archive one name, for repl and the kernel tab."""
    st = state()
    ns = _ns()
    if not _tracked(name):
        return {"ok": False, "reason": f"{name!r} is not a user name"}
    if action in ("keep", "unarchive") and name not in ns and name in st.archived:
        reason = _bring_back(name, ns)
        st.back = [n for n in st.back if n != name]
        if reason is not None:
            return {"ok": False, "reason": f"could not bring {name} back: {reason}"}
    if action == "keep":
        if name not in ns:
            return {"ok": False, "reason": f"{name} does not exist"}
        st.pins.add(name)
    elif action == "unkeep":
        st.pins.discard(name)
        if name in st.names:
            st.names[name]["t"] = st.cell  # the countdown starts again, not from where it stood before the pin
    elif action == "unarchive":
        if name not in ns:
            return {"ok": False, "reason": f"{name} is not archived" + (" (it was deleted)" if name in st.deleted else "")}
        st.names.setdefault(name, {"b": st.cell})["t"] = st.cell
    elif action == "archive":
        if name not in ns:
            return {"ok": False, "reason": f"{name} does not exist"}
        if name in st.pins:
            return {"ok": False, "reason": f"{name} is pinned; unpin it first"}
        if not st.active:
            return {"ok": False, "reason": "archiving needs the snapshot directory, which this kernel does not have"}
        st.names.setdefault(name, {"t": st.cell, "b": st.cell})["k"] = _kind(ns[name])
        reason = _archive(name, ns)
        if reason is not None:
            return {"ok": False, "reason": f"{name} cannot be archived: {reason}"}
    else:
        return {"ok": False, "reason": f"unknown action {action!r}"}
    if st.active:
        save()
    return {"ok": True}


def install(repl_module) -> None:
    """Wrap the (already panel-wrapped) compile step and the NameError builder. Idempotent."""
    compile_cell = repl_module._compile_cell
    if not getattr(compile_cell, "_dsh_lifecycle", False):
        def compile_with_lifecycle(code, filename):
            try:
                observe(code)
            except Exception:  # noqa: BLE001 - bookkeeping must never stop a cell
                pass
            return compile_cell(code, filename)

        compile_with_lifecycle._dsh_lifecycle = True  # type: ignore[attr-defined]
        repl_module._compile_cell = compile_with_lifecycle
    error_event = repl_module._error_event
    if not getattr(error_event, "_dsh_lifecycle", False):
        def _error_event(cell_id, exc):
            event = error_event(cell_id, exc)
            try:
                hint = name_error_hint(getattr(exc, "name", None)) if isinstance(exc, NameError) else None
                if hint is not None:
                    event["traceback"] = [*event.get("traceback", []), hint]
            except Exception:  # noqa: BLE001
                pass
            return event

        _error_event._dsh_lifecycle = True  # type: ignore[attr-defined]
        repl_module._error_event = _error_event
