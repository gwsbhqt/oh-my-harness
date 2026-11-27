"""Preserve user bindings and shared object identity in Prime's independent snapshot records."""
from __future__ import annotations

import pickle
import sys
from contextvars import ContextVar
from itertools import chain
from pathlib import Path
from typing import Any

from .snapshot_errors import snapshot_error_reader
from .snapshot_resources import dimension_type, save_with_dimensions, snapshot_resource_reader

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


class _NamedRootToken(int):
    """Old readers require an exact int. Text pickle cannot decimal-format very long binding names."""

    def __reduce_ex__(self, protocol):
        if protocol < 2:
            return int, (format(self, "x"), 16)
        return int, (int(self),)


def _named_token(name: str) -> int:
    # Negative keys are disjoint from v1 sequence numbers. The leading byte preserves every UTF-8 byte.
    return -int.from_bytes(b"\x01" + str.encode(name, "utf-8", "surrogatepass"), "big")


class _NamedRecords(dict):
    """Prime iterates (name, blob) pairs. The detached reader requests each blob by name."""

    def items(self):
        state = _restoring.get()
        for name, blob in super().items():
            state.current_name = name
            yield name, blob

    def __getitem__(self, name):
        _restoring.get().current_name = name
        return super().__getitem__(name)


def _decode_record_names(records, legacy_names: set[str] | None):
    decoded = _NamedRecords()
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
        self.current_name = None
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


class _PickleReferences(dict):
    """Targets to recognize during normal pickle traversal of roots with custom state."""

    def __init__(self):
        super().__init__()
        self.custom_roots: set[str] = set()


def shared_references(roots: dict, namespace: dict, candidates=None, *, for_pickle=None) -> tuple[set[str], dict]:
    """Return confirmed sharing. Only the writer also tracks names its pickler may encounter in custom state."""
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
                        if identity not in references:
                            references[identity] = (_REFERENCE_TAG, len(references), value)
                        if first[0] != name:
                            shared_names.update((first[0], name))
                            if for_pickle is not None:
                                for_pickle[identity] = references[identity]
                        continue
                    owners[identity] = (name, value)
                if for_pickle is not None and kind not in _CHILDREN:
                    for_pickle.custom_roots.add(name)
                if kind not in walkers:
                    mro = type.__dict__["__mro__"].__get__(cls)
                    walkers[kind] = next((_CHILDREN[id(t)] for t in mro if id(t) in _CHILDREN), None)
                children = walkers[kind]
                if children is not None:
                    stack.append(children(value))
                    break
            else:
                stack.pop()
    if for_pickle is not None and for_pickle.custom_roots:
        # Ordinary records carry their names in the frame. Only another record that visits the value needs a tag.
        for name, value in roots.items():
            identity = id(value)
            if identity in for_pickle or (type(value) is tuple and not value):
                continue
            known = references.get(identity) if name in shared_names else None
            if known is None:
                known = (_REFERENCE_TAG, _NamedRootToken(_named_token(name)), value)
            for_pickle[identity] = known
    return shared_names, references


class _SharedRoot:
    def __init__(self, value, references, dimension_cls, *, confirmed=True):
        self.dimension_cls = dimension_cls
        self.value = value
        self.references = references
        self.confirmed = confirmed


def _save_shared_root(pickler, root):
    # Each record includes its own ordinary value, so it can load even if a
    # different record containing the same object was skipped or fails to load.
    # The pickle memo encodes repeat visits (including cycles) within a record.
    if root.references is None:
        save_with_dimensions(pickler, root.value, root.dimension_cls)
        return
    inline = None

    def persistent_id(value):
        nonlocal inline
        if value is inline:
            inline = None
            return None
        reference = root.references.get(id(value))
        if reference is None or (value is root.value and reference[1] < 0):
            return None  # The root's name is already in its own frame.
        pickler.bin = True  # Text-mode persistent ids would format the user value with str().
        if id(reference) not in pickler.memo:
            inline = value  # the value inside this persistent id uses its ordinary reducer once
        return reference

    previous = pickler.persistent_id
    binary = pickler.bin
    if root.confirmed:
        # Retain the established v1 encoding. An unconfirmed record keeps its exact bytes until a reference occurs.
        pickler.bin = True
    pickler.persistent_id = persistent_id
    try:
        save_with_dimensions(pickler, root.value, root.dimension_cls)
    finally:
        pickler.persistent_id = previous
        pickler.bin = binary


class _SnapshotNames:
    """A read-through view. Prime's optional committed prune still acts on the live name."""

    def __init__(self, ns, roots, shared_names, references, for_pickle):
        self.ns = ns
        self.roots = roots
        self.shared_names = shared_names
        self.references = references | for_pickle if for_pickle.custom_roots else references
        self.for_pickle = for_pickle
        self.dimension_cls = dimension_type()

    def keys(self):
        return (_SnapshotName(name) if name.startswith(("_", _LEGACY_PREFIX)) else name for name in self.roots)

    def get(self, name, default):
        value = self.ns.get(name, default)
        if name in self.shared_names and value is not default:
            return _SharedRoot(value, self.references, self.dimension_cls)
        if name in self.for_pickle.custom_roots and value is not default:
            return _SharedRoot(value, self.for_pickle, self.dimension_cls, confirmed=False)
        if self.dimension_cls is not None and value is not default and id(type(value)) not in _ATOMS:
            return _SharedRoot(value, None, self.dimension_cls, confirmed=False)
        return value

    def __contains__(self, name):
        return name in self.ns

    def pop(self, name, default):
        return self.ns.pop(name, default)


