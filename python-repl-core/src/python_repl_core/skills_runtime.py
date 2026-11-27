"""Kernel-side generic `skills.*` namespace loader (host-agnostic)."""

from __future__ import annotations

import builtins
import importlib
import importlib.util
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any


class _SkillsNamespace:
    """Exposes discovered Python skills as `skills.<import_name>`."""

    def __init__(self, *, on_retry: Callable[[str, str | None], None] | None = None) -> None:
        self._loaded: dict[str, Any] = {}
        self._entries: dict[str, dict[str, Any]] = {}
        self._failed: dict[str, str] = {}
        self._conflicts: dict[str, list[dict[str, Any]]] = {}
        self._on_retry = on_retry

    def _import_entry(self, entry: dict[str, Any]) -> Exception | None:
        name, source = entry["import_name"], entry["source_root"]
        # Another skill or a later cell may have moved this source behind a namesake.
        if source in sys.path:
            sys.path.remove(source)
        sys.path.insert(0, source)
        try:
            spec = importlib.util.find_spec(name)
            origin = Path(spec.origin).resolve() if spec and spec.has_location and spec.origin else None
            if origin is None or not origin.is_relative_to(source):
                raise ImportError(f"Cannot import skill {name!r} from its discovered source {source}")
            self._loaded[name] = importlib.import_module(name)
        except Exception as exc:
            self._failed[name] = f"{type(exc).__name__}: {exc}"
            return exc
        self._failed.pop(name, None)
        return None

    def _register_all(self, entries: list[dict[str, Any]]) -> dict[str, Any]:
        by_name: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            by_name.setdefault(entry["import_name"], []).append(entry)

        for name, group in by_name.items():
            # Project skills win over global skills. Reject duplicate definitions at the chosen tier.
            chosen = [entry for entry in group if entry.get("is_project")] or group
            if len(chosen) > 1:
                self._conflicts[name] = chosen
                self._failed[name] = f"Ambiguous duplicate skill {name!r}"
                continue
            entry = {**chosen[0], "source_root": str(Path(chosen[0]["source_root"]).resolve())}
            self._entries[name] = entry
            if reason := entry.get("document_error"):
                self._failed[name] = (f"{reason}. Fix the instructions and use a new kernel name or reopen the workbench "
                                      "to discover the skill again.")
            else:
                self._import_entry(entry)
        return {"loaded": sorted(self._loaded), "failed": self._failed.copy()}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._loaded:
            return self._loaded[name]
        if name in self._conflicts:
            raise AttributeError(f"Skill {name!r} was not loaded due to duplicate conflict")
        if name in self._failed:
            raise AttributeError(self._failure(name, name))
        raise AttributeError(f"No Python skill named {name!r}. Call `await skills.list()` to see available skills.")

    def _failure(self, key: str, display_name: str) -> str:
        status = "has invalid instructions" if self._entries[key].get("document_error") else "failed to import"
        return f"Skill {display_name!r} {status}: {self._failed[key]}"

    def __dir__(self) -> list[str]:
        return sorted([*self._loaded, "list", "describe", "retry"])

    async def list(self) -> list[dict[str, Any]]:
        return [
            {
                "import_name": name,
                "name": entry["name"],
                "description": entry["description"],
                "directory": entry["directory"],
                **({"status": "failed", "error": self._failed[name]} if name in self._failed else {"status": "loaded"}),
            }
            for name, entry in sorted(self._entries.items())
        ]

    def _lookup(self, import_name: str) -> dict[str, Any]:
        key = import_name.replace("-", "_")
        conflicts = self._conflicts.get(key, [])
        if any(import_name in (record["name"], record["import_name"]) for record in conflicts):
            raise KeyError(f"Skill {import_name!r} was not loaded due to duplicate definitions of {key!r}")
        entry = self._entries.get(key)
        if entry is None or import_name not in (entry["name"], entry["import_name"]):
            raise KeyError(f"Unknown skill {import_name!r}")
        return entry

    async def retry(self, import_name: str) -> dict[str, str]:
        """Retry one failed import from the source selected when this kernel started."""
        entry = self._lookup(import_name)
        key = entry["import_name"]
        if key in self._loaded:
            return {"import_name": key, "status": "already_loaded"}
        if entry.get("document_error"):
            raise ValueError(f"Cannot retry {import_name!r}: {self._failed[key]}")
        importlib.invalidate_caches()
        error = self._import_entry(entry)
        if self._on_retry:
            self._on_retry(key, self._failed.get(key))
        if error is not None:
            raise error
        return {"import_name": key, "status": "loaded"}

    async def describe(self, import_name: str) -> dict[str, Any]:
        entry = self._lookup(import_name)
        key = entry["import_name"]
        if key in self._failed:
            raise KeyError(self._failure(key, import_name))
        document = Path(entry["doc_path"])
        try:
            doc = document.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            raise RuntimeError(f"Cannot read skill instructions at {document}: {exc}") from exc
        return {
            "import_name": entry["import_name"],
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
