"""remote-host stats: what gets run over and over, read from the local usage log."""

import json
import time
from collections import Counter

from .core import log_file


def cmd_stats(args):
    """Show what gets run over and over, so it can become a subcommand."""
    cutoff = time.time() - args.days * 86400
    rows = []
    try:
        for line in log_file().read_text(errors="replace").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("ts", 0) >= cutoff:
                rows.append(r)
    except OSError:
        pass
    if not rows:
        print(f"remote-host: no usage recorded in the last {args.days} days")
        return 0

    total_ms = sum(r.get("ms", 0) for r in rows)
    print(f"{len(rows)} calls over {args.days} days, {total_ms / 1000:.0f}s in ssh")
    by_cmd = Counter(r["cmd"] for r in rows)
    print("  " + "  ".join(f"{c} {n}" for c, n in by_cmd.most_common()))

    shaped = [r for r in rows if r["cmd"] in ("run", "send") and r.get("sig", "-") != "-"]
    if shaped:
        agg = {}
        for r in shaped:
            a = agg.setdefault(r["sig"], {"n": 0, "ms": 0, "eg": r.get("head", "")})
            a["n"] += 1
            a["ms"] += r.get("ms", 0)
        print(f"\nshapes that recur ({args.threshold}+ marks a candidate):")
        print(f"  {'':2} {'n':>4} {'time':>7}  shape / example")
        for sig, a in sorted(agg.items(), key=lambda kv: -kv[1]["n"])[: args.top]:
            flag = "->" if a["n"] >= args.threshold else "  "
            print(f"  {flag} {a['n']:>4} {a['ms'] / 1000:>6.0f}s  {sig}")
            print(f"        {'':>11}  e.g. {a['eg'][:90]}")

    dupes = Counter(r["hash"] for r in shaped if r.get("hash"))
    repeats = [(h, n) for h, n in dupes.most_common(args.top) if n > 1]
    if repeats:
        head = {r["hash"]: r.get("head", "") for r in shaped}
        print("\nbyte-identical payloads (pure repetition):")
        for h, n in repeats:
            print(f"  {n:>4}x  {head.get(h, '')[:90]}")
    return 0
