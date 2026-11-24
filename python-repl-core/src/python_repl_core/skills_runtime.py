"""Kernel-side generic `skills.*` namespace loader (host-agnostic)."""

from __future__ import annotations

import builtins
import importlib
import sys
import traceback
from pathlib import Path
from typing import Any


class _SkillsNamespace:
    """Exposes discovered Python skills as `skills.<import_name>`."""

    def __init__(self) -> None:
        self._loaded: dict[str, Any] = {}
        self._entries: dict[str, dict[str, Any]] = {}
        self._failed: dict[str, dict[str, Any]] = {}
        self._conflicts: set[str] = set()

    def _register_all(self, entries: list[dict[str, Any]]) -> dict[str, Any]:
        by_name: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            by_name.setdefault(entry["import_name"], []).append(entry)

        loaded: list[str] = []
        failed: dict[str, str] = {}

        for imp_name, group in by_name.items():
            # Project skills win over global skills when both exist; duplicate
            # definitions at the same tier are rejected as ambiguous.
            project_group = [e for e in group if e.get("is_project")]
            chosen_group = project_group if project_group else group
            if len(chosen_group) > 1:
                self._conflicts.add(imp_name)
                failed[imp_name] = f"Ambiguous duplicate skill {imp_name!r}"
                continue

            entry = chosen_group[0]
            src_root = entry["source_root"]
            if src_root not in sys.path:
                sys.path.insert(0, src_root)
            try:
                mod = importlib.import_module(imp_name)
                self._loaded[imp_name] = mod
                self._entries[imp_name] = entry
                loaded.append(imp_name)
            except Exception as exc:
                msg = f"{type(exc).__name__}: {exc}"
                self._failed[imp_name] = {"error": msg, "traceback": traceback.format_exc(), **entry}
                failed[imp_name] = msg

        return {"loaded": sorted(loaded), "failed": failed}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._loaded:
            return self._loaded[name]
        if name in self._conflicts:
            raise AttributeError(f"Skill {name!r} was not loaded due to duplicate conflict")
        if name in self._failed:
            raise AttributeError(f"Skill {name!r} failed to import: {self._failed[name]['error']}")
        raise AttributeError(f"No Python skill named {name!r}. Call `await skills.list()` to see available skills.")

    def __dir__(self) -> list[str]:
        return sorted([*self._loaded.keys(), "list", "describe"])

    async def list(self) -> list[dict[str, Any]]:
        return [
            {
                "import_name": imp_name,
                "name": entry["name"],
                "description": entry["description"],
                "directory": entry["directory"],
            }
            for imp_name, entry in sorted(self._entries.items())
        ]

    async def describe(self, import_name: str) -> dict[str, Any]:
        if import_name not in self._entries:
            raise KeyError(f"Unknown skill {import_name!r}")
        entry = self._entries[import_name]
        doc = ""
        try:
            doc = Path(entry["doc_path"]).read_text(encoding="utf-8")
        except OSError:
            pass
        return {
            "import_name": import_name,
            "name": entry["name"],
            "directory": entry["directory"],
            "doc_path": entry["doc_path"],
            "documentation": doc,
        }


def install_skills_import_guard(ns: dict[str, Any], skills_ns: _SkillsNamespace) -> None:
    """Ensure `import skills` inside a cell returns the live `skills` namespace."""
    original = getattr(builtins.__import__, "__repl_core_original__", builtins.__import__)

    def __import__(name: str, globals: dict[str, Any] | None = None, locals: dict[str, Any] | None = None, fromlist: tuple[str, ...] = (), level: int = 0) -> Any:
        if name != "skills" or level != 0 or globals is not ns:
            return original(name, globals, locals, fromlist, level)
        for item in fromlist or ():
            if item == "*":
                continue
            try:
                getattr(skills_ns, item)
            except AttributeError as exc:
                raise ImportError(f"cannot import name {item!r} from 'skills': {exc}", name="skills") from None
        return skills_ns

    __import__.__repl_core_original__ = original  # type: ignore[attr-defined]
    builtins.__import__ = __import__
