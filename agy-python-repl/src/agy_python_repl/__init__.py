"""Antigravity Python REPL plugin package."""

from __future__ import annotations

import sys
from pathlib import Path

__all__ = ["__version__"]

__version__ = "0.2.1"

_PLUGIN_ROOT = Path(__file__).resolve().parents[2]
for _candidate in (
    _PLUGIN_ROOT / "_bundled",
    _PLUGIN_ROOT.parent / "python-repl-core" / "src",
):
    if (_candidate / "python_repl_core").is_dir() and str(_candidate) not in sys.path:
        sys.path.insert(0, str(_candidate))
        break
