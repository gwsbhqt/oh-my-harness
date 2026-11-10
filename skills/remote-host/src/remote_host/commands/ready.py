"""Waiting for readiness, and starting/stopping macOS apps in the right order."""

import shlex
import sys

from agentkit.remote.ssh import remote_dir, run_remote

from .core import host_of


def wait_script(port=None, proc=None, file=None, check=None, gone=False, timeout=120, every=2):
    conds = []
    if port:
        h, _, p = port.rpartition(":") if ":" in port else ("127.0.0.1", "", port)
        conds.append(f"(exec 3<>/dev/tcp/{h or '127.0.0.1'}/{int(p)}) 2>/dev/null")
    if proc:
        conds.append(f"pgrep -f {shlex.quote(proc)} >/dev/null 2>&1")
    if file:
        conds.append(f"[ -e {remote_dir(file)} ]")
    if check:
        conds.append(f"( {check} ) >/dev/null 2>&1")
    if not conds:
        sys.exit("remote-host: wait needs --port, --proc, --file or --cmd")
    test = " && ".join(conds)
    if gone:
        test = f"! {{ {test}; }}"
    what = " and ".join(x for x in (
        port and f"port {port}", proc and f"process {proc!r}",
        file and f"file {file}", check and "command") if x)
    verb = "gone" if gone else "ready"
    return (
        "__s=$(date +%s)\n"
        f"while :; do\n  if {test}; then echo \"remote-host: {what} {verb} after $(( $(date +%s) - __s ))s\"; exit 0; fi\n"
        f"  [ $(( $(date +%s) - __s )) -ge {int(timeout)} ] && break\n  sleep {int(every)}\ndone\n"
        f"echo \"remote-host: {what} not {verb} within {int(timeout)}s\" >&2; exit 124\n"
    )


def cmd_wait(args):
    return run_remote(host_of(args), wait_script(
        args.port, args.proc, args.file, args.check, args.gone, args.timeout, args.every))


def app_script(action, app, timeout=30, port=None):
    q = shlex.quote(app)
    pat = shlex.quote(f"/{app}.app/Contents/MacOS/")
    status = f'__pids=$(pgrep -f {pat} | tr "\\n" " ")\n'
    stop = (
        f"osascript -e 'tell application \"'{q}'\" to quit' >/dev/null 2>&1\n"
        + f"__i=0; while pgrep -f {pat} >/dev/null && [ $__i -lt {int(timeout)} ]; do sleep 1; __i=$((__i+1)); done\n"
        + f'if pgrep -f {pat} >/dev/null; then echo "remote-host: {app} ignored quit for {int(timeout)}s — TERM" >&2; '
        + f"pkill -TERM -f {pat}; sleep 3; pkill -KILL -f {pat} 2>/dev/null; fi\n"
        + f'pgrep -f {pat} >/dev/null && {{ echo "remote-host: {app} is still running" >&2; exit 1; }}\n'
        + f'echo "remote-host: {app} stopped"\n'
    )
    start = (
        f'open -a {q} || {{ echo "remote-host: cannot open {app} (not installed?)" >&2; exit 1; }}\n'
        + f"__i=0; until pgrep -f {pat} >/dev/null; do sleep 1; __i=$((__i+1)); "
        + f'[ $__i -ge {int(timeout)} ] && {{ echo "remote-host: {app} did not start within {int(timeout)}s" >&2; exit 124; }}; done\n'
        + (wait_script(port=port, timeout=timeout) if port else "")
        + status + f'echo "remote-host: {app} running (pids $__pids)"\n'
    )
    if action == "status":
        return status + f'[ -n "$__pids" ] && echo "remote-host: {app} running (pids $__pids)" || {{ echo "remote-host: {app} not running"; exit 1; }}\n'
    if action == "stop":
        return stop
    if action == "start":
        return start
    if action == "restart":
        return f"( {stop} ) || exit 1\n" + start
    sys.exit(f"remote-host: unknown app action {action}")


