"""Short cell errors: the model's own lines, one line for frames elsewhere, the message once.

A cell's error reaches the model as `Ename: evalue` followed by the traceback,
whose last line repeats that message. Measured on real sessions (2026-11-03, 330
sessions): a failed skill call averaged 2,218 characters, 84% of them frames
inside the skill, asyncio and thread pools; a failed tool call carried bridge
frames that say nothing about the cell. Kept: every frame in the session's own
code (cells and functions defined in them). Dropped to one marker line: frames
elsewhere, except the frame that raised a non-business error inside a library
or skill, which is where a real bug would be fixed.
"""
from __future__ import annotations

import re
import traceback

_CARET = re.compile(r"^\s*[\^~]+\s*$")
_SOURCE_CHARS = 300
_KEPT_FRAMES = 24
_CHAIN = 3


def _where(filename: str) -> tuple[str, str]:
    """(kind, label) of a frame outside the session's cells."""
    path = filename.replace("\\", "/")
    if "/dsh-python-repl/python/" in path or "/vendor/prime/" in path:
        return "bridge", "the DSH bridge"
    match = re.search(r"/skills/([^/]+)/", path) or re.search(r"/src/([^/]+)/", path)
    if match:
        return "library", f"skill {match.group(1).replace('_', '-')}"
    match = re.search(r"/site-packages/([^/]+)", path)
    if match:
        return "library", match.group(1).split(".")[0]
    match = re.search(r"/lib/python3\.\d+/(?:([^/.]+)/|([^/]+)\.py$)", path)
    if match:
        return "stdlib", match.group(1) or match.group(2)
    return "library", path.rsplit("/", 1)[-1]


def _frame(summary: traceback.FrameSummary) -> str:
    text = traceback.StackSummary.from_list([summary]).format()[0]
    kept = []
    for line in text.splitlines():
        if _CARET.match(line) and len(line) > 80:
            continue
        if line.startswith("    ") and len(line) > _SOURCE_CHARS + 4:
            line = line[: _SOURCE_CHARS + 4] + " …"
        kept.append(line)
    return "\n".join(kept) + "\n"


def _marker(labels: list[str], count: int) -> str:
    names = ", ".join(dict.fromkeys(labels))
    return f"  [{count} frame{'s' if count != 1 else ''} inside {names} not shown]\n"


def _stack_lines(stack, business: bool) -> list[str]:
    frames = list(stack)
    out: list[str] = []
    run: list[tuple[str, str]] = []
    for index, summary in enumerate(frames):
        if summary.filename.startswith("<cell-"):
            if run:
                out.append(_marker([label for _, label in run], len(run)))
                run = []
            out.append(_frame(summary))
            continue
        kind, label = _where(summary.filename)
        last = index == len(frames) - 1
        if last and not business and kind == "library":
            if run:
                out.append(_marker([lbl for _, lbl in run], len(run)))
                run = []
            out.append(_frame(summary))
        else:
            run.append((kind, label))
    if run:
        out.append(_marker([label for _, label in run], len(run)))
    if len(out) > _KEPT_FRAMES:
        half = _KEPT_FRAMES // 2
        out = out[:half] + [f"  [{len(out) - _KEPT_FRAMES} more lines not shown]\n"] + out[-half:]
    return out


def compact(exc: BaseException, cell_stack, business) -> list[str] | None:
    """Traceback lines for the host to append after `Ename: evalue`, or None to keep Prime's.

    `cell_stack` is Prime's _cell_stack; `business(exc)` says whether the
    exception is an expected outcome (a tool or skill reporting failure) whose
    frames outside the cell never help.
    """
    te = traceback.TracebackException.from_exception(exc)
    if cell_stack(te.stack) is None:
        return None
    chain: list[tuple[traceback.TracebackException, str | None]] = []
    current, seen = te, set()
    while current is not None and id(current) not in seen and len(chain) < _CHAIN:
        seen.add(id(current))
        if current.__cause__ is not None:
            chain.append((current, "\nThe above exception was the direct cause of the following exception:\n\n"))
            current = current.__cause__
        elif current.__context__ is not None and not current.__suppress_context__:
            chain.append((current, "\nDuring handling of the above exception, another exception occurred:\n\n"))
            current = current.__context__
        else:
            chain.append((current, None))
            current = None
    lines: list[str] = []
    for position, (entry, _) in enumerate(reversed(chain)):
        outermost = position == len(chain) - 1
        stack = cell_stack(entry.stack) if outermost else entry.stack
        if stack:
            lines.append("Traceback (most recent call last):\n")
            lines.extend(_stack_lines(stack, business(exc) if outermost else False))
        only = list(entry.format_exception_only())
        # The host already printed `Ename: evalue` for the outermost exception; keep only its notes.
        lines.extend(only[1:] if outermost else only)
        if not outermost:
            lines.append(chain[len(chain) - 2 - position][1] or "")
    return lines


