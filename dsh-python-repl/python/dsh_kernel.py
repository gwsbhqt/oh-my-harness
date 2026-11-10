"""Bridge module importable from BOTH the REPL namespace and skill modules.

A skill module has its OWN globals: the REPL's top-level `bash` is invisible to
it (technical design §9.3). A skill that needs DSH capability does:

    from dsh_kernel import tools
    await tools.bash({"command": "ls"})

    # or, for a name that is not a valid attribute:
    from dsh_kernel import call_tool
    await call_tool("some-tool", {"arg": 1})

That is the supported path. There is no magic propagation of REPL globals, and
the six top-level names (`read`/`write`/`edit`/`bash`/`glob`/`grep`) are REPL
conveniences — they are NOT importable from here. Everything goes through
`tools` or `call_tool`, which resolve against the calling cell's authority.

Everything here routes through one host request per call, tagged with the
CURRENT cell's run id read from a contextvar. A proxy captured in cell 1 and
called in cell 2 therefore resolves against cell 2 — while a background task
started by cell 1 keeps cell 1's id and is refused once cell 1 settles. That
asymmetry is the whole authority model (technical design §6.3).
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import sys
import time
import weakref
from typing import Any

#: The kernel's OWN per-cell contextvar (``rlm.repl._current_cell``), bound at
#: install time. It is the single source of truth for "which cell is running":
#: the kernel sets it around every execute, and asyncio tasks inherit it at
#: creation — including tasks a cell leaves behind. Keeping a parallel variable
#: in sync would be a second, divergent answer to the same question.
_cell_var: contextvars.ContextVar | None = None

#: Kernel generation. A restart bumps it so a reply tagged with an older
#: generation can never be honoured.
_epoch_value: int = 0

#: Populated by the bootstrap with the host_request sender from rlm.repl.
_host_request = None

#: Set inside `repl.background` work (python/background.py) and inherited by
#: tasks it starts. Once the starting cell has ended, the host answers calls
#: tagged with it through that job's own grant instead of the cell's.
_job_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("dsh_background_job", default=None)


def _current_run_id() -> str | None:
    """The cell that owns the calling context, or None outside any cell."""
    if _cell_var is None:
        return None
    return _cell_var.get()


class ToolCallError(Exception):
    """A DSH tool call failed.

    Mirrors the host's declared error contract and nothing more: `toolName`
    plus a human-readable message. Deliberately NOT carrying `retryable`,
    `idempotent` or the original payload — the host does not supply those and
    inventing them would let callers auto-retry side effects. See
    Keeps tool results usable as dictionaries while exposing their documented fields.

    Subclasses `Exception` (not `BaseException`), so `except ToolCallError`
    does NOT swallow `asyncio.CancelledError`. That is load-bearing: a
    cancelled cell must not look like a per-item failure that a loop can skip
    past (technical design §10.2.2).
    """

    def __init__(self, tool_name: str, message: str) -> None:
        super().__init__(message)
        self.toolName = tool_name


class _ToolResult(dict):
    """A tool's canonical JSON value, displayed as a readable view.

    Still a plain `dict` for every program purpose — indexing, `json.dumps`,
    passing it back into another tool — only `repr()`/`str()` differ. The
    kernel displays a trailing expression with `repr()`, and a raw dict repr
    puts a whole shell transcript on one line with escaped newlines. So the
    model wrote `print(r["stdout"]["text"], r["exitCode"])` by hand in 174 of
    314 cells of a real session (2026-09-23) — and never once looked at
    `truncated` or `spillPath`. The view shows the fields a conclusion depends
    on (exit status, stderr, truncation) every time, so skipping them is no
    longer the path of least resistance.

    The header names the tool and says it is a view, so it is never mistaken
    for the raw JSON. A shape the renderer does not recognise falls back to
    the plain dict repr: a view must never hide data it cannot render.
    """

    __slots__ = ()

    def __repr__(self) -> str:
        try:
            return self._render()
        except Exception:  # noqa: BLE001 - an unexpected shape displays raw, never fails the cell
            return dict.__repr__(self)

    __str__ = __repr__

    def __missing__(self, key: Any) -> Any:
        # 2026-11-03 real sessions: `r["text"]` on a read result and `r[:500]` on a dict were common KeyErrors.
        keys = ", ".join(repr(k) for k in self)
        if isinstance(key, slice):
            raise KeyError(f"this tool result is a dict, not text or a list, so it cannot be sliced; its keys are {keys}")
        raise KeyError(f"{key!r} is not a key of this tool result; its keys are {keys}")

    def __getattr__(self, name: str) -> Any:
        # 2026-11-03 evolve I-044: after the KeyError hint, cells still wrote `r.totalLines`, `files.paths`,
        # `g.matches` and failed. Reading an existing key by attribute is unambiguous, so it just works.
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(exc.args[0] if exc.args else name) from None

    def _render(self) -> str:  # pragma: no cover - overridden
        return dict.__repr__(self)


class _NestedResult(_ToolResult):
    """A nested dict in a tool result: dict semantics plus attribute access."""

    __slots__ = ()


class _NestedList(list):
    """A nested list in a tool result; its dict elements are recursively wrapped."""

    __slots__ = ()


def _wrap_nested(value: Any) -> Any:
    """Recursively wrap nested dict/list values without changing their JSON shape."""
    if type(value) is dict:
        wrapped = _NestedResult()
        for key, item in value.items():
            dict.__setitem__(wrapped, key, _wrap_nested(item))
        return wrapped
    if type(value) is list:
        return _NestedList(_wrap_nested(item) for item in value)
    return value


def require_complete(result: Any, stream: str = "stdout", *, check_exit: bool = True) -> str:
    """Return an untruncated bash stream; never mistake a tail for full output.

    A spillPath is a location hint, not a durable host read API. This function
    deliberately does not access it or re-run a possibly side-effecting command.
    """
    if stream not in ("stdout", "stderr"):
        raise ValueError("stream must be stdout or stderr")
    if isinstance(result, dict) and "lines" in result and "totalLines" in result:
        raise ValueError(
            "read does not report reliable byte completeness; require_complete cannot certify it. "
            "Use await repl.read_window(result) for window validation only, not lossless reading."
        )
    if not isinstance(result, dict) or result.get("kind") != "foreground":
        raise ValueError("require_complete needs a foreground bash result; collect background/promoted jobs without re-running them")
    output = result.get(stream)
    if not isinstance(output, dict) or not isinstance(output.get("text"), str):
        raise ValueError(f"bash result has no valid {stream} text")
    if result.get("stopped") or result.get("signal") is not None:
        raise ValueError("bash did not finish normally; do not treat its output as a complete result")
    for flag in ("timedOut", "aborted"):
        if result.get(flag) is not False:
            raise ValueError(f"bash did not finish normally or {flag} is unknown; completeness cannot be certified")
    if type(result.get("exitCode")) is not int:
        raise ValueError("bash exitCode is missing or invalid; completeness is unknown even with check_exit=False")
    if check_exit and result.get("exitCode") != 0:
        raise ValueError(
            f"bash exitCode={result.get('exitCode')}; inspect stderr. "
            "Use check_exit=False only when you intend to analyze failed output; "
            "it does not turn failure into success and still rejects truncation/interruption."
        )
    if output.get("truncated"):
        location = output.get("spillPath") or "not reported"
        raise ValueError(
            f"bash {stream} was truncated; only its tail is in text (full output path: {location}). "
            "The host has not promised a durable complete-output API here; do not parse or count this tail. "
            "Do not re-run a command with side effects automatically."
        )
    if output.get("truncated") is not False:
        raise ValueError(f"bash {stream} has no reliable truncation flag; completeness is unknown")
    return output["text"]


_READ_TRUNCATION = re.compile(r"\.\.\. \(line truncated to \d+ chars\)$")


def validate_read_window(result: Any, *, offset: int | None = None, limit: int | None = None) -> dict:
    """Validate read line numbering and known truncation; byte completeness stays unknown."""
    if not isinstance(result, dict) or not isinstance(result.get("path"), str):
        raise ValueError("read_window needs a read result with a path")
    start, total, lines = result.get("offset"), result.get("totalLines"), result.get("lines")
    if type(start) is not int or start < 1 or type(total) is not int or total < 0 or not isinstance(lines, list):
        raise ValueError("read_window needs positive offset, non-negative totalLines, and a lines list")
    if offset is not None and (type(offset) is not int or offset < 1 or offset != start):
        raise ValueError("read_window offset does not match the requested window")
    if limit is not None and (type(limit) is not int or limit < 1 or len(lines) > limit):
        raise ValueError("read_window exceeds the requested limit or limit is invalid")
    if result.get("truncated"):
        raise ValueError("read_window contains reported truncation; do not parse or count it as complete")
    if not lines and start <= total:
        raise ValueError("read_window is empty before EOF; no safe next offset")
    for i, line in enumerate(lines):
        if (not isinstance(line, dict) or type(line.get("number")) is not int
                or line["number"] != start + i or line["number"] > total
                or not isinstance(line.get("text"), str)):
            raise ValueError("read_window has missing, non-contiguous, or out-of-range lines")
        if line.get("truncated") or _READ_TRUNCATION.search(line["text"]):
            raise ValueError(f"read_window line {line['number']} has a truncation marker; its text is incomplete")
    next_offset = start + len(lines) if lines and start + len(lines) <= total else None
    return {
        "path": result["path"], "offset": start, "lines": lines, "totalLines": total,
        "next_offset": next_offset, "has_more": next_offset is not None,
        "byte_completeness": "unknown",
    }


def _stream(label: str, stream: Any) -> list[str]:
    """One bash stream: its text plus an explicit truncation marker."""
    if not isinstance(stream, dict):
        return []
    text = stream.get("text") or ""
    lines = [f"[{label}]", text.rstrip("\n")] if text else []
    if stream.get("truncated"):
        spill = stream.get("spillPath")
        where = f"; full output: {spill}" if spill else "; no full-output file was reported"
        lines.append(f"[{label} truncated to its tail{where}]")
    return lines


async def _ready(value: Any) -> Any:
    return value


class _BashResult(_ToolResult):
    __slots__ = ()

    # A bash call still running past the cell's wait is a job; the result itself is its handle.
    def _handle(self) -> "BashJob":
        job_id = self.get("jobId")
        if self.get("kind") not in ("background", "promoted") or not job_id:
            raise TypeError("this bash call already finished; its result is this value")
        handle = _HANDLES.get(job_id)
        if handle is None:
            if job_id in _RELEASED:
                raise RuntimeError(
                    f"bash job {job_id} finished long ago and its kept output was released to save memory "
                    f"(the kernel keeps the last {_KEEP_FINISHED} finished jobs). Run the command again if you still need it; "
                    "next time keep `await job`'s result in a variable."
                )
            handle = BashJob(job_id, "")
            if self.get("kind") == "promoted" and self.get("output"):
                handle._text.append(self["output"])
            _HANDLES[job_id] = handle
        return handle

    def __await__(self):
        if self.get("kind") not in ("background", "promoted"):
            return _ready(self).__await__()
        return self._handle().wait().__await__()

    async def wait(self, timeout_ms: float | None = None) -> Any:
        """The finished job's result (stdout, stderr, exitCode); raises JobStillRunning past the cell's wait."""
        return await self._handle().wait(timeout_ms)

    async def peek(self) -> str:
        """Everything the job wrote so far, without waiting."""
        return await self._handle().peek()

    async def kill(self, reason: str | None = None) -> Any:
        """Ask DSH to stop the job."""
        return await self._handle().kill(reason)

    def __missing__(self, key: Any) -> Any:  # noqa: D105 - see below
        # Observed: `r["stdout"]["text"]` on a command the host moved to the
        # background raised a bare KeyError, and the receipt view never showed.
        if self.get("kind") in ("background", "promoted"):
            job = self.get("jobId")
            raise KeyError(
                f"{key!r}: this bash call became a {self['kind']} job {job!r} and has no {key!r} yet. "
                f"DSH wakes you when it finishes, so end this turn instead of waiting in a cell; then `await` this value for its result (or tools.job_output({{'job_id': {job!r}}})). Do not re-run the command"
            )
        return _ToolResult.__missing__(self, key)

    def _render(self) -> str:
        if self.get("kind") in ("background", "promoted"):
            job = self["jobId"]
            kind = self["kind"]
            timeout = f" after {self.get('timeoutMs')}ms" if kind == "promoted" else ""
            out = [f"── bash · {kind} job {job}{timeout} (view of a dict) ──"]
            if kind == "promoted":
                out.extend(["[output received before promotion]", self.get("output") or "(no output)"])
            out.append("(still running, not a final result — do not re-run the command)")
            out.append("DSH wakes you when it finishes, so end this turn instead of waiting in a cell; then `await` this value for its result.")
            return "\n".join(out)
        status = [f"exitCode={self['exitCode']}"]
        if self.get("signal"):
            status.append(f"signal={self['signal']}")
        if self.get("timedOut"):
            status.append(f"TIMED OUT after {self.get('timeoutMs')}ms")
        if self.get("aborted"):
            status.append("ABORTED")
        sandbox = self.get("sandbox")
        if isinstance(sandbox, dict) and sandbox.get("denied"):
            status.append("SANDBOX DENIED")
        body = _stream("stdout", self["stdout"]) + _stream("stderr", self["stderr"])
        if not body:
            body = ["(no output on stdout or stderr)"]
        return "\n".join([f"── bash · {' · '.join(status)} (view of a dict) ──", *body])


class _PreviewResult(_ToolResult):
    """`repl.preview` output: shows the preview text itself, not an escaped dict."""

    __slots__ = ()

    def _render(self) -> str:
        state = f"truncated: {', '.join(self['reasons'])}" if self["truncated"] else "whole value within budget"
        return f"── preview of {self['type']} · {state} (view of a dict; in-memory value only) ──\n{self['text']}"


class _ReadResult(_ToolResult):
    __slots__ = ()

    @property
    def text(self) -> str:
        """This window's lines joined with newlines, without line numbers; not the whole file when more lines remain."""
        return "\n".join(line["text"] for line in self["lines"])

    def __missing__(self, key: Any) -> Any:
        # 2026-11-06 evolve I-073: the KeyError hint still cost one failed cell per session (4 that day); r["text"] is unambiguous.
        if key == "text":
            return self.text
        return super().__missing__(key)

    def _render(self) -> str:
        lines = self["lines"]
        total = self["totalLines"]
        if lines:
            span = f"lines {lines[0]['number']}-{lines[-1]['number']} of {total}"
        else:
            span = f"no lines at offset {self.get('offset')} of {total}"
        out = [f"── read {self['path']} · {span} (view of a dict) ──"]
        cut = [line["number"] for line in lines if line.get("truncated") or _READ_TRUNCATION.search(line["text"])]
        if cut:
            out.append(f"!! known truncation in line(s) {cut[:10]}; do not parse these strings as complete text")
        out += [f"{line['number']}: {line['text']}" for line in lines]
        if lines and lines[-1]["number"] < total:
            out.append(f"── more below: offset={lines[-1]['number'] + 1} (last returned line + 1, not offset + limit) ──")
        out.append("(read byte completeness is unknown; await repl.read_window(r) validates only the line window and known truncation markers)")
        return "\n".join(out)


