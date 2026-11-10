"""Write labeling batches (then have labelers follow rubric.md).

    python3 scripts/habits/label.py stratified 400        # recall frame: random shapes per stratum
    python3 scripts/habits/label.py census 20,50,3,1,0.7  # every "make a function" note of these policies
    python3 scripts/habits/label.py edit 100              # hand-edit notes (edit-tool advice)

Add --jev to pre-label with Jev (jev.py): confident items are labeled
directly, only the rest plus a 10% audit sample are written for labelers.

Shapes already labeled are skipped. Each call writes batches/<name>-<i>.md
(~100 items each) and batches/<name>.meta.json; labelers write
batches/<name>-<i>.labels.jsonl next to them.
"""

import json
import pickle
import random
import sys
import time

import simulate
from common import BATCHES, OUT, load_labels, policy_of

CHUNK = 100


def stratum(s):
    size = s["size"]
    band = "a" if size < 14 else "b" if size < 22 else "c" if size < 30 else "d" if size < 50 else "e"
    reps = "2" if s["total"] == 2 else "3" if s["total"] <= 4 else "5"
    return band, s["logic"], s["literal"] > 0.5, reps


def clip(text, n=1400):
    text = text or ""
    return text if len(text) <= n else text[:n] + "\n…(truncated)"


def write(name, kind, note, picked, use_jev=False, rng=None):
    BATCHES.mkdir(parents=True, exist_ok=True)
    items = [{"id": f"{name}-{i:04d}", "session": s["session"], "key": s["key"]} for i, s in enumerate(picked)]
    json.dump({"kind": kind, "note": note, "items": items}, open(BATCHES / f"{name}.meta.json", "w"))
    if use_jev and picked:
        import jev

        scores = jev.score(note, picked)
        auto, review = jev.triage(items, scores, rng)
        with open(BATCHES / f"{name}-jev.labels.jsonl", "w") as f:
            f.writelines(json.dumps(a) + "\n" for a in auto)
        tokens = sum(s.get("tokens", 0) for s in scores)
        failed = sum("error" in s for s in scores)
        print(f"jev: {len(auto)} labeled directly, {len(review)} to review ({failed} unscored); "
              f"{tokens} input tokens ≈ ${tokens * 0.042 / 1e6:.4f}")
        keep = set(review)
        pairs = [(i, s) for i, s in zip(items, picked) if i["id"] in keep]
        items, picked = [i for i, _ in pairs], [s for _, s in pairs]
    for c in range(0, len(picked), CHUNK):
        path = BATCHES / f"{name}-{c // CHUNK}.md"
        with open(path, "w") as f:
            for item, s in zip(items[c:c + CHUNK], picked[c:c + CHUNK]):
                f.write(f"### {item['id']}  (this shape ran {s['total']} times in the session)\n"
                        f"--- first occurrence ---\n{clip(s['first'])}\n--- second occurrence ---\n{clip(s['second'])}\n\n")
        print(f"{path}  →  labels: {str(path)[:-3]}.labels.jsonl")
    print(f"{len(picked)} items; give each labeler the '{note}' section of scripts/habits/rubric.md")


def main():
    use_jev = "--jev" in sys.argv
    argv = [a for a in sys.argv if a != "--jev"]
    if len(argv) < 3:
        sys.exit(__doc__)
    mode, arg = argv[1], argv[2:]
    shapes = {(s["session"], s["key"]): s for s in map(json.loads, open(OUT / "shapes.jsonl"))}
    done = load_labels()
    stamp = time.strftime("%Y%m%d-%H%M")
    rng = random.Random(int(time.time()))
    if mode == "stratified":
        n = int(arg[0])
        pool = [s for k, s in shapes.items() if not s.get("rep_of") and k not in done]
        groups = {}
        for s in pool:
            groups.setdefault(stratum(s), []).append(s)
        picked = []
        for g in groups.values():
            picked += rng.sample(g, min(len(g), max(3, round(n * len(g) / len(pool)))))
        rng.shuffle(picked)
        write(f"stratified-{stamp}", "stratified", "function", picked, use_jev, rng)
    elif mode == "census":
        cells = pickle.load(open(OUT / "cells.pkl", "rb"))
        wanted = set()
        for text in arg:
            wanted |= simulate.run(cells, policy_of(text))["function"]
        picked = [shapes[k] for k in sorted(wanted) if k not in done and k in shapes]
        write(f"census-{stamp}", "census", "function", picked, use_jev, rng)
    elif mode == "edit":
        pool = [s for k, s in shapes.items() if s["hand_edit"] and not (k in done and done[k]["note"] == "edit")]
        write(f"edit-{stamp}", "census", "edit", rng.sample(pool, min(len(pool), int(arg[0]))), use_jev, rng)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
