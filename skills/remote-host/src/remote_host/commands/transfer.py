"""Manifests, verification, and staged host-to-host copies."""

import os
import shlex
import hashlib
import subprocess
import sys
import time
import uuid

from agentkit.remote.ssh import EOF_MARK, PRELUDE, remote_argv, remote_dir, run_remote, stash_here

from .core import split_loc


#: Runs on the host with python3: one process walks, stats and hashes, so a
#: 185k-file tree costs one interpreter instead of 370k `stat`/`shasum` forks,
#: and macOS and Linux agree (their `stat` flags do not).
MANIFEST_PY = r"""
import hashlib, os, stat, sys
root, quick = os.path.expanduser(sys.argv[1]), sys.argv[2] == "1"
if not os.path.lexists(root):
    sys.exit(f"remote-host: no such path: {root}")
def esc(p):
    return p.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")
def entry(full, rel):
    st = os.lstat(full)
    if os.path.islink(full):
        return f"L\t{esc(os.readlink(full))}\t{esc(rel)}"
    if os.path.isdir(full):
        return f"D\t{esc(rel)}"
    # Sockets and fifos (git's fsmonitor--daemon.ipc) cannot travel in a tar
    # and opening them blocks or fails; they are runtime handles, not data.
    if not stat.S_ISREG(st.st_mode):
        return None
    h = "-"
    if not quick:
        d = hashlib.sha256()
        with open(full, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                d.update(chunk)
        h = d.hexdigest()
    return f"F\t{h}\t{st.st_size}\t{esc(rel)}"
out = []
if os.path.isdir(root) and not os.path.islink(root):
    for dirpath, dirs, files in os.walk(root):
        for name in dirs + files:
            full = os.path.join(dirpath, name)
            out.append(entry(full, os.path.relpath(full, root)))
else:
    out.append(entry(root, os.path.basename(root)))
out = sorted(e for e in out if e is not None)
sys.stdout.write("\n".join(out) + ("\n" if out else ""))
"""


def manifest_script(path, quick=False):
    """Shell that prints the canonical manifest of a file or tree, relative to
    its root, one entry per line, tab-separated, sorted:
    `F <sha256|-> <size> <path>`, `D <path>`, `L <target> <path>`.
    Sockets and fifos are left out — tar skips them too."""
    return (
        'command -v python3 >/dev/null || { echo "remote-host: manifest needs python3 on this host '
        '(a new Mac: xcode-select --install)" >&2; exit 127; }\n'
        + f"python3 - {shlex.quote(path)} {1 if quick else 0} <<'{EOF_MARK}'\n"
        + MANIFEST_PY.strip("\n") + f"\n{EOF_MARK}\n"
    )


def get_manifest(loc, quick=False):
    host, path = split_loc(loc)
    script = PRELUDE + manifest_script(path, quick)
    if host:
        done = run_remote(host, script, capture=True)
    else:
        done = subprocess.run(["bash", "-s"], input=script.encode(), capture_output=True)
    if done.returncode:
        sys.exit(f"remote-host: manifest of {loc} failed: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout.decode(errors="replace").splitlines()


def summarize(lines):
    files = [l for l in lines if l.startswith("F\t")]
    return {
        "files": len(files),
        "dirs": sum(1 for l in lines if l.startswith("D\t")),
        "links": sum(1 for l in lines if l.startswith("L\t")),
        "bytes": sum(int(l.split("\t")[2]) for l in files),
        "digest": hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16],
    }


def compare(a, b):
    """(missing on b, only on b, differing) paths between two manifests."""
    def index(lines):
        out = {}
        for line in lines:
            parts = line.split("\t")
            out[parts[-1]] = tuple(parts[:-1])
        return out
    ia, ib = index(a), index(b)
    missing = sorted(set(ia) - set(ib))
    extra = sorted(set(ib) - set(ia))
    changed = sorted(p for p in set(ia) & set(ib) if ia[p] != ib[p])
    return missing, extra, changed


def report_verify(src, dst, a, b):
    sa, sb = summarize(a), summarize(b)
    for label, s in ((src, sa), (dst, sb)):
        print(f"  {label}: {s['files']} files, {s['dirs']} dirs, {s['links']} links, "
              f"{s['bytes']} bytes, digest {s['digest']}")
    missing, extra, changed = compare(a, b)
    if not (missing or extra or changed):
        print("remote-host: verified — identical (every file's content hash, the directory tree and link targets)")
        return 0
    for title, items in (("missing on target", missing), ("only on target", extra), ("differs", changed)):
        if items:
            print(f"  {title}: {len(items)}")
            for p in items[:20]:
                print(f"    {p}")
            if len(items) > 20:
                print(f"    … {len(items) - 20} more")
    print("remote-host: NOT identical", file=sys.stderr)
    return 1


