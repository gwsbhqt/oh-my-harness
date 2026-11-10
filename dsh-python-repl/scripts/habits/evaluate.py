"""Measure note policies against the labels.

    python3 scripts/habits/evaluate.py grid              # search; sampled precision, 5-fold over sessions
    python3 scripts/habits/evaluate.py sens              # one knob at a time around habits.Policy()
    python3 scripts/habits/evaluate.py exact [POLICY..]  # exact precision (needs census labels), default Policy()
    python3 scripts/habits/evaluate.py replay            # the real Tracker over the corpus: note rate per source

POLICY is `min_size,big_size,small_occurrence,require_logic,max_literal`, e.g. 20,50,3,1,0.7.

Numbers:
  note rate  = cells that get a note / successful kernel cells
  precision  = share of "make a function" notes labeled right (1 - false positives)
  recall     = weighted share of worth-wrapping repeats that a note covered (1 - misses)
Sampled precision (grid/sens) comes from stratified labels only and is noisy
when a policy notes few sampled shapes; decide on `exact`.
"""

import ast
import collections
import itertools
import json
import math
import multiprocessing as mp
import pickle
import statistics
import sys
from dataclasses import replace

from common import OUT, define, fold, kernel_sessions, load_labels, policy_of, static_keep
import habits
import simulate
from label import stratum

K = 5
CELLS = LABELS = WEIGHTS = SHAPES = None


def load():
    global CELLS, LABELS, WEIGHTS, SHAPES
    CELLS = pickle.load(open(OUT / "cells.pkl", "rb"))
    LABELS = load_labels()
    SHAPES = {(s["session"], s["key"]): s for s in map(json.loads, open(OUT / "shapes.jsonl"))}
    # Stratified labels stand for their stratum: weight = stratum size / labeled in it.
    size, got = collections.Counter(), collections.Counter()
    for k, s in SHAPES.items():
        if not s.get("rep_of"):
            size[stratum(s)] += 1
            if LABELS.get(k, {}).get("kind") == "stratified":
                got[stratum(s)] += 1
    WEIGHTS = {k: size[stratum(SHAPES[k])] / got[stratum(SHAPES[k])]
               for k, v in LABELS.items() if v["kind"] == "stratified" and k in SHAPES and got[stratum(SHAPES[k])]}


def n_cells():
    return sum(len(r) for r in CELLS.values())


def sampled(result, part=None):
    tp_p = fw = tp_r = pos = 0.0
    for k, w in WEIGHTS.items():
        if part is not None and fold(k[0], K) != part:
            continue
        yes = LABELS[k]["yes"]
        if k in result["function"]:
            fw += w
            tp_p += w * yes
        if yes:
            pos += w
            tp_r += w * (k in result["covered"])
    return (tp_p / fw if fw else 0.0), (tp_r / pos if pos else 0.0)


def fbeta(p, r, b=0.5):
    return (1 + b * b) * p * r / (b * b * p + r) if p > 0 and r > 0 else 0.0


def wilson(k, n, z=1.96):
    if not n:
        return float("nan"), float("nan")
    p, d = k / n, 1 + z * z / n
    c, r = p + z * z / (2 * n), z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - r) / d, (c + r) / d


GRID = [habits.Policy(min_size=a, big_size=b, small_occurrence=c, require_logic=d, max_literal=e)
        for a, b, c, d, e in itertools.product([6, 8, 10, 12, 14, 16, 18, 20, 24, 28], [20, 25, 30, 35, 40, 50, 60, 80, 10**9],
                                               [2, 3, 4], [True, False], [0.3, 0.4, 0.5, 0.6, 0.7, 1.01])]


def _grid_one(policy):
    r = simulate.run(CELLS, policy)
    return policy, r["cells"] / n_cells(), [sampled(r, f) for f in range(K)], sampled(r)


def show(p):
    return f"{p.min_size},{p.big_size if p.big_size < 10**9 else 'never'},{p.small_occurrence},{int(p.require_logic)},{p.max_literal}"


