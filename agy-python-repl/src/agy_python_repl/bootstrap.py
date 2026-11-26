"""Kernel-side bootstrap executed once per Antigravity REPL kernel."""

from __future__ import annotations

import sys
from typing import Any

from python_repl_core import prelude
from python_repl_core.preview import preview as _preview
from python_repl_core.skills_runtime import _SkillsNamespace, install_skills_import_guard


class _SnapshotSkipNames(set[str]):
    """Prime asks for names. Prelude names are defaults only while their objects match."""

    def __init__(self, fixed_names: set[str], namespace: dict[str, Any]) -> None:
        super().__init__(fixed_names)
        self.namespace = namespace

    def __contains__(self, name: object) -> bool:
        return super().__contains__(name) or prelude.is_preloaded(name, self.namespace.get(name))


class _ReplHelper:
    """Bounded inspection helpers exposed as `repl` inside user cells."""

    def preview(self, value: Any, *, chars: int = 4000, items: int = 20, depth: int = 8) -> dict[str, Any]:
        return _preview(value, chars=chars, items=items, depth=depth)

    def vars(self) -> list[str]:
        from rlm import repl as prime

        return prime._list_names(vars(sys.modules["__main__"]))


def install_antigravity_surface(skill_entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Prepare the cell namespace and return the skill load report."""
    import dill._dill as dill_impl
    from rlm import repl as prime
    from python_repl_core.snapshot_names import install_snapshot_names

    install_snapshot_names(dill_impl, legacy_underscore_aliases=False)
    ns = sys.modules["__main__"].__dict__
    skills_ns = _SkillsNamespace()
    report = skills_ns._register_all(skill_entries)
    install_skills_import_guard(ns, skills_ns)

    bindings = {"skills": skills_ns, "repl": _ReplHelper()}
    ns.update(bindings)
    prelude.install(ns)
    prime._ALWAYS_SKIP = _SnapshotSkipNames(prime._ALWAYS_SKIP, ns)
    prime._ALWAYS_SKIP.update(bindings)
    # Older snapshots still contain bindings from their original kernel.
    prime._RESTORE_SKIP.update(bindings)

    return report