#: Display caps for search views, matching the host's direct-call caps
#: (`grepMaxMatches` 250, `globMaxResults` 100). A cell gets the COMPLETE
#: result — the host caps only top-level calls — so an uncapped view put 6519
#: matches of `grep e` into the context (field regression 2026-09-23).
_GREP_SHOW = 250
_GLOB_SHOW = 100
_LINE_SHOW = 300


def _clip_line(line: str) -> str:
    return line if len(line) <= _LINE_SHOW else f"{line[:_LINE_SHOW]}… ({len(line)} chars)"


def _not_shown(hidden: int, total: int, key: str, shown: int) -> str:
    return (
        f"… {hidden} more not shown. The value holds all {total}: "
        f"slice `r['{key}'][{shown}:]` or filter in Python instead of printing them."
    )


class _GrepResult(_ToolResult):
    __slots__ = ("_search_scope",)

    def _render(self) -> str:
        matches = self["matches"]
        files = len({m["path"] for m in matches})
        scope = getattr(self, "_search_scope", None)
        label = f" · scope={scope}" if scope in ("normal", "all") else ""
        unreadable = self.get("unreadable")
        incomplete = self.get("unreadableIncomplete") or isinstance(unreadable, list) and bool(unreadable)
        warning = " · INCOMPLETE: some paths could not be read" if incomplete else ""
        out = [f"── grep{label} · {len(matches)} matches in {files} files{warning} (view of a dict) ──"]
        if isinstance(unreadable, list):
            for item in unreadable[:10]:
                if isinstance(item, dict):
                    out.append(f"  unreadable {_clip_line(item.get('path', '(not reported)'))}: {_clip_line(item.get('error', '(not reported)'))}")
            if len(unreadable) > 10:
                out.append(f"  … {len(unreadable) - 10} more unreadable paths remain in r['unreadable']")
        if self.get("unreadableIncomplete"):
            out.append("  (the unreadable list itself was cut short)")
        out += [f"{m['path']}:{m['lineNumber']}: {_clip_line(m['line'])}" for m in matches[:_GREP_SHOW]]
        if len(matches) > _GREP_SHOW:
            out.append(_not_shown(len(matches) - _GREP_SHOW, len(matches), "matches", _GREP_SHOW))
        if not matches:
            out.append("(no matches in the selected search scope; check the grep contract before concluding absence)")
        return "\n".join(out)


