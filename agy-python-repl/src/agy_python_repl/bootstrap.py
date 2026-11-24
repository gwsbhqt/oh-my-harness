"""Kernel-side bootstrap executed once per Antigravity REPL kernel."""

from __future__ import annotations

import sys
from typing import Any

from python_repl_core.preview import preview as _preview
from python_repl_core.skills_runtime import _SkillsNamespace, install_skills_import_guard


class _ReplHelper:
    """Bounded inspection helpers exposed as `repl` inside user cells."""

    def preview(self, value: Any, *, chars: int = 4000, items: int = 20, depth: int = 8) -> dict[str, Any]:
        return _preview(value, chars=chars, items=items, depth=depth)

    def vars(self) -> list[str]:
        ns = sys.modules["__main__"].__dict__
        return sorted(
            k for k in ns
            if not k.startswith("_") and k not in {"skills", "repl"}
        )


def install_antigravity_surface(skill_entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Install `skills` and `repl` into `__main__` and return the skill load report."""
    ns = sys.modules["__main__"].__dict__
    skills_ns = _SkillsNamespace()
    report = skills_ns._register_all(skill_entries)
    install_skills_import_guard(ns, skills_ns)

    ns["skills"] = skills_ns
    ns["repl"] = _ReplHelper()

    try:
        import rlm.repl as _repl
        skip = getattr(_repl, "_SNAPSHOT_SKIP_NAMES", None)
        if isinstance(skip, set):
            skip.update({"skills", "repl"})
    except Exception:
        pass

    return report
