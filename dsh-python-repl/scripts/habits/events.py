"""Replay every kernel session through habits.units and record each unit.

    python3 scripts/habits/events.py   → $HABITS_DIR/cells.pkl, shapes.jsonl

cells.pkl  : {session: [[unit dict, ...] per cell]} — the input every policy
             is simulated on. Unit features and occurrence counts do not
             depend on any threshold, so one replay serves the whole grid.
shapes.jsonl: one record per shape repeated within a session, with its first
             two occurrences as source (what a labeler sees), its total count,
             and `rep_of` when it only ever occurs inside a bigger repeated shape.
"""

import collections
import json
import pickle

from common import OUT, define, kernel_sessions, static_keep
import habits


def main():
    cells, shapes = {}, {}
    for sess, rs in kernel_sessions().items():
        defined, seen, rows = set(), collections.Counter(), []
        for idx, r in enumerate(rs):
            tree = habits.parse(r["code"])
            if tree is None:
                continue
            lines = r["code"].splitlines()
            row = []
            for u in habits.units(tree, static_keep(tree, defined)):
                occ = seen[u.key] + 1
                row.append({**u.__dict__, "occ": occ})
                s = shapes.setdefault((sess, u.key), {
                    "session": sess, "key": u.key, "size": u.size, "logic": u.logic, "literal": round(u.literal, 3),
                    "plain": u.plain, "hand_edit": u.hand_edit, "first": "\n".join(lines[u.first - 1:u.last]),
                    "second": None, "spans": []})
                s["spans"].append((idx, u.first, u.last))
                if occ == 2 and s["second"] is None:
                    s["second"] = "\n".join(lines[u.first - 1:u.last])
            for k in {u["key"] for u in row}:
                seen[k] += 1
            define(tree, defined)
            rows.append(row)
        cells[sess] = rows

    repeated = {k: v for k, v in shapes.items() if len(v["spans"]) >= 2 and not v["plain"] and v["size"] >= 6}
    by_sess = collections.defaultdict(list)
    for v in repeated.values():
        by_sess[v["session"]].append(v)
    for items in by_sess.values():
        items.sort(key=lambda v: -v["size"])
        for i, small in enumerate(items):
            inside = {c for c, _, _ in small["spans"]}
            for big in items[:i]:
                spans = {c: (a, b) for c, a, b in big["spans"]}
                if big["size"] > small["size"] and not big.get("rep_of") and inside == set(spans) and all(
                        spans[c][0] <= a and b <= spans[c][1] for c, a, b in small["spans"]):
                    small["rep_of"] = big["key"]
                    break
    with open(OUT / "shapes.jsonl", "w") as f:
        for v in repeated.values():
            v["total"] = len(v.pop("spans"))
            f.write(json.dumps(v, ensure_ascii=False) + "\n")
    pickle.dump(cells, open(OUT / "cells.pkl", "wb"))
    reps = [v for v in repeated.values() if not v.get("rep_of")]
    print(f"{len(cells)} sessions, {sum(len(c) for c in cells.values())} cells, "
          f"{len(repeated)} repeated shapes ({len(reps)} representative)")


if __name__ == "__main__":
    main()
