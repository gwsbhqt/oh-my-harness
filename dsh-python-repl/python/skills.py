"""Vet and import the Python skills the host found into the `skills` namespace.

The host discovers them (src/skill-discovery.ts: SKILL.md frontmatter, Prime's
import-name rule) and passes the entries in; this module never rescans.

Deliberate limits, all from AGENTS.md:

- Only explicitly configured trusted roots are scanned. Never the whole
  workspace.
- Nothing is pip-installed here. A missing dependency is reported, not fixed;
  the model can fix it with `repl.install` and `repl.restart`.
- A skill that fails to import is reported and EXCLUDED; the others still load.
- Two skills claiming the same import name: NEITHER loads. No scan-order winner.
- Import failures are never swallowed silently.
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import keyword
import types
import sys
import traceback
from pathlib import Path
from typing import Any

from dsh_kernel import _Namespace, _page

#: Static markers that a module wants Prime's host, which this deployment has
#: no intention of providing. Detection is a diagnostic, never a security gate:
#: a dynamic import inside a function body will only surface when it runs.
_PRIME_IMPORT_MARKERS = (
    "from rlm import",
    "import rlm",
    "from rlm.",
)


def _static_prime_dependency(package_dir: Path) -> str | None:
    """Report the first obvious Prime-host import, with its location."""
    for py in sorted(package_dir.rglob("*.py")):
        try:
            text = py.read_text(encoding="utf-8")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            for marker in _PRIME_IMPORT_MARKERS:
                if stripped.startswith(marker):
                    return f"{py}:{lineno}: {stripped}"
    return None


class _CallableSkill:
    """Wraps a skill module so `await skills.name(...)` works.

    Prime's convention: a module exposing `run` is itself callable, the call
    is awaited, and an awaitable result is awaited too, so a sync `run` works
    the same way. Attribute access still reaches the real module.
    """

    __slots__ = ("_module", "_name")

    def __init__(self, module: Any, name: str) -> None:
        self._module = module
        self._name = name

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        run = getattr(self._module, "run", None)
        if not callable(run):
            raise TypeError(
                f"skill {self._name!r} is not callable: it defines no run(); "
                f"call one of its functions directly, e.g. skills.{self._name}.some_function(...)"
            )
        result = run(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    def __getattr__(self, attribute: str) -> Any:
        return getattr(self._module, attribute)

    def __dir__(self) -> list:
        return dir(self._module)

    def __repr__(self) -> str:
        return f"<skill {self._name!r}>"

    def __reduce__(self):
        # Snapshots keep `reader = skills.demo_reader` as a name, not the module's state (python/snapshot_refs.py).
        import snapshot_refs

        return (snapshot_refs.skill, (self._name,))


def _callable_module(module: Any, name: str) -> Any:
    """Expose a skill as callable when it follows the `run` convention."""
    if callable(getattr(module, "run", None)):
        return _CallableSkill(module, name)
    return module


def _candidate(entry: dict[str, Any]) -> dict[str, Any]:
    if entry.get("document_error"):
        return {**entry, "status": "unavailable", "reason": entry["document_error"]}
    if entry.get("instructions_file") not in {"SKILL.md", "PYSKILL.md"}:
        return {**entry, "status": "unavailable", "reason": "host did not select a valid skill instruction document"}
    if entry.get("import_name"):
        return {**entry, "status": "candidate"}
    return {**entry, "status": "docs-only", "reason": "no Python package under src/; this skill is instructions only"}


def load(entries: list[dict[str, Any]], namespace: Any, disabled: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    """Vet and import every Python skill the host found; bind the good ones into `namespace`.

    Returns a report the host shows verbatim — loaded names, and for each
    failure a reason a human can act on.

    `disabled` names skills the user switched off (skill settings provider): the
    host already left them out of `entries`; they are reported as "disabled".
    """
    candidates = [_candidate(entry) for entry in entries]
    candidates += [
        {"skill": name, "import_name": None, "status": "disabled", "reason": "turned off in the skill exposure settings"}
        for name in disabled
    ]

    # Conflict pre-check BEFORE any import, so a losing candidate never runs
    # module-level code. Same import name twice => neither loads.
    by_import: dict[str, list[dict[str, Any]]] = {}
    for record in candidates:
        if record["status"] != "candidate":
            continue
        by_import.setdefault(record["import_name"], []).append(record)
    for import_name, group in by_import.items():
        if len(group) > 1:
            where = ", ".join(r["path"] for r in group)
            for record in group:
                record["status"] = "unavailable"
                record["reason"] = (
                    f"import name {import_name!r} is claimed by {len(group)} skills ({where}); "
                    "none is loaded — resolve the collision explicitly"
                )

    loaded: list[str] = []
    for record in candidates:
        if record["status"] != "candidate":
            continue
        import_name = record["import_name"]
        src = record["src"]
        assert isinstance(import_name, str) and isinstance(src, str)

        if not import_name.isidentifier():
            record["status"] = "unavailable"
            record["reason"] = f"{import_name!r} is not a valid Python module name"
            continue

        prime_dep = _static_prime_dependency(Path(src) / import_name)
        if prime_dep is not None:
            record["status"] = "unavailable"
            record["reason"] = (
                f"depends on Prime's own host runtime ({prime_dep}); this deployment provides DSH "
                "capabilities through `from dsh_kernel import tools` instead"
            )
            continue

        # Inserting on sys.path does NOT beat sys.modules: if `json` (or any
        # module the kernel already imported) shares this import name,
        # import_module returns the CACHED module and we would bind the stdlib
        # while reporting the skill as loaded.
        cached = sys.modules.get(import_name)
        if cached is not None:
            cached_file = getattr(cached, "__file__", None)
            if cached_file is None or not str(Path(cached_file).resolve()).startswith(
                str(Path(src).resolve())
            ):
                record["status"] = "unavailable"
                record["reason"] = (
                    f"import name {import_name!r} is already taken by another module "
                    f"({cached_file or 'a built-in'}); rename the skill package so it cannot "
                    "shadow or be shadowed by it"
                )
                continue

        # Appended, as Prime's editable installs are: a skill never shadows the
        # stdlib or an installed package (the resolution check below says so).
        if src not in sys.path:
            sys.path.append(src)
        try:
            module = importlib.import_module(import_name)
        except BaseException as exc:  # noqa: BLE001 - report, never swallow
            record["status"] = "unavailable"
            record["reason"] = f"{type(exc).__name__}: {exc}"
            record["traceback"] = traceback.format_exc(limit=5)
            continue

        # Verify what we actually got: an import can still resolve elsewhere
        # (a stale entry, a namespace package). Binding the wrong object while
        # claiming success is the failure this guards against.
        resolved = getattr(module, "__file__", None)
        if resolved is None or not str(Path(resolved).resolve()).startswith(str(Path(src).resolve())):
            record["status"] = "unavailable"
            record["reason"] = (
                f"{import_name!r} resolved to {resolved or 'a built-in module'}, which is outside "
                f"the skill directory {src}; refusing to bind an unrelated module"
            )
            sys.modules.pop(import_name, None)
            continue

        namespace._put(import_name, _callable_module(module, import_name))
        record["status"] = "available"
        record["entry"] = "run" if callable(getattr(module, "run", None)) else None
        loaded.append(import_name)

    report = {
        "loaded": sorted(loaded),
        "skills": candidates,
        "failed": [r for r in candidates if r["status"] == "unavailable"],
    }
    if isinstance(namespace, _SkillsNamespace):
        namespace._report = report
    return report



def _instructions(record: dict[str, Any]) -> str | None:
    """Read the host-selected document lazily; never switch variants after a read failure."""
    path = record.get("path")
    if not path:
        return None
    if record.get("document_error"):
        raise RuntimeError(record["document_error"])
    file = record.get("instructions_file")
    if file not in {"SKILL.md", "PYSKILL.md"}:
        raise ValueError("host did not select a valid skill instruction document")
    try:
        return (Path(path) / file).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as err:
        raise RuntimeError(f"{file} unreadable: {err}") from err


def _access(name: str) -> str:
    if name.isidentifier() and not keyword.iskeyword(name) and not name.startswith("_") and name not in {"list", "describe"}:
        return f"skills.{name}"
    return f"skills[{name!r}]"


def _function_details(value: Any, access: str) -> dict[str, Any]:
    """Inspect only real Python functions, without user signature hooks/repr.

    A clean function copy removes __signature__, __wrapped__ and annotations;
    opaque defaults are shown as Ellipsis rather than evaluated for display.
    """
    if type(value) is not types.FunctionType:
        return {"signature": None, "description": None}
    import inspect

    def safe_default(default):
        return default if any(type(default) is cls for cls in (str, int, float, complex, bool, type(None))) else Ellipsis

    clean = types.FunctionType(value.__code__, {}, value.__name__,
                               tuple(safe_default(v) for v in value.__defaults__) if value.__defaults__ else None,
                               value.__closure__)
    clean.__kwdefaults__ = {k: safe_default(v) for k, v in (value.__kwdefaults__ or {}).items()}
    return {
        "signature": access + str(inspect.signature(clean)),
        "description": value.__doc__ if type(value.__doc__) is str else None,
        "async": bool(value.__code__.co_flags & inspect.CO_COROUTINE),
        "signature_note": "Annotations omitted; opaque defaults shown as Ellipsis.",
    }


class _SkillsNamespace(_Namespace):
    """Local metadata for skills already considered by the startup loader.

    Never scans, imports or calls a skill during discovery queries. This is not
    the host's text-skill registry (use tools.skill for that registry).
    """

    def __init__(self, renames=None):
        super().__init__("skills")
        self._report = None
        self._renames = {key.lower(): value for key, value in (renames or {}).items()}

    def _records(self):
        return self._report["skills"] if self._report is not None else []

    def __getattr__(self, name):
        try:
            return super().__getattr__(name)
        except AttributeError:
            # Like Prime's import-failure placeholder: say why, at the point of use.
            for record in self._records():
                if record.get("import_name") == name and record.get("reason"):
                    raise AttributeError(f"skill {name!r} is not available: {record['reason']}") from None
                # Text-only skills are listed in skills.list(), but are not
                # Python modules; point at the host skill tool instead.
                if record.get("status") == "docs-only" and record["skill"].replace("-", "_") == name:
                    raise AttributeError(
                        f"skill {name!r} is a text skill, not a Python module; "
                        f"use await tools.skill({{'name': {record['skill']!r}}})"
                    ) from None
            if name.startswith("__"):
                raise
            raise AttributeError(_missing_skill(name, sorted(self._members), self._renames)) from None

    def _item(self, record):
        name = record.get("import_name") or record["skill"]
        available = record["status"] == "available" and name in self._members
        status = record["status"] if record["status"] != "available" or available else "unavailable"
        return {
            "id": name, "name": record["skill"], "skill_name": record["skill"],
            "summary": record.get("description", "").split("\n")[0][:160],
            "status": status,
            "instructions_file": record.get("instructions_file"),
            "reason": "loaded skill binding is missing" if record["status"] == "available" and not available else record.get("reason"),
            "access": _access(name) if available else None,
        }

    async def list(self, query=None, *, limit=20, cursor=None):
        if query is not None and type(query) is not str:
            raise TypeError("query must be a string or None")
        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be a positive integer")
        query = (query or "").strip().lower()
        items = sorted((self._item(r) for r in self._records()), key=lambda r: (r["id"], r["name"]))
        items = [item for item in items if query in (item["id"] + " " + item["name"] + " " + item["summary"]).lower()]
        page, next_cursor = _page(items, limit, cursor, "skills.list")
        state = "ready" if self._report is not None else "not-initialized"
        return {
            "items": page, "total": len(items), "next_cursor": next_cursor,
            "status": state,
            "reason": ("Python skills have not been initialized." if state == "not-initialized" else
                       "No Python skills found in the configured skillRoots." if not self._records() else None),
            "note": "Python instructions prefer PYSKILL.md; SKILL.md is selected only when it is absent. Other host text skills use tools.skill.",
        }

    async def describe(self, targets):
        if type(targets) is str:
            targets = [targets]
        if type(targets) is not list or any(type(t) is not str for t in targets):
            raise TypeError("targets must be a string or list of strings")
        items = []
        for target in targets:
            # Exact ids win, including docs-only names containing dots. Otherwise
            # accept exactly one public module member, never arbitrary traversal.
            records = [r for r in self._records() if (r.get("import_name") or r["skill"]) == target]
            member = None
            if not records and target.count(".") == 1:
                name, member = target.split(".")
                if member.isidentifier() and not keyword.iskeyword(member) and not member.startswith("_"):
                    records = [r for r in self._records() if r.get("import_name") == name]
            if len(records) != 1:
                items.append({"id": target, "status": "unknown" if not records else "unavailable",
                              "reason": "no unique loaded skill or public member matches this target" if not records else "; ".join(r.get("reason", "ambiguous skill id") for r in records)})
                continue
            record = records[0]
            item = self._item(record)
            item.update(id=target, description=record.get("description", ""),
                        parameters=None, returns=None)
            if member is None:
                item["instructions"] = _instructions(record)
                if record.get("path"):
                    # Without this a model resolves references/… against a skillRoot it saw elsewhere (I-062).
                    item["directory"] = record["path"]
                    item["links"] = "Relative links in instructions (references/…, src/…) resolve against directory."
            if item["status"] == "available":
                value = self._members[record["import_name"]]
                if type(value) is _CallableSkill:
                    value = object.__getattribute__(value, "_module")
                module = types.ModuleType.__getattribute__(value, "__dict__") if type(value) is types.ModuleType else {}
                if member is not None:
                    if member not in module:
                        item.update(status="unknown", access=None, reason="no such public module member")
                    else:
                        item["access"] += "." + member
                        item.update(_function_details(module[member], item["access"]))
                else:
                    item["members"] = sorted(k for k in module if type(k) is str and not k.startswith("_"))
                    item.update({k: v for k, v in _function_details(module.get("run"), item["access"]).items() if k != "description"})
            elif member is not None:
                item["access"] = None
            items.append(item)
        return {"items": items}


def _missing_skill(name: str, available: list[str], renames=None) -> str:
    """Say which skill was probably meant: a retired name's successor, or a close spelling."""
    import difflib

    guess = (renames or {}).get(name.lower())
    if guess not in available:
        close = difflib.get_close_matches(name, available, n=1, cutoff=0.6)
        guess = close[0] if close else None
    listed = ", ".join(available[:20]) + (" …" if len(available) > 20 else "")
    if guess is not None:
        return f"no skill named {name!r}; did you mean skills.{guess}? Available: {listed}"
    return f"no skill named {name!r}. Available: {listed}"
