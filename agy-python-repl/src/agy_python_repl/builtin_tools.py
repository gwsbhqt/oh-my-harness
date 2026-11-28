"""Local async file/search/shell helpers for Antigravity Python REPL cells."""

from __future__ import annotations

import asyncio
import base64
import copyreg
import fcntl
import fnmatch
import json
import math
import os
import re
import shutil
import signal
import stat
import tempfile
import threading
from collections import defaultdict
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, BinaryIO

_IGNORED_DIRS = frozenset({".git", "node_modules", ".venv", "site-packages", "__pycache__",
                           ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox"})
_GREP_IGNORE_MARKERS = frozenset({".git", ".gitignore", ".ignore", ".rgignore"})
_GREP_NEEDS_RG = "Applying ignore files requires ripgrep (rg); use scope='all' to include ignored files"
_GREP_SHOW = 250
_GREP_MAX_BYTES = 10 * 1024 * 1024
_GLOB_SHOW = 100
_LINE_SHOW = 300
_MAX_READ_LIMIT = 2000
_EDIT_MAX_BYTES = 4 * 1024 * 1024
_BASH_MAX_BYTES = 4 * 1024 * 1024

_POSITIONAL: dict[str, tuple[str, ...]] = {
    "read": ("file_path",),
    "write": ("file_path", "content"),
    "edit": ("file_path", "old_string", "new_string"),
    "bash": ("command", "description"),
    "glob": ("pattern", "path"),
    "grep": ("pattern", "path"),
}

_OPTIONS = {
    "read": {"offset", "limit"},
    "write": set(),
    "edit": {"replace_all", "edits"},
    "bash": {"workdir", "stdin", "timeoutMs", "env", "run_in_background"},
    "glob": {"limit"},
    "grep": {"scope", "include", "case_sensitive", "fixed_strings", "limit"},
}


class ToolCallError(RuntimeError):
    """Raised when a built-in REPL tool call fails validation or execution."""

    __snapshot_exception_fields__ = {"toolName": str}

    def __init__(self, tool_name: str, message: str) -> None:
        super().__init__(message)
        self.toolName = tool_name

    def __reduce__(self):
        return copyreg.__newobj__, (type(self), *self.args), self.__dict__


class _ToolResult(dict):
    """Plain dict with attribute access and a compact human/model-readable view."""

    __slots__ = ()

    def __repr__(self) -> str:
        try:
            return self._render()
        except Exception:  # noqa: BLE001
            return dict.__repr__(self)

    __str__ = __repr__

    def __missing__(self, key: Any) -> Any:
        keys = ", ".join(repr(k) for k in self)
        if isinstance(key, slice):
            raise KeyError(f"this tool result is a dict, not text or a list, so it cannot be sliced; its keys are {keys}")
        raise KeyError(f"{key!r} is not a key of this tool result; its keys are {keys}")

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(exc.args[0] if exc.args else name) from None

    def _render(self) -> str:
        return dict.__repr__(self)


class _NestedResult(_ToolResult):
    """Nested dict with attribute access."""

    __slots__ = ()


class _NestedList(list):
    """Nested list whose dict elements are wrapped recursively."""

    __slots__ = ()


def _wrap_nested(value: Any) -> Any:
    if type(value) is dict:
        wrapped = _NestedResult()
        for key, item in value.items():
            dict.__setitem__(wrapped, key, _wrap_nested(item))
        return wrapped
    if type(value) is list:
        return _NestedList(_wrap_nested(item) for item in value)
    return value


def _clip_line(line: str) -> str:
    return line if len(line) <= _LINE_SHOW else f"{line[:_LINE_SHOW]}… ({len(line)} chars)"


class _ReadResult(_ToolResult):
    __slots__ = ()

    @property
    def text(self) -> str:
        """This window's lines joined with newlines, without line numbers."""
        return "\n".join(line["text"] for line in self["lines"])

    def __missing__(self, key: Any) -> Any:
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
        out += [f"{line['number']}: {_clip_line(line['text'])}" for line in lines]
        if lines and lines[-1]["number"] < total:
            out.append(f"── more below: offset={lines[-1]['number'] + 1} ──")
        return "\n".join(out)


class _WriteResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        return f"── write {self['path']} · operation={self['operation']} · {self['bytes']} UTF-8 bytes ──"


class _EditResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        results = self["results"]
        replacements = sum(step["replacements"] for step in results)
        return f"── edit {results[0]['path']} · applied={len(results)} · {replacements} replacements ──"


class _BashResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        status = [f"exitCode={self['exitCode']}"]
        if self.get("signal"):
            status.append(f"signal={self['signal']}")
        if self.get("timedOut"):
            status.append(f"TIMED OUT after {self.get('timeoutMs')}ms")
        body: list[str] = []
        notices: list[str] = []
        for label in ("stdout", "stderr"):
            stream = self.get(label)
            if isinstance(stream, dict):
                if stream["truncated"]:
                    detail = (f"full output: {stream['spillPath']}" if stream.get("spillPath") else
                              f"full output unavailable: {stream.get('spillError', 'no capture was recorded')}")
                    notices.append(f"[{label} truncated at {_BASH_MAX_BYTES} bytes; {detail}]")
                text = stream["text"]
                if text:
                    body.extend([f"[{label}]", text[:4000].removesuffix("\n")])
                    if len(text) > 4000:
                        body.append(f"[… {len(text) - 4000} more characters in r.{label}.text]")
        if not body and not notices:
            body.append("(no output on stdout or stderr)")
        return "\n".join([f"── bash · {' · '.join(status)} (view of a dict) ──", *notices, *body])


def _search_preview_path(result: dict, path: str) -> str:
    root = result.get("searchPath", result.get("root"))
    if root is not None and Path(path).is_relative_to(root):
        return str(Path(path).relative_to(root))
    return path


def _search_errors(result: dict) -> list[str]:
    errors = result.get("unreadable", [])
    lines = []
    for item in errors[:10]:
        path = _search_preview_path(result, item["path"])
        message = item["error"].replace(item["path"], path)
        lines.append(f"  unreadable {path}: {message}")
    if len(errors) > 10:
        lines.append(f"  … {len(errors) - 10} more in r.unreadable")
    return lines


class _GrepResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        matches = self["matches"]
        files = len({m["path"] for m in matches})
        count = f"{len(matches)} retained matches" if matches and self["outputCapped"] else f"{len(matches)} matches"
        label = f" · scope={self['scope']}" if self.get("scope") else ""
        root = f" under {self['root']}" if self.get("root") else ""
        coverage = f" in {files} matching file{'s' if files != 1 else ''}" if files else ""
        out = [f"── grep{label} · {count}{coverage}{root} (view of a dict) ──"]
        if self["outputCapped"]:
            out.append("INCOMPLETE: search output was capped")
        if self.get("unreadable"):
            out.extend(["INCOMPLETE: some paths could not be read", *_search_errors(self)])
        out.extend(f"{_search_preview_path(self, m['path'])}:{m['lineNumber']}: {_clip_line(m['line'])}"
                   for m in matches[:_GREP_SHOW])
        if len(matches) > _GREP_SHOW:
            out.append(f"… {len(matches) - _GREP_SHOW} more in r.matches[{_GREP_SHOW}:]")
        if not matches:
            out.append("(no matches returned from the readable part of the selected scope)")
        return "\n".join(out)


class _GlobResult(_ToolResult):
    __slots__ = ()

    def _render(self) -> str:
        paths = self["paths"]
        out = [f"── glob · {len(paths)} paths under {self['root']} (view of a dict) ──"]
        if self["truncated"]:
            out.append(f"INCOMPLETE: returning {len(paths)} of {self['total']} matching paths found")
        if self.get("unreadable"):
            out.extend(["INCOMPLETE: some paths could not be read", *_search_errors(self)])
        out.extend(_search_preview_path(self, path) for path in paths[:_GLOB_SHOW])
        if len(paths) > _GLOB_SHOW:
            out.append(f"… {len(paths) - _GLOB_SHOW} more in r.paths[{_GLOB_SHOW}:]")
        pattern = self.get("pattern", "")
        if not paths and "/" in pattern and not pattern.startswith("**/"):
            out.append("(patterns with / match from the search root; use **/ to search below any directory)")
        return "\n".join(out)


def _fold_arguments(name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    """Accept positional args, a single dict, or keyword args just like DSH's tool proxies."""
    if not args or (len(args) == 1 and args[0] is None):
        payload: dict[str, Any] = {}
    elif len(args) == 1 and isinstance(args[0], dict):
        payload = dict(args[0])
    else:
        order = _POSITIONAL[name]
        if any(isinstance(a, dict) for a in args):
            raise TypeError(f"{name}() takes one dict, keyword args, or positional {', '.join(order)}")
        if len(args) > len(order):
            raise TypeError(f"{name}() takes at most {len(order)} positional arguments ({', '.join(order)})")
        payload = dict(zip(order, args))
    if kwargs:
        both = sorted(set(payload) & set(kwargs))
        if both:
            raise TypeError(f"{name}() got {', '.join(both)} twice")
        payload.update(kwargs)
    aliases = {"path": "file_path"} if name in ("read", "write", "edit") else {}
    if name == "bash":
        aliases = {"cwd": "workdir", "timeout_ms": "timeoutMs"}
    for alias, key in aliases.items():
        if alias in payload:
            if key in payload:
                raise TypeError(f"{name}() got both {alias!r} and {key!r}")
            payload[key] = payload.pop(alias)
    extra = payload.keys() - _POSITIONAL[name] - _OPTIONS[name]
    if extra:
        raise ToolCallError(name, f"Unsupported argument(s): {', '.join(sorted(extra))}")
    return {k: os.fspath(v) if isinstance(v, os.PathLike) else v for k, v in payload.items()}


def _resolve_path(raw: Any, tool_name: str, *, allow_missing: bool = False, absolute: bool = True) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise ToolCallError(tool_name, "file_path/path must be a non-empty string")
    try:
        candidate = Path(raw).expanduser()
        if absolute:
            candidate = candidate.resolve()
        if not allow_missing:
            candidate.stat()
    except FileNotFoundError:
        raise ToolCallError(tool_name, f"Path does not exist: {candidate}") from None
    except (OSError, RuntimeError, ValueError) as exc:
        raise ToolCallError(tool_name, f"Cannot access {raw}: {exc}") from None
    return candidate


async def _read_impl(payload: dict[str, Any]) -> _ReadResult:
    target = _resolve_path(payload.get("file_path"), "read")
    if target.is_dir():
        raise ToolCallError("read", f"Path is a directory, not a file: {target}")
    offset = payload.get("offset", 1)
    limit = payload.get("limit", _MAX_READ_LIMIT)
    if type(offset) is not int or offset < 1:
        raise ToolCallError("read", "offset must be a positive integer (1-based)")
    if type(limit) is not int or not 1 <= limit <= _MAX_READ_LIMIT:
        raise ToolCallError("read", f"limit must be an integer between 1 and {_MAX_READ_LIMIT}")

    def _load() -> _ReadResult:
        lines = []
        total = 0
        try:
            with target.open(encoding="utf-8", newline="\n") as source:
                for total, line in enumerate(source, 1):
                    if "\x00" in line:
                        raise ToolCallError("read", f"Cannot read binary file: {target}")
                    if offset <= total < offset + limit:
                        text = line.removesuffix("\n").removesuffix("\r") if line.endswith("\n") else line
                        lines.append({"number": total, "text": text})
        except (OSError, UnicodeError) as exc:
            raise ToolCallError("read", f"Failed to read {target} as UTF-8: {exc}") from None
        if offset > max(total, 1):
            raise ToolCallError("read", f"offset {offset} is out of range for {target} ({total} lines)")
        return _ReadResult(path=str(target), offset=offset, lines=_wrap_nested(lines), totalLines=total,
                           truncated=offset - 1 + len(lines) < total)

    return await asyncio.to_thread(_load)


def _try_lock(fd: int) -> bool:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


async def _mutate_file(target: Path, tool: str, action, *, create: bool = False):
    cancelled = threading.Event()

    def attempt():
        if cancelled.is_set():
            return None
        if create:
            target.parent.mkdir(parents=True, exist_ok=True)
        # A newly created file must already be locked when another writer opens it.
        # Release the directory lock before doing any file content I/O.
        with ExitStack() as opening:
            directory = os.open(target.parent, getattr(os, "O_SEARCH", os.O_RDONLY) | os.O_DIRECTORY)
            opening.callback(os.close, directory)
            if not _try_lock(directory):
                return None
            created = False
            try:
                stream = target.open("r+b")
            except FileNotFoundError:
                if not create:
                    raise
                if cancelled.is_set():
                    return None
                try:
                    stream = target.open("x+b")
                except FileExistsError:
                    return None
                created = True
            with stream:
                if not _try_lock(stream.fileno()):
                    return None
                opening.close()
                if not created and cancelled.is_set():
                    return None
                return action(stream, created)

    try:
        while (result := await asyncio.to_thread(attempt)) is None:
            await asyncio.sleep(0.02)
        return result
    except (OSError, UnicodeError) as exc:
        raise ToolCallError(tool, f"Failed to {tool} {target}: {exc}") from None
    finally:
        cancelled.set()


def _replace_contents(stream: BinaryIO, data: bytes) -> None:
    stream.seek(0)
    stream.write(data)
    stream.truncate()


async def _write_impl(payload: dict[str, Any]) -> _ToolResult:
    target = _resolve_path(payload.get("file_path"), "write", allow_missing=True)
    content = payload.get("content")
    if not isinstance(content, str):
        raise ToolCallError("write", "content must be a string")
    if target.is_dir():
        raise ToolCallError("write", f"Path is a directory: {target}")

    try:
        encoded = content.encode("utf-8")
    except UnicodeError as exc:
        raise ToolCallError("write", f"Failed to encode content as UTF-8: {exc}") from None

    def _save(stream: BinaryIO, created: bool) -> _ToolResult:
        before = None if created else stream.read().decode("utf-8")
        _replace_contents(stream, encoded)
        lines = content.count("\n") + int(bool(content) and not content.endswith("\n"))
        return _WriteResult(path=str(target), operation="create" if before is None else "update",
                            before=before, after=content, bytes=len(encoded), lines=lines)

    return await _mutate_file(target, "write", _save, create=True)


async def _edit_impl(payload: dict[str, Any]) -> _ToolResult:
    target = _resolve_path(payload.get("file_path"), "edit")
    if target.is_dir():
        raise ToolCallError("edit", f"Path is a directory: {target}")

    raw_edits = payload.get("edits")
    if raw_edits is None:
        old_s = payload.get("old_string")
        new_s = payload.get("new_string")
        replace_all = payload.get("replace_all", False)
        if type(replace_all) is not bool:
            raise ToolCallError("edit", "replace_all must be a bool")
        edits = [{"old_string": old_s, "new_string": new_s, "replace_all": replace_all}]
    else:
        if {"old_string", "new_string", "replace_all"}.intersection(payload):
            raise ToolCallError("edit", "edits cannot be combined with single-edit arguments")
        if not isinstance(raw_edits, list) or not raw_edits or not all(isinstance(e, dict) for e in raw_edits):
            raise ToolCallError("edit", "edits must be a non-empty list of {old_string, new_string[, replace_all]}")
        edits = raw_edits

    for i, change in enumerate(edits):
        if set(change) - {"old_string", "new_string", "replace_all"}:
            raise ToolCallError("edit", f"change {i + 1} has unsupported fields")
        if not isinstance(change.get("old_string"), str) or not isinstance(change.get("new_string"), str):
            raise ToolCallError("edit", f"change {i + 1} old_string and new_string must both be strings")
        if not change["old_string"]:
            raise ToolCallError("edit", f"change {i + 1} old_string must not be empty")
        if "replace_all" in change and type(change["replace_all"]) is not bool:
            raise ToolCallError("edit", f"change {i + 1} replace_all must be a bool")
        if change["old_string"] == change["new_string"]:
            raise ToolCallError("edit", f"change {i + 1} old_string and new_string are identical")
        if "\x00" in change["new_string"]:
            raise ToolCallError("edit", f"change {i + 1} new_string contains a NUL byte")

    def _apply(stream: BinaryIO, _created: bool) -> _ToolResult:
        raw_bytes = stream.read(_EDIT_MAX_BYTES + 1)
        if len(raw_bytes) > _EDIT_MAX_BYTES:
            raise ToolCallError("edit", f"File exceeds edit limit ({_EDIT_MAX_BYTES} bytes): {target}")
        if b"\x00" in raw_bytes:
            raise ToolCallError("edit", f"Cannot edit binary file: {target}")
        try:
            original = raw_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ToolCallError("edit", f"File is not valid UTF-8 ({target}): {exc}") from None

        text = original
        first_break = re.search(r"\r?\n", text)
        default_ending = first_break[0] if first_break else "\n"
        results = []
        for i, change in enumerate(edits, 1):
            old, new = change["old_string"], change["new_string"]
            explicit = "\r\n" in old or "\r\n" in new
            if explicit:
                # A literal LF must not match the second byte of a CRLF.
                pattern = re.compile(r"(?<!\r)\n".join(re.escape(part) for part in re.split(r"(?<!\r)\n", old)))
            else:
                pattern = re.compile(r"\r?\n".join(re.escape(part) for part in old.split("\n")))

            def replacement(match: re.Match[str]) -> str:
                if explicit:
                    return new
                ending = re.search(r"\r?\n", match[0]) if "\n" in new else None
                return new.replace("\n", ending[0] if ending else default_ending)

            updated, count = pattern.subn(replacement, text)
            if not count or (count > 1 and not change.get("replace_all")):
                reason = "was not found" if not count else f"matches {count} places; add context or set replace_all=True"
                raise ToolCallError("edit", f"batch rejected (no change was applied): "
                                            f"change {i} of {len(edits)} old_string {reason}")
            results.append({"path": str(target), "before": text, "after": updated, "replacements": count})
            text = updated
        _replace_contents(stream, text.encode("utf-8"))
        result = _EditResult(applied=len(results), results=_wrap_nested(results))
        if raw_edits is None:
            result.update(results[0])
        return result

    return await _mutate_file(target, "edit", _apply)


async def _bash_stream(source: BinaryIO, label: str, capture_dir: Path | None) -> _NestedResult:
    source.seek(0)
    first = source.read(_BASH_MAX_BYTES + 1)
    truncated = len(first) > _BASH_MAX_BYTES
    result = _NestedResult(text=first[:_BASH_MAX_BYTES].decode("utf-8", errors="replace"), truncated=truncated)
    if not truncated:
        return result
    if capture_dir is None:
        result["spillError"] = "no capture directory was configured"
        return result

    target = None
    try:
        capture_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="wb", dir=capture_dir, prefix=f"bash-{label}-",
                                         suffix=".bin", delete=False) as sink:
            target = Path(sink.name)
            chunk = first
            while chunk:
                sink.write(chunk)
                # A large capture must let other foreground commands time out or be cancelled.
                await asyncio.sleep(0)
                chunk = source.read(256 * 1024)
    except OSError as exc:
        result["spillError"] = f"could not save full {label} in {capture_dir}: {exc}"
    else:
        result["spillPath"] = str(target)
    finally:
        if target is not None and "spillPath" not in result:
            try:
                target.unlink(missing_ok=True)
            except OSError as cleanup_error:
                reason = result.get("spillError", "capture cancelled")
                result["spillError"] = f"{reason}; could not remove partial file {target}: {cleanup_error}"
    return result


async def _bash_impl(payload: dict[str, Any], *, capture_dir: Path | None = None) -> _BashResult:
    command = payload.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ToolCallError("bash", "command must be a non-empty string")
    if type(payload.get("run_in_background", False)) is not bool:
        raise ToolCallError("bash", "run_in_background must be a bool")
    if payload.get("run_in_background"):
        raise ToolCallError("bash", "run_in_background requires a host job queue; this helper runs in the foreground")
    raw_dir = payload.get("workdir")
    work_dir = _resolve_path(raw_dir, "bash") if raw_dir is not None else Path.cwd()
    if not work_dir.is_dir():
        raise ToolCallError("bash", f"workdir is not a directory: {work_dir}")
    stdin_text = payload.get("stdin")
    if stdin_text is not None and not isinstance(stdin_text, str):
        raise ToolCallError("bash", "stdin must be a string")
    timeout_ms = payload.get("timeoutMs")
    if timeout_ms is not None and (type(timeout_ms) not in (int, float) or not math.isfinite(timeout_ms) or timeout_ms <= 0):
        raise ToolCallError("bash", "timeoutMs must be a finite positive number")

    env = os.environ.copy()
    extra_env = payload.get("env")
    if extra_env is not None:
        if not isinstance(extra_env, dict):
            raise ToolCallError("bash", "env must be a dict of environment overrides")
        for k, v in extra_env.items():
            if v is None:
                env.pop(str(k), None)
            else:
                env[str(k)] = str(v)

    shell = shutil.which("bash")
    if not shell:
        raise ToolCallError("bash", "Bash executable not found on PATH")
    timed_out = False
    # Capture both streams independently even if the timeout interrupts communicate().
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            stdin_bytes = stdin_text.encode("utf-8") if stdin_text is not None else None
            proc = await asyncio.create_subprocess_exec(
                shell, "-c", command, cwd=work_dir, env=env, start_new_session=True,
                stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else asyncio.subprocess.DEVNULL,
                stdout=stdout, stderr=stderr,
            )
        except (OSError, ValueError) as exc:
            raise ToolCallError("bash", f"Cannot start bash: {exc}") from None
        try:
            await asyncio.wait_for(proc.communicate(stdin_bytes), None if timeout_ms is None else timeout_ms / 1000)
        except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await proc.wait()
            if isinstance(exc, asyncio.CancelledError):
                raise
            timed_out = True
        streams = {}
        with ExitStack() as unfinished:
            for label, source in (("stdout", stdout), ("stderr", stderr)):
                stream = streams[label] = await _bash_stream(source, label, capture_dir)
                if "spillPath" in stream:
                    unfinished.callback(Path(stream.spillPath).unlink, missing_ok=True)
            unfinished.pop_all()
    rc = proc.returncode
    sig = signal.Signals(-rc).name if rc is not None and rc < 0 else None
    return _BashResult(
        kind="foreground", cwd=str(work_dir), command=command, description=payload.get("description"),
        exitCode=None if sig else rc, signal=sig, timedOut=timed_out, timeoutMs=timeout_ms,
        **streams,
    )


def _skipped_dirs(target: Path, pattern: str) -> set[str]:
    named = set(target.parts) | set(Path(pattern).parts)
    return {".git"} | (_IGNORED_DIRS - named)


def _path_matches(path: Path, pattern: str) -> bool:
    if "/" not in pattern:
        return fnmatch.fnmatchcase(path.name, pattern)
    if pattern.startswith("/"):
        return False
    names, parts = path.parts, Path(pattern).parts

    def match(i: int, j: int) -> bool:
        if j == len(parts):
            return i == len(names)
        if parts[j] == "**":
            return any(match(k, j + 1) for k in range(i, len(names) + 1))
        return i < len(names) and fnmatch.fnmatchcase(names[i], parts[j]) and match(i + 1, j + 1)

    return match(0, 0)


def _walk_files(root: Path, skipped: set[str], errors: list[dict], *, normal_fallback: bool = False):
    def record(exc: OSError) -> None:
        errors.append({"path": exc.filename or str(root), "error": str(exc)})

    for directory, subdirs, names in os.walk(root, onerror=record):
        if normal_fallback and (_GREP_IGNORE_MARKERS.intersection(names) or ".git" in subdirs):
            raise ToolCallError("grep", _GREP_NEEDS_RG)
        subdirs[:] = sorted(d for d in subdirs if d not in skipped and not (normal_fallback and d.startswith(".")))
        for name in sorted(names):
            if not (normal_fallback and name.startswith(".")):
                yield Path(directory) / name


async def _glob_impl(payload: dict[str, Any]) -> _GlobResult:
    pattern = payload.get("pattern")
    if not isinstance(pattern, str) or not pattern.strip():
        raise ToolCallError("glob", "pattern must be a non-empty string")
    root = _resolve_path(payload.get("path") if payload.get("path") is not None else ".", "glob", absolute=False)
    if not root.is_dir():
        raise ToolCallError("glob", f"path is not a directory: {root}")
    limit = payload.get("limit", 1000)
    if type(limit) is not int or limit < 1:
        raise ToolCallError("glob", "limit must be a positive integer")

    def _scan() -> _GlobResult:
        matches = []
        errors = []
        for path in _walk_files(root, _skipped_dirs(root, pattern), errors):
            if not _path_matches(path.relative_to(root), pattern):
                continue
            try:
                info = path.stat()
            except OSError as exc:
                errors.append({"path": str(path), "error": str(exc)})
                continue
            if stat.S_ISREG(info.st_mode):
                matches.append((-info.st_mtime_ns, str(path)))
        matches.sort()
        return _GlobResult(root=str(root.absolute()), searchPath=str(root), pattern=pattern,
                           paths=[p for _, p in matches[:limit]], total=len(matches),
                           truncated=len(matches) > limit, unreadable=_wrap_nested(errors))

    return await asyncio.to_thread(_scan)


def _rg_text(field: dict, *, path: bool = False) -> str:
    if "text" in field:
        return field["text"]
    raw = base64.b64decode(field["bytes"])
    return os.fsdecode(raw) if path else raw.decode("utf-8", errors="replace")


@asynccontextmanager
async def _rg_output(command: list[str], errors: list[dict]):
    # Stderr must drain even when stdout is capped or the caller stops reading file names.
    with tempfile.TemporaryFile() as diagnostics:
        try:
            proc = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE,
                                                        stderr=diagnostics, limit=_GREP_MAX_BYTES)
        except (OSError, ValueError) as exc:
            raise ToolCallError("grep", f"Cannot start ripgrep: {exc}") from None
        try:
            yield proc.stdout
        finally:
            stopped_early = not proc.stdout.at_eof()
            if stopped_early and proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            await proc.communicate()
        diagnostics.seek(0)
        message = diagnostics.read().decode("utf-8", errors="replace").strip()
    for line in message.splitlines():
        error = re.fullmatch(r"rg: (.+?): (.+\(os error \d+\).*)", line)
        if not error:
            raise ToolCallError("grep", message)
        errors.append({"path": error[1], "error": error[2]})
    if not stopped_early and proc.returncode not in (0, 1) and not message:
        raise ToolCallError("grep", f"ripgrep exited with status {proc.returncode}")


async def _matching_file_batches(names: asyncio.StreamReader, root: Path, include: str):
    batch = []
    size = 0
    while True:
        try:
            entry = await names.readuntil(b"\0")
        except asyncio.IncompleteReadError as exc:
            if exc.partial:
                raise ToolCallError("grep", "ripgrep returned an incomplete file name") from exc
            # rg still validates the regex when there are no eligible files.
            yield batch or [os.devnull]
            return
        path = os.fsdecode(entry[:-1])
        if not _path_matches(Path(path).relative_to(root), include):
            continue
        if batch and size + len(entry) > 32 * 1024:
            yield batch
            batch = []
            size = 0
        batch.append("./-" if path == "-" else path)
        size += len(entry)


async def _grep_impl(payload: dict[str, Any]) -> _GrepResult:
    pattern = payload.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        raise ToolCallError("grep", "pattern must be a non-empty string")
    target = _resolve_path(payload.get("path") if payload.get("path") is not None else ".", "grep", absolute=False)
    include = payload.get("include")
    if include is not None and (not isinstance(include, str) or not include):
        raise ToolCallError("grep", "include must be a non-empty glob string")
    scope = payload.get("scope", "normal")
    if scope not in ("normal", "all"):
        raise ToolCallError("grep", "scope must be 'normal' or 'all'")
    case_sensitive = payload.get("case_sensitive", True)
    fixed = payload.get("fixed_strings", False)
    if type(case_sensitive) is not bool or type(fixed) is not bool:
        raise ToolCallError("grep", "case_sensitive and fixed_strings must be bools")
    limit = payload.get("limit", _GREP_SHOW)
    if type(limit) is not int or limit < 1:
        raise ToolCallError("grep", "limit must be a positive integer")
    is_directory = target.is_dir()
    skipped = _skipped_dirs(target, include or "")
    errors: list[dict] = []
    matches: list[dict] = []

    def add(path: str, number: int, text: str) -> bool:
        if len(matches) == limit:
            return False
        matches.append({"path": path, "lineNumber": number, "line": text})
        return True

    def python_search() -> bool:
        try:
            rx = re.compile(re.escape(pattern) if fixed else pattern, 0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            raise ToolCallError("grep", f"Invalid regex: {exc}") from None
        normal = scope == "normal" and is_directory
        if normal and any((parent / marker).exists() for parent in target.resolve().parents
                          for marker in _GREP_IGNORE_MARKERS):
            raise ToolCallError("grep", _GREP_NEEDS_RG)
        files = _walk_files(target, skipped, errors, normal_fallback=normal) if is_directory else [target]
        retained_bytes = 0
        for path in files:
            if is_directory:
                if path.is_symlink() or (include and not _path_matches(path.relative_to(target), include)):
                    continue
            try:
                if not stat.S_ISREG(path.stat().st_mode):
                    continue
                with path.open("rb") as source:
                    if b"\x00" in source.read(4096):
                        continue
                    source.seek(0)
                    for number, raw in enumerate(source, 1):
                        line = raw.removesuffix(b"\n").removesuffix(b"\r").decode("utf-8", errors="replace")
                        if rx.search(line):
                            retained_bytes += len(raw) + len(os.fsencode(path))
                            if retained_bytes > _GREP_MAX_BYTES or not add(str(path), number, line):
                                return True
            except OSError as exc:
                errors.append({"path": str(path), "error": str(exc)})
        return False

    rg = shutil.which("rg")
    if not rg:
        capped = await asyncio.to_thread(python_search)
    else:
        traversal = [rg, "--no-config"]
        if scope == "all":
            traversal.extend(["--hidden", "--no-ignore"])
        for directory in sorted(skipped):
            traversal.extend(["--glob", f"!**/{directory}"])
        search = ["--json", "--max-count", str(limit + 1)]
        if not case_sensitive:
            search.append("--ignore-case")
        if fixed:
            search.append("--fixed-strings")
        search.extend(["--", pattern])
        size = 0

        async def search_paths(command: list[str], *, check_binary: bool = False) -> bool:
            nonlocal size
            pending = defaultdict(list)
            async with _rg_output(command, errors) as output:
                while True:
                    try:
                        raw = await output.readline()
                    except ValueError:  # A single event exceeded the stream limit.
                        return True
                    if not raw:
                        return False
                    size += len(raw)
                    if size > _GREP_MAX_BYTES:
                        return True
                    event = json.loads(raw)
                    data = event["data"]
                    if event["type"] == "match":
                        path = str(Path(_rg_text(data["path"], path=True)))
                        line = _rg_text(data["lines"]).removesuffix("\n").removesuffix("\r")
                        if check_binary:
                            pending[path].append((data["line_number"], line))
                        elif not add(path, data["line_number"], line):
                            return True
                    elif check_binary and event["type"] == "end":
                        # Explicit paths can emit matches before rg flags the file as binary.
                        path = str(Path(_rg_text(data["path"], path=True)))
                        rows = pending.pop(path, ())
                        if data.get("binary_offset") is None:
                            for number, line in rows:
                                if not add(path, number, line):
                                    return True

        operand = "./-" if str(target) == "-" else str(target)
        if include and is_directory:
            # A positive rg --glob overrides ignore files. Filter the eligible names instead.
            capped = False
            async with _rg_output([*traversal, "--files", "--null", "--", operand], errors) as names:
                async for batch in _matching_file_batches(names, target, include):
                    if await search_paths([rg, "--no-config", *search, *batch], check_binary=True):
                        capped = True
                        break
        else:
            capped = await search_paths([*traversal, *search, operand])
    root = target if is_directory else target.parent
    return _GrepResult(root=str(root.absolute()), searchPath=str(root), matches=_wrap_nested(matches), total=len(matches),
                       outputCapped=capped, scope=scope, unreadable=_wrap_nested(errors), skippedDirectories=sorted(skipped))


_IMPLS = {
    "read": _read_impl,
    "write": _write_impl,
    "edit": _edit_impl,
    "bash": _bash_impl,
    "glob": _glob_impl,
    "grep": _grep_impl,
}


BUILTIN_TOOL_NAMES = frozenset(_IMPLS)


class BuiltinTool:
    """Awaitable top-level helper matching DSH's positional/dict/keyword call contract."""

    __slots__ = ("_name", "__name__", "_doc", "_capture_dir")

    def __init__(self, name: str, doc: str, *, capture_dir: Path | None = None) -> None:
        self._name = name
        self._capture_dir = capture_dir.absolute() if capture_dir is not None else None
        self.__name__ = name
        self._doc = doc

    @property
    def __doc__(self) -> str:
        return self._doc

    def __call__(self, *args: Any, **kwargs: Any):
        payload = _fold_arguments(self._name, args, kwargs)
        if self._name == "bash" and (directory := getattr(self, "_capture_dir", None)) is not None:
            return _bash_impl(payload, capture_dir=directory)
        return _IMPLS[self._name](payload)

    def __repr__(self) -> str:
        return f"<agy repl tool {self._name!r}>"


def create_builtin_tools(*, capture_dir: Path | None = None) -> dict[str, Any]:
    """Build the six shortcuts with an optional session directory for complete Bash streams."""
    return {
        "read": BuiltinTool("read", "await read(path, *, offset=1, limit=2000) -> numbered lines and .text for this page"),
        "write": BuiltinTool("write", "await write(path, content) -> UTF-8 create/update receipt with before and after"),
        "edit": BuiltinTool("edit", "await edit(path, old_string, new_string, *, replace_all=False) "
                                    "or await edit(path, edits=[...]) -> literal changes, checked before writing"),
        "bash": BuiltinTool("bash", "await bash(command, description=None, *, workdir=None, stdin=None, "
                                    "timeoutMs=None, env=None) -> foreground result; a timeout stops the local "
                                    "process group (cwd and timeout_ms are aliases)", capture_dir=capture_dir),
        "glob": BuiltinTool("glob", "await glob(pattern, path=None, *, limit=1000) -> files, newest first; patterns with / "
                                    "start at path (default: cwd), other patterns match basenames"),
        "grep": BuiltinTool("grep", "await grep(pattern, path=None, *, include=None, scope='normal', case_sensitive=True, "
                                    "fixed_strings=False, limit=250) -> matches and search completeness; include filters eligible "
                                    "files by basename or, with /, relative to the search directory"),
        "ToolCallError": ToolCallError,
    }
