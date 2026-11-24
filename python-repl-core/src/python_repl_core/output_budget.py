"""Bounded output formatting with head/tail truncation and overflow file spill."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class BoundedText:
    text: str
    truncated: bool
    overflow_path: str | None = None
    total_chars: int = 0


def bound_text(
    raw: str,
    *,
    max_chars: int = 24_000,
    overflow_dir: Path | None = None,
    overflow_name: str = "output.txt",
) -> BoundedText:
    """Keep head and tail when `raw` exceeds `max_chars`, spilling full text to disk."""
    total = len(raw)
    if max_chars <= 0 or total <= max_chars:
        return BoundedText(text=raw, truncated=False, overflow_path=None, total_chars=total)

    overflow_path: str | None = None
    if overflow_dir is not None:
        overflow_dir.mkdir(parents=True, exist_ok=True)
        target = overflow_dir / overflow_name
        target.write_text(raw, encoding="utf-8")
        overflow_path = str(target)

    # Reserve room for the truncation marker so the returned string stays bounded.
    head_len = max(1, (max_chars - 256) // 2)
    tail_len = max(1, (max_chars - 256) - head_len)
    omitted = total - head_len - tail_len
    note = f"\n\n... [{omitted} chars omitted out of {total}"
    if overflow_path:
        note += f"; full output saved to {overflow_path}"
    note += "] ...\n\n"
    return BoundedText(
        text=raw[:head_len] + note + raw[-tail_len:],
        truncated=True,
        overflow_path=overflow_path,
        total_chars=total,
    )
