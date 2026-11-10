"""Kernel-side bootstrap: install the DSH capability surface into `__main__`.

Runs ONCE per kernel, as a cell, before any user code. Deliberately NOT
Prime's own bootstrap: we never inject `bash`/`mcp`/`rlm` native entry points
(technical design §8.2) — the same names here are DSH tool proxies.

The bridge module `dsh_kernel` is importable by skill modules, which have their
own globals and cannot see this namespace (§9.3).
"""

from __future__ import annotations

import asyncio
import sys as _sys


def _bootstrap(tool_names, top_level_names, epoch, skill_entries=(), disabled_skills=(), skill_renames=None):
    """Build the namespace. Returns the skill report for the host."""
    import rlm.repl as _repl
    import dsh_kernel as _bridge
    import skills as _skills
    import repl_info as _repl_info
    import prelude as _prelude

    # Adopt the KERNEL's own per-cell contextvar rather than maintaining a
    # second one: it is already set around every execute and inherited by the
    # tasks a cell spawns, which is exactly the attribution we need.
    _bridge._install(_repl.host_request, _repl._current_cell, epoch)
    _bridge._track_created_tasks(asyncio.get_running_loop())
    _contain_system_exit(asyncio.get_running_loop(), _repl._current_cell)

    ns = _sys.modules["__main__"].__dict__

    for name in tool_names:
        _bridge.tools._put(name, _bridge._proxy(name))

    _bridge.skills = _skills._SkillsNamespace(skill_renames)
    ns["tools"] = _bridge.tools
    ns["skills"] = _bridge.skills
    ns["ToolCallError"] = _bridge.ToolCallError
    ns["asyncio"] = asyncio
    ns["repl"] = _Repl(_repl_info, epoch)
    _prelude.install(ns)

    # The six fixed top-level tools. Chosen by DSH hot path, not Pi's count:
    # file discovery is `glob`, content search is `grep`, and neither may be
    # reached by shelling out through `bash`.
    for name in top_level_names:
        if name in _bridge.tools:
            ns[name] = _bridge.tools[name]

    # Skills are pre-imported here, before the first user cell: the model is
    # never asked to perform a load step (no skills.load). A skill that fails
    # is reported and excluded; the rest still load.
    skill_report = _skills.load(list(skill_entries), _bridge.skills, list(disabled_skills))
    # Before any snapshot or restore: modules and skills are saved by name (python/snapshot_refs.py).
    import snapshot_refs as _snapshot_refs

    _snapshot_refs.install()

    # Remember what the bridge installed, so restore_binding() has an original
    # to put back. Captured AFTER skills load so `skills` holds its modules.
    _BRIDGE_NAMES.clear()
    _BRIDGE_NAMES.update(("tools", "skills", "repl", "ToolCallError", *top_level_names))
    _ORIGINAL_BINDINGS.clear()
    for _name in _BRIDGE_NAMES:
        if _name in ns:
            _ORIGINAL_BINDINGS[_name] = ns[_name]

    # Prime's rule for its own bootstrap names: rebuilt on every start, never
    # snapshotted. DSH restores after this bootstrap, so they are also kept
    # out of the restore, which would otherwise put back dead copies.
    _skip(*_ORIGINAL_BINDINGS, *_prelude.NAMES)
    import panel_state

    panel_state.install(_repl, epoch)
    import lifecycle

    lifecycle.install(_repl)

    return skill_report


async def _ensure_snapshot_support():
    """Whether `dill` is importable: the vendored kernel needs it for snapshot and restore.

    The host installs it into the kernel venv, as Prime does; an interpreter
    without it runs, but its variables do not survive a restart.
    """
    try:
        import dill
    except ImportError:
        return {"error": f"dill is not installed in {_sys.prefix}"}
    return {"dill": dill.__version__}


#: Names the bridge owns: its namespaces plus the top-level tools the host named.
_BRIDGE_NAMES: set = set()

#: Bridge-installed values, for explicit restore. Not user data.
_ORIGINAL_BINDINGS: dict = {}


class SystemExitBlocked(Exception):
    """A cell called sys.exit()/exit()/quit() or raised SystemExit."""


def _blocked_exit_message(code) -> str:
    return (
        f"sys.exit({code!r}) (or exit()/quit()/raise SystemExit) would end this persistent kernel and "
        "lose every variable, so it was turned into this error instead; the kernel and its variables are intact. "
        "Do not call sys.exit in the kernel: to stop a cell early, raise an exception or just let the cell end. "
        "If a string meant as file content ran as code, check for a nested triple quote."
    )