#: Runs on the host with python3 (Command Line Tools). argv: app name, minutes, lines.
#:
#: The hard part is WHERE an app logs. Clash Party writes to
#: ~/Library/Application Support/mihomo-party/logs — a directory named after
#: none of its app name, executable or bundle id (party.mihomo.app); finding it
#: took a real session a long detour (2026-09-23). So directories are matched
#: on the WORDS of those three names, not on any one of them.
LOGS_PY = r"""
import glob, os, plistlib, re, subprocess, sys, time
name, since, lines = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
home = os.path.expanduser("~")
app = next((p for p in (f"/Applications/{name}.app", f"{home}/Applications/{name}.app") if os.path.isdir(p)), None)
if not app:
    sys.exit(f"remote-host: no {name}.app in /Applications or ~/Applications")
info = plistlib.load(open(app + "/Contents/Info.plist", "rb"))
exe, bid = info.get("CFBundleExecutable", name), info.get("CFBundleIdentifier", "")
print(f"== {name} · executable {exe} · bundle {bid}")

print(f"\n== errors and faults in the system log, last {since} min")
try:
    out = subprocess.run(["log", "show", "--last", f"{since}m", "--style", "compact", "--predicate",
                          f'process == "{exe}" AND (messageType == error OR messageType == fault)'],
                         capture_output=True, text=True, timeout=120).stdout.splitlines()
    out = [l for l in out if l.strip() and not l.startswith(("Timestamp", "Filtering"))]
    print("\n".join(l[:300] for l in out[-lines:]) or "(none)")
except subprocess.TimeoutExpired:
    print("(log show took over 120 s — narrow --since)")

print("\n== crash reports")
reports = sorted((p for d in (f"{home}/Library/Logs/DiagnosticReports", "/Library/Logs/DiagnosticReports")
                  for p in glob.glob(d + "/*") if os.path.basename(p).lower().startswith(exe.lower())),
                 key=os.path.getmtime, reverse=True)[:3]
for p in reports:
    print(f"{p}  ({time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(p)))})")
    keys = [l.strip()[:200] for l in open(p, errors="replace") if re.search(r'"(type|signal|indicator)"|Exception Type|Termination Reason|Crashed Thread', l)]
    for l in keys[:4]:
        print("   ", l)
if not reports:
    print("(none)")

GENERIC = {"app", "apps", "com", "org", "net", "io", "the", "helper", "mac", "macos", "desktop", "inc", "ltd"}
words = lambda s: {w for w in re.split(r"[^a-z0-9]+", s.lower()) if len(w) >= 3 and w not in GENERIC}
want = words(name) | words(exe) | words(bid)
roots = [f"{home}/Library/Logs", f"{home}/Library/Application Support", f"{home}/Library/Containers/{bid}/Data/Library/Logs"]
dirs = [os.path.join(r, d) for r in roots if os.path.isdir(r) for d in os.listdir(r) if words(d) & want]
dirs += [r for r in roots[2:] if os.path.isdir(r)]
# Browser storage in Electron apps also ends in .log (leveldb) and is binary.
STORAGE = {"Local Storage", "Session Storage", "IndexedDB", "leveldb", "Cache", "Code Cache", "GPUCache", "blob_storage"}
def text(path):
    try:
        return b"\0" not in open(path, "rb").read(4096)
    except OSError:
        return False
files = []
for d in dirs:
    for dp, dn, fn in os.walk(d):
        dn[:] = [x for x in dn if x not in STORAGE] if dp[len(d):].count(os.sep) < 3 else []
        files += [os.path.join(dp, f) for f in fn if f.endswith((".log", ".txt")) and text(os.path.join(dp, f))]
files.sort(key=os.path.getmtime, reverse=True)
recent = [f for f in files if time.time() - os.path.getmtime(f) < since * 60] or files[:3]
print(f"\n== the app's own log files (dirs matching {sorted(want)})")
for f in recent[:5]:
    age = int((time.time() - os.path.getmtime(f)) / 60)
    print(f"-- {f.replace(home, '~')}  ({os.path.getsize(f)} bytes, changed {age} min ago)")
    tail = open(f, errors="replace").read().splitlines()[-5000:]
    bad = [l for l in tail if re.search(r"error|fatal|exception|eacces|eperm|denied|panic|fail", l, re.I)]
    for l in (bad[-lines:] if bad else tail[-5:]):
        print("   ", l[:300])
    if not bad:
        print("    (no error lines — last lines shown)")
if not recent:
    print("(no log files found)")
"""


def app_logs_script(app, since=60, lines=20):
    return f"python3 -c {shlex.quote(LOGS_PY)} {shlex.quote(app)} {int(since)} {int(lines)}\n"


def cmd_app(args):
    if args.action == "logs":
        return run_remote(host_of(args), app_logs_script(args.app, args.since, args.lines))
    return run_remote(host_of(args), app_script(args.action, args.app, args.timeout, args.port))