class _GlobResult(_ToolResult):
    __slots__ = ("_pattern",)

    def _render(self) -> str:
        paths = self["paths"]
        out = [f"── glob · {len(paths)} paths under {self['root']} (view of a dict) ──", *paths[:_GLOB_SHOW]]
        if len(paths) > _GLOB_SHOW:
            out.append(_not_shown(len(paths) - _GLOB_SHOW, len(paths), "paths", _GLOB_SHOW))
        # Observed: `*/package.json` with a path, then an absolute pattern, both
        # came back empty with nothing saying why; the fourth try was right.
        pattern, with_path = getattr(self, "_pattern", (None, False))
        if not paths and isinstance(pattern, str) and "/" in pattern and not pattern.startswith("**/"):
            if pattern.startswith("/"):
                out.append("(an absolute pattern is matched from the workspace root and finds nothing; "
                           "pass the directory as `path` and a `**/…` pattern)")
            elif with_path:
                out.append(f"(a pattern containing `/` is matched from the workspace root, not from `path`; "
                           f"to search below `path` write `**/{pattern}`)")
        return "\n".join(out)


class _JobOutputResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        job = self["job"]
        status = [f"status={job['status']}"]
        if job.get("detail"):
            status.append(str(job["detail"]))
        text = self.get("text") or ""
        head = f"── job {job['id']} · {' · '.join(status)} (view of a dict) ──"
        lines = [head, text.rstrip("\n") if text else "(no new output since the previous read)"]
        if job["status"] == "running":
            lines.append("(still running; output shown here is consumed. " + "DSH wakes you when it finishes, so end this turn instead of waiting in a cell" + ")")
        return "\n".join(lines)