def cmd_manifest(args):
    lines = get_manifest(args.loc, args.quick)
    if args.full:
        print("\n".join(lines))
    s = summarize(lines)
    print(f"{args.loc}: {s['files']} files, {s['dirs']} dirs, {s['links']} links, "
          f"{s['bytes']} bytes, digest {s['digest']}" + ("  (quick: sizes only)" if args.quick else ""))
    return 0


def cmd_verify(args):
    return report_verify(args.src, args.dst, get_manifest(args.src, args.quick), get_manifest(args.dst, args.quick))


def tar_flavor(host):
    probe = "tar --version 2>/dev/null | head -1; command -v zstd >/dev/null && echo zstd=yes\n"
    if host:
        out = run_remote(host, PRELUDE + probe, capture=True).stdout.decode(errors="replace")
    else:
        out = subprocess.run(["bash", "-c", PRELUDE + probe], capture_output=True, text=True).stdout
    return ("bsdtar" if "bsdtar" in out else "gnu"), ("zstd=yes" in out)


def copy_scripts(src_path, dst_dir, name, src_tar, dst_tar, zstd):
    """Sender and receiver halves. The receiver unpacks into a staging dir next
    to the destination; the caller moves it into place only after verifying."""
    x_sparse = " -S" if dst_tar == "bsdtar" else " --warning=no-unknown-keyword"
    c_flags = " --sparse" if src_tar == "gnu" else ""
    if src_tar == "bsdtar" and dst_tar != "bsdtar":
        # Mac → non-Mac: xattrs would be unpacked as `._name` AppleDouble files
        # (caught by --verify on the first test). Mac → Mac keeps them — the
        # WeChat container needs its com.apple.macl.
        c_flags = " --no-mac-metadata"
    sender = (
        PRELUDE
        + f"__p={remote_dir(src_path)}\n"
        + '[ -e "$__p" ] || [ -L "$__p" ] || { echo "remote-host: no such path: $__p" >&2; exit 1; }\n'
        + 'cd "$(dirname "$__p")" || exit 1\n'
        + ("export COPYFILE_DISABLE=1\n" if "no-mac" in c_flags else "")
        + f'tar{c_flags} -cf - "$(basename "$__p")"' + (" | zstd -q -3 -T0" if zstd else "") + "\n"
    )
    stage = f"{dst_dir.rstrip('/')}/.remote-host-incoming-{uuid.uuid4().hex}-{name}"
    receiver = (
        PRELUDE
        + f"__s={remote_dir(stage)}\n"
        + 'mkdir -p "$(dirname "$__s")" && mkdir "$__s" || exit 1\n'
        + ("zstd -q -d -T0 | " if zstd else "")
        + f'tar{x_sparse} -xf - -C "$__s"\n'
    )
    return sender, receiver, stage


FINALIZE_PY = r"""
import fcntl, hashlib, os, sys
stage, directory, name, replace = sys.argv[1:]
stage, directory = os.path.expanduser(stage), os.path.realpath(os.path.expanduser(directory))
target = os.path.join(directory, name)
lockpath = os.path.join(directory, '.remote-host-copy-' + hashlib.sha256(name.encode()).hexdigest() + '.lock')
with open(lockpath, 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    incoming = os.path.join(stage, name)
    if not os.path.lexists(incoming):
        sys.exit('remote-host: staged source is missing; target left untouched')
    backup = target + '.remote-host-old-' + os.path.basename(stage).removeprefix('.remote-host-incoming-')
    existed = os.path.lexists(target)
    if existed:
        if replace != '1':
            sys.exit(f'remote-host: {target} exists — pass --replace to move it aside')
        if os.path.lexists(backup):
            sys.exit(f'remote-host: backup already exists: {backup}; target left untouched')
        try:
            os.rename(target, backup)
        except OSError as exc:
            sys.exit(f'remote-host: backup failed: {exc}; target left untouched')
    try:
        os.rename(incoming, target)
    except OSError as exc:
        if existed:
            try:
                os.rename(backup, target)
            except OSError as rollback:
                sys.exit(f'remote-host: placement failed: {exc}; restore failed: {rollback}; original retained at {backup}')
        sys.exit(f'remote-host: placement failed: {exc}; original restored')
    os.rmdir(stage)
    if existed:
        print(f'remote-host: previous copy kept as {backup}')
    print(f'remote-host: placed at {target}')
"""