_SCAN_BYTES = 2_000_000
_OLD_LINES = 60
_SHOWN_LINES = 12
_QUOTED_PATH = re.compile(r'"(/[^"]+)"')


def _near_paths(path: str) -> str | None:
    """Close names next to a path that does not exist, or the deepest directory that does."""
    import difflib
    import os

    parent, name = os.path.split(os.path.normpath(path))
    probe = parent
    while probe and not os.path.isdir(probe):
        probe = os.path.dirname(probe) if os.path.dirname(probe) != probe else ""
    if not probe:
        return None
    if probe != parent:
        return f"{parent} does not exist either; the deepest existing directory is {probe}."
    try:
        entries = os.listdir(parent)
    except OSError:
        return None
    close = difflib.get_close_matches(name, entries, n=3, cutoff=0.6)
    if not close:
        return f"Nothing in {parent} is named like {name!r}."
    return "Similar names in that directory: " + ", ".join(os.path.join(parent, c) for c in close) + "."


def _closest_text(path: str, old: str) -> str | None:
    """The lines of `path` most like `old`, numbered, when they are close enough to be the intended text."""
    import difflib

    try:
        with open(path, "rb") as fh:
            raw = fh.read(_SCAN_BYTES + 1)
    except OSError:
        return None
    if len(raw) > _SCAN_BYTES:
        return None
    try:
        lines = raw.decode("utf-8").split("\n")
    except UnicodeDecodeError:
        return None
    want = old.strip("\n").split("\n")
    if not want or len(want) > _OLD_LINES:
        return None
    k = len(want)
    head = want[0].strip()
    # Rank start lines by their first line, then compare whole windows for the best few.
    starts = sorted(range(max(1, len(lines) - k + 1)),
                    key=lambda i: -difflib.SequenceMatcher(None, lines[i].strip(), head).quick_ratio())[:8]
    target = "\n".join(want)
    best, score = None, 0.0
    for i in starts:
        ratio = difflib.SequenceMatcher(None, "\n".join(lines[i:i + k]), target).ratio()
        if ratio > score:
            best, score = i, ratio
    if best is None or score < 0.6:
        return None
    shown = lines[best:best + min(k, _SHOWN_LINES)]
    body = "\n".join(f"{best + 1 + j}: {line[:200]}" for j, line in enumerate(shown))
    more = f"\n… {k - len(shown)} more lines" if k > len(shown) else ""
    return f"Closest text in the file (lines {best + 1}-{best + k}, {score:.0%} alike); copy old_string from it:\n{body}{more}"


def _edit_target(message: str, args) -> tuple[str, str] | None:
    """(path, old_string) of the change an edit error is about."""
    if not isinstance(args, dict) or not isinstance(args.get("file_path"), str):
        return None
    edits = args.get("edits")
    if isinstance(edits, list):
        which = re.search(r"change (\d+)", message)
        index = int(which.group(1)) - 1 if which else 0
        change = edits[index] if 0 <= index < len(edits) and isinstance(edits[index], dict) else None
        old = change.get("old_string") if change else None
    else:
        old = args.get("old_string")
    return (args["file_path"], old) if isinstance(old, str) and old else None


def _line_count(path: str) -> int | None:
    try:
        with open(path, "rb") as fh:
            return sum(chunk.count(b"\n") for chunk in iter(lambda: fh.read(1 << 20), b"")) + 1
    except OSError:
        return None