class _MutationResult(_ToolResult):
    __slots__ = ("_tool",)

    def __repr__(self) -> str:
        try:
            return self._render()
        except Exception:
            return "── mutation result · unrecognized shape (bounded view of a dict); inspect fields in Python, full value remains in the kernel ──"

    __str__ = __repr__

    def _render(self) -> str:
        tool = getattr(self, "_tool", "edit")
        if "results" in self and "applied" in self:
            results = self["results"]
            out = [f"── {tool} · applied={self['applied']} (bounded view of a dict) ──"]
            for i, result in enumerate(results[:5]):
                out.append(f"{i + 1}: path={_clip_line(result.get('path', '(not reported)'))}")
            if len(results) > 5:
                out.append(f"… {len(results) - 5} more results not shown")
            out.append("(full per-edit results remain in r['results']; before/after contents are not displayed)")
            return "\n".join(out)
        out = [f"── {tool} · path={_clip_line(self['path'])} (bounded view of a dict) ──"]
        if "operation" in self:
            out.append(f"operation={_clip_line(self['operation'])}")
        for key in ("before", "after"):
            value = self.get(key)
            summary = f"{len(value)} chars; content not displayed" if isinstance(value, str) else "None" if value is None else "unrecognized value; not displayed"
            out.append(f"{key}: {summary}")
        out.append("(full canonical dict remains in the kernel; index before/after only when needed)")
        return "\n".join(out)


#: Tool name → display view. Only tools whose canonical shape the renderer
#: knows; everything else keeps the value exactly as the host sent it.
_VIEWS: dict[str, type[_ToolResult]] = {
    "bash": _BashResult,
    "write": _MutationResult,
    "edit": _MutationResult,
    "read": _ReadResult,
    "grep": _GrepResult,
    "glob": _GlobResult,
    "job_output": _JobOutputResult,
}


def _with_view(tool: str, result: Any, args: Any = None) -> Any:
    view = _VIEWS.get(tool)
    if view is None or type(result) is not dict:
        return result
    shown = view(result)
    if isinstance(shown, _MutationResult):
        shown._tool = tool
    if tool == "glob" and isinstance(args, dict):
        shown._pattern = (args.get("pattern"), bool(args.get("path")))
    if tool == "grep" and isinstance(args, dict):
        scope = args.get("scope", "normal")
        if scope in ("normal", "all"):
            shown._search_scope = scope
    for key, value in list(shown.items()):
        dict.__setitem__(shown, key, _wrap_nested(value))
    return shown


def _install(host_request: Any, cell_var: Any, epoch: int) -> None:
    """Wire the host transport and adopt the kernel's own cell contextvar."""
    global _host_request, _cell_var, _epoch_value
    _host_request = host_request
    _cell_var = cell_var
    _epoch_value = epoch
    repl_module = sys.modules.get("rlm.repl")
    if repl_module is not None:
        _hint_name_errors(repl_module)


#: Appended to a NameError for `display`: GPT called IPython's display() in 10
#: cells (session analysis 2026-10-08). `display` is deliberately NOT defined —
#: a stand-in would hide the mistake instead of teaching the REPL's way.
_DISPLAY_HINT = (
    "This is not IPython: use print() or put the value last in the cell (a trailing expression is displayed).\n"
)


def _business_error(exc: BaseException) -> bool:
    """A tool or a skill reporting failure, not a bug: frames outside the cell never help."""
    if isinstance(exc, ToolCallError):
        return True
    module = type(exc).__module__.split(".")[0]
    members = getattr(globals().get("skills"), "_members", None)
    if not isinstance(members, dict):
        return False
    roots = {getattr(value, "__name__", "").split(".")[0] for value in members.values()}
    return module in roots and module not in ("builtins", "")


def _name_error_hint(name: Any) -> str | None:
    """Why a missing name is missing, when the bridge knows: IPython's display, or a
    tool or skill reached without its namespace (`read_image(...)` for
    `tools.read_image(...)`: 7 cells on real sessions, 2026-11-03)."""
    if type(name) is not str:
        return None
    if name == "display":
        return _DISPLAY_HINT
    members = getattr(globals().get("tools"), "_members", None)
    if isinstance(members, dict) and name in members:
        return f"`{name}` is a DSH tool: call it as `await tools.{name}(...)`. Only read/write/edit/bash/glob/grep are top-level.\n"
    members = getattr(globals().get("skills"), "_members", None)
    if isinstance(members, dict) and name in members:
        return f"`{name}` is a Python skill: use it as `skills.{name}`.\n"
    return None


def _hint_name_errors(repl_module: Any) -> None:
    """Wrap the kernel's error-event builder so a `display` NameError carries the hint.

    The upstream kernel (vendor/, read-only) formats every cell error in
    `_error_event`, looked up as a module global at call time, so replacing
    the attribute is enough. Idempotent.
    """
    original = getattr(repl_module, "_error_event", None)
    if original is None or getattr(original, "_dsh_hinted", False):
        return

    def _error_event(cell_id: str, exc: BaseException) -> dict:
        event = original(cell_id, exc)
        try:
            import cell_errors

            lines = cell_errors.compact(exc, repl_module._cell_stack, _business_error)
            if lines is not None:
                event["traceback"] = repl_module._cap_traceback_lines([repl_module._cap_text(line) for line in lines])
        except Exception:  # noqa: BLE001 - Prime's own traceback stays when shortening fails
            pass
        try:
            import cell_errors

            hint = _name_error_hint(getattr(exc, "name", None)) if isinstance(exc, NameError) else None
            if isinstance(exc, ToolCallError):
                hint = cell_errors.tool_hint(str(exc), getattr(exc, "_dsh_args", None))
                hint = None if hint is None else hint + "\n"
            if hint is not None:
                event["traceback"] = [*event.get("traceback", []), hint]
            skipped = cell_errors.skipped_note(exc)
            if skipped is not None:
                event["traceback"] = [*event.get("traceback", []), skipped]
        except Exception:  # noqa: BLE001 - a hint must never break error reporting
            pass
        return event

    _error_event._dsh_hinted = True  # type: ignore[attr-defined]
    repl_module._error_event = _error_event