def cmd_grid():
    with mp.Pool(8, initializer=load) as pool:
        res = pool.map(_grid_one, GRID, chunksize=20)
    res.sort(key=lambda r: -statistics.mean(fbeta(*x) for x in r[2]))
    print("policy                note%   P(mean±sd)   R(mean±sd)   F0.5   — sampled; confirm with `exact`")
    for pol, rate, folds, _ in res[:15]:
        ps, rs = [p for p, _ in folds], [r for _, r in folds]
        print(f"{show(pol):20} {100*rate:5.2f}%  {statistics.mean(ps):.2f}±{statistics.pstdev(ps):.2f}  "
              f"{statistics.mean(rs):.2f}±{statistics.pstdev(rs):.2f}  {statistics.mean(fbeta(*x) for x in folds):.3f}")


def cmd_sens():
    base = habits.Policy()
    knobs = {"min_size": [6, 10, 14, 16, 18, 20, 24, 28], "big_size": [20, 30, 40, 50, 60, 80, 10**9],
             "small_occurrence": [2, 3, 4], "require_logic": [True, False], "max_literal": [0.3, 0.5, 0.6, 0.7, 1.01]}
    for knob, values in knobs.items():
        print(f"--- {knob}")
        for v in values:
            r = simulate.run(CELLS, replace(base, **{knob: v}))
            p, rc = sampled(r)
            mark = "  <= current" if getattr(base, knob) == v else ""
            print(f"   {str(v):>10}: notes {100*r['cells']/n_cells():4.1f}%  false+ {100*(1-p):3.0f}%  missed {100*(1-rc):3.0f}%{mark}")


def cmd_exact(texts):
    policies = [policy_of(t) for t in texts] or [habits.Policy()]
    for pol in policies:
        r = simulate.run(CELLS, pol)
        labeled = [LABELS[k] for k in r["function"] if k in LABELS and LABELS[k]["note"] == "function"]
        got = [v["yes"] for v in labeled]
        by_jev = sum(v.get("jev", False) for v in labeled)
        k, n = sum(got), len(got)
        lo, hi = wilson(k, n)
        _, rc = sampled(r)
        print(f"{show(pol):20} notes {100*r['cells']/n_cells():.2f}%  function notes {len(r['function'])} "
              f"(labeled {n}, {by_jev} by Jev) precision {k/max(1,n):.2f} [{lo:.2f}-{hi:.2f}]  recall {rc:.2f}  edit notes {len(r['edit'])}"
              + ("" if n == len(r["function"]) else "   ← not all notes labeled: run label.py census"))
    edits = [v["yes"] for v in LABELS.values() if v["note"] == "edit"]
    if edits:
        lo, hi = wilson(sum(edits), len(edits))
        print(f"edit-tool advice right: {sum(edits)}/{len(edits)} = {sum(edits)/len(edits):.2f} [{lo:.2f}-{hi:.2f}]")


def cmd_replay():
    total, noted = collections.Counter(), collections.Counter()
    for sess, rs in kernel_sessions().items():
        tracker, defined, src = habits.Tracker(), set(), sess.split(":")[0]
        for r in rs:
            tree = habits.parse(r["code"])
            if tree is None:
                continue
            total[src] += 1
            if tracker.observe(r["code"], {n: len for n in static_keep(tree, defined)}):
                noted[src] += 1
            define(tree, defined)
    for src in total:
        print(f"{src:7} {noted[src]:5}/{total[src]:<6} {100*noted[src]/total[src]:.2f}%")
    t = sum(total.values())
    print(f"all     {sum(noted.values()):5}/{t:<6} {100*sum(noted.values())/t:.2f}%   (simulate: "
          f"{100*simulate.run(CELLS, habits.Policy())['cells']/n_cells():.2f}%)")


if __name__ == "__main__":
    load()
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"grid": cmd_grid, "sens": cmd_sens, "replay": cmd_replay}.get(cmd, lambda: None)() if cmd != "exact" else cmd_exact(sys.argv[2:])
    if cmd not in ("grid", "sens", "replay", "exact"):
        sys.exit(__doc__)
