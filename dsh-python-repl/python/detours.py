"""Notice a cell that reached a library through a second interpreter.

The pattern this answers (2026-09-29, 29 cells in one session): a library was
missing from the kernel, so the model ran `bash("uv run --with pymupdf python -")`
with the script on stdin. Each such cell cold-starts another Python, re-opens
the same file, and throws away everything it computed — the opposite of what
a persistent kernel is for. `repl.install` removes the reason; this makes the
detour visible the moment it happens, once per kind per kernel.

Only text that actually reaches a `bash` call counts: string literals in its
arguments, plus string values assigned in the same cell to names those
arguments use. Text passed to `edit`/`write` (documentation that merely
mentions `uv run`) is never inspected. Running anything in a project's own
environment (`uv run python …`, a project interpreter, its tests or scripts)
is the right place for project code, as Prime's usage rules say, and is not
matched; only pulling a library in ad hoc is.
"""

from __future__ import annotations

import ast
import re
import sys

#: An interpreter fed code written in this cell: `-c '…'`, or `-` with the
#: script on stdin. `python -m unittest`, `python script.py` and a project
#: interpreter given by path are ordinary shell work and do not match.
_START = r"(?:^|[;&|(\n`'\"]|\blc\s+['\"]?|\bexec\s+)\s*"
_INLINE = r"\s+(?:-[IEsBu]+\s+)*(?:-c\b|-(?=\s|$|['\"]))"
_UV_INLINE = re.compile(_START + r"uv\s+run\b[^\n;|&]*?\bpython(?:3(?:\.\d+)?)?" + _INLINE, re.M)
#: `uv run --with pkg …`: a library pulled in for this one run.
_UV_WITH = re.compile(r"--with[\s=]+['\"]?([A-Za-z0-9_.\-\[\]]+)")
_BARE_INLINE = re.compile(_START + r"python(?:3(?:\.\d+)?)?" + _INLINE, re.M)
_IMPORT = re.compile(r"(?:^|[;'\"])\s*(?:import|from)\s+([A-Za-z_]\w*)", re.M)

#: Reported once per kernel: a reminder is worth one line, not a nag.
_REPORTED: set[str] = set()


def _is_bash(func: ast.expr) -> bool:
    if isinstance(func, ast.Name):
        return func.id == "bash"
    return isinstance(func, ast.Attribute) and func.attr == "bash"


def _strings(node: ast.AST) -> list[str]:
    out: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            out.append(child.value)
        elif isinstance(child, ast.JoinedStr):
            out.append("".join(v.value for v in child.values if isinstance(v, ast.Constant) and isinstance(v.value, str)))
    return out


