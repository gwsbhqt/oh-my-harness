"""Preserve shared data across snapshot records and save modules and skills by name.

dill saves a module outside the standard library and site-packages together
with its whole global namespace. A restore then imports the current code from
disk and writes the old globals over it: new code, old data. A skill module
whose globals hold locks or sessions may not be serializable at all, which
can also prevent restoration of bindings and functions that reference it.
Here an importable module is saved as its import name and imported again on
restore; a skill binding is saved as its name in `skills`. The cost:
attributes set on a module by hand are not kept.
"""
from __future__ import annotations

import importlib
import pickle
import sys
from contextvars import ContextVar
from itertools import chain
from types import ModuleType
from typing import Any

_installed = False


def reimport(name: str) -> ModuleType:
    """Restore side of a module saved by name: the module as the new kernel imports it."""
    return importlib.import_module(name)


def skill(name: str) -> Any:
    """Restore side of a skill binding: the same `skills.<name>` the new kernel loaded."""
    import dsh_kernel

    return getattr(dsh_kernel.skills, name)


def skills_namespace() -> Any:
    """Restore side of the skills namespace: the new kernel's live `__main__.skills`."""
    return sys.modules["__main__"].__dict__["skills"]


def by_name(module: ModuleType) -> bool:
    """Whether a new kernel gets this exact module back from `import <name>`."""
    name = getattr(module, "__name__", None)
    if type(name) is not str or name == "__main__" or name.startswith("__runtime__"):
        return False
    return sys.modules.get(name) is module and getattr(module, "__spec__", None) is not None


def _underscore_alias(name: str) -> str:
    return "dsh_user_" + name[1:]


def _rename_result(result: Any, aliases: dict[str, str]) -> Any:
    """Show the user's original names in a snapshot/restore report, not the temporary aliases."""
    if not isinstance(result, dict):
        return result
    changed = dict(result)
    for field in ("saved", "restored", "skipped", "failed", "pruned"):
        values = changed.get(field)
        if not isinstance(values, list):
            continue
        renamed = []
        for item in values:
            if isinstance(item, str) and item in aliases:
                renamed.append(aliases[item])
            elif isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"] in aliases:
                renamed.append({**item, "name": aliases[item["name"]]})
            else:
                renamed.append(item)
        changed[field] = renamed
    return changed


# Walk only storage owned by built-in containers, including the plugin's
# dict/list views. Their subclasses may override iteration, keys or __class__.
_ATOMS = {id(t) for t in (type(None), bool, int, float, complex, str, bytes, range,
                          type(Ellipsis), type(NotImplemented))}
_REFERENCE_TAG = "dsh.shared.v1"


class _RestoreReferences:
    def __init__(self):
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

    def __init__(self, ns, aliases, shared_names, references):
        self.ns = ns
        self.aliases = aliases
        self.shared_names = shared_names
        self.references = references

    def keys(self):
        return (*self.ns, *self.aliases)

    def get(self, name, default):
        value = self.ns.get(self.aliases.get(name, name), default)
        if name in self.shared_names and value is not default:
            return _SharedRoot(value, self.references)
        return value

    def __contains__(self, name):
        return self.aliases.get(name, name) in self.ns

    def pop(self, name, default):
        return self.ns.pop(self.aliases.get(name, name), default)


def _install_snapshot_names(dill_impl: Any) -> None:
    """Keep user underscore names and cross-record identities in Prime's framed snapshot."""
    import rlm.repl as repl

    original_snapshot = repl._snapshot_state
    original_restore = repl._restore_state
    original_revive = repl._revive_with_live_globals
    guarded_unpickler = repl._snapshot_unpickler
    dill_impl.Pickler.dispatch[_SharedRoot] = _save_shared_root

    def snapshot(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        initial = ns.copy()
        aliases = {_underscore_alias(n): n for n in initial if type(n) is str and n.startswith("_")
                   and n != "_" and not n.startswith("__") and _underscore_alias(n) not in initial}
        roots = {n: v for n, v in initial.items() if type(n) is str and not n.startswith("_")
                 and n not in repl._ALWAYS_SKIP}
        roots.update((alias, initial[name]) for alias, name in aliases.items())
        names, refs = shared_references(roots, ns)
        source = _SnapshotNames(ns, aliases, names, refs) if aliases or names else ns
        return _rename_result(original_snapshot(source, *args, **kwargs), aliases)

    def unpickler(dill):
        base = guarded_unpickler(dill)
        state = _restoring.get()
        if state is None:
            return base

        class Unpickler(base):
            def load(self):
                self.pending = {}
                value = super().load()
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
        if not linked:
            return original_revive(value, ns, backfill)
        memo = {i: state.revived[i] for i in linked if i in state.revived}
        result = original_revive(value, ns, backfill, memo)
        state.revived.update((i, memo[i]) for i in linked if i in memo)
        return result

    def restore(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        token = _restoring.set(_RestoreReferences())
        try:
            result = original_restore(ns, *args, **kwargs)
        finally:
            _restoring.reset(token)
        aliases: dict[str, str] = {}
        for name in result.get("restored", ()):
            if type(name) is str and name.startswith("dsh_user_"):
                original = "_" + name[len("dsh_user_"):]
                aliases[name] = original
                ns[original] = ns.pop(name)
        return _rename_result(result, aliases)

    repl._snapshot_state = snapshot
    repl._restore_state = restore
    repl._snapshot_unpickler = unpickler
    repl._revive_with_live_globals = revive


def _install_skills_namespace(dill_impl: Any) -> None:
    """Save the live `skills` namespace by reference, not by recursive content.

    A user function that reads `skills` keeps the namespace object in its globals;
    dill then walks `skills._members` and recurses through the loaded skill
    modules (locks and sessions included). The new kernel rebuilds `skills`, so
    save a restore callable instead, exactly as the module rule does.
    """
    import skills as skills_module

    cls = getattr(skills_module, "_SkillsNamespace", None)
    if not isinstance(cls, type):
        return

    def save_skills(pickler: Any, obj: Any) -> None:
        pickler.save_reduce(skills_namespace, (), obj=obj)

    dill_impl.Pickler.dispatch[cls] = save_skills


def install() -> bool:
    """Register the by-name rule with dill; idempotent, False when dill is missing."""
    global _installed
    if _installed:
        return True
    try:
        import dill._dill as dill_impl
    except Exception:  # noqa: BLE001 - snapshots are off without dill anyway
        return False
    original = dill_impl.Pickler.dispatch[ModuleType]

    def save_module(pickler: Any, obj: ModuleType) -> None:
        if by_name(obj):
            pickler.save_reduce(reimport, (obj.__name__,), obj=obj)
        else:
            original(pickler, obj)

    dill_impl.Pickler.dispatch[ModuleType] = save_module
    _install_skills_namespace(dill_impl)
    _install_snapshot_names(dill_impl)
    _installed = True
    return True