def _with_stdin(tool: str, args: Any) -> Any:
    """Turn `bash({"command": ..., "stdin": text})` into a quoted heredoc.

    The host `bash` tool has no stdin parameter, and a plugin cannot add one:
    `tools/pre-execute` sees frozen arguments. Cells kept building heredocs by
    hand (or base64 one-liners) to feed scripts to `ssh`/`python3 -`, and got
    the quoting wrong. The kernel does it once, correctly: the command runs in
    a `{ ...; }` group whose stdin is a quoted heredoc (no expansion), under a
    delimiter guaranteed absent from the text. One trailing newline of `stdin`
    is the heredoc's own line end, so text without one gains exactly one.
    """
    if tool != "bash" or not isinstance(args, dict) or "stdin" not in args:
        return args
    args = dict(args)
    stdin = args.pop("stdin")
    if stdin is None:
        return args
    if not isinstance(stdin, str):
        raise ToolCallError(tool, f"stdin must be a str, got {type(stdin).__name__}")
    command = args.get("command")
    if not isinstance(command, str):
        return args  # let the host report the missing/invalid command
    body = stdin[:-1] if stdin.endswith("\n") else stdin
    delim = "DSH_STDIN"
    n = 0
    while delim in body or delim in command:
        n += 1
        delim = f"DSH_STDIN_{n}"
    args["command"] = f"{{ {command}\n}} <<'{delim}'\n{body}\n{delim}"
    return args


_REHEARSAL_MAX_BYTES = 32 * 1024 * 1024


def _rehearsal_text(file_path: str) -> str | None:
    """The file's current text with CRLF folded to LF, or None when unsure."""
    import os

    if not os.path.isabs(file_path):
        file_path = os.path.join(os.environ.get("DSH_PYTHON_REPL_WORKSPACE") or os.getcwd(), file_path)
    try:
        if not os.path.isfile(file_path) or os.path.getsize(file_path) > _REHEARSAL_MAX_BYTES:
            return None
        with open(file_path, "rb") as fh:
            return fh.read().decode("utf-8").replace("\r\n", "\n")
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def _rehearse(text: str, edits: list[dict]) -> str | None:
    """Apply `edits` in memory by the host's literal-edit rules; the first failure as a message, else None."""
    total = len(edits)
    for i, change in enumerate(edits):
        old = change["old_string"].replace("\r\n", "\n")
        new = change["new_string"].replace("\r\n", "\n")
        after = f" after changes 1-{i} are applied" if i else ""
        if not old:
            return f"change {i + 1} of {total}: old_string is empty once CRLF is folded to LF"
        count = text.count(old)
        if count == 0:
            return f"change {i + 1} of {total}: old_string was not found in the file{after}"
        if count > 1 and not change.get("replace_all"):
            return (
                f"change {i + 1} of {total}: old_string matches {count} places in the file{after}; "
                "add surrounding text to make it unique, or set replace_all"
            )
        text = text.replace(old, new)
    return None


async def _edit_many(args: dict) -> Any:
    """`edit({"file_path": p, "edits": [{"old_string", "new_string", "replace_all"?}, ...]})`.

    The host `edit` changes one place per call, so cells patched several places
    by hand — `assert old in t; t = t.replace(old, new); write back` — around
    900 times in the sessions mined on 2026-09-23, bypassing the host's
    read-before-edit policy. Here every change is still one host `edit`, in
    order, each under that policy.

    Before dispatching anything, the whole batch is rehearsed in memory against
    the file's current text with the host's matching rules, each change seeing
    the result of the ones before it. If any change would fail, the batch is
    rejected and nothing is written. A new_string holding U+0000 is rejected
    too: the host treats a file containing it as binary and refuses every later
    edit, so the batch would stop half-applied (evolve I-004, where a normal
    Python string turned "\\x00" into a real NUL). When the file cannot be
    read here (missing, not UTF-8, too large), the rehearsal is skipped and
    changes go straight to the host. A change can still fail during dispatch
    (the file changed in between, or the host's read policy refuses); then the
    error says exactly which changes are already in the file (edits are not
    rolled back).
    """
    edits = args.get("edits")
    def reject(reason: str) -> None:
        raise ToolCallError("edit", f"batch rejected before dispatch (no change was applied): {reason}")

    if not isinstance(edits, list) or not edits or not all(isinstance(e, dict) for e in edits):
        reject("edits must be a non-empty list of {old_string, new_string[, replace_all]}")
    base = {k: v for k, v in args.items() if k != "edits"}
    if not isinstance(base.get("file_path"), str):
        reject("file_path must be a string")
    for i, change in enumerate(edits):
        if set(change) - {"old_string", "new_string", "replace_all"}:
            reject(f"change {i + 1} has fields other than old_string, new_string, replace_all")
        if not isinstance(change.get("old_string"), str) or not isinstance(change.get("new_string"), str):
            reject(f"change {i + 1} old_string and new_string must both be strings")
        if not change["old_string"]:
            reject(f"change {i + 1} old_string must not be empty")
        if "replace_all" in change and type(change["replace_all"]) is not bool:
            reject(f"change {i + 1} replace_all must be a bool")
        if change["old_string"] == change["new_string"]:
            reject(f"change {i + 1} old_string and new_string are identical")
        if "\x00" in change["new_string"]:
            reject(
                f"change {i + 1} new_string contains a NUL character (U+0000); the host treats a file "
                "holding it as binary and refuses every later edit. In a normal Python string \"\\x00\" "
                "is that character: to put the four characters \\x00 in the file, use a raw string "
                "(r'...') or write \"\\\\x00\""
            )
    try:
        json.dumps(args, allow_nan=False)
    except (ValueError, TypeError) as exc:
        reject(f"arguments are not JSON-serializable: {exc}")
    text = _rehearsal_text(base["file_path"])
    if text is not None:
        failure = _rehearse(text, edits)
        if failure is not None:
            reject(failure)
    results = []
    for i, change in enumerate(edits):
        try:
            results.append(await call_tool("edit", {**base, **change}))
        except ToolCallError as exc:
            done = f"changes 1-{i} are applied and in the file" if i else "no change was applied"
            raise ToolCallError("edit", f"change {i + 1} of {len(edits)} failed ({done}): {exc}") from None
    return _with_view("edit", {"applied": len(results), "results": results})


async def call_tool(tool: str, args: Any = None) -> Any:
    """Invoke one registered DSH tool and return its canonical JSON value."""
    try:
        return await _call_tool(tool, args)
    except ToolCallError as exc:
        # The arguments let the error hint name the closest path or text (python/cell_errors.py).
        if not hasattr(exc, "_dsh_args"):
            exc._dsh_args = args  # type: ignore[attr-defined]
        raise


