"""Modules and skills go into snapshots by name, not by content.

dill saves a module outside the standard library and site-packages together
with its whole global namespace. A restore then imports the current code from
disk and writes the old globals over it: new code, old data (Prime research,
2026-11-03), and a skill module whose globals hold locks or sessions cannot be
saved at all, so `reader = skills.demo_reader` and every function that used it
came back missing after a restart. Here an importable module is saved as its
import name and imported again on restore; a skill binding is saved as its
name in `skills`. The cost: attributes set on a module by hand are not kept.
"""
from __future__ import annotations

import importlib
import sys
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
    for field in ("saved", "restored", "skipped", "failed"):
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


def _install_underscore_aliases() -> None:
    """Let single-underscore user names survive Prime's underscore-skipping snapshot.

    Prime deliberately skips names beginning with `_` as internals, but a user
    may keep `_b`, `_j` or `_i` as ordinary data. Snapshot through a temporary
    non-underscore alias, then put the value back under its real name on restore.
    This stays in our compatibility layer; vendor files are untouched.
    """
    import rlm.repl as repl

    if getattr(repl, "_dsh_underscore_aliases", False):
        return
    original_snapshot = getattr(repl, "_snapshot_state", None)
    original_restore = getattr(repl, "_restore_state", None)
    if not callable(original_snapshot) or not callable(original_restore):
        return

    def snapshot(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        aliases: dict[str, str] = {}
        for name in list(ns):
            if type(name) is not str or name == "_" or not name.startswith("_") or name.startswith("__"):
                continue
            alias = _underscore_alias(name)
            if alias in ns:
                continue
            aliases[alias] = name
            ns[alias] = ns[name]
        try:
            result = original_snapshot(ns, *args, **kwargs)
        finally:
            for alias in aliases:
                ns.pop(alias, None)
        return _rename_result(result, aliases)

    def restore(ns: dict[str, Any], *args: Any, **kwargs: Any) -> Any:
        result = original_restore(ns, *args, **kwargs)
        aliases: dict[str, str] = {}
        for name in list(ns):
            if type(name) is str and name.startswith("dsh_user_"):
                original = "_" + name[len("dsh_user_"):]
                aliases[name] = original
                ns[original] = ns.pop(name)
        return _rename_result(result, aliases)

    repl._snapshot_state = snapshot
    repl._restore_state = restore
    repl._dsh_underscore_aliases = True


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
    _install_underscore_aliases()
    _installed = True
    return True
