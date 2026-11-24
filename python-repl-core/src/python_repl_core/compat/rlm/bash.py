"""`rlm.bash` — Shared compatibility shim for vendored Prime `rlm/repl.py`.

Exports ONLY `_kill_live_handles` and `_rehydrate_persistent_shells` so the
kernel never mounts Prime's own unmanaged bash runner.
"""

from __future__ import annotations

import os
import signal
import threading

__all__ = ["_kill_live_handles", "_rehydrate_persistent_shells"]


def _rehydrate_persistent_shells() -> None:
    """Hosts manage their own jobs; the kernel never restores Prime shells."""
    return None


def _kill_live_handles() -> None:
    """SIGTERM what the kernel started and did not detach, on its way out."""
    if os.environ.get("PYTHON_REPL_OWNS_GROUP") != "1" and os.environ.get("DSH_PYTHON_REPL_OWNS_GROUP") != "1":
        return None
    try:
        if os.getpgrp() != os.getpid():
            return None
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.killpg(os.getpid(), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    return None
