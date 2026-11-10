"""Shared pieces for calibrating repetition notes against real session data.

Everything that decides a note comes from python/habits.py itself, so what is
measured here is exactly what the kernel runs.
"""

from __future__ import annotations

import ast
import glob
import hashlib
import json
import os
import sys
import warnings
from pathlib import Path

warnings.simplefilter("ignore")  # compile() warnings from other people's code
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "python"))
import habits  # noqa: E402

#: Working data (session code — private, never committed).
OUT = Path(os.environ.get("HABITS_DIR", Path.home() / ".cache" / "dsh-python-repl" / "habits"))
BATCHES = OUT / "batches"

#: Names every kernel binds; offline there is no live namespace to read them from.
BRIDGE = {"bash", "read", "write", "edit", "glob", "grep", "tools", "mcp", "skills", "repl", "print", "len"}


def static_keep(tree: ast.AST, defined: set[str]) -> set[str]:
    """Offline stand-in for the live namespace: names called or imported in the
    cell, functions defined earlier in the session, and the bridge names."""
    keep = set(defined) | BRIDGE
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            keep.add(node.func.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            keep.update((a.asname or a.name).split(".")[0] for a in node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            keep.add(node.name)
    return keep


def define(tree: ast.Module, defined: set[str]) -> None:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)


def kernel_sessions() -> dict[str, list[dict]]:
    """Successful persistent-kernel Python cells, per session, in order."""
    out: dict[str, list[dict]] = {}
    for line in open(OUT / "corpus.jsonl"):
        r = json.loads(line)
        if r["lang"] == "py" and r["kind"] == "cell" and r["ok"] is not False:
            out.setdefault(f'{r["src"]}:{r["session"]}', []).append(r)
    for rs in out.values():
        rs.sort(key=lambda r: r["seq"])
    return out


def fold(session: str, k: int = 5) -> int:
    return int(hashlib.sha1(session.encode()).hexdigest(), 16) % k


def policy_of(text: str) -> habits.Policy:
    """`20,50,3,1,0.7` → Policy(min_size, big_size, small_occurrence, require_logic, max_literal)."""
    a, b, c, d, e = text.split(",")
    return habits.Policy(min_size=int(a), big_size=int(b), small_occurrence=int(c),
                         require_logic=d.strip() in ("1", "true", "True"), max_literal=float(e))


def load_labels() -> dict[tuple[str, str], dict]:
    """(session, key) → {yes, high, kind, weight} from every labeled batch.
    kind "stratified" carries a sampling weight; "census" (every note of some
    policy) does not, and is only used for exact precision."""
    out = {}
    for meta_file in glob.glob(str(BATCHES / "*.meta.json")):
        meta = json.load(open(meta_file))
        prefix = meta_file[: -len(".meta.json")]
        answers = {}
        # A labeler's answer overrides Jev's pre-label for the same item.
        files = sorted(glob.glob(prefix + "-*.labels.jsonl"), key=lambda f: not f.endswith("-jev.labels.jsonl"))
        for f in files:
            for line in open(f):
                if line.strip():
                    d = json.loads(line)
                    answers[d["id"]] = d
        missing = sum(item["id"] not in answers for item in meta["items"])
        if meta["kind"] == "stratified" and missing:
            # A half-labeled stratified batch is not a random sample any more
            # (with --jev, the labeled half is exactly the easy cases).
            print(f"note: {Path(meta_file).name}: {missing} items unlabeled — batch ignored until complete", file=sys.stderr)
            continue
        for item in meta["items"]:
            a = answers.get(item["id"])
            if a is None:
                continue
            out[(item["session"], item["key"])] = {
                "yes": a["label"] == "yes", "high": a.get("confidence") in ("high", "jev"),
                "jev": a.get("confidence") == "jev",
                "kind": meta["kind"], "weight": item.get("weight"), "note": meta.get("note", "function"),
            }
    return out
