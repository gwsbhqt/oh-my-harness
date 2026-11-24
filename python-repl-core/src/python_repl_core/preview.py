"""Explicit, read-only previews of live values; never certify upstream completeness."""

from __future__ import annotations

from typing import Any

_MAX_CHARS = 50_000
_MAX_ITEMS = 100
_MAX_DEPTH = 32
_MAX_NODES = 1_024
_MAX_SCALAR_CHARS = 50_000
_MAX_INT_BITS = 4_096
_NAME_CHARS = 128


class _StopPreview(Exception):
    pass


def _type_name(value: Any) -> str:
    # A metaclass may override both attribute access and the __name__ property.
    name = type.__dict__["__name__"].__get__(type(value))
    # __name__ itself may be a str subclass with a hostile __getitem__.
    return str.__getitem__(name, slice(_NAME_CHARS))


def preview(value: Any, *, chars: int = 4000, items: int = 20,
            depth: int = 8) -> dict[str, Any]:
    """Return a bounded JSON-compatible preview, without changing the value.

    ``chars`` bounds ``text`` including placeholders and ellipses, not metadata.
    Each container exposes at most ``items`` entries. ``depth`` is the number
    of nonempty container levels to expand. All budgets must be exact, nonnegative
    ints within the hard caps (50,000 / 100 / 32); bool is not an integer budget.
    A separate fixed work budget applies regardless of the requested budgets.

    ``unsupported`` describes only encountered values, not unvisited portions.
    Even an untruncated preview is only of a value already in memory: it says
    nothing about upstream pagination, clipping, failed reads or completeness.
    """
    for name, budget, maximum in (("chars", chars, _MAX_CHARS),
                                  ("items", items, _MAX_ITEMS),
                                  ("depth", depth, _MAX_DEPTH)):
        if type(budget) is not int:
            raise TypeError(f"{name} must be an exact int")
        if budget < 0 or budget > maximum:
            raise ValueError(f"{name} must be between 0 and {maximum}")

    parts: list[str] = []
    used = 0
    nodes = 0
    scalar_chars = 0
    unsupported = False
    reasons: list[str] = []

    def mark(reason: str) -> None:
        if reason not in reasons:
            reasons.append(reason)

    def add(text: str) -> None:
        nonlocal used
        remaining = chars - used
        if len(text) > remaining:
            parts.append(text[:remaining])
            used = chars
            mark("chars_limit")
            raise _StopPreview
        parts.append(text)
        used += len(text)

    def walk(item: Any, ancestors: tuple[int, ...] = ()) -> None:
        nonlocal nodes, scalar_chars, unsupported
        cls = type(item)
        if nodes >= _MAX_NODES:
            mark("work_limit")
            raise _StopPreview
        nodes += 1

        if cls is str or cls is bytes or cls is bytearray:
            size = len(item)
            work_left = _MAX_SCALAR_CHARS - scalar_chars
            take = min(size, chars - used, work_left)
            scalar_chars += take
            # Slice BEFORE repr: escaping can amplify text but never sees the
            # whole giant input, even if the requested output budget is large.
            add(repr(item[:take]))
            if take < size:
                mark("work_limit" if take == work_left else "chars_limit")
                add("…")
        elif cls is int:
            bits = item.bit_length()
            if bits > _MAX_INT_BITS:
                mark("integer_limit")
                add(f"<int bit_length={bits}>")
            else:
                try:
                    text = repr(item)
                except ValueError:
                    # Python's process-wide decimal conversion cap can be
                    # stricter than ours. Do not change it or retry conversion.
                    mark("integer_limit")
                    text = f"<int bit_length={bits}>"
                add(text)
        elif cls is float or cls is complex or cls is bool or cls is type(None):
            add(repr(item))
        elif cls is list or cls is tuple or cls is dict or cls is set or cls is frozenset:
            identity = id(item)
            if identity in ancestors:
                mark("cycle")
                add(f"<cycle {_type_name(item)}>")
                return
            size = len(item)
            if size and len(ancestors) >= depth:
                mark("depth_limit")
                add(f"<depth {_type_name(item)}>")
                return
            if cls is list:
                opening, closing = "[", "]"
            elif cls is tuple:
                opening, closing = "(", ")"
            elif cls is frozenset:
                opening, closing = ("frozenset({", "})") if size else ("frozenset(", ")")
            elif cls is set and not size:
                opening, closing = "set(", ")"
            else:
                opening, closing = "{", "}"
            add(opening)
            ancestors = (*ancestors, identity)
            iterator = iter(item.items() if cls is dict else item)
            count = min(size, items)
            for index in range(count):
                if used == chars:
                    mark("chars_limit")
                    raise _StopPreview
                if index:
                    add(", ")
                try:
                    child = next(iterator)
                except StopIteration:
                    mark("concurrent_mutation")
                    raise _StopPreview
                if cls is dict:
                    key, child_value = child
                    walk(key, ancestors)
                    add(": ")
                    walk(child_value, ancestors)
                else:
                    walk(child, ancestors)
            if size > count:
                mark("items_limit")
                if count:
                    add(", ")
                add("…")
            elif cls is tuple and size == 1:
                add(",")
            add(closing)
        else:
            unsupported = True
            mark("unsupported_type")
            add(f"<unsupported {_type_name(item)}>")

    try:
        walk(value)
    except RuntimeError:
        # Exact dict/set iterators can detect concurrent mutation. Never catch
        # BaseException: cancellation, KeyboardInterrupt and SystemExit escape.
        mark("concurrent_mutation")
    except _StopPreview:
        pass

    text = "".join(parts)
    if reasons and ("chars_limit" in reasons or "work_limit" in reasons
                    or "concurrent_mutation" in reasons):
        if chars:
            text = text[:chars - 1] + "…"
    return {
        "text": text,
        "truncated": bool(reasons),
        "unsupported": unsupported,
        "reasons": reasons,
        "type": _type_name(value),
        "budget": {"chars": chars, "items": items, "depth": depth},
        "scope": "in_memory_value",
        "upstream_completeness": "not_checked",
        "note": "In-memory value preview only; does not prove upstream data completeness. "
                "Unsupported reports only values encountered within the preview budgets.",
    }