async def _call_tool(tool: str, args: Any = None) -> Any:
    if tool == "edit" and isinstance(args, dict) and "edits" in args:
        return await _edit_many(args)
    if _host_request is None:
        raise RuntimeError("dsh-python-repl: kernel bridge is not installed")
    run_id = _current_run_id()
    if run_id is None:
        # A user thread has no cell context. Failing closed is required: there
        # is no safe "current cell" to borrow.
        raise ToolCallError(
            tool,
            "no active cell context: DSH tools are only callable from cell code "
            "or from tasks that inherited a cell's context (plain threads do not)",
        )
    args = _with_stdin(tool, args)
    payload = {
        "kind": "tool_call",
        "runId": run_id,
        "epoch": _epoch_value,
        "tool": tool,
        "args": args,
    }
    job_id = _job_var.get()
    if job_id is not None:
        payload["jobId"] = job_id
    # Validate BEFORE sending. `json.dumps` defaults to allow_nan=True, which
    # writes bare `NaN`/`Infinity` — not valid JSON. The host's line parser
    # then fails, the frame is dropped, and this coroutine waits forever on a
    # reply that can never arrive. Upstream guards `emit()` exactly this way
    # and notes NaN is the only corruption vector, because every other
    # unserializable value already raises during the send itself.
    #
    # Failing fast with a normal tool error beats hanging: the model sees which
    # argument cannot be sent and can fix it. (Cost a real session ~8 minutes
    # on 2026-09-22.)
    try:
        json.dumps(payload, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise ToolCallError(
            tool,
            f"argument is not JSON-serializable and cannot be sent to the host: {exc}. "
            "NaN and Infinity have no JSON representation. Convert the value only as the "
            "tool's schema and intended meaning permit; do not silently substitute a sentinel.",
        ) from None

    # `rlm.repl.host_request` returns the reply's `data` dict VERBATIM — that is
    # the envelope the host wrote (Prime's shape: `{"status": "ok", "result": …}`
    # or `{"status": "error", "error": …}`), not the tool's value.
    try:
        envelope = await _host_request(payload)
    except ValueError as exc:
        # The vendored kernel refuses a request over its single-frame cap
        # (rlm.repl._PAYLOAD_CAP) before sending; that refusal is still a tool error.
        raise ToolCallError(
            tool,
            f"arguments are too large to send to the host: {exc}. "
            "Write large data to a file and pass its path instead.",
        ) from None
    if not isinstance(envelope, dict):
        raise ToolCallError(tool, f"malformed host reply: {envelope!r}")
    if envelope.get("status") != "ok":
        message = str(envelope.get("error", "tool call failed"))
        if envelope.get("cancelled"):
            # Raise the real cancellation type. `CancelledError` derives from
            # BaseException, so a user's `except ToolCallError` cannot swallow
            # it and continue the loop (technical design §10.2.2).
            raise asyncio.CancelledError(message)
        raise ToolCallError(tool, message)
    result = envelope.get("result")
    if tool == "job_output":
        _keep_job_text(args, result)
    return _with_view(tool, result, args)


#: Positional order for the six top-level tools, so `read(p)` and
#: `bash("ls", "列出文件")` work like Prime's plain functions. Other tools take
#: one dict or keyword arguments: their schemas give no natural order.
_POSITIONAL = {
    "read": ("file_path",),
    "write": ("file_path", "content"),
    "edit": ("file_path", "old_string", "new_string"),
    "bash": ("command", "description"),
    "glob": ("pattern", "path"),
    "grep": ("pattern", "path"),
}


def _arguments(name: str, args: tuple, kwargs: dict) -> Any:
    """Fold the call forms a tool accepts into the one dict the host expects."""
    # The host rejects a missing arguments object, so `tools.job_list()` sends {}.
    if not args or (len(args) == 1 and args[0] is None):
        payload = {}
    elif len(args) == 1 and isinstance(args[0], dict):
        payload = args[0]
    else:
        order = _POSITIONAL.get(name)
        if order is None or any(isinstance(a, dict) for a in args):
            raise TypeError(
                f"{name}() takes one dict of arguments or keyword arguments"
                f"{'' if order is None else ', or positional ' + ', '.join(order)}; "
                f'the contract is in await tools.describe("{name}")'
            )
        if len(args) > len(order):
            raise TypeError(f"{name}() takes at most {len(order)} positional arguments ({', '.join(order)})")
        payload = dict(zip(order, args))
    if kwargs:
        base = dict(payload or {})
        both = sorted(set(base) & set(kwargs))
        if both:
            raise TypeError(f"{name}() got {', '.join(both)} twice")
        base.update(kwargs)
        payload = base
    if isinstance(payload, dict) and any(isinstance(v, os.PathLike) for v in payload.values()):
        payload = {k: os.fspath(v) if isinstance(v, os.PathLike) else v for k, v in payload.items()}
    return payload


class _ToolProxy:
    """One awaitable tool entry point bound to a stable name."""

    __slots__ = ("_name",)

    def __init__(self, name: str) -> None:
        self._name = name

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return call_tool(self._name, _arguments(self._name, args, kwargs))

    def __repr__(self) -> str:
        return f"<dsh tool {self._name!r}>"


_JOB_EXIT = re.compile(r"exit code: (-?\d+)")
_JOB_LIVE = ("running", "stopping")

#: Longest a cell waits on one job, in ms (host setting cellWaitMs; 0 = no cap). A cell that
#: waits blocks the user and the agent; DSH wakes the agent when a job ends.
_WAIT_MS = int(os.environ.get("DSH_PYTHON_REPL_WAIT_MS") or 0)


class JobStillRunning(TimeoutError):
    """`await job` gave up waiting; the job keeps running and DSH reports when it ends."""


class _BashJobResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        code = self["exitCode"]
        status = f"exitCode={code}" if code is not None else f"status={self['status']}"
        out = [f"── bash job {self['jobId']} · {status} (view of a dict) ──"]
        text = self["text"]
        if len(text) > _BASH_JOB_SHOW:
            out.append(f"[... first {len(text) - _BASH_JOB_SHOW} chars not shown; all of it is in r['text'] ...]")
            text = text[-_BASH_JOB_SHOW:]
        out.append(text.rstrip("\n") if text else "(no output)")
        if self.get("detail") and code is None:
            out.append(f"detail: {self['detail']}")
        return "\n".join(out)


_BASH_JOB_SHOW = 20_000

#: Handles made from a still-running bash result, kept so `await r` sees every piece of output.
_HANDLES: dict[str, "BashJob"] = {}
#: Finished handles in `_HANDLES`, oldest first; past the cap the oldest leave it.
_FINISHED: dict[str, None] = {}
#: Ids that left `_HANDLES`, so awaiting one says why instead of waiting on a job DSH forgot.
_RELEASED: dict[str, None] = {}
_KEEP_FINISHED = 100
_KEEP_RELEASED_IDS = 10_000


def _finished(handle: "BashJob") -> None:
    """Keep only the newest finished handles; the result value a cell holds is unaffected."""
    if _HANDLES.get(handle.id) is not handle:
        return
    _FINISHED[handle.id] = None
    while len(_FINISHED) > _KEEP_FINISHED:
        old = next(iter(_FINISHED))
        del _FINISHED[old]
        _HANDLES.pop(old, None)
        _RELEASED[old] = None
    while len(_RELEASED) > _KEEP_RELEASED_IDS:
        del _RELEASED[next(iter(_RELEASED))]


def _streams(text: str) -> dict:
    """A job's text (stdout, then stderr after a `[stderr]` line) as the foreground stdout/stderr fields."""
    head, sep, tail = text.partition("\n[stderr]\n") if not text.startswith("[stderr]\n") else ("", "x", text[len("[stderr]\n"):])
    return {"stdout": {"text": head + ("\n" if sep and head and not head.endswith("\n") else ""), "truncated": False},
            "stderr": {"text": tail if sep else "", "truncated": False}}

#: Live handles by job id. DSH hands each piece of a job's output out once, so
#: a `tools.job_output` call made outside the handle would otherwise take that
#: piece away from `await job` without a trace.
_BASH_JOBS: "weakref.WeakValueDictionary[str, BashJob]" = weakref.WeakValueDictionary()


def _keep_job_text(args: Any, result: Any) -> None:
    """Give the text a job_output call consumed to the job's handle, if one exists."""
    job_id = args.get("job_id") if isinstance(args, dict) else None
    handle = _BASH_JOBS.get(job_id) if isinstance(job_id, str) else None
    if handle is not None and handle._result is None and isinstance(result, dict):
        handle._text.append(result.get("text") or "")


class BashJob:
    """A bash command running as a DSH background job; `await job` collects it.

    Ordinary bash calls run one at a time (DSH runs a tool that may change
    things alone), so `asyncio.gather` over them is serial. A background job
    returns at once, and waiting on several jobs does overlap. The job's
    stdout and stderr arrive as one text, stderr after a `[stderr]` line,
    which is how DSH reports a job; the exit code is read from the job's
    `detail` and stays None when the job did not report one.
    """

    __slots__ = ("id", "command", "_text", "_result", "__weakref__")

    def __init__(self, job_id: str, command: str) -> None:
        self.id = job_id
        self.command = command
        self._text: list[str] = []
        self._result: _BashJobResult | None = None
        _BASH_JOBS[job_id] = self

    @property
    def jobId(self) -> str:
        """Same as `id`; the host's bash result names it `jobId`."""
        return self.id

    def __await__(self):
        return self.wait().__await__()

    async def wait(self, timeout_ms: float | None = None) -> _BashJobResult:
        """Block until the job ends (or `timeout_ms` passes) and return its result."""
        if self._result is not None:
            return self._result
        if _WAIT_MS > 0:
            timeout_ms = _WAIT_MS if timeout_ms is None else min(timeout_ms, _WAIT_MS)
        deadline = None if timeout_ms is None else time.monotonic() + timeout_ms / 1000
        while True:
            args: dict[str, Any] = {"job_id": self.id, "wait": True}
            if deadline is not None:
                left = int((deadline - time.monotonic()) * 1000)
                if left < 1:
                    # DSH refuses a zero wait; a wait that timed out a hair early is simply over.
                    raise self._still_running(timeout_ms)
                args["timeout_ms"] = left
            else:
                # The host caps each wait; asking for a long one keeps the
                # number of round trips small.
                args["timeout_ms"] = 600_000
            got = await call_tool("job_output", args)
            job = got.get("job", {})
            if job.get("status") in _JOB_LIVE and "user steered" in (job.get("detail") or ""):
                # DSH ends every wait at once while a user message waits for the next step;
                # asking again spun 1000+ calls a second (2026-11-08: 11737 calls in 10 s).
                raise JobStillRunning(
                    f"bash job {self.id} still running; the user just sent a message, so the wait stopped. "
                    "Read it now. The job keeps running and DSH wakes you when it finishes; `await job` then returns its result at once. Do not start it again."
                )
            if job.get("status") not in _JOB_LIVE:
                match = _JOB_EXIT.search(job.get("detail") or "")
                self._result = _BashJobResult(
                    jobId=self.id,
                    status=job.get("status"),
                    exitCode=int(match.group(1)) if match else None,
                    text="".join(self._text),
                    detail=job.get("detail"),
                    **_streams("".join(self._text)),
                )
                # The result now holds the text; a second copy would double the memory every job keeps.
                self._text = []
                _finished(self)
                return self._result
            if deadline is not None and time.monotonic() >= deadline:
                raise self._still_running(timeout_ms)

    def _still_running(self, timeout_ms: float) -> "JobStillRunning":
        return JobStillRunning(
            f"bash job {self.id} still running after {timeout_ms / 1000:g}s; it keeps running. "
            "DSH wakes you when it finishes, so end this turn instead of waiting in a cell; `await job` then returns its result at once. Do not start it again."
        )

    async def peek(self) -> str:
        """Everything the job has written so far, without waiting; `await job` still gets all of it."""
        if self._result is not None:
            return self._result["text"]
        await call_tool("job_output", {"job_id": self.id})
        return "".join(self._text)

    async def kill(self, reason: str | None = None) -> Any:
        """Ask DSH to stop the job; `await job` afterwards collects what it wrote."""
        args = {"job_id": self.id} if reason is None else {"job_id": self.id, "reason": reason}
        return await call_tool("job_kill", args)

    def __repr__(self) -> str:
        state = "running" if self._result is None else f"finished exitCode={self._result['exitCode']}"
        return f"<bash job {self.id} {state}: {self.command[:80]!r}>"


class _BashProxy(_ToolProxy):
    """`bash(...)`; past the cell's wait its result is a job you can `await`. `bash.start` is the old spelling of run_in_background=True."""

    __slots__ = ()

    async def start(self, *args: Any, **kwargs: Any) -> BashJob:
        """Start the command as a background job and return its handle at once."""
        payload = _arguments(self._name, args, kwargs)
        if not isinstance(payload, dict):
            raise TypeError('bash.start() needs at least command and description')
        payload = {**payload, "run_in_background": True}
        got = await call_tool(self._name, payload)
        job_id = got.get("jobId") if isinstance(got, dict) else None
        if not job_id:
            raise ToolCallError(self._name, f"bash did not start a background job: {got!r}")
        return BashJob(job_id, str(payload.get("command", "")))


def _proxy(name: str) -> _ToolProxy:
    """The entry point for one tool; bash gets the background-job helper too."""
    return _BashProxy(name) if name == "bash" else _ToolProxy(name)


def _meta_options(query: Any, limit: int, cursor: str | None, where: str) -> dict:
    """Normalise meta-query arguments, accepting the natural dict form too.

    Every OTHER DSH tool takes a single dict, so `tools.list({"cursor": "20"})`
    is the shape a model reaches for first. It used to pass that dict straight
    through as `query`, and the host then failed with a raw JS message
    (`options.query?.toLowerCase is not a function`) — an internal error where
    a usage hint belongs. Accept the dict, and reject anything else in words.
    """
    if isinstance(query, dict):
        unknown = set(query) - {"query", "limit", "cursor"}
        if unknown:
            raise TypeError(
                f"{where}: unknown option(s) {sorted(unknown)}; "
                "accepted keys are query, limit, cursor"
            )
        limit = query.get("limit", limit)
        cursor = query.get("cursor", cursor)
        query = query.get("query")
    if query is not None and not isinstance(query, str):
        raise TypeError(f"{where}: query must be a string or None, got {type(query).__name__}")
    if cursor is not None and not isinstance(cursor, str):
        raise TypeError(f"{where}: cursor must be the string from a previous next_cursor")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"{where}: limit must be an int, got {type(limit).__name__}")
    return {"query": query, "limit": limit, "cursor": cursor}