def read_snapshot_values(stream, saved_names: list[str]) -> tuple[dict, list[dict]]:
    """Load a new framed snapshot without rebinding its functions or classes to the live main module."""
    import io
    import types

    import dill
    import rlm.repl as repl

    if stream.read(len(repl._SNAPSHOT_MAGIC)) != repl._SNAPSHOT_MAGIC:
        raise ValueError("invalid recovery copy payload")
    token = _restoring.set(_RestoreReferences(legacy_underscore_aliases=False))
    try:
        records = repl._read_snapshot_records(
            stream, repl.DEFAULT_SNAPSHOT_MAX_BYTES, repl.DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
        )
        if set(records) != set(saved_names):
            raise ValueError("recovery copy records do not match its manifest")
        detached_main = types.ModuleType("__main__")

        class CopyUnpickler(repl._snapshot_unpickler(dill)):
            def find_class(self, module, name):
                if module == "__main__" or (module, name) == ("__builtin__", "__main__"):
                    raise pickle.UnpicklingError("copy contains a reference to the live __main__ namespace")
                return super().find_class(module, name)

        values = {}
        failed = []
        for name in saved_names:
            try:
                # dill otherwise reconnects an instance to a same-named class in the running __main__.
                reader = CopyUnpickler(io.BytesIO(records[name]), ignore=True)
                reader._main = detached_main
                values[name] = reader.load()
            except Exception as exc:
                failed.append({"name": name, "reason": f"{type(exc).__name__}: {repl._safe_str(exc)[:200]}"})
        return values, failed
    finally:
        _restoring.reset(token)


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

    def snapshot(ns, path, manifest_path, max_bytes, max_variable_bytes, prune_oversized, committed=None):
        from . import snapshot_store

        pair = snapshot_store.managed_pair(path)
        managed = pair is not None
        if managed and pair.manifest != Path(manifest_path).absolute():
            return {"error": "write failed: incorrect manifest for this session snapshot"}
        roots = {name: value for name, value in ns.copy().items() if user_name(name)}
        for_pickle = _PickleReferences()
        names, refs = shared_references(roots, ns, for_pickle=for_pickle)
        # Prime may remove pruned names once its *private* files are ready. Defer those removals to publication.
        view = _SnapshotNames(ns.copy() if managed and prune_oversized else ns, roots, names, refs, for_pickle)

        def write_pair(data, manifest):
            result = original_snapshot(view, str(data), str(manifest), max_bytes, max_variable_bytes,
                                       prune_oversized, None if managed else committed)
            if "saved" in result:
                for field in ("saved", "pruned"):
                    result[field] = list(map(str, result[field]))
                for item in result["skipped"]:
                    item["name"] = str(item["name"])
            return result

        if not managed:
            return write_pair(path, manifest_path)

        def finish(result):
            for name in result["pruned"]:
                ns.pop(name, None)
            if committed is not None:
                committed.append(result)

        try:
            return snapshot_store.publish_snapshot(pair, write_pair, finish)
        except OSError as exc:
            return {"error": f"write failed: {exc}"}

    def read_records(*args, **kwargs):
        records = original_read_records(*args, **kwargs)
        state = _restoring.get()
        if state is None:
            return records
        state.reading_header = False
        return _decode_record_names(records, state.legacy_names)

    def unpickler(dill):
        resources = snapshot_resource_reader(guarded_unpickler(dill), dill_impl, repl._RestoredFileStub)
        base = snapshot_error_reader(resources, dill)
        state = _restoring.get()
        if state is None:
            return base

        class Unpickler(base):
            def load(self):
                self.pending = {}
                name = state.current_name
                value = super().load()
                if state.reading_header:
                    state.reading_header = False
                    if isinstance(value, dict):
                        value = _decode_record_names(value, state.legacy_names)
                elif type(name) is str:
                    value = state.values.setdefault(_named_token(name), value)
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

    def restore(ns, path, committed=None, max_bytes=None, max_variable_bytes=None):
        from . import snapshot_store

        token = _restoring.set(_RestoreReferences(legacy_underscore_aliases))
        pair = snapshot_store.managed_pair(path)
        result = {}
        try:
            if pair is None:
                return original_restore(ns, path, committed, max_bytes, max_variable_bytes)
            with snapshot_store.open_snapshot(pair.payload, pair.manifest) as selected:
                if selected is None:
                    result = {"restored": [], "failed": [], "reason": "snapshot not found"}
                else:
                    metadata = snapshot_store.read_manifest(selected)
                    items = metadata.get("skipped")
                    skipped = ([item["name"] for item in items
                                if isinstance(item, dict) and isinstance(item.get("name"), str)]
                               if isinstance(items, list) else [])
                    applied = []
                    try:
                        result = original_restore(ns, str(selected.payload), applied, max_bytes, max_variable_bytes)
                    finally:
                        if applied:
                            applied[0].update(snapshot_manifest=metadata, snapshot_skipped=skipped)
                            if committed is not None:
                                committed.append(applied[0])
                    result.update(snapshot_manifest=metadata, snapshot_skipped=skipped)
            return result
        except OSError as exc:
            result = {"error": f"could not read saved snapshot: {exc}"}
            return result
        finally:
            _restoring.reset(token)
            if pair is not None and ("restored" not in result or result.get("failed") or result.get("reason")):
                target = repl._last_snapshot_target
                if target is not None and snapshot_store.managed_pair(target["path"]) == pair:
                    repl._last_snapshot_target = None

    repl._read_snapshot_records = read_records
    repl._snapshot_state = snapshot
    repl._restore_state = restore
    repl._snapshot_unpickler = unpickler
    repl._revive_with_live_globals = revive
    repl._list_names = list_names
    _installed = True
