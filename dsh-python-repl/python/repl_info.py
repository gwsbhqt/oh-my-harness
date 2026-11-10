"""`repl`: read-only awareness of the live kernel.

Answers "what is actually bound right now", which the capability catalog
cannot: the catalog lists what the HOST offers, while this reads real Python
globals — including the user's own variables and any name they shadowed.

Safety rules (CAPABILITY-DISCOVERY §11.3), enforced here rather than left to
good intentions:

- Never call a user `__repr__`, `__str__`, `__len__`, property or `__getattr__`
  just to build a listing. Introspection must not run user code or trigger
  side effects.
- Only well-known builtin containers get a size; anything else reports its type
  and stops.
- `describe` accepts an exact top-level name, never an expression to evaluate.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import prelude as _prelude

#: Types whose len()/repr() are C-level and cannot run user code.
#:
#: Matched by EXACT type, never isinstance: a subclass can override __len__ or
#: __repr__, so `isinstance(x, list)` would happily execute user code during a
#: supposedly read-only listing.
_SAFE_SIZED_EXACT = frozenset({str, bytes, bytearray, list, tuple, dict, set, frozenset})
_SAFE_SCALAR_EXACT = frozenset({int, float, complex, bool, type(None)})


def _actual_instance(value: Any, *classes: type) -> bool:
    """Compare real MRO identities without a user-controlled __class__ hook."""
    mro = type.__dict__["__mro__"].__get__(type(value))
    return any(base is target for base in mro for target in classes)


def _is_bridge_value(value: Any) -> bool:
    """Whether a bridge-owned name still holds something the bridge installed.

    Resolved against the bridge's real classes (and their subclasses, so a new
    container type like the MCP root is covered automatically) rather than a
    hand-maintained list of type names — that list was a standing source of
    false "you shadowed a system name" warnings every time a class was added.
    `ToolCallError` is bound to a class, which is why `isinstance(value, type)`
    counts.
    """
    if _actual_instance(value, type):
        return True
    try:
        import dsh_kernel as _bridge
    except ImportError:
        return False
    import bootstrap as _bootstrap

    return _actual_instance(value, _bridge._Namespace, _bridge._ToolProxy, _bootstrap._Repl)


def _origin(name: str, value: Any) -> str:
    if name in _bridge_names():
        return "system"
    if _prelude.is_preloaded(name, value):
        return "preloaded"
    if _actual_instance(value, types.ModuleType):
        return "import"
    if name.startswith("_"):
        return "internal"
    return "user"


def _kind(value: Any) -> str:
    if _is_bridge_value(value) and not _actual_instance(value, type):
        return "system"
    if _actual_instance(value, types.ModuleType):
        return "module"
    if _actual_instance(value, types.FunctionType, types.MethodType, types.BuiltinFunctionType):
        return "function"
    if _actual_instance(value, type):
        return "class"
    return "data"


def _summary(value: Any) -> str:
    """A cheap description that NEVER runs user code.

    Exact-type checks only. A `class Sneaky(list)` with a logging `__len__`
    must yield just its type name, not a length obtained by calling it.
    """
    cls = type(value)
    type_name = str.__getitem__(type.__dict__["__name__"].__get__(cls), slice(128))
    if any(cls is candidate for candidate in _SAFE_SIZED_EXACT):
        return f"{type_name}, len={len(value)}"
    if any(cls is candidate for candidate in _SAFE_SCALAR_EXACT):
        return f"{type_name}={value!r}"
    # Anything else — including a subclass of a builtin — gets its type only.
    return type_name


def _user_namespace() -> dict[str, Any]:
    return sys.modules["__main__"].__dict__


def _cwd_matches_workspace() -> bool | None:
    """Whether the kernel's cwd is the workspace the host told us about.

    Returns None when the host did not say — never a guess.
    """
    import os

    declared = os.environ.get("DSH_PYTHON_REPL_WORKSPACE")
    if not declared:
        return None
    try:
        return os.path.realpath(os.getcwd()) == os.path.realpath(declared)
    except OSError:
        return None


def info(epoch: int = 0, python_version: str | None = None) -> dict[str, Any]:
    """Kernel state: generation, interpreter, and how many names of each origin."""
    ns = _user_namespace()
    counts: dict[str, int] = {}
    for name, value in ns.items():
        if name.startswith("__") and name.endswith("__"):
            continue
        counts[_origin(name, value)] = counts.get(_origin(name, value), 0) + 1
    return {
        "epoch": epoch,
        "python": python_version or ".".join(str(p) for p in sys.version_info[:3]),
        "executable": sys.executable,
        "cwd": __import__("os").getcwd(),
        # Say outright whether a relative path here means the same thing it
        # means to `bash` and the file tools. They are aligned by default, but
        # a caller that overrides the working directory — or a fallback when no
        # session cwd is known — can separate them, and silently disagreeing
        # about where `open("out.csv")` lands is a nasty way to find out.
        "cwd_matches_workspace": _cwd_matches_workspace(),
        "bindings": counts,
        # The venv `repl.install` puts packages into; None when the kernel runs outside one.
        "packages": None if sys.prefix == sys.base_prefix else sys.prefix,
        # Reporting "idle" from inside a running cell would be a lie.
        "state": "running-this-cell",
    }


def list_names(
    query: str | None = None,
    kind: str | None = None,
    origin: str | None = None,
    limit: int = 20,
    cursor: str | None = None,
) -> dict[str, Any]:
    """List real top-level bindings, filtered and paged.

    Preloaded standard-library names are left out of an unfiltered listing:
    they are in every kernel and would bury the user's own names. A query or
    `origin="preloaded"` still finds them.
    """
    from dsh_kernel import _page

    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError("limit must be an exact int between 1 and 500")
    for label, value in (("query", query), ("kind", kind), ("origin", origin)):
        if value is not None and type(value) is not str:
            raise TypeError(f"{label} must be a string or None")
    matched = []
    for name, value in sorted(_user_namespace().copy().items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        if query is not None and query.lower() not in name.lower():
            continue
        item_origin = _origin(name, value)
        if origin is not None and item_origin != origin:
            continue
        if origin is None and query is None and (item_origin == "preloaded" or name == "_"):
            continue
        item_kind = _kind(value)
        if kind is not None and item_kind != kind:
            continue
        matched.append((name, value, item_kind, item_origin))
    page, next_cursor = _page(matched, limit, cursor, "repl.list")
    return {
        "items": [{"name": name, "kind": item_kind, "origin": item_origin, "summary": _summary(value)}
                  for name, value, item_kind, item_origin in page],
        "total": len(matched),
        "next_cursor": next_cursor,
    }


def _public_methods(value: Any) -> list[dict[str, Any]]:
    """List the public methods on system helper objects and their first docstring line."""
    import inspect

    cls = type(value)
    if cls.__module__ not in ("bootstrap", "dsh_kernel"):
        return []
    methods: list[dict[str, Any]] = []
    for name, member in inspect.getmembers(cls, predicate=inspect.isfunction):
        if name.startswith("_"):
            continue
        try:
            signature = inspect.signature(member)
            parameters = list(signature.parameters.values())[1:]
            rendered = str(signature.replace(parameters=parameters))
        except (TypeError, ValueError):
            rendered = "(...)"
        doc = (inspect.getdoc(member) or "").splitlines()[0] if inspect.getdoc(member) else ""
        methods.append({"name": name, "signature": f"{name}{rendered}", "doc": doc})
    return sorted(methods, key=lambda item: item["name"])


def describe(name: str) -> dict[str, Any]:
    """Explain what ONE exact top-level name is currently bound to.

    Not an evaluator: `name` must be a binding, not an expression. Business
    contracts (what a tool does) belong to the capability catalog; this only
    answers "what is this name now".
    """
    ns = _user_namespace()
    if name not in ns:
        return {"name": name, "status": "unbound", "reason": "no such top-level name"}
    value = ns[name]
    record: dict[str, Any] = {
        "name": name,
        "status": "bound",
        "kind": _kind(value),
        "origin": _origin(name, value),
        "summary": _summary(value),
    }
    if type(value) is types.ModuleType:
        # Read __dict__ directly: dir() honours a module-level __dir__, and
        # getattr() can fire a module __getattr__ (PEP 562) — both user code.
        module_dict = getattr(value, "__dict__", {})
        record["module"] = module_dict.get("__name__")
        record["file"] = module_dict.get("__file__")
        record["members"] = sorted(k for k in module_dict if not k.startswith("_"))[:40]
    elif type(value).__module__ in ("bootstrap", "dsh_kernel"):
        methods = _public_methods(value)
        if methods:
            record["methods"] = methods
    elif type(value) in (types.FunctionType, types.MethodType):
        try:
            import inspect

            # Render parameters WITHOUT repr()-ing default values: a default
            # object's __repr__ is user code, and str(Signature) calls it.
            signature = inspect.signature(value)
            rendered = []
            for param_name, param in signature.parameters.items():
                prefix = ""
                if param.kind is inspect.Parameter.VAR_POSITIONAL:
                    prefix = "*"
                elif param.kind is inspect.Parameter.VAR_KEYWORD:
                    prefix = "**"
                if param.default is inspect.Parameter.empty:
                    rendered.append(f"{prefix}{param_name}")
                else:
                    default = param.default
                    shown = (
                        repr(default) if type(default) in _SAFE_SCALAR_EXACT else f"<{type(default).__name__}>"
                    )
                    rendered.append(f"{prefix}{param_name}={shown}")
            record["signature"] = f"{name}({', '.join(rendered)})"
            record["doc"] = (inspect.getdoc(value) or "").split("\n\n")[0] or None
            code = getattr(value, "__code__", None)
            if code is not None:
                record["defined_at"] = f"{code.co_filename}:{code.co_firstlineno}"
        except (TypeError, ValueError):
            record["signature"] = None
    if name in _bridge_names():
        originals = _installed_originals()
        record["shadowed"] = name in originals and value is not originals[name]
        if record["shadowed"]:
            advice = (
                'restore repl first: import bootstrap as _b; repl = _b._ORIGINAL_BINDINGS["repl"]'
                if ns.get("repl") is not originals.get("repl")
                else f"call await repl.restore_binding({name!r}) to put the original back"
            )
            record["reason"] = (
                f"{name!r} is a system binding but currently holds a {type(value).__name__}; {advice}"
            )
    return record


class _HelperView(dict):
    """`repl.helpers()` result: an ordinary dict that displays as a short list."""

    def __repr__(self) -> str:
        items = self["items"]
        if not items:
            return "── helpers · none yet — define a function the second time you write the same code ──"
        lines = [f"── helpers · {len(items)} (view of a dict) ──"]
        for item in items:
            doc = item["doc"] or "(no docstring — add one line saying what it returns)"
            lines.append(f"{item['signature'] or item['name']}  — {doc}")
        return "\n".join(lines)

    __str__ = __repr__


def helpers() -> dict[str, Any]:
    """The user's own top-level functions and classes, for finding what to reuse.

    Signatures are rendered by `describe`, which never repr()s default values.
    """
    ns = _user_namespace()
    items = []
    for name in sorted(ns):
        value = ns[name]
        if _origin(name, value) != "user" or _kind(value) not in ("function", "class"):
            continue
        record = describe(name)
        doc = record.get("doc")
        if doc is None and isinstance(value, type):
            import inspect

            doc = (inspect.getdoc(value) or "").split("\n\n")[0] or None
        items.append({"name": name, "kind": record["kind"], "signature": record.get("signature"), "doc": doc})
    return _HelperView(items=items, total=len(items))


def shadowed_bindings(originals: dict | None = None) -> list[str]:
    """System names that no longer hold what the bridge installed.

    Compares by OBJECT IDENTITY against the recorded originals, not by type:
    `tools = int` passed a type-based check (a class is "bridge-like"), and a
    deleted name was skipped entirely because the loop `continue`d on absence.
    Both are now reported.

    Only names the bridge actually installed are considered, so a deployment
    that never granted `glob` does not report it as missing.
    """
    ns = _user_namespace()
    if originals is None:
        originals = _installed_originals()
    bad: list[str] = []
    for name in sorted(originals):
        if name not in ns:
            bad.append(name)  # deleted
            continue
        if ns[name] is not originals[name]:
            bad.append(name)  # replaced
    return bad


def _installed_originals() -> dict:
    """The bridge's recorded originals, or {} before bootstrap ran."""
    try:
        import bootstrap as _b

        return _b._ORIGINAL_BINDINGS
    except Exception:  # noqa: BLE001 - awareness must never break a cell
        return {}


