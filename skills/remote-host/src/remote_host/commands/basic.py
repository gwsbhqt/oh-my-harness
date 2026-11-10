"""One-off commands: run a payload, copy a file up or down, report host status."""

import base64
import subprocess
import sys
import json
import shlex
import tempfile

from agentkit.remote.pins import read_pin
from agentkit.remote.ssh import PRELUDE, SSH_OPTS, PROXY, path_line, remote_argv, remote_dir, run_remote, ssh_config, ssh_hint, stash_here

from .core import build_exec, cwd_of, deps_of, host_of, interp_of, read_body


def cmd_run(args):
    host = host_of(args)
    name, spec = interp_of(args)
    body = read_body(args.command)
    if name in ("powershell", "pwsh"):
        if PROXY["on"] or deps_of(args):
            print("remote-host: PowerShell run does not support --proxy or --with", file=sys.stderr)
            return 2
        cwd = cwd_of(args)
        bootstrap = (
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
            "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; "
            + "$script = [Console]::In.ReadToEnd(); try { "
            + ("Set-Location -LiteralPath '" + cwd.replace("'", "''") + "'; " if cwd else "")
            + "& ([ScriptBlock]::Create($script)); "
            "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; exit 0 } "
            "catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }"
        )
        encoded = base64.b64encode(bootstrap.encode("utf-16-le")).decode("ascii")
        flags = " -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded
        if name == "powershell":
            command = ('cmd.exe /d /c "where.exe pwsh.exe >nul 2>&1 & '
                       'if errorlevel 1 (powershell.exe' + flags + ') else (pwsh.exe' + flags + ')"')
        else:
            command = "pwsh.exe" + flags
        argv = remote_argv(host, command)
        argv.insert(1, "-a")
        code = ssh_hint(subprocess.run(argv, input=body.encode("utf-8")).returncode, host)
        if code:
            print(f"remote-host: {host} ({name}) exit {code}", file=sys.stderr)
        return code
    if spec["shell"]:
        body = path_line(spec["ext"] == "fish") + "\n" + body
    path = f'~/.cache/remote-host/run.$$.{spec["ext"]}'
    cwd = cwd_of(args)
    script = (
        PRELUDE
        + "mkdir -p ~/.cache/remote-host\n"
        + stash_here(path, body)
        + (f"cd {remote_dir(cwd)} || exit 1\n" if cwd else "")
        + build_exec(spec, deps_of(args))
        + f'[ -n "$__remote_host_missing" ] && {{ rm -f {path}; exit 127; }}\n'
        # Without </dev/null the payload would read the rest of this script.
        # eval: build_exec shell-quotes --with packages, so the command line has to be re-parsed, not word-split.
        + f'eval "$__remote_host_exec {path}" < /dev/null\n__remote_host_rc=$?\nrm -f {path}\nexit $__remote_host_rc\n'
    )
    code = run_remote(host, script)
    if code:
        print(f"remote-host: {host} ({name}) exit {code}", file=sys.stderr)
    return code


