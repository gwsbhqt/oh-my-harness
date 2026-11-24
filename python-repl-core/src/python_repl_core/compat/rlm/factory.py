"""`rlm.factory` — Shared compatibility shim for vendored Prime `rlm/repl.py`."""

from __future__ import annotations

from typing import Any

__all__ = ["ACTIVITY_ACTIONS", "ACTIVITY_TIMEOUT_MS_CAP", "schedule_activity"]

ACTIVITY_ACTIONS: tuple[str, ...] = ()
ACTIVITY_TIMEOUT_MS_CAP = 0


def schedule_activity(request: dict[str, Any]) -> None:
    raise RuntimeError("factory_activity is not supported in this host")