def tool_hint(message: str, args=None) -> str | None:
    """What the model can do next, for the tool failures seen most on real sessions (2026-11-03).

    Read and edit argument mistakes started 417 retry chains there; where the
    file system can say more (a near path, the closest text, the line count),
    say it here. None when the host already says what to do.
    """
    try:
        extra = _next_step(message, args)
    except Exception:  # noqa: BLE001 - a hint must never break error reporting
        extra = None
    if extra is not None:
        return extra
    if re.search(r"replace_all|provide a more specific|read it again|use glob", message, re.I):
        return None
    if re.search(r"old_string (?:matched|matches) \d+", message):
        return "Make old_string longer so it matches exactly one place, or pass replace_all=True to change every match."
    if "must differ" in message:
        return "old_string and new_string are the same, so nothing would change; the file may already have the new text — read it to check."
    if "limit must be less than or equal to" in message:
        return "read returns at most 2000 lines per call: continue at r['lines'][-1]['number'] + 1 (await repl.read_window(r) gives next_offset)."
    if re.search(r"old_string (?:was )?not found", message):
        return "The file does not contain that exact text (spaces, quotes and line breaks count): read those lines again and copy old_string from them."
    if re.search(r"cannot read .*not found|no such file", message, re.I):
        return "Check the path: await glob('**/<name>', path=<dir>) finds a file; a relative path starts at the session's working directory."
    return None


_NAMES_SHOWN = 10


def _defined(stmt) -> list[str]:
    """Top-level names a statement would bind: def, class, import, plain assignment."""
    import ast

    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [stmt.name]
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return [(alias.asname or alias.name).split(".")[0] for alias in stmt.names if alias.name != "*"]
    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
    names: list[str] = []
    for target in targets:
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                names.append(node.id)
    return names


def skipped_note(exc: BaseException) -> str | None:
    """Which later lines of the failed cell never ran, and what they would have defined.

    A cell that fails on line 3 never reaches the `def helper` on line 10, and
    the next cell's NameError does not say why (52 retry chains on real sessions,
    2026-11-03). Top-level statements only; None when nothing was skipped.
    """
    import ast
    import linecache

    tb = exc.__traceback__
    while tb is not None and not tb.tb_frame.f_code.co_filename.startswith("<cell-"):
        tb = tb.tb_next
    if tb is None:
        return None
    filename = tb.tb_frame.f_code.co_filename
    namespace = tb.tb_frame.f_globals
    line = tb.tb_lineno
    try:
        tree = ast.parse("".join(linecache.getlines(filename)))
    except SyntaxError:
        return None
    body = tree.body
    at = next((i for i, stmt in enumerate(body) if stmt.lineno <= line <= (stmt.end_lineno or stmt.lineno)), None)
    if at is None or at + 1 >= len(body):
        return None
    later = body[at + 1:]
    names = list(dict.fromkeys(name for stmt in later for name in _defined(stmt)))
    first, last = later[0].lineno, later[-1].end_lineno or later[-1].lineno
    span = f"line {first}" if first == last else f"lines {first}-{last}"
    if not names:
        return f"The cell stopped at line {line}; {span} did not run.\n"
    missing = [n for n in names if n not in namespace]
    stale = [n for n in names if n in namespace]
    parts = []
    if missing:
        parts.append(f"not defined: {', '.join(missing[:_NAMES_SHOWN])}" + (f" (+{len(missing) - _NAMES_SHOWN} more)" if len(missing) > _NAMES_SHOWN else ""))
    if stale:
        parts.append(f"still the value from an earlier cell: {', '.join(stale[:_NAMES_SHOWN])}" + (f" (+{len(stale) - _NAMES_SHOWN} more)" if len(stale) > _NAMES_SHOWN else ""))
    return f"The cell stopped at line {line}; {span} did not run, so {'; '.join(parts)}.\n"


def _next_step(message: str, args) -> str | None:
    """A hint built from the file system: near paths, closest text, line count."""
    if re.search(r"old_string (?:was )?not found", message):
        target = _edit_target(message, args)
        return None if target is None else _closest_text(*target)
    if re.search(r"cannot read .*not found|no such file", message, re.I):
        quoted = _QUOTED_PATH.search(message)
        near = None if quoted is None else _near_paths(quoted.group(1))
        return None if near is None else f"{near} await glob('**/<name>', path=<dir>) searches deeper."
    found = re.search(r"offset (\d+) is out of range", message)
    if found:
        quoted = _QUOTED_PATH.search(message)
        total = None if quoted is None else _line_count(quoted.group(1))
        return None if total is None else f"The file has {total} lines; pass an offset from 1 to {total}."
    return None