def _page(items: list, limit: int, cursor: str | None, where: str) -> tuple[list, str | None]:
    """One page of a listing and the cursor for the next, or None at the end.

    The cursor is the decimal offset of the next item, as `tools.list` uses.
    Each page filters the current contents again, so a page reflects what
    exists when it is asked for.
    """
    offset = 0
    if cursor is not None:
        if type(cursor) is not str:
            raise TypeError(f"{where}: cursor must be the string from a previous next_cursor, or None")
        if not cursor.isdecimal():
            raise ValueError(f"{where}: invalid cursor {cursor!r}; pass a previous next_cursor, or None to start over")
        offset = int(cursor)
    end = offset + limit
    return items[offset:end], (str(end) if end < len(items) else None)


class _Namespace:
    """A capability container: `tools` or `skills`.

    Attribute access yields business entry points; `list`/`describe` are the
    meta interface. Names that collide with a meta method, or that are not
    valid identifiers, are reachable by subscript: `tools["list"](...)`.
    """

    def __init__(self, kind: str, members: dict[str, Any] | None = None) -> None:
        self._kind = kind
        self._members: dict[str, Any] = dict(members or {})

    def _put(self, name: str, value: Any) -> None:
        self._members[name] = value

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self._members[name]
        except KeyError:
            raise AttributeError(
                f"{self._kind} has no member {name!r}; use await {self._kind}.list() to see what is available"
            ) from None

    def __getitem__(self, name: str) -> Any:
        try:
            return self._members[name]
        except KeyError:
            if name in ("list", "describe"):
                # Observed: `tools['list']({...})`, read as "index to reach the catalog method".
                raise KeyError(
                    f"{self._kind}[{name!r}] only reaches a member literally named {name!r}, and there is none; "
                    f"the catalog method is await {self._kind}.{name}(...)"
                ) from None
            raise KeyError(f"{self._kind} has no member {name!r}") from None

    def __contains__(self, name: str) -> bool:
        return name in self._members

    def __dir__(self) -> list[str]:
        return sorted({*self._members, "list", "describe"})

    def __repr__(self) -> str:
        return f"<{self._kind}: {len(self._members)} members>"

    async def list(self, query: Any = None, *, limit: int = 20, cursor: str | None = None) -> Any:
        """List this container's available members, with paging."""
        options = _meta_options(query, limit, cursor, f"{self._kind}.list()")
        return await call_tool("__catalog_list__", {"container": self._kind, **options})

    async def describe(self, targets: Any) -> Any:
        """Explain one or more members using the host catalog."""
        return await call_tool("__catalog_describe__", {"container": self._kind, "targets": targets})


