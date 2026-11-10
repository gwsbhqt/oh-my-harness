"""`rlm.factory` — OUR compatibility shim, not upstream code.

Upstream's real `rlm/factory.py` (~220KB) runs Prime's "factory machines" and
answers the out-of-band `factory_activity` request. DSH has no factory and never
sends that request, so it is not vendored. `repl.py` imports this module at the
top and reads exactly three names from it.

`ACTIVITY_ACTIONS` is empty on purpose: `repl.py` checks every incoming
`factory_activity` action against it before scheduling anything, so a request
that does arrive is refused as an unknown action instead of half-handled.
"""

from __future__ import annotations

from typing import Any

__all__ = ["ACTIVITY_ACTIONS", "ACTIVITY_TIMEOUT_MS_CAP", "schedule_activity"]

ACTIVITY_ACTIONS: tuple[str, ...] = ()
ACTIVITY_TIMEOUT_MS_CAP = 0


def schedule_activity(request: dict[str, Any]) -> None:
    raise RuntimeError("factory_activity is not supported in DSH")
