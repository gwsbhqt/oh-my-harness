"""Kernel-side bootstrap executed once per Antigravity REPL kernel."""

from __future__ import annotations

import ast
import asyncio
import inspect
import os
import sys
import types
from pathlib import Path
from typing import Any

from python_repl_core import prelude, recovery_copies
from python_repl_core.preview import preview as _preview
from python_repl_core.skills_runtime import _SkillsNamespace, install_skills_import_guard

from agy_python_repl.builtin_tools import BUILTIN_TOOL_NAMES, _ToolResult, create_builtin_tools

SKILL_RETRY_MIME = "application/vnd.agy-python-repl.skill-retry+json"
REUSE_HINT_MIME = "application/vnd.agy-python-repl.reuse-hint+json"
SNAPSHOT_BUILTINS = BUILTIN_TOOL_NAMES | {"asyncio", "ToolCallError"}
_PATH_TYPE = type(Path())
_ORIGINAL_BINDINGS: dict[str, Any] = {}
_SAFE_SIZED_EXACT = frozenset({str, bytes, bytearray, list, tuple, dict, set, frozenset})
_SAFE_SCALAR_EXACT = frozenset({int, float, complex, bool, type(None)})


def _reused_path(code: str, namespace: dict[str, Any], reported: set[str]) -> str | None:
    if "Path" not in code or namespace.get("Path") is not Path:
        return None
    rebound: set[str] = set()
    for node in ast.parse(code).body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    return None
                if (isinstance(node, ast.ImportFrom) and node.level == 0 and node.module == "pathlib"
                        and alias.name == "Path" and alias.asname is None):
                    continue
                rebound.add(alias.asname or alias.name.split(".")[0])
            continue
        match node:
            case ast.Assign(targets=[ast.Name(id=name)], value=ast.Call(
                func=ast.Name(id="Path"), args=[ast.Constant(value=str() as path)], keywords=[]
            )) if "Path" not in rebound:
                current = namespace.get(name)
                if (name not in rebound and name not in reported
                        and type(current) is _PATH_TYPE and current == Path(path)):
                    return name
                rebound.add(name)
            case _:
                break
    return None


def _install_reuse_hint(prime: Any, namespace: dict[str, Any]) -> None:
    compile_cell = prime._compile_cell
    if getattr(compile_cell, "_agy_reuse_hint", False):
        return
    reported: set[str] = set()

    def compile_cell_with_hint(code: str, filename: str) -> tuple[list[types.CodeType], bool]:
        compiled = compile_cell(code, filename)
        name = _reused_path(code, namespace, reported)
        if name is not None:
            reported.add(name)
            prime.emit({REUSE_HINT_MIME: f"`{name[:80]}` already held that path at cell entry. Use it directly in later cells."})
        return compiled

    compile_cell_with_hint._agy_reuse_hint = True
    prime._compile_cell = compile_cell_with_hint


class _SnapshotSkipNames(set[str]):
    """Prime asks for names. Prelude and unmodified system bindings stay out of snapshots."""

    def __init__(self, fixed_names: set[str], namespace: dict[str, Any]) -> None:
        super().__init__(fixed_names)
        self.namespace = namespace

    def __contains__(self, name: object) -> bool:
        if super().__contains__(name) or prelude.is_preloaded(name, self.namespace.get(name)):
            return True
        return (
            isinstance(name, str)
            and name not in ("skills", "repl")
            and name in _ORIGINAL_BINDINGS
            and self.namespace.get(name) is _ORIGINAL_BINDINGS[name]
        )


class _PreviewResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        state = "whole in-memory value"
        if self["truncated"]:
            state = f"in-memory preview limited by {', '.join(self['reasons'])}"
        return f"── preview of {self['type']} · {state} (view of a dict) ──\n{self['text']}"


class _HelperList(list[dict[str, str]]):
    def __repr__(self) -> str:
        lines = [f"User helper list ({len(self)})"]
        for item in self[:20]:
            line = item["signature"]
            if item["doc"]:
                line += f"  {item['doc']}"
            lines.append(line if len(line) <= 240 else line[:239] + "…")
        if len(self) > 20:
            lines.append(f"{len(self) - 20} more. Filter with await repl.helpers('name').")
        return "\n".join(lines)


