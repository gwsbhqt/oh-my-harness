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
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

_CORE_SRC = Path(__file__).resolve().parents[2] / "python-repl-core" / "src"
if _CORE_SRC.is_dir() and str(_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(_CORE_SRC))

from python_repl_core.snapshot_names import install_snapshot_names, shared_references  # noqa: E402

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


def install(*, legacy_underscore_aliases: bool = True) -> bool:
    """Install once per kernel. Only DSH encoded single-underscore bindings in legacy snapshots."""
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
    install_snapshot_names(dill_impl, legacy_underscore_aliases=legacy_underscore_aliases)
    _installed = True
    return True