FILE_SOURCE_PY = r"""
import hashlib, json, os, stat, sys
def digest_file(f):
    digest = hashlib.sha256()
    for chunk in iter(lambda: f.read(1 << 20), b''):
        digest.update(chunk)
    return digest.hexdigest()
path = os.path.abspath(os.path.expanduser(sys.argv[1]))
if not os.path.isfile(path):
    sys.exit('remote-host: get/put accepts one existing regular file, not a directory or dangling link; use remote-host copy for trees')
with open(path, 'rb') as f:
    before = os.fstat(f.fileno())
    digest = digest_file(f)
    after = os.fstat(f.fileno())
if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
    sys.exit('remote-host: source changed while hashing')
print(json.dumps({'path':path, 'name':os.path.basename(path), 'sha256':digest}))
"""
FILE_RECEIVE_PY = r"""
import fcntl, hashlib, os, shutil, stat, sys, tempfile
def digest_file(f):
    digest = hashlib.sha256()
    for chunk in iter(lambda: f.read(1 << 20), b''):
        digest.update(chunk)
    return digest.hexdigest()
path, name, expected, guard = sys.argv[1:]
path = os.path.abspath(os.path.expanduser(path))
if os.path.isdir(path):
    path = os.path.join(path, name)
def snapshot():
    real = os.path.realpath(path)
    chain = []
    part = path
    while True:
        if os.path.lexists(part):
            s = os.lstat(part)
            chain.append((part, s.st_dev, s.st_ino, s.st_mode, os.readlink(part) if stat.S_ISLNK(s.st_mode) else None))
        if part == os.path.dirname(part): break
        part = os.path.dirname(part)
    if os.path.lexists(path) and not os.path.isfile(path):
        raise ValueError('destination is not a regular file or is a dangling symlink')
    info = None
    if os.path.exists(real):
        s = os.stat(real)
        if s.st_nlink != 1:
            raise ValueError('hardlinked destination cannot be atomically updated without breaking its links')
        if s.st_uid != os.geteuid():
            raise ValueError('destination owner cannot be preserved by this user')
        if sys.platform == 'darwin':
            import subprocess
            attrs = subprocess.run(['/usr/bin/xattr', real], capture_output=True, text=True, check=True)
            attributes = tuple((key, subprocess.run(['/usr/bin/xattr', '-px', key, real], capture_output=True, text=True, check=True).stdout.strip())
                               for key in sorted(attrs.stdout.splitlines()))
            acl = subprocess.run(['/bin/ls', '-lde', real], capture_output=True, text=True, check=True)
            if any(line.lstrip().split(':', 1)[0].isdigit() for line in acl.stdout.splitlines()[1:]):
                raise ValueError('destination has an ACL; atomic get/put cannot safely preserve it')
        elif sys.platform.startswith('linux'):
            keys = os.listxattr(real)
            if any(key.startswith('system.posix_acl_') for key in keys):
                raise ValueError('destination has ACL; atomic get/put cannot safely preserve it')
            attributes = tuple((key, os.getxattr(real, key).hex()) for key in sorted(keys))
        else:
            raise ValueError('destination ACL verification is not supported on this platform')
        with open(real, 'rb') as f:
            digest = digest_file(f)
        info = (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_mode, s.st_uid, s.st_gid, attributes, digest)
    return real, chain, info
try:
    initial = snapshot()
    real, _, info = initial
    parent = os.path.dirname(real)
    lockpath = os.path.join(parent, '.remote-host-file-' + hashlib.sha256(real.encode()).hexdigest() + '.lock')
    with open(lockpath, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if snapshot() != initial:
            raise ValueError('destination changed before transfer; original not overwritten')
        if guard and (not info or info[-1] != guard):
            raise ValueError('destination SHA-256 does not match --expect-sha256')
        fd, temporary = tempfile.mkstemp(prefix='.remote-host-file-incoming-', dir=parent)
        try:
            with os.fdopen(fd, 'wb') as f:
                digest = hashlib.sha256()
                for chunk in iter(lambda: sys.stdin.buffer.read(1 << 20), b''):
                    digest.update(chunk)
                    f.write(chunk)
                f.flush()
                os.fsync(f.fileno())
                if info:
                    ownership = os.fstat(f.fileno())
                    if (ownership.st_uid, ownership.st_gid) != (info[5], info[6]):
                        os.fchown(f.fileno(), info[5], info[6])
                    ownership = os.fstat(f.fileno())
                    if (ownership.st_uid, ownership.st_gid) != (info[5], info[6]):
                        raise ValueError('destination owner/group cannot be preserved by this user')
            if digest.hexdigest() != expected:
                raise ValueError('transferred content failed SHA-256 validation; original not overwritten')
            if snapshot() != initial:
                raise ValueError('destination or symlink changed during transfer; original not overwritten')
            if info:
                os.chmod(temporary, stat.S_IMODE(info[4]))
                if sys.platform == 'darwin':
                    import subprocess
                    for key, value in info[7]:
                        subprocess.run(['/usr/bin/xattr', '-wx', key, value, temporary], capture_output=True, check=True)
                else:
                    for key, value in info[7]:
                        os.setxattr(temporary, key, bytes.fromhex(value))
            if snapshot() != initial:
                raise ValueError('destination metadata changed before replacement')
            os.replace(temporary, real)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
except (OSError, ValueError) as exc:
    sys.exit(f'remote-host: safe file transfer refused: {exc}')
"""


