"""What keeps an idle kernel from being stopped to free memory (host: ReplSession.reclaimIfIdle).

Stopping a kernel ends everything inside it, and a snapshot only brings back
values. So a kernel stays while it still has live asyncio tasks, threads other
than its own, processes in its group, or direct children still in its session.
Each blocker is named, so the host can say why.
"""
from __future__ import annotations

import os
import subprocess
import threading


def _children() -> int:
    """Count processes in the kernel's group and its direct children in other groups of the same session."""
    try:
        me = os.getpid()
        group = os.getpgid(0)
        session = os.getsid(0)
        proc = subprocess.Popen(
            ["ps", "-A", "-o", "pid=,ppid=,pgid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            out, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return -1
    except Exception:  # noqa: BLE001 - not knowing is a reason to keep the kernel
        return -1
    if proc.returncode != 0:
        return -1
    count = 0
    saw_kernel = False
    for line in out.splitlines():
        try:
            pid, parent, pgid = map(int, line.split())
        except ValueError:
            return -1
        if pid == me:
            saw_kernel = True
            continue
        if pid == proc.pid:
            continue
        if pgid == group:
            count += 1
        elif parent == me:
            # BSD and GNU ps have different session columns. Ask the OS only for a direct child in another group.
            try:
                if os.getsid(pid) == session:
                    count += 1
            except ProcessLookupError:
                continue  # The child exited after ps took its snapshot.
            except OSError:
                return -1
    return count if saw_kernel else -1


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
