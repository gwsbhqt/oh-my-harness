"""What keeps an idle kernel from being stopped to free memory (host: ReplSession.reclaimIfIdle).

Stopping a kernel ends everything inside it, and a snapshot only brings back
values. So a kernel stays while it still has live asyncio tasks, threads other
than its own, or child processes in its process group (a dev server started
with subprocess.Popen, say). Each blocker is named, so the host can say why.
"""
from __future__ import annotations

import os
import subprocess
import threading


def _children() -> int:
    """Other processes in this kernel's process group (the kernel leads its own group)."""
    try:
        group = os.getpgid(0)
        out = subprocess.run(["ps", "-A", "-o", "pid=,pgid="], capture_output=True, text=True, timeout=5).stdout
    except Exception:  # noqa: BLE001 - not knowing is a reason to keep the kernel
        return -1
    me = os.getpid()
    count = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == str(group) and parts[0] != str(me):
            count += 1
    # The ps process itself has exited by now, but its pid may still be listed: never count it as a user process.
    return max(0, count - 1) if count else 0


#: The kernel's own long-lived coroutines (vendor rlm.repl), never user work.
_KERNEL_COROS = {"_serve", "_mcp_status_lane"}


def _user_tasks() -> list:
    import asyncio

    me = asyncio.current_task()
    out = []
    for task in asyncio.all_tasks():
        if task is me or task.done():
            continue
        name = getattr(task.get_coro(), "__qualname__", "")
        if name.split(".")[0] in _KERNEL_COROS:
            continue
        out.append(task)
    return out


def blockers() -> list[str]:
    reasons = []
    live = _user_tasks()
    if live:
        reasons.append(f"{len(live)} asyncio task(s) still running")
    extra = [t for t in threading.enumerate() if t is not threading.main_thread() and t.is_alive() and not t.daemon]
    if extra:
        reasons.append(f"{len(extra)} thread(s) still running")
    children = _children()
    if children != 0:
        reasons.append("child processes running in the kernel" if children > 0 else "could not check child processes")
    return reasons
