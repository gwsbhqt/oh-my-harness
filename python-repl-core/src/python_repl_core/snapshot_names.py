"""Preserve user bindings and shared object identity in Prime's independent snapshot records."""
from __future__ import annotations

import pickle
import sys
from contextvars import ContextVar
from itertools import chain
from typing import Any

_installed = False

_LEGACY_PREFIX = "dsh_user_"


class _SnapshotName(str):
    """Prime tests startswith("_") for eligibility, then encodes the record name separately from JSON."""

    def startswith(self, prefix, *bounds):
        if prefix == "_" and not bounds:
            return False  # Only eligible user bindings enter this view.
        return super().startswith(prefix, *bounds)

    def encode(self, encoding="utf-8", errors="strict"):
        # Old writers never emitted double-underscore record names. The manifest still uses the literal name.
        name = "__" + self if str.startswith(self, _LEGACY_PREFIX) else self
        return str.encode(name, encoding, errors)


def _decode_record_names(records, legacy_names: set[str] | None):
    decoded = {}
    for name, blob in records.items():
        if isinstance(name, str):
            if name.startswith("__" + _LEGACY_PREFIX):
                name = name[2:]
            elif legacy_names is not None and name.startswith(_LEGACY_PREFIX):
                # Legacy DSH stored only this key, even on a collision. Keep its historical binding.
                legacy_names.add(name)
                name = "_" + name[len(_LEGACY_PREFIX):]
        if name in decoded:
            raise ValueError(f"duplicate snapshot binding: {name!r}")
        decoded[name] = blob
    return decoded


# Walk only storage owned by built-in containers, including the plugin's
# dict/list views. Their subclasses may override iteration, keys or __class__.
_ATOMS = {id(t) for t in (type(None), bool, int, float, complex, str, bytes, range,
                          type(Ellipsis), type(NotImplemented))}
_REFERENCE_TAG = "dsh.shared.v1"


class _RestoreReferences:
    def __init__(self, legacy_underscore_aliases: bool):
        self.legacy_names = set() if legacy_underscore_aliases else None
        self.reading_header = True  # A legacy snapshot's first unpickle is its outer record dictionary.
        self.values = {}       # wire token -> canonical object from a successfully loaded record
        self.by_root = {}      # staged root identity -> shared object identities in that record
        self.revived = {}      # shared object identity -> value rebound to the live namespace


_restoring: ContextVar[_RestoreReferences | None] = ContextVar("dsh_restoring_references", default=None)
_REFCOUNT = (getattr(sys, "getrefcount", None) if sys.implementation.name == "cpython"
             and getattr(sys, "_is_gil_enabled", lambda: True)() else None)


def _dict_children(value):
    return chain(dict.keys(value), dict.values(value))


_CHILDREN = {id(dict): _dict_children, id(list): list.__iter__, id(tuple): tuple.__iter__,
             id(set): set.__iter__, id(frozenset): frozenset.__iter__}


def _immutable_contents(value) -> bool:
    """An exact tuple/frozenset shared by two names matters only if it reaches mutable data."""
    stack = [iter(value)]
    seen = {id(value)}
    while stack:
        for item in stack[-1]:
            cls = type(item)
            if id(cls) in _ATOMS:
                continue
            if cls is not tuple and cls is not frozenset:
                return False
            if id(item) not in seen:
                seen.add(id(item))
                stack.append(iter(item))
                break
        else:
            stack.pop()
    return True


def shared_references(roots: dict, namespace: dict, candidates=None) -> tuple[set[str], dict]:
    """Names sharing an object and the per-snapshot tokens for those objects."""
    shared_names: set[str] = set()
    references: dict = {}
    if candidates is not None and all(id(type(roots[n])) in _ATOMS for n in candidates):
        return shared_names, references
    roots = {n: v for n, v in roots.items() if v is not namespace and id(type(v)) not in _ATOMS}
    if len(roots) < 2:
        return shared_names, references
    owners: dict = {}
    immutable: set[int] = set()
    walkers = _CHILDREN.copy()
    for name, root in roots.items():
        stack = [iter((root,))]
        while stack:
            for value in stack[-1]:
                cls = type(value)
                kind = id(cls)
                if kind in _ATOMS or value is namespace or (cls is tuple and not value):
                    continue
                # With the GIL, a single incoming reference plus the loop local
                # and getrefcount's argument cannot be shared. Avoid retaining
                # an identity table entry for every ordinary row of a large list.
                if _REFCOUNT is None or _REFCOUNT(value) > 3:
                    identity = id(value)
                    first = owners.get(identity)
                    if first is not None:
                        if identity in immutable:
                            continue
                        if (cls is tuple or cls is frozenset) and identity not in references and _immutable_contents(value):
                            immutable.add(identity)
                            continue
                        if first[0] != name:
                            shared_names.update((first[0], name))
                        if identity not in references:
                            references[identity] = (_REFERENCE_TAG, len(references), value)
                        continue
                    owners[identity] = (name, value)
                if kind not in walkers:
                    mro = type.__dict__["__mro__"].__get__(cls)
                    walkers[kind] = next((_CHILDREN[id(t)] for t in mro if id(t) in _CHILDREN), None)
                children = walkers[kind]
                if children is not None:
                    stack.append(children(value))
                    break
            else:
                stack.pop()
    return shared_names, references


class _SharedRoot:
    def __init__(self, value, references):
        self.value = value
        self.references = references


