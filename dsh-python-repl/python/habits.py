"""Notice when a cell repeats code an earlier cell already ran.

A persistent kernel lets a model define a function once and reuse it. Repeating
the same call-parse-check block with new literals misses that benefit. This
module identifies repeated structure and makes it visible when it happens.

After each SUCCESSFUL cell (a failed cell's retry is not repetition), every
statement and every run of 2-3 consecutive sibling statements is reduced to a
*shape*: literals and f-strings become one placeholder, and variable names
become `_` unless they name a function, class or module (calling your own
helper again IS reuse and stays small). Code inside `def`/`class`/`lambda`
is skipped for the same reason. Occurrences are counted for every shape;
`Policy` then decides which repeat earns a note — at most one per cell and
once per shape. It filters out:

- echo code: a unit must process data (loop, branch, comprehension, slice or
  a parsing/collecting method) — "call a tool, print it" repeats constantly
  and wrapping it saves nothing;
- a unit that is mostly string literal: the literal (an edit's text, a shell
  script) is the substance, not the wrapper;
- a bare tool call with literal arguments, alone or in a run of them;
- small units until their 3rd occurrence.

Pure analysis: it never executes, imports or `repr`s user objects.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import sys
import types
import warnings
from dataclasses import dataclass
from typing import Any

_PLACEHOLDER = "…"

#: Names the kernel already binds, so importing them is pure waste.
_PREBOUND_MODULES = frozenset({"json", "os", "re", "sys", "time", "asyncio"})
_PREBOUND_FROM = frozenset({("pathlib", "Path"), ("collections", "Counter"), ("collections", "defaultdict")})


def _reusable_names(ns: dict[str, Any]) -> set[str]:
    """Names whose repetition is reuse, not copy-paste: callables and modules.

    `callable()` reads a type slot and runs no user code; it also covers the
    bridge proxies (`bash`, `tools.x`), which are callables but not functions.
    """
    return {name for name, value in ns.items() if isinstance(value, types.ModuleType) or callable(value)}


class _Shape(ast.NodeTransformer):
    def __init__(self, keep: set[str]):
        self.keep = keep

    def visit_Constant(self, node: ast.Constant) -> ast.AST:
        return ast.Constant(value=_PLACEHOLDER)

    def visit_JoinedStr(self, node: ast.JoinedStr) -> ast.AST:
        return ast.Constant(value=_PLACEHOLDER)

    def visit_Name(self, node: ast.Name) -> ast.AST:
        return node if node.id in self.keep else ast.Name(id="_", ctx=node.ctx)

    def visit_Dict(self, node: ast.Dict) -> ast.AST:
        # Keys are structure (which fields you pass); values are data.
        keys = [k if isinstance(k, ast.Constant) else (self.visit(k) if k is not None else None) for k in node.keys]
        return ast.Dict(keys=keys, values=[self.visit(v) for v in node.values])


_SKIP = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)


def _size(node: ast.AST) -> int:
    count = 0
    for sub in ast.walk(node):
        if not isinstance(sub, (ast.expr_context, ast.Load, ast.Store, ast.Del)):
            count += 1
    return count


#: The kernel's tool entry points: `bash(...)`, `tools.x(...)`, `skills.x(...)`.
_TOOL_NAMES = frozenset({"bash", "read", "write", "edit", "glob", "grep"})
_TOOL_ROOTS = frozenset({"tools", "skills"})


def _is_tool(func: ast.expr) -> bool:
    if isinstance(func, ast.Name):
        return func.id in _TOOL_NAMES
    while isinstance(func, ast.Attribute):
        func = func.value
    return isinstance(func, ast.Name) and func.id in _TOOL_ROOTS


def _is_plain_tool_call(stmt: ast.stmt, keep: set[str]) -> bool:
    """`[x =] await tool({literal args})` — calling a TOOL with different
    arguments is not a pattern to wrap. Only tool calls: `print(...)` or
    `text.find(...)` are ordinary code and must stay eligible."""
    value = stmt.value if isinstance(stmt, (ast.Expr, ast.Assign, ast.AnnAssign)) else None
    if isinstance(value, ast.Await):
        value = value.value
    if not isinstance(value, ast.Call) or not _is_tool(value.func):
        return False
    leaf = (ast.Constant, ast.JoinedStr, ast.Name, ast.Attribute, ast.Subscript, ast.BinOp)

    def literal(node: ast.AST) -> bool:
        if isinstance(node, ast.Dict):
            return all(literal(v) for v in node.values)
        if isinstance(node, (ast.List, ast.Tuple)):
            return all(literal(e) for e in node.elts)
        return isinstance(node, leaf)

    return all(literal(a) for a in value.args) and all(literal(k.value) for k in value.keywords)


#: Methods whose use means the code is processing data, not just echoing it.
_PROCESSING_METHODS = frozenset({
    "find", "rfind", "index", "split", "rsplit", "splitlines", "partition", "strip", "replace",
    "startswith", "endswith", "count", "join", "loads", "dumps", "match", "search", "findall",
    "sub", "group", "get", "items", "keys", "values", "append", "extend", "sort", "encode", "decode",
})


def _has_logic(stmts: list[ast.stmt]) -> bool:
    """Whether a unit does something with data: a loop, branch, comprehension,
    try, slice, or a parsing/collecting method. Echo-style code ("call a tool,
    print the result") repeats constantly and wrapping it saves nothing; the
    repetition worth a function is the processing around calls. Requiring
    that processing keeps display-only wrappers out of the suggestions.
    """
    display = {id(n) for stmt in stmts for call in ast.walk(stmt) if _is_print(call)
               for arg in [*call.args, *(k.value for k in call.keywords)] for n in ast.walk(arg)}
    for stmt in stmts:
        for node in ast.walk(stmt):
            if id(node) in display:
                # `print(r.stdout[-300:])`, `print(x.strip())`: trimming for
                # display, not processing that benefits from a reusable helper.
                continue
            if isinstance(node, (ast.For, ast.AsyncFor, ast.While, ast.If, ast.IfExp, ast.Try,
                                 ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp, ast.Slice)):
                return True
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in _PROCESSING_METHODS:
                return True
    return False


def _is_print(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print"


_WRITE_ATTRS = frozenset({"write_text", "write"})


def _is_hand_edit(stmts: list[ast.stmt]) -> bool:
    """`t.replace(old, new)` and a file write in one unit: a file edit done by
    hand. Repeated, the right advice is the edit tool's `edits` batch, not a
    new function — and it keeps the host's file policy in the loop."""
    replaces = writes = False
    for stmt in stmts:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                replaces |= node.func.attr == "replace"
                writes |= node.func.attr in _WRITE_ATTRS
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open":
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
                writes |= isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "w" in mode.value
    return replaces and writes


def _literal_share(stmts: list[ast.stmt]) -> float:
    """How much of the unit's source is string literal. When most of it is, the
    literal IS the substance (an edit's old/new text, a shell script) and two
    such units are different work that merely share a wrapper."""
    total = literal = 0
    for stmt in stmts:
        total += len(ast.unparse(stmt))
        for node in ast.walk(stmt):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                literal += len(node.value)
            elif isinstance(node, ast.JoinedStr):
                literal += sum(len(v.value) for v in node.values if isinstance(v, ast.Constant))
    return literal / total if total else 0.0


def _bodies(tree: ast.AST):
    """Every statement list outside function/class bodies."""
    stack = [tree]
    while stack:
        node = stack.pop()
        for field in ("body", "orelse", "finalbody"):
            block = getattr(node, field, None)
            if isinstance(block, list) and block and isinstance(block[0], ast.stmt):
                yield block
                stack.extend(s for s in block if not isinstance(s, _SKIP))
        for handler in getattr(node, "handlers", []) or []:
            yield handler.body
            stack.extend(s for s in handler.body if not isinstance(s, _SKIP))


def _units(tree: ast.AST):
    """(first stmt, last stmt) spans: single statements and 2-3 statement runs."""
    for block in _bodies(tree):
        stmts = [s for s in block if not isinstance(s, _SKIP)]
        for i in range(len(stmts)):
            for n in (1, 2, 3):
                if i + n <= len(stmts):
                    yield stmts[i : i + n]


@dataclass(frozen=True)
class Unit:
    """One statement or run of 2-3 sibling statements, with the features the
    policy decides on. Computed for EVERY unit, whatever the policy, so the
    occurrence count of a shape never depends on the thresholds."""

    key: str
    size: int
    stmts: int
    logic: bool
    literal: float
    plain: bool
    #: A hand-rolled file edit (replace + write): noted with edit-tool advice.
    hand_edit: bool
    first: int
    last: int


@dataclass(frozen=True)
class Policy:
    """When a repeated unit earns a note.

    Each threshold trades false positives against missed repetitions.
    Requiring enough structure and repeated occurrences limits reminders for
    trivial wrappers or deliberate one-off checks. The calibration utilities
    in scripts/habits/ can evaluate a supplied labeled corpus; these defaults
    do not establish an accuracy guarantee for other workloads.

    Tracker._structure_notes also detects redundant imports (including
    pre-bound names) and identical top-level re-definitions. Each fires at
    most once per distinct imported binding or redefined name per kernel.
    These checks use exact bindings or source equality rather than the shape
    heuristic, and do not change its thresholds.
    """

    #: Minimum shaped AST size; small wrappers rarely benefit from extraction.
    min_size: int = 20
    #: At or above this size a unit is noted at its `big_occurrence`, else at
    #: its `small_occurrence`. Larger repeated units are worth surfacing earlier.
    big_size: int = 50
    big_occurrence: int = 2
    #: Smaller units must repeat more often before earning a note.
    small_occurrence: int = 3
    #: Require a loop, branch, comprehension, slice or parsing method.
    require_logic: bool = True
    #: Above this share of string literal, the literal is the substance.
    max_literal: float = 0.7
    #: A hand-rolled file edit is noted from its 2nd occurrence.
    edit_occurrence: int = 2

    def due(self, unit: Unit, occurrence: int) -> bool:
        if unit.hand_edit:
            # The edit text is its substance, so literal share and size say
            # nothing here: the repeated procedure is what to replace.
            return occurrence >= self.edit_occurrence
        if unit.plain or unit.size < self.min_size or unit.literal > self.max_literal:
            return False
        if self.require_logic and not unit.logic:
            return False
        need = self.big_occurrence if unit.size >= self.big_size else self.small_occurrence
        return occurrence >= need


def parse(code: str) -> ast.Module | None:
    try:
        # compile() prints SyntaxWarnings (e.g. "\\$" in a plain string) to
        # stderr, which would land in the cell's output.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return compile(code, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except (SyntaxError, ValueError):
        return None


def units(tree: ast.Module, keep: set[str]) -> list[Unit]:
    shaper = _Shape(keep)
    out = []
    for stmts in _units(tree):
        shaped = [shaper.visit(copy.deepcopy(s)) for s in stmts]
        out.append(Unit(
            key=hashlib.sha1("\n".join(ast.dump(s) for s in shaped).encode()).hexdigest(),
            size=sum(_size(s) for s in shaped),
            stmts=len(stmts),
            logic=_has_logic(stmts),
            literal=_literal_share(stmts),
            plain=all(_is_plain_tool_call(s, keep) for s in stmts),
            hand_edit=_is_hand_edit(stmts),
            first=stmts[0].lineno,
            last=stmts[-1].end_lineno or stmts[-1].lineno,
        ))
    return out


class Tracker:
    """Per-kernel memory of shapes seen in successful cells."""

    def __init__(self, policy: Policy | None = None) -> None:
        self.policy = policy or Policy()
        self.cells = 0
        self.seen: dict[str, int] = {}
        self.noted: set[str] = set()
        self.imports_seen: dict[tuple[str, ...], int] = {}
        self.import_noted: set[tuple[str, ...]] = set()
        self.defs_seen: dict[str, str] = {}
        self.def_noted: set[str] = set()

    def observe(self, code: str, ns: dict[str, Any] | None = None) -> list[str]:
        """Record one successful cell; return at most one note about repetition."""
        tree = parse(code)
        if tree is None:
            return []
        self.cells += 1
        keep = _reusable_names(ns if ns is not None else sys.modules["__main__"].__dict__)
        found = units(tree, keep)
        extra = self._structure_notes(tree)
        note = None
        claimed: list[tuple[int, int]] = []
        for unit in sorted(found, key=lambda u: -u.size):
            occurrence = self.seen.get(unit.key, 0) + 1
            overlaps = any(not (unit.last < a or unit.first > b) for a, b in claimed)
            if note is None and not overlaps and unit.key not in self.noted and self.policy.due(unit, occurrence):
                claimed.append((unit.first, unit.last))
                note = (self._edit_note if unit.hand_edit else self._note)(occurrence, unit.first, unit.last, code)
        if claimed:
            # The noted block's own pieces are the same repetition: without
            # this, each sub-window re-notes it in a later cell (a 4-cell
            # repeat produced 3 notes).
            a, b = claimed[0]
            self.noted.update(u.key for u in found if not (u.last < a or u.first > b))
        for key in {u.key for u in found}:
            self.seen[key] = self.seen.get(key, 0) + 1
        return ([note] if note else []) + extra

    def _structure_notes(self, tree: ast.Module) -> list[str]:
        """Cross-cell redundant imports and identical re-definitions.

        Imports: any import is noted from its second cell on; a pre-bound
        name is still waste when repeated, so it gets the sharper wording. Functions/classes: identical
        code under a name already defined this session is a copy-paste; a
        changed body is a legitimate revision and is never noted.
        """
        prebound: list[str] = []
        repeated: list[str] = []
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    binding = alias.asname or alias.name.split('.')[0]
                    key = ('import', alias.name, binding)
                    pre = alias.name in _PREBOUND_MODULES and alias.asname is None
                    first = key not in self.imports_seen
                    if first:
                        self.imports_seen[key] = node.lineno
                    if (not first) and key not in self.import_noted:
                        self.import_noted.add(key)
                        (prebound if pre else repeated).append(binding)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                for alias in node.names:
                    if alias.name == '*':
                        continue
                    binding = alias.asname or alias.name
                    key = ('from', node.module, alias.name, binding)
                    pre = (node.module, alias.name) in _PREBOUND_FROM and alias.asname is None
                    first = key not in self.imports_seen
                    if first:
                        self.imports_seen[key] = node.lineno
                    if (not first) and key not in self.import_noted:
                        self.import_noted.add(key)
                        (prebound if pre else repeated).append(binding)
        dup_defs: list[str] = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = node.name
                try:
                    body = ast.dump(node, include_attributes=False)
                except Exception:
                    body = name
                fingerprint = hashlib.sha1(body.encode()).hexdigest()
                prev = self.defs_seen.get(name)
                if prev is None:
                    self.defs_seen[name] = fingerprint
                elif prev == fingerprint:
                    if name not in self.def_noted:
                        self.def_noted.add(name)
                        dup_defs.append(name)
                else:
                    self.defs_seen[name] = fingerprint
                    self.def_noted.discard(name)
        notes: list[str] = []
        if prebound or repeated:
            segments = []
            if prebound:
                segments.append(f"{', '.join(prebound)} (already bound in the kernel — no import needed)")
            if repeated:
                segments.append(f"{', '.join(repeated)} (imported earlier this session)")
            notes.append("Redundant import: " + "; ".join(segments) + ". The kernel persists between cells — drop the import and reuse the existing name.")
        if dup_defs:
            joined = ", ".join(f"`{n}`" for n in dup_defs)
            notes.append(f"Redefined {joined}: identical code was defined earlier this session. The kernel keeps it — redefine under the same name, or just call the function, instead of pasting it again.")
        return notes

    @staticmethod
    def _edit_note(occurrence: int, first: int, last: int, code: str) -> str:
        where = f"line {first}" if first == last else f"lines {first}-{last}"
        return (
            f"Hand-rolled file edit: {where} replace text and write the file back — the {_ordinal(occurrence)} "
            'time this session. Use the edit tool instead: `await edit({"file_path": p, "edits": '
            '[{"old_string": a, "new_string": b}, ...]})` makes several changes in one call, each checked '
            "by the host's file policy, and names any change that failed."
        )

    @staticmethod
    def _note(occurrence: int, first: int, last: int, code: str) -> str:
        where = f"line {first}" if first == last else f"lines {first}-{last}"
        head = code.splitlines()[first - 1].strip()
        head = head if len(head) <= 80 else head[:79] + "…"
        return (
            f"Repeated code: {where} (`{head}`) is the {_ordinal(occurrence)} time this session that code of "
            "this shape ran — only the values differed. Make it a function now (it persists in the "
            "kernel) and call it from here on; if a helper you already have almost fits, redefine it "
            "under the same name instead of copying it. `await repl.helpers()` lists your functions."
        )


def _ordinal(n: int) -> str:
    return {2: "2nd", 3: "3rd"}.get(n, f"{n}th")


TRACKER = Tracker()
