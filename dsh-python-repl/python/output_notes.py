"""What the model is told about `_` when a cell's output was cut.

The host cuts a cell's output to its budget and saves the whole text, but
only 2% of cut cells on real sessions (2026-11-03) went on to use `_` or the saved
file; 21% rewrote the cell and ran it again. Saying what `_` holds right
there (type, length, first keys) makes slicing it the obvious next step. Only
exact builtin types are described: no user `repr`, `len` or attribute access.
"""
from __future__ import annotations

_last_id: int | None = None
_KEYS = 8
_KEY_CHARS = 40


def _describe(value) -> str | None:
    kind = type(value)
    if kind is str:
        return f"a str of {len(value)} characters"
    if kind is bytes:
        return f"bytes of length {len(value)}"
    if isinstance(value, dict) and type(value).__module__ in ("builtins", "dsh_kernel"):
        keys = [repr(k)[:_KEY_CHARS] for k in list(value)[:_KEYS]]
        more = f" (+{len(value) - _KEYS} more)" if len(value) > _KEYS else ""
        return f"a dict of {len(value)} keys: {', '.join(keys)}{more}"
    if kind in (list, tuple, set, frozenset):
        first = next(iter(value), None) if kind is not set and kind is not frozenset else None
        inner = ""
        if type(first) is dict:
            inner = f"; items are dicts with keys {', '.join(repr(k)[:_KEY_CHARS] for k in list(first)[:_KEYS])}"
        elif first is not None and type(first).__module__ == "builtins":
            inner = f"; items are {type(first).__name__}"
        return f"a {kind.__name__} of {len(value)} items{inner}"
    return f"a {kind.__module__}.{kind.__qualname__}" if kind.__module__ != "builtins" else f"a {kind.__name__}"


def _how(value) -> str:
    """Ways to look into this value that work for its type: a dict cannot be sliced."""
    kind = type(value)
    if kind in (str, bytes, list, tuple):
        return "`_[:20]`, `len(_)`"
    if isinstance(value, dict):
        return "`list(_)[:5]`, `_[key]`, `len(_)`"
    if kind in (set, frozenset):
        return "`sorted(_)[:20]`, `len(_)`"
    return "its fields or `len(_)`"


def after_cell(ns: dict, truncated: bool) -> str | None:
    """Remember which object `_` is; when the output was cut, say what it holds."""
    global _last_id
    value = ns.get("_")
    fresh = "_" in ns and id(value) != _last_id
    _last_id = id(value) if "_" in ns else None
    if not truncated:
        return None
    if not fresh:
        return ("This cell ended without a value, so `_` still holds an earlier result. "
                "Next time assign what you print to a variable and show a slice or a count instead.")
    described = _describe(value)
    return (f"`_` holds this cell's value, {described}. Slice, filter or count it ({_how(value)}) "
            "instead of running the cell again.") if described else None
