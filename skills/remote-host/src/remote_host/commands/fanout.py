"""One call, several hosts: parallel children, per-host sections or a key=value table."""

import subprocess
import sys
import unicodedata

from .core import ENTRY, parse_kv


def reads_stdin(argv):
    """Whether the per-host command takes its payload from stdin."""
    if "run" not in argv:
        return False
    rest = [a for a in argv[argv.index("run") + 1:] if a != "--table"]
    return not rest


def fan_out(argv, hosts, table):
    """Run the same remote-host call on every host at once; sections per host, then a
    summary of exit codes. Each host is a child remote-host, so every flag, pin and
    safety of a single call applies unchanged."""
    import threading

    # The payload is read ONCE here and handed to every child. Only when the
    # call names no command: an agent's stdin is often an open pipe that never
    # closes, and reading it unconditionally hangs forever.
    body = sys.stdin.read() if reads_stdin(argv) else ""
    results = [None] * len(hosts)

    def one(i, h):
        child = [sys.executable, str(ENTRY), "-H", h, *argv]
        results[i] = subprocess.run(child, input=body.encode(), capture_output=True)

    threads = [threading.Thread(target=one, args=(i, h)) for i, h in enumerate(hosts)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    labels = unique_labels(hosts)
    if table:
        outputs = [r.stdout.decode(errors="replace") for r in results]
        rendered = render_table(outputs, labels)
        if rendered is None:
            print("remote-host: a table value is too long; showing complete output by host", file=sys.stderr)
            for label, r, out in zip(labels, results, outputs):
                print(f"══ {label} · exit {r.returncode} ══")
                if out:
                    print(out.rstrip("\n"))
        else:
            print(rendered)
        for label, r in zip(labels, results):
            err = r.stderr.decode(errors="replace").strip()
            if err:
                print(f"[{label}] {err}", file=sys.stderr)
    else:
        for label, r in zip(labels, results):
            print(f"══ {label} · exit {r.returncode} ══")
            out = r.stdout.decode(errors="replace").rstrip("\n")
            if out:
                print(out)
            err = r.stderr.decode(errors="replace").rstrip("\n")
            if err:
                print(err, file=sys.stderr)
    print("remote-host: " + "  ".join(f"{l}={r.returncode}" for l, r in zip(labels, results)), file=sys.stderr)
    # A child killed by a signal has a negative returncode; report it the shell way (128+N) so it is not hidden by a 0.
    return max((r.returncode if r.returncode >= 0 else 128 - r.returncode for r in results), default=0)


def unique_labels(hosts):
    """Column/section names; a host named twice gets #2, #3 so nothing collapses."""
    seen, out = {}, []
    for h in hosts:
        seen[h] = seen.get(h, 0) + 1
        out.append(h if seen[h] == 1 else f"{h}#{seen[h]}")
    return out


def display_width(text):
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def render_table(outputs, hosts):
    """Return a table, or None when a long value needs complete per-host sections."""
    parsed = dict(zip(hosts, (parse_kv(o) for o in outputs)))
    keys = []
    for h in hosts:
        for k in parsed[h]:
            if k not in keys:
                keys.append(k)
    cell = lambda h, k: ", ".join(parsed[h].get(k, ["-"]))
    if any(display_width(k) > 60 or display_width(cell(h, k)) > 60 for h in hosts for k in keys):
        return None
    widths = [max([display_width("key")] + [display_width(k) for k in keys])]
    widths += [max([display_width(h)] + [display_width(cell(h, k)) for k in keys]) for h in hosts]
    rows = [["key", *hosts]] + [[k, *[cell(h, k) for h in hosts]] for k in keys]
    lines = []
    for i, row in enumerate(rows):
        same = i > 0 and len({row[j] for j in range(1, len(row))}) == 1
        mark = "  " if i == 0 or same else "≠ "
        lines.append(mark + "  ".join(c + " " * (w - display_width(c)) for c, w in zip(row, widths)).rstrip())
    return "\n".join(lines)


FAN_OUT = ("run", "status", "doctor", "wait", "app")


def strip_host(argv):
    """argv without its -H/--host (and --table): what each per-host child runs."""
    out, skip = [], False
    for a in argv:
        if skip:
            skip = False
            continue
        if a in ("-H", "--host"):
            skip = True
        elif a.startswith("--host=") or (a.startswith("-H") and len(a) > 2) or a == "--table":
            continue
        else:
            out.append(a)
    return out