def finalize_script(stage, dst_dir, name, replace):
    return (f"python3 - {shlex.quote(stage)} {shlex.quote(dst_dir)} {shlex.quote(name)} {int(replace)} <<'{EOF_MARK}'\n"
            + FINALIZE_PY + f"\n{EOF_MARK}\n")


def endpoint(host, script):
    """argv that runs `script` at one end of a data pipe. stdin carries the
    data, so the script cannot ride on it: it is stashed as a file first (one
    extra call) and run from there — nothing re-parsed by a fish login shell."""
    if not host:
        return ["bash", "-c", script]
    path = f"~/.cache/remote-host/copy.{uuid.uuid4().hex[:8]}.sh"
    script = 'rm -f "$0"\n' + script
    if run_remote(host, "mkdir -p ~/.cache/remote-host\n" + stash_here(path, script)):
        sys.exit(f"remote-host: could not stage the copy script on {host}")
    # The command passes the host's LOGIN shell (fish on the Macs), so it stays
    # a single word-level `exec`; the script removes itself as its first act.
    return remote_argv(host, f"exec bash {path}")


def cmd_copy(args):
    """Stream a file or tree from one place to another (either end may be this
    machine), staged, then verified and moved into place."""
    import threading

    sh, sp = split_loc(args.src)
    dh, dp = split_loc(args.dst)
    name = os.path.basename(sp.rstrip("/")) or sys.exit("remote-host: source must name a file or directory")
    src_tar, src_z = tar_flavor(sh)
    dst_tar, dst_z = tar_flavor(dh)
    zstd = src_z and dst_z and not args.no_compress
    sender, receiver, stage = copy_scripts(sp, dp, name, src_tar, dst_tar, zstd)

    dst_target = remote_dir(dp.rstrip("/") + "/" + name)
    dst_check = f"if [ -e {dst_target} ] || [ -L {dst_target} ]; then echo EXISTS; fi\n"
    exists = (run_remote(dh, dst_check, capture=True).stdout if dh else
              subprocess.run(["bash", "-c", dst_check], capture_output=True).stdout)
    if b"EXISTS" in exists and not args.replace:
        sys.exit(f"remote-host: {args.dst.rstrip('/')}/{name} exists — pass --replace to move it aside")

    started = time.time()
    s_proc = subprocess.Popen(endpoint(sh, sender), stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
    r_proc = subprocess.Popen(endpoint(dh, receiver), stdin=s_proc.stdout)
    s_proc.stdout.close()
    stop = threading.Event()

    def progress():
        probe = f"du -sk {remote_dir(stage)} 2>/dev/null | cut -f1\n"
        while not stop.wait(args.every):
            out = (run_remote(dh, probe, capture=True).stdout if dh else
                   subprocess.run(["bash", "-c", probe], capture_output=True).stdout)
            kb = int((out.decode().strip() or "0").split()[0])
            rate = kb / 1024 / max(time.time() - started, 1)
            print(f"[copy {time.strftime('%H:%M:%S')}] {kb / 1048576:.2f} GiB on target, {rate:.0f} MiB/s",
                  file=sys.stderr, flush=True)

    t = threading.Thread(target=progress, daemon=True)
    if args.every > 0:
        t.start()
    rc_r = r_proc.wait()
    rc_s = s_proc.wait()
    stop.set()
    if rc_s or rc_r:
        print(f"remote-host: transfer failed (sender exit {rc_s}, receiver exit {rc_r}); staging left at {stage}",
              file=sys.stderr)
        return rc_s or rc_r
    print(f"remote-host: transferred in {time.time() - started:.0f}s ({'zstd' if zstd else 'uncompressed'})", file=sys.stderr)

    if not args.no_verify:
        a = get_manifest(args.src, args.quick)
        staged = f"{dh}:{stage}/{name}" if dh else f"{stage}/{name}"
        b = get_manifest(staged, args.quick)
        if report_verify(args.src, "target", a, b):
            print(f"remote-host: staging kept for inspection at {stage}", file=sys.stderr)
            return 1
    fin = finalize_script(stage, dp, name, args.replace)
    return run_remote(dh, fin) if dh else subprocess.run(["bash", "-c", fin]).returncode
