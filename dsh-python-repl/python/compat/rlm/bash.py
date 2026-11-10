"""`rlm.bash` — OUR compatibility shim, not upstream code.

This file lives under `python/compat/`, which holds only our own code;
everything under `vendor/prime/` is upstream and byte-for-byte unmodified.
`rlm` is a PEP 420 namespace package spanning both directories, so the
vendored `repl.py` resolves `from .bash import _kill_live_handles` to this
module without a single edit to upstream. See ../README.md.

Upstream's real `rlm/bash.py` (~48KB) implements Prime's own bash capability
(BashHandle, process groups, Windows job objects, a shutdown journal). We
deliberately do not vendor it: DSH owns bash, and a native runner inside the
kernel would bypass DSH's permission gates (technical design §8.2, §8.3).
`repl.py` needs startup restoration and shutdown cleanup hooks. DSH has no
Prime shells to restore. Cleanup ends the processes the kernel started and did
not detach, when the host can no longer do that itself.

Exports ONLY `_kill_live_handles` and `_rehydrate_persistent_shells`. If a future vendor bump makes `repl.py`
import anything else from here, the kernel fails loudly at startup instead of
degrading silently — that tripwire is intentional.
"""

from __future__ import annotations

import os
import signal
import threading

__all__ = ["_kill_live_handles", "_rehydrate_persistent_shells"]


def _rehydrate_persistent_shells() -> None:
    """DSH owns its jobs; this kernel never creates Prime persistent shells."""
    return None


def _kill_live_handles() -> None:
    """SIGTERM what the kernel started and did not detach, on its way out.

    The host starts the kernel as a process-group leader; every child stays in
    that group unless it calls setsid (Python `start_new_session=True`). Both
    upstream call sites are exits: the shutdown request and the owner watchdog.
    The host reaps the group again after the exit, with a SIGKILL fallback, but
    when the host itself is quitting it may not live long enough to, so the
    kernel does its own part here.

    The kernel is in the group too. On the main thread it ignores the signal
    and finishes its normal exit; signal handlers cannot be set from the
    watchdog thread, and there being terminated is the intended outcome anyway.

    Matches upstream's contract: called for effect, returns None, never raises.
    """
    if os.environ.get("DSH_PYTHON_REPL_OWNS_GROUP") != "1":
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
