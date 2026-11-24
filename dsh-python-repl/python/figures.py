"""Shared module; delegates to `python_repl_core.figures`."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_CORE_SRC = Path(__file__).resolve().parents[2] / "python-repl-core" / "src"
if _CORE_SRC.is_dir() and str(_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(_CORE_SRC))

sys.modules[__name__] = importlib.import_module("python_repl_core.figures")