async def _exit_guard(coro):
    try:
        return await coro
    except SystemExit as exc:
        raise SystemExitBlocked(_blocked_exit_message(exc.code)) from None


def _contain_system_exit(loop, cell_var) -> None:
    """Turn SystemExit inside a cell's tasks into an ordinary error.

    asyncio re-raises SystemExit from a task straight to the event loop, past
    the vendored kernel's `except BaseException` around the cell: the process
    exits and every variable is lost in real sessions. Wrapping the
    coroutine of every task a cell creates — the cell itself included — stops
    it inside the task, where it is an ordinary exception. `os._exit` and
    signals are left alone on purpose.
    """
    import contextvars

    previous = loop.get_task_factory()

    def factory(loop, coro, **kwargs):
        context = kwargs.get("context") or contextvars.copy_context()
        if context.get(cell_var) is not None and asyncio.iscoroutine(coro):
            guarded = _exit_guard(coro)
            # Task labels in cleanup reports name the coroutine; keep the user's name.
            for attr in ("__name__", "__qualname__"):
                try:
                    setattr(guarded, attr, getattr(coro, attr))
                except (AttributeError, TypeError):
                    pass
            coro = guarded
        if previous is not None:
            return previous(loop, coro, **kwargs)
        return asyncio.Task(coro, loop=loop, **kwargs)

    loop.set_task_factory(factory)


def _sync_tools(tool_names, top_level_names):
    """Make the Python surface match THIS cell's bindings.

    Tool visibility is per call: PTC may grant a different set each time, and a
    kernel outlives many cells.
    """
    import dsh_kernel as _bridge

    ns = _sys.modules["__main__"].__dict__
    wanted = set(tool_names)
    present = set(_bridge.tools._members)

    for name in wanted - present:
        _bridge.tools._put(name, _bridge._proxy(name))
    for name in present - wanted:
        _bridge.tools._members.pop(name, None)

    # Top-level names track the same grant. A name the user overwrote with
    # their own value is left alone: clobbering it back would silently destroy
    # their variable. repl.describe() reports the shadowing instead.
    for name in top_level_names:
        if name in wanted:
            current = ns.get(name)
            if current is None or isinstance(current, _bridge._ToolProxy):
                ns[name] = _bridge.tools[name]
                _ORIGINAL_BINDINGS[name] = ns[name]
                _skip(name)
        elif isinstance(ns.get(name), _bridge._ToolProxy):
            ns.pop(name, None)
            _ORIGINAL_BINDINGS.pop(name, None)
            _unskip(name)


def _skip(*names):
    """Keep bridge-installed names out of snapshots and restores, as Prime does
    for its own bootstrap names: a user value under a name the bridge never
    installed is still the user's and comes back."""
    import rlm.repl as _repl

    _repl._ALWAYS_SKIP.update(names)
    _repl._RESTORE_SKIP.update(names)


def _unskip(name):
    import rlm.repl as _repl

    _repl._ALWAYS_SKIP.discard(name)
    _repl._RESTORE_SKIP.discard(name)