def _bash_texts(tree: ast.AST) -> list[str]:
    """Strings that reach a bash call in this cell."""
    assigned: dict[str, list[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assigned.setdefault(target.id, []).extend(_strings(node.value))
    texts: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_bash(node.func):
            for arg in [*node.args, *(k.value for k in node.keywords)]:
                texts.extend(_strings(arg))
                for name in ast.walk(arg):
                    if isinstance(name, ast.Name):
                        texts.extend(assigned.get(name.id, []))
    return texts


def _third_party(texts: list[str]) -> list[str]:
    """Top-level modules imported by inline code that the stdlib does not provide."""
    names = {m for t in texts for m in _IMPORT.findall(t)}
    return sorted(n for n in names if n not in sys.stdlib_module_names and n != "__future__" and not _local(n))


def _local(name: str) -> bool:
    """A module this kernel already imports from a project directory, not an installed package.

    `find_spec` on a top-level name locates it without executing it. A cell
    that pipes code importing the bridge or a skill's own source into another
    interpreter is testing that code in isolation, and `repl.install` is not
    the answer for it.
    """
    import importlib.util

    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return False
    origin = getattr(spec, "origin", None) if spec is not None else None
    return origin is not None and "site-packages" not in origin and "/packages/" not in origin


def _python_detour(tree: ast.AST) -> list[str]:
    """The ad hoc library notice for a parsed cell, once per kernel."""
    if "detour" in _REPORTED:
        return []
    texts = _bash_texts(tree)
    if not texts:
        return []
    # `uv run python -c …` without `--with` runs in the project's own
    # environment, which is where project code belongs.
    libraries = sorted({m for t in texts if _UV_INLINE.search(t) for m in _UV_WITH.findall(t)})
    if not libraries and any(_BARE_INLINE.search(t) for t in texts):
        libraries = _third_party(texts)
    if not libraries:
        return []
    _REPORTED.add("detour")
    return [
        f"This cell pulled in {', '.join(libraries)} through a separate Python in bash. If you need it for your own "
        "analysis, nothing that process builds stays in this kernel: install it here with "
        f"`await repl.install(\"{libraries[0]}\")` and import it in the same cell (the import name can differ, "
        "e.g. fitz/pymupdf). A project's own code, tests and scripts belong in the project's environment "
        "(`uv run …`, its `.venv`), not in this kernel."
    ]


# ── Shell habits that throw away what the cell already has ────────────────────
#
# Session analysis 2026-10-08: Claude cut 30% and DeepSeek 61% of their bash
# output with `| head`/`| tail`, and source files were read with `cat`. A prompt
# rule alone changed little, so the cell that does it gets one line, once per
# kind per kernel. Nothing is blocked. `2>/dev/null` is NOT flagged: 3 of 40
# sampled hits only probed whether something exists, where dropping stderr is right.
# Calibrated against 297 real sessions to avoid warning on ordinary library usage.

#: Command text inside `$(...)` or backticks computes a value (`f=$(ls -t | head -1)`);
#: cutting it is not hiding output from the model.
_SUBST = re.compile(r"\$\([^()]*\)|`[^`]*`")
#: Output cut by a pipe stage; `tail -f`/`-F` follows a file and is something else.
_HEAD_TAIL = re.compile(r"\|\s*(?:head|tail)\b(?![^|;&\n]*\s-[a-zA-Z]*[fF]\b)")
#: `cat` of source/config files as a whole command (not piped into a tool: `cat a.json | jq` is processing).
_SOURCE = r"(?:py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|ya?ml|toml|sh|bash|zsh|fish|go|rs|java|kt|swift|c|h|cc|cpp|hpp|rb|php|css|scss|html|vue|sql|ini|cfg|conf|xml|patch)"
_CAT = re.compile(
    r"(?:^|[;&\n(]\s*|&&\s*|\|\|\s*|\bthen\s+|\bdo\s+)cat\s+(?:-[a-zA-Z]+\s+)*"
    r"(?:[\"']?[^\s|;&<>$`()\"']+\." + _SOURCE + r"[\"']?[ \t]*)+"
    r"(?=$|[;&\n)]|\|\s*(?:head|tail|sed\s+-n)\b)",
    re.M,
)
#: The command runs on another machine or in a container: `read` cannot reach those files.
_REMOTE = re.compile(r"\b(?:ssh|remote-host|scp|docker\s+exec|kubectl\s+exec|podman\s+exec|adb\s+shell)\b")

_CORE = "The bash result in a cell is already a Python string you can slice; read files with `read`."
SHELL_NOTES = {
    "head_tail": (
        "This cell cut bash output with `| head`/`| tail`. " + _CORE + " Keep the output whole and slice it in "
        "Python (`r[\"stdout\"][\"text\"].splitlines()[:40]`); without the pipe, exitCode is the command's own, "
        "not tail's."
    ),
    "cat": (
        "This cell read a source file with `cat` through bash. " + _CORE + " `read` pages long files, numbers the "
        "lines and counts as reading the file before an edit."
    ),
}


def _command_texts(tree: ast.AST) -> list[str]:
    """Shell text of each bash call: the "command" value of a dict literal, else what the argument names.

    Only the command is inspected: "description" prose and "stdin" payloads
    (a script fed to another program) are not shell the cell runs.
    """
    assigned: dict[str, list[ast.expr]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assigned.setdefault(target.id, []).append(node.value)

    def from_expr(expr: ast.expr, depth: int = 0) -> list[str]:
        if isinstance(expr, ast.Dict):
            out: list[str] = []
            for key, value in zip(expr.keys, expr.values):
                if isinstance(key, ast.Constant) and key.value == "command" and value is not None:
                    out += from_value(value, depth)
            return out
        if isinstance(expr, ast.Name) and depth < 3:
            return [t for value in assigned.get(expr.id, []) for t in from_expr(value, depth + 1)]
        return []

    def from_value(value: ast.expr, depth: int) -> list[str]:
        out = _strings(value)
        for name in ast.walk(value):
            if isinstance(name, ast.Name) and depth < 3:
                out += [t for v in assigned.get(name.id, []) for t in _strings(v)]
        return out

    texts: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_bash(node.func) and node.args:
            texts += from_expr(node.args[0])
    return texts


def shell_kinds(command: str) -> set[str]:
    """Which shell habits one command text shows."""
    kinds: set[str] = set()
    outer = command
    for _ in range(4):
        reduced = _SUBST.sub(" ", outer)
        if reduced == outer:
            break
        outer = reduced
    if _HEAD_TAIL.search(outer):
        kinds.add("head_tail")
    if not _REMOTE.search(command) and "<<" not in command and _CAT.search(outer):
        kinds.add("cat")
    return kinds


def _shell_habits(tree: ast.AST) -> list[str]:
    seen: set[str] = set()
    for text in _command_texts(tree):
        seen |= shell_kinds(text)
    notes = []
    for kind in ("head_tail", "cat"):
        if kind in seen and kind not in _REPORTED:
            _REPORTED.add(kind)
            notes.append(SHELL_NOTES[kind])
    return notes


_SUBPROCESS_CALLS = {"Popen", "run", "call", "check_call", "check_output"}
SUBPROCESS_NOTE = "subprocess in a cell: use `bash`/`bash.start` instead; DSH runs commands one at a time, and a detached process is yours to stop."


SLEEP_POLL_NOTE = (
    "This cell polls in a loop with sleep. While a cell runs the user cannot reach you and you cannot do other work: "
    "end the turn instead. DSH wakes you when a background job or subagent finishes."
)
#: A subagent's jobs die with its turn and send no notice (src/subagent.ts): waiting is right, sleeping is not.
SUBAGENT_SLEEP_POLL_NOTE = (
    "This cell polls in a loop with sleep. You are a subagent, so waiting in a cell is right (ending your turn kills your jobs with no notice), "
    "but wait on the job itself instead of sleeping between checks: `await r` on a bash handle, `await job` on repl.background work, "
    "or tools.job_output with wait=True each return as soon as it ends."
)


def _sleep_poll(tree: ast.AST) -> list[str]:
    """A loop that sleeps between checks: 569 cells on real sessions (2026-11-03), 12+ hours of waiting."""
    for loop in ast.walk(tree):
        if not isinstance(loop, (ast.For, ast.AsyncFor, ast.While)):
            continue
        for node in ast.walk(loop):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
                if name == "sleep":
                    kernel = sys.modules.get("dsh_kernel")
                    return [SUBAGENT_SLEEP_POLL_NOTE if getattr(kernel, "_SUBAGENT", False) else SLEEP_POLL_NOTE]
    return []


def _usage(tree: ast.AST) -> list[str]:
    """subprocess calls only, judged on the syntax tree: text that merely mentions
    subprocess inside a string (a script handed to bash) is not this cell doing it.
    Writing files with open()/write_text gets no note: the user does not mind how
    files are written (2026-11-05)."""
    modules = {"subprocess": {"subprocess"}, "os": {"os"}}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in modules:
                    modules[alias.name].add(alias.asname or alias.name)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id in modules["subprocess"] and func.attr in _SUBPROCESS_CALLS:
                return [SUBPROCESS_NOTE]
            if func.value.id in modules["os"] and func.attr == "system":
                return [SUBPROCESS_NOTE]
    return []


def observe(code: str) -> list[str]:
    """Advice lines for a successful cell's code; empty when nothing new was seen."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    return _python_detour(tree) + _shell_habits(tree) + _usage(tree) + _sleep_poll(tree)