def _bridge_names() -> set:
    """Names the bridge owns, as bootstrap recorded them; empty before it ran."""
    try:
        import bootstrap as _b

        return _b._BRIDGE_NAMES
    except Exception:  # noqa: BLE001 - awareness must never break a cell
        return set()


def restore_binding(name: str, originals: dict[str, Any]) -> dict[str, Any]:
    """Explicitly put a bridge-managed name back.

    Only restores names the bridge owns, only on request, and never touches
    user data. Not a reload, not a restart, not a snapshot rollback.
    """
    if name not in _bridge_names():
        return {"name": name, "restored": False, "reason": "not a bridge-managed binding"}
    if name not in originals:
        return {"name": name, "restored": False, "reason": "no original recorded for this kernel"}
    ns = _user_namespace()
    before = _summary(ns[name]) if name in ns else "unbound"
    ns[name] = originals[name]
    return {"name": name, "restored": True, "before": before, "after": _summary(ns[name])}


#: Conservative default sizing/work budget, not a guarantee about the host's
#: display threshold or its rich-formatting behavior.
DISPLAY_BUDGET_CHARS = 50_000


def display_size(value: Any, budget: int = DISPLAY_BUDGET_CHARS) -> dict[str, Any]:
    """Bounded sizing of builtin repr text, not a prediction of rich display.

    Only exact builtin values are inspected; custom hooks are never called.
    `chars` is exact for status="exact", otherwise None. `over_budget` is
    None for status="unknown": unsupported values, cycles/deep nesting or
    the fixed work limit must not be mistaken for a value that fits.
    """
    if type(budget) is not int:
        raise TypeError("budget must be an exact int")
    if budget < 0:
        raise ValueError("budget must be non-negative")
    limit = budget
    # Invoke the builtin descriptor directly, bypassing metaclass properties
    # and __getattribute__. Never hash/compare an untrusted class, either.
    type_name = type.__dict__["__name__"].__get__(type(value))
    chars = 0
    nodes = 0

    class UnknownSize(Exception):
        pass

    class OverBudget(Exception):
        pass

    def add(count: int) -> None:
        nonlocal chars
        chars += count
        if chars > limit:
            raise OverBudget
        if chars > DISPLAY_BUDGET_CHARS:
            raise UnknownSize

    def count(item: Any, ancestors: tuple[int, ...] = ()) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > DISPLAY_BUDGET_CHARS or len(ancestors) > 64:
            raise UnknownSize
        cls = type(item)
        if any(cls is t for t in (str, bytes, bytearray)):
            # repr never shortens these values. Check before formatting, and
            # cap the input even when the caller requests an enormous budget.
            if len(item) > limit - chars:
                raise OverBudget
            if len(item) > DISPLAY_BUDGET_CHARS:
                raise UnknownSize
            add(len(repr(item)))
        elif any(cls is t for t in (int, float, complex, bool, type(None))):
            # Decimal conversion of arbitrarily large ints is not bounded.
            if cls is int and item.bit_length() > 4096:
                raise UnknownSize
            add(len(repr(item)))
        elif any(cls is t for t in (list, tuple, dict, set, frozenset)):
            if id(item) in ancestors:
                raise UnknownSize
            ancestors = (*ancestors, id(item))
            size = len(item)
            if cls is set and not size:
                add(5)  # set()
            elif cls is frozenset:
                add(13 if size else 11)  # frozenset({...}) / frozenset()
            else:
                add(3 if cls is tuple and size == 1 else 2)
            for index, child in enumerate(item.items() if cls is dict else item):
                if index:
                    add(2)  # comma and space
                if cls is dict:
                    count(child[0], ancestors)
                    add(2)  # colon and space
                    count(child[1], ancestors)
                else:
                    count(child, ancestors)
        else:
            raise UnknownSize

    status = "exact"
    over_budget: bool | None = False
    advice = "builtin repr fits the budget; rich display may differ"
    try:
        count(value)
    except OverBudget:
        status, over_budget = "over_budget", True
        advice = (
            "larger than the display budget — do NOT end a cell with it. "
            "Show len()/a count, a few sample items, or a computed conclusion."
        )
    except (UnknownSize, ValueError, RuntimeError):
        # Includes integer conversion limits and concurrent container mutation,
        # but deliberately never catches cancellation/KeyboardInterrupt.
        status, over_budget = "unknown", None
        advice = "cannot determine within safe sizing limits; show a computed summary instead"
    return {
        "chars": chars if status == "exact" else None,
        "over_budget": over_budget,
        "budget": limit,
        "type": type_name,
        "advice": advice,
        "status": status,
    }