class _Repl:
    """The `repl` entry point: read-only kernel awareness.

    A system binding, not a business capability — it never competes for the
    shortcut list, and its meta methods are async like every other container's.
    """

    __slots__ = ("_info", "_epoch")

    def __init__(self, info_module, epoch):
        self._info = info_module
        self._epoch = epoch

    def __repr__(self):
        return "<repl: kernel awareness and control (info/list/describe/helpers/restore_binding/install/background/restart/keep/unkeep/unarchive)>"

    async def info(self):
        return self._info.info(self._epoch)

    async def list(self, query=None, *, kind=None, origin=None, limit=20, cursor=None):
        return self._info.list_names(query, kind, origin, limit, cursor)

    async def describe(self, name):
        return self._info.describe(name)

    async def helpers(self):
        """Your own functions and classes: signature and first docstring line."""
        return self._info.helpers()

    async def size(self, value):
        """How big `value` would be if displayed — without displaying it.

        Cheap even for enormous objects: it renders at most the budget, never
        the whole thing.
        """
        return self._info.display_size(value)

    async def preview(self, value, *, chars=4000, items=20, depth=8):
        """Bounded, read-only builtin preview; not proof of source completeness."""
        import dsh_kernel as _bridge
        import preview as _preview

        return _bridge._PreviewResult(_preview.preview(value, chars=chars, items=items, depth=depth))

    async def require_complete(self, result, stream="stdout", *, check_exit=True):
        """Return a complete foreground bash stream or explain why it is unsafe."""
        import dsh_kernel as _bridge

        return _bridge.require_complete(result, stream=stream, check_exit=check_exit)

    async def read_window(self, result, *, offset=None, limit=None):
        """Validate a read window and next offset, not lossless file/byte completeness."""
        import dsh_kernel as _bridge

        return _bridge.validate_read_window(result, offset=offset, limit=limit)

    async def restore_binding(self, name):
        return self._info.restore_binding(name, _ORIGINAL_BINDINGS)

    async def install(self, *specs, upgrade=False, timeout=900):
        """Install packages into the kernel venv; importable without a restart."""
        import packages as _packages

        return await _packages.install(list(specs), upgrade=upgrade, timeout=timeout)

    async def keep(self, *names):
        """Pin names so they are never archived or deleted for disuse; an archived name comes back first."""
        return _lifecycle_ops("keep", names)

    async def unkeep(self, *names):
        """Unpin names; their unused-cell count starts again from this cell."""
        return _lifecycle_ops("unkeep", names)

    async def unarchive(self, *names):
        """Bring archived names back now (a cell that names one directly does this by itself)."""
        return _lifecycle_ops("unarchive", names)

    async def background(self, work, label=None):
        """Run long work after this cell ends, as a DSH background job; DSH wakes you when it finishes."""
        import background as _background

        return await _background.start(work, label)

    async def agent(self, prompt, *, schema=None, model=None, provider=None, label=None):
        """Start a subagent and wait for it: its final text, its structured value with `schema`, or None if it failed."""
        import agents as _agents

        return await _agents.run(prompt, schema=schema, model=model, provider=provider, label=label)

    def progress(self, text):
        """Inside repl.background work: add one line to the job's output (no await needed; works in a thread too)."""
        import background as _background

        return _background.progress(text)

    async def restart(self, reason=None):
        """Replace the kernel once this cell ends; saved variables and installed packages come back."""
        import packages as _packages

        return _packages.request_restart(reason)


def _lifecycle_ops(action, names):
    import lifecycle as _lifecycle

    if not names:
        raise TypeError(f"repl.{action}() needs at least one name")
    for name in names:
        if type(name) is not str:
            raise TypeError(f"repl.{action}() takes names as strings, got {type(name).__name__}")
    results = {name: _lifecycle.op(action, name) for name in names}
    failed = {name: r["reason"] for name, r in results.items() if not r["ok"]}
    return {"ok": not failed, "done": [n for n in names if n not in failed], "failed": failed}


async def _end_cell(code=None, truncated=False):
    """Report what the host tells the model at the end of a cell.

    Called by the host after a cell settles (ok, error, or cancelled). Like
    Prime, the cell's asyncio tasks keep running; the host has already revoked
    the cell's tool grant, so a task outliving it can compute but not call DSH
    tools. `code` is a successful cell's source, analysed for advice.
    """
    import dsh_kernel as _bridge
    import repl_info as _repl_info

    outcome = {"failed": _bridge._unretrieved_failures()}
    outcome["shadowed"] = _repl_info.shadowed_bindings()
    import packages as _packages

    restart = _packages.take_restart()
    if restart is not None:
        outcome["restart"] = restart
    outcome["advice"] = []
    try:
        import output_notes as _output_notes

        note = _output_notes.after_cell(_sys.modules["__main__"].__dict__, bool(truncated))
        if note is not None:
            outcome["advice"].append(note)
    except Exception:  # noqa: BLE001 - advice must never break teardown
        pass
    try:
        import lifecycle as _lifecycle

        outcome["advice"] += _lifecycle.sweep()
    except Exception:  # noqa: BLE001 - lifecycle bookkeeping must never break teardown
        pass
    if code is not None:
        # Only successful cells are passed in: a retry after a failure is not
        # repetition. Advice must never break teardown, so any analysis error
        # just means no advice.
        try:
            import habits as _habits

            outcome["advice"] += _habits.TRACKER.observe(code)
        except Exception:  # noqa: BLE001
            pass
        try:
            import detours as _detours

            outcome["advice"] += _detours.observe(code)
        except Exception:  # noqa: BLE001
            pass
        try:
            import figures as _figures

            outcome["advice"] += _figures.observe(code)
        except Exception:  # noqa: BLE001
            pass
    return outcome

