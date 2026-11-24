"""`rlm.factory` — OUR compatibility shim, not upstream code.

Delegates to shared `python_repl_core.compat.rlm.factory` while preserving
the namespace package file location under `python/compat/rlm/`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CORE_SRC = Path(__file__).resolve().parents[4] / "python-repl-core" / "src"
if _CORE_SRC.is_dir() and str(_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(_CORE_SRC))

from python_repl_core.compat.rlm.factory import (  # noqa: E402, F401
    ACTIVITY_ACTIONS,
    ACTIVITY_TIMEOUT_MS_CAP,
    schedule_activity,
)

__all__ = ["ACTIVITY_ACTIONS", "ACTIVITY_TIMEOUT_MS_CAP", "schedule_activity"]