class _ReplHelper:
    """Kernel inspection, helper listing, package installation and recovery copies."""

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
        return _PreviewResult(_preview(value, chars=chars, items=items, depth=depth))

    async def helpers(self, query: str = "") -> list[dict[str, str]]:
        """List user functions and classes by name. Start the query with _ to include private helpers."""
        signature_options = {}
        if sys.version_info >= (3, 14):
            from annotationlib import Format

            signature_options["annotation_format"] = Format.STRING
        ns = sys.modules["__main__"].__dict__
        items = _HelperList()
        for name in sorted(ns):
            if query not in name or name.startswith("__") or (name.startswith("_") and not query.startswith("_")):
                continue
            value = ns[name]
            if value is _ORIGINAL_BINDINGS.get(name) or prelude.is_preloaded(name, value):
                continue
            if not (isinstance(value, types.FunctionType) or isinstance(value, type)):
                continue
            if getattr(value, "__module__", "__main__") != "__main__":
                continue
            try:
                signature = inspect.signature(value, **signature_options)
                parameters = []
                for p in signature.parameters.values():
                    default = p.default
                    if default is not p.empty and not (
                        type(default) in (bool, float, type(None)) or type(default) is int and default.bit_length() <= 64
                    ):
                        default = Ellipsis
                    parameters.append(p.replace(annotation=p.empty, default=default))
                sig = str(signature.replace(parameters=parameters, return_annotation=signature.empty))
                sig = sig.replace("=Ellipsis", "=...")
            except (TypeError, ValueError, NameError):
                sig = "(...)"
            doc = (inspect.getdoc(value) or "").partition("\n")[0]
            items.append({"name": name, "signature": f"{name}{sig}", "doc": doc})
        return items

    async def size(self, value: Any) -> str:
        """Describe a built-in value's type and container size without running user hooks."""
        cls = type(value)
        type_name = str.__getitem__(type.__dict__["__name__"].__get__(cls), slice(128))
        if any(cls is candidate for candidate in _SAFE_SIZED_EXACT):
            return f"{type_name}, len={len(value)}"
        if any(cls is candidate for candidate in _SAFE_SCALAR_EXACT):
            return f"{type_name}={value!r}"
        return type_name

    async def restore_binding(self, name: str) -> dict[str, Any]:
        """Restore a shadowed built-in helper or capability namespace."""
        if name not in _ORIGINAL_BINDINGS:
            raise KeyError(f"Unknown built-in binding: {name!r}")
        sys.modules["__main__"].__dict__[name] = _ORIGINAL_BINDINGS[name]
        return {"restored": name}

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
                "arguments": {"action": "restart"},
                "instruction": "Restart this conversation's kernel to load the updated modules.",
            }
        return result

    def vars(self, query: str = "") -> list[str]:
        """Find user-defined names containing query without displaying their values."""
        from rlm import repl as prime

        return [name for name in prime._list_names(vars(sys.modules["__main__"])) if query in name]


def _report_skill_retry(name: str, error: str | None) -> None:
    from rlm import repl as prime

    prime.emit({SKILL_RETRY_MIME: {"import_name": name, "error": error[:1024] if error else None}})


def install_antigravity_surface(
    skill_entries: list[dict[str, Any]], *, kernel: str, copy_session: str | None = None,
    capture_dir: str | None = None,
) -> dict[str, Any]:
    """Prepare the cell namespace and return the skill load report."""
    import dill._dill as dill_impl
    from rlm import repl as prime
    from python_repl_core.snapshot_names import install_snapshot_names

    install_snapshot_names(dill_impl, legacy_underscore_aliases=False)
    ns = sys.modules["__main__"].__dict__
    skills_ns = _SkillsNamespace(on_retry=_report_skill_retry)
    report = skills_ns._register_all(skill_entries)
    install_skills_import_guard(ns, skills_ns)

    tools_surface = create_builtin_tools(capture_dir=Path(capture_dir) if capture_dir else None)
    bindings: dict[str, Any] = {
        "skills": skills_ns,
        "repl": _ReplHelper(kernel=kernel, copy_session=copy_session),
        "asyncio": asyncio,
        **tools_surface,
    }
    _ORIGINAL_BINDINGS.clear()
    _ORIGINAL_BINDINGS.update(bindings)
    ns.update(bindings)
    prelude.install(ns)
    _install_reuse_hint(prime, ns)
    fixed_names = prime._ALWAYS_SKIP.difference(SNAPSHOT_BUILTINS) | {"skills", "repl"}
    prime._ALWAYS_SKIP = _SnapshotSkipNames(fixed_names, ns)
    # Old snapshots may contain user functions with names that later became built-ins.
    prime._RESTORE_SKIP.update({"skills", "repl"})

    return report