def _task_label(task) -> str:
    """`Task-43 (fetch_later)`: the default name alone does not tell the model which work was lost."""
    name = task.get_name()
    try:
        coro = task.get_coro()
        func = getattr(coro, "__name__", None) or type(coro).__name__
    except Exception:  # noqa: BLE001 - a label must never break teardown
        return name
    return f"{name} ({func})"


#: Every task a cell created, weakly: a task that already finished is gone
#: from `asyncio.all_tasks()`, and those are exactly the ones whose error
#: nobody saw.
_created_tasks: "weakref.WeakSet[asyncio.Task]" = weakref.WeakSet()


def _track_created_tasks(loop: asyncio.AbstractEventLoop) -> None:
    """Record each new task without changing how it is built or runs."""
    previous = loop.get_task_factory()

    def factory(loop, coro, **kwargs):
        task = previous(loop, coro, **kwargs) if previous is not None else asyncio.Task(coro, loop=loop, **kwargs)
        _created_tasks.add(task)
        return task

    loop.set_task_factory(factory)


def _unretrieved_failures() -> list[str]:
    """Tasks that ended with an error nobody has looked at, from any cell.

    Without this the only trace is asyncio's "Task exception was never
    retrieved", printed whenever the task is garbage-collected.
    `_log_traceback` is asyncio's own "nobody retrieved this" flag; reading it
    here does not consume the error.
    """
    failed = []
    for task in list(_created_tasks):
        try:
            if not task.done() or task.cancelled() or not getattr(task, "_log_traceback", False):
                continue
            # Read it the way asyncio's own warning does: `exception()` would
            # mark it retrieved, and the C task refuses to have the flag set
            # back, so the model's later `.exception()` and asyncio's
            # never-retrieved warning both keep working only this way.
            exc = task._exception
        except Exception:  # noqa: BLE001 - a report must never break teardown
            continue
        if exc is None:
            continue
        _created_tasks.discard(task)
        failed.append(f"{_task_label(task)}: {type(exc).__name__}: {exc}"[:300])
    return failed


__all__ = [
    "ToolCallError",
    "call_tool",
    "tools",
    "skills",
]

#: Capability containers. Populated by the bootstrap from the live DSH catalog.
tools = _Namespace("tools")
skills = _Namespace("skills")