def file_script(body, *argv):
    return PRELUDE + "python3 -c " + shlex.quote(body) + " " + shlex.join(argv) + "\n"


def transfer_file(source_host, source, target_host, target, guard=""):
    """Transfer one verified file, retaining destination symlinks and original data on failure."""
    from .transfer import endpoint

    script = file_script(FILE_SOURCE_PY, source)
    metadata = (run_remote(source_host, script, capture=True) if source_host else
                subprocess.run(["bash", "-c", script], capture_output=True))
    if metadata.returncode:
        print(metadata.stderr.decode(errors="replace"), end="", file=sys.stderr)
        return metadata.returncode
    info = json.loads(metadata.stdout)
    # Complete the source hop first: an SSH failure after all bytes arrived must not authorize commit.
    with tempfile.TemporaryFile() as spool:
        sender = subprocess.run(endpoint(source_host, "cat -- " + shlex.quote(info["path"])),
                                stdout=spool, stdin=subprocess.DEVNULL)
        if sender.returncode:
            print("remote-host: source transfer failed; destination left untouched", file=sys.stderr)
            return sender.returncode
        spool.seek(0)
        receiver = subprocess.run(endpoint(target_host, file_script(FILE_RECEIVE_PY, target, info["name"],
                                  info["sha256"], guard or "")), stdin=spool)
    return receiver.returncode


def cmd_put(args):
    return transfer_file(None, args.local, host_of(args), args.remote or "~/",
                         getattr(args, "expect_sha256", ""))


def cmd_get(args):
    return transfer_file(host_of(args), args.remote, None, args.local or ".",
                         getattr(args, "expect_sha256", ""))



def cmd_status(args):
    host, pin = host_of(args), read_pin("remote-host")
    name, _ = interp_of(args)
    print(f"host:    {host}" + ("  (pinned)" if pin.get("host") == host else ""), flush=True)
    target = ssh_config(host).get("hostname", host)
    print(f"target:  {target}  (from local SSH config)", flush=True)
    if pin.get("host") == host:
        from agentkit.remote.reach import local_addr_towards, same_lan
        import ipaddress

        try:
            address = ipaddress.ip_address(target)
        except ValueError:
            address = None
        if address and address.is_private:
            here = local_addr_towards(target)
            if here and not same_lan(target, here):
                print(f"network: local route uses {here}, not {target}'s LAN; check VPN/network before relying on this pin", flush=True)
        elif target.endswith(".local"):
            print("network: .local names only resolve on their LAN; check the pinned target after changing networks", flush=True)
    print(f"interp:  {name}", flush=True)
    if cwd_of(args):
        print(f"cwd:     {cwd_of(args)}", flush=True)

    try:
        klist = subprocess.run(["klist"], capture_output=True, text=True, timeout=10).stdout
        for line in klist.splitlines():
            if "krbtgt" in line:
                print(f"ticket:  {line.strip()}", flush=True)
                break
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    script = PRELUDE + (
        'echo "name:    $(hostname)"\n'
        'echo "up:      $(uptime -p 2>/dev/null || uptime)"\n'
        'echo "login:   $SHELL"\n'
        "__remote_host_mux=$(command -v tmux || echo none)\n"
        'echo "mux:     $__remote_host_mux"\n'
        "__remote_host_have=\n"
        "for __remote_host_i in bash fish zsh sh python3 bun node; do\n"
        '  command -v "$__remote_host_i" >/dev/null && __remote_host_have="$__remote_host_have $__remote_host_i"\n'
        "done\n"
        'echo "found:  $__remote_host_have"\n'
        'if [ "$__remote_host_mux" != none ]; then\n'
        '  __remote_host_s=$("$__remote_host_mux" list-sessions -F "#{session_name}" 2>/dev/null | tr "\\n" " ")\n'
        '  echo "session: ${__remote_host_s:-none}"\n'
        "fi\n"
    )
    return run_remote(host, script)