def _save_shared_root(pickler, root):
    # Each record includes its own ordinary value, so it can load even if a
    # different record containing the same object was skipped or fails to load.
    # The pickle memo encodes repeat visits (including cycles) within a record.
    inline = None

    def persistent_id(value):
        nonlocal inline
        if value is inline:
            inline = None
            return None
        reference = root.references.get(id(value))
        if reference is not None and id(reference) not in pickler.memo:
            inline = value  # the value inside this persistent id uses its ordinary reducer once
        return reference

    previous = pickler.persistent_id
    binary = pickler.bin
    # Text-mode persistent ids call str() on their payload, including user values.
    # Binary pickle opcodes carry the reference as data in either case.
    pickler.bin = True
    pickler.persistent_id = persistent_id
    try:
        pickler.save(root.value)
    finally:
        pickler.persistent_id = previous
        pickler.bin = binary


class _SnapshotNames:
    """A read-through view. Prime's optional committed prune still acts on the live name."""

    def __init__(self, ns, roots, shared_names, references):
        self.ns = ns
        self.roots = roots
        self.shared_names = shared_names
        self.references = references

    def keys(self):
        return (_SnapshotName(name) if name.startswith(("_", _LEGACY_PREFIX)) else name for name in self.roots)

    def get(self, name, default):
        value = self.ns.get(name, default)
        if name in self.shared_names and value is not default:
            return _SharedRoot(value, self.references)
        return value

    def __contains__(self, name):
        return name in self.ns

    def pop(self, name, default):
        return self.ns.pop(name, default)


def install_snapshot_names(dill_impl: Any, *, legacy_underscore_aliases: bool) -> None:
    """Keep user underscore names and cross-record identities in Prime's framed snapshot."""
    import rlm.repl as repl

    global _installed
    if _installed:
        return

    original_snapshot = repl._snapshot_state
    original_restore = repl._restore_state
    original_revive = repl._revive_with_live_globals
    original_read_records = repl._read_snapshot_records
    guarded_unpickler = repl._snapshot_unpickler
    dill_impl.Pickler.dispatch[_SharedRoot] = _save_shared_root

    def user_name(name: object) -> bool:
        return type(name) is str and name != "_" and not name.startswith("__") and name not in repl._ALWAYS_SKIP

    def list_names(ns: dict[str, Any]) -> list[str]:
        return sorted(name for name in ns if user_name(name))

    def snapshot(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        roots = {name: value for name, value in ns.copy().items() if user_name(name)}
        names, refs = shared_references(roots, ns)
        result = original_snapshot(_SnapshotNames(ns, roots, names, refs), *args, **kwargs)
        if "saved" in result:
            # The same dictionary is returned to a caller observing an already-committed interrupt.
            for field in ("saved", "pruned"):
                result[field] = list(map(str, result[field]))
            for item in result["skipped"]:
                item["name"] = str(item["name"])
        return result

    def read_records(*args, **kwargs):
        records = original_read_records(*args, **kwargs)
        state = _restoring.get()
        if state is None:
            return records
        state.reading_header = False
        return _decode_record_names(records, state.legacy_names)

    def unpickler(dill):
        base = guarded_unpickler(dill)
        state = _restoring.get()
        if state is None:
            return base

        class Unpickler(base):
            def load(self):
                self.pending = {}
                value = super().load()
                if state.reading_header:
                    state.reading_header = False
                    if isinstance(value, dict):
                        value = _decode_record_names(value, state.legacy_names)
                if self.pending:  # a failed record must leave no partial objects behind
                    state.values.update(self.pending)
                    state.by_root.setdefault(id(value), set()).update(id(item) for item in self.pending.values())
                return value

            def persistent_load(self, ref):
                if (type(ref) is not tuple or len(ref) != 3 or type(ref[0]) is not str
                        or ref[0] != _REFERENCE_TAG or type(ref[1]) is not int):
                    raise pickle.UnpicklingError("unknown shared reference in snapshot")
                _, key, fallback = ref
                return self.pending.setdefault(key, state.values.get(key, fallback))

        return Unpickler

    def revive(value, ns, backfill=None, memo=None):
        # Prime rebuilds functions and some immutable containers. A shared
        # pickle object must also map to one rebound object across records.
        if memo is not None:
            return original_revive(value, ns, backfill, memo)
        state = _restoring.get()
        linked = state.by_root.get(id(value)) if state is not None else None
        if linked:
            memo = {i: state.revived[i] for i in linked if i in state.revived}
            result = original_revive(value, ns, backfill, memo)
            state.revived.update((i, memo[i]) for i in linked if i in memo)
        else:
            result = original_revive(value, ns, backfill)
        if backfill and state is not None and state.legacy_names:
            # A function's saved globals must not introduce a second binding for an ambiguous legacy record.
            backfill[:] = [(name, dep) for name, dep in backfill if name not in state.legacy_names]
        return result

    def restore(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        token = _restoring.set(_RestoreReferences(legacy_underscore_aliases))
        try:
            return original_restore(ns, *args, **kwargs)
        finally:
            _restoring.reset(token)

    repl._read_snapshot_records = read_records
    repl._snapshot_state = snapshot
    repl._restore_state = restore
    repl._snapshot_unpickler = unpickler
    repl._revive_with_live_globals = revive
    repl._list_names = list_names
    _installed = True
