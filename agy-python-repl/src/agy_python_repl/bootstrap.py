"""Kernel-side bootstrap executed once per Antigravity REPL kernel."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from python_repl_core import prelude, recovery_copies
from python_repl_core.preview import preview as _preview
from python_repl_core.skills_runtime import _SkillsNamespace, install_skills_import_guard

SKILL_RETRY_MIME = "application/vnd.agy-python-repl.skill-retry+json"


class _SnapshotSkipNames(set[str]):
    """Prime asks for names. Prelude names are defaults only while their objects match."""

    def __init__(self, fixed_names: set[str], namespace: dict[str, Any]) -> None:
        super().__init__(fixed_names)
        self.namespace = namespace

    def __contains__(self, name: object) -> bool:
        return super().__contains__(name) or prelude.is_preloaded(name, self.namespace.get(name))


class _ReplHelper:
    """Kernel inspection, package installation and explicit recovery copies for user cells."""

    def __init__(self, *, kernel: str, copy_session: str | None = None) -> None:
        self._kernel = kernel
        self._copy_session = copy_session

    async def save_copy(self, *names: str) -> dict:
        """Save named live values in a separate copy for this kernel. Functions can include dependencies."""
        return recovery_copies.save(self._copy_session, names)

    async def list_copies(self) -> list[str]:
        """List the IDs of completed copies for this kernel."""
        return recovery_copies.list_copies(self._copy_session)

    async def read_copy(self, copy_id: str) -> dict:
        """Read selected values without replacing live names; also reports failed and skipped names."""
        return recovery_copies.read(self._copy_session, copy_id)

    def preview(self, value: Any, *, chars: int = 4000, items: int = 20, depth: int = 8) -> dict[str, Any]:
        return _preview(value, chars=chars, items=items, depth=depth)

    async def install(self, *specs: str, upgrade: bool = False, timeout: float | None = 900) -> dict[str, Any]:
        """Install analysis libraries in the plugin environment and refresh the running kernel."""
        from python_repl_core import packages

        data = os.environ.get("PLUGIN_DATA")
        constraints = os.environ.get("AGY_PYTHON_REPL_CONSTRAINTS")
        if not data or not constraints or Path(sys.prefix).resolve() != (Path(data) / "venv").resolve():
            raise RuntimeError("repl.install requires the workbench launcher and its PLUGIN_DATA/venv environment")
        result = dict(await packages.install(list(specs), upgrade=upgrade, timeout=timeout, constraints=constraints))
        if result["stale"]:
            result["next_step"] = {
                "tool": "kernel_state",
                "arguments": {"action": "restart", "kernel": self._kernel},
                "instruction": "Use the same kernel as this run_code call to load the updated modules.",
            }
        return result

    def vars(self) -> list[str]:
        from rlm import repl as prime

        return prime._list_names(vars(sys.modules["__main__"]))


def _report_skill_retry(name: str, error: str | None) -> None:
    from rlm import repl as prime

    prime.emit({SKILL_RETRY_MIME: {"import_name": name, "error": error[:1024] if error else None}})


def install_antigravity_surface(skill_entries: list[dict[str, Any]], *, kernel: str,
                                copy_session: str | None = None) -> dict[str, Any]:
    """Prepare the cell namespace and return the skill load report."""
    import dill._dill as dill_impl
    from rlm import repl as prime
    from python_repl_core.snapshot_names import install_snapshot_names

    install_snapshot_names(dill_impl, legacy_underscore_aliases=False)
    ns = sys.modules["__main__"].__dict__
    skills_ns = _SkillsNamespace(on_retry=_report_skill_retry)
    report = skills_ns._register_all(skill_entries)
    install_skills_import_guard(ns, skills_ns)

    bindings = {"skills": skills_ns, "repl": _ReplHelper(kernel=kernel, copy_session=copy_session)}
    ns.update(bindings)
    prelude.install(ns)
    prime._ALWAYS_SKIP = _SnapshotSkipNames(prime._ALWAYS_SKIP, ns)
    prime._ALWAYS_SKIP.update(bindings)
    # Older snapshots still contain bindings from their original kernel.
    prime._RESTORE_SKIP.update(bindings)

    return report
