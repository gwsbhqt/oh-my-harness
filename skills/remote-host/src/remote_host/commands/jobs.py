"""Background jobs that need no multiplexer: nohup, a log, an exit-code file."""

import re
import sys
import time
import shlex
import uuid

from agentkit.remote.ssh import PRELUDE, path_line, remote_dir, run_remote, stash_here

from .core import build_exec, cwd_of, deps_of, host_of, interp_of, read_body


JOB_ROOT = "~/.cache/remote-host/jobs"


def job_name(name):
    if name in (".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]{1,48}", name or ""):
        sys.exit(f"remote-host: bad job name {name!r} — letters, digits, . _ - only")
    return name


JOB_WORKER = r"""
import os, signal, subprocess, sys, time
from pathlib import Path
directory, command, token = sys.argv[1:]
d = Path(directory)
cancelled = False
def terminate(sig, frame):
    global cancelled
    cancelled = True
signal.signal(signal.SIGTERM, terminate)
with (d/'out.log').open('ab', buffering=0) as log:
    import json
    try:
        child = subprocess.Popen(json.loads(command), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        rc = child.wait()
    except OSError as exc:
        log.write((f'remote-host: payload failed to start: {exc}\n').encode())
        rc = 127
rc = 143 if cancelled else (128 - rc if rc < 0 else rc)
temporary = d / ('rc.'+token)
temporary.write_text(str(rc)+'\n')
os.replace(temporary, d/'rc')
"""
JOB_PY = r"""
import fcntl, json, os, shlex, signal, subprocess, sys, time, uuid
from pathlib import Path
root = Path.home()/'.cache/remote-host/jobs'
root.mkdir(parents=True, exist_ok=True)
action, name = sys.argv[1:3]
def directory(name):
    if name in ('.','..') or not __import__('re').fullmatch(r'[A-Za-z0-9_.-]{1,48}',name):
        raise ValueError('unsafe job name')
    d = root/name
    if d.is_symlink() or not d.resolve().is_relative_to(root.resolve()):
        raise ValueError('job path escapes its root')
    return d
def identity(pid):
    r = subprocess.run(['ps','-p',str(pid),'-o','lstart=','-o','command='],capture_output=True,text=True)
    return r.stdout.strip() if r.returncode == 0 else ''
def alive(d):
    try:
        pid = int((d/'pid').read_text())
        return pid > 1 and identity(pid) == (d/'identity').read_text() and bool(identity(pid))
    except (OSError, ValueError): return False
def state(d):
    if (d/'rc').exists(): return 'exited '+(d/'rc').read_text().strip()
    if alive(d): return 'running'
    # The worker writes rc before exiting, so it may have finished after the first look.
    if (d/'rc').exists(): return 'exited '+(d/'rc').read_text().strip()
    return 'lost (no exit code; process identity is gone)'
try:
    if action == 'list':
        for d in sorted(root.iterdir()):
            if d.is_dir() and not d.is_symlink() and not d.name.startswith('.'):
                print(d.name, state(directory(d.name)))
        sys.exit(0)
    d = directory(name)
    lock = (root/('.'+name+'.lock')).open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    if action == 'start':
        command, worker, token, payload, wrapper = sys.argv[3:8]
        if d.exists() and alive(d) and not (d/'rc').exists():
            print(f'remote-host: job {name} is still running',file=sys.stderr); sys.exit(2)
        if d.exists():
            backup = root/('.'+name+'.old-'+token)
            os.rename(d, backup)
        d.mkdir()
        (d/'started').write_text(str(int(time.time())))
        (d/'token').write_text(token)
        (d/'out.log').touch()
        # The UUID in argv and process start time prevent pid-reuse from authorizing a kill.
        p = subprocess.Popen([sys.executable,'-c',worker,str(d),json.dumps((['bash', wrapper] if wrapper else []) + shlex.split(command) + [payload]),token],
                             stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                             start_new_session=True)
        (d/'pid').write_text(str(p.pid))
        started_identity = identity(p.pid)
        if not started_identity and not (d/'rc').exists():
            sys.exit('remote-host: job supervisor identity is missing; start outcome unknown')
        (d/'identity').write_text(started_identity)
        print(f'remote-host: job {name} started (pid {p.pid}) — remote-host job wait/follow {name}')
    elif action == 'kill':
        if (d/'rc').exists(): print(f'remote-host: job {name} already {state(d)}'); sys.exit(0)
        if not alive(d): sys.exit(f'remote-host: job {name} lost; refusing to kill an unowned pid')
        pid = int((d/'pid').read_text())
        table = subprocess.run(['ps','-axo','pid=,ppid='],capture_output=True,text=True,check=True)
        children = {}
        for line in table.stdout.splitlines():
            p, parent = map(int,line.split()); children.setdefault(parent,[]).append(p)
        owned = []
        def descend(p):
            for child in children.get(p,[]): descend(child)
            owned.append((p,identity(p)))
        descend(pid)
        for p, ident in owned:
            if ident and identity(p) == ident:
                try: os.kill(p,signal.SIGTERM)
                except ProcessLookupError: pass
        time.sleep(3)
        for p, ident in owned:
            if ident and identity(p) == ident:
                try: os.kill(p,signal.SIGKILL)
                except ProcessLookupError: pass
        if not (d/'rc').exists():
            tmp = d/'rc.cancelled'; tmp.write_text('143\n'); os.replace(tmp,d/'rc')
        print(f'remote-host: job {name} killed (exit 143)')
    elif action in ('wait','follow','tail'):
        timeout, lines = map(int,sys.argv[3:5])
        generation = (d/'token').read_text() if (d/'token').exists() else ''
        fcntl.flock(lock, fcntl.LOCK_UN)
        deadline = time.monotonic()+timeout
        position = 0
        while True:
            current = (d/'token').read_text() if (d/'token').exists() else ''
            if current != generation:
                print('remote-host: job generation changed; previous job outcome unknown', file=sys.stderr)
                sys.exit(125)
            if action == 'follow' and (d/'out.log').exists():
                with (d/'out.log').open('rb') as log:
                    log.seek(position); data=log.read(); position=log.tell()
                sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
            st = state(d)
            if action == 'tail' or not st.startswith('running') or time.monotonic() >= deadline: break
            time.sleep(.1)
        # Output written between the last read and the exit check would otherwise be dropped.
        if action == 'follow' and (d/'out.log').exists():
            with (d/'out.log').open('rb') as log:
                log.seek(position); sys.stdout.buffer.write(log.read()); sys.stdout.buffer.flush()
        if action != 'follow' and (d/'out.log').exists():
            sys.stdout.buffer.write(b''.join((d/'out.log').read_bytes().splitlines(keepends=True)[-lines:]))
        print(f'remote-host: job {name} {st}',file=sys.stderr)
        if st.startswith('exited'): sys.exit(int(st.split()[1]))
        if st.startswith('lost'): sys.exit(125)
        sys.exit(0 if action == 'tail' else 124)
except (OSError, ValueError) as exc:
    sys.exit(f'remote-host: job refused: {exc}')
"""

def job_start_script(name, spec, body, progress, every, deps, cwd):
    job_name(name)
    token = uuid.uuid4().hex
    payload = f"~/.cache/remote-host/jobs/.payload-{token}.{spec['ext']}"
    if spec["shell"]:
        body = path_line(spec["ext"] == "fish") + "\n" + body
    wrapper = ""
    script = (PRELUDE + "mkdir -p ~/.cache/remote-host/jobs\n"
              + stash_here(payload, body)
              + (f"cd {remote_dir(cwd)} || exit 1\n" if cwd else "")
              + build_exec(spec, deps) + '[ -n "$__remote_host_missing" ] && exit 127\n')
    # Sampling is a child of the payload wrapper, so cancellation owns it too.
    if progress:
        wrapper = f"~/.cache/remote-host/jobs/.wrapper-{token}.sh"
        progress_path = f"~/.cache/remote-host/jobs/.progress-{token}.sh"
        script += stash_here(progress_path, progress)
        script += stash_here(wrapper, f"( while true; do __v=$(bash {progress_path} 2>&1 | tail -n 1); echo \"[progress $(date +%H:%M:%S)] $__v\"; sleep {max(1,int(every))}; done ) &\n__sampler=$!\n\"$@\"\n__code=$?\nkill $__sampler 2>/dev/null; wait $__sampler 2>/dev/null\nexit $__code")
    wrapper_arg = remote_dir(wrapper) if wrapper else "''"
    return script + f'python3 -c {shlex.quote(JOB_PY)} start {shlex.quote(name)} "$__remote_host_exec" {shlex.quote(JOB_WORKER)} {token} {remote_dir(payload)} {wrapper_arg}\n'



def job_wait_script(name, timeout, follow, lines):
    job_name(name)
    return f"python3 -c {shlex.quote(JOB_PY)} {'follow' if follow else 'wait'} {shlex.quote(name)} {int(timeout)} {int(lines)}\n"


def job_list_script():
    return f"python3 -c {shlex.quote(JOB_PY)} list -\n"


def job_kill_script(name):
    job_name(name)
    return f"python3 -c {shlex.quote(JOB_PY)} kill {shlex.quote(name)}\n"


JOB_OPTS = {"--progress": ("progress", str), "--every": ("every", int),
            "-t": ("timeout", int), "--timeout": ("timeout", int),
            "-n": ("lines", int), "--lines": ("lines", int)}
#: Options that take no value.
JOB_FLAGS = {"--follow": "follow"}

#: `start --follow` hands one call to the agent's background tooling for the
#: whole job, so it waits far longer than a plain `wait`/`follow` by default.
FOLLOW_TIMEOUT = 6 * 3600
WAIT_TIMEOUT = 600


def take_job_opts(args):
    """argparse's REMAINDER swallows every option written after the job name
    (`remote-host job wait build -t 30` would wait the default 600s). Peel leading job
    options off the remainder; the first other word, or `--`, starts the command."""
    rest = list(args.command or [])
    while rest:
        tok = rest[0]
        if tok == "--":
            rest.pop(0)
            break
        if tok in JOB_FLAGS:
            rest.pop(0)
            setattr(args, JOB_FLAGS[tok], True)
            continue
        key, _, inline = tok.partition("=")
        if key not in JOB_OPTS:
            break
        rest.pop(0)
        dest, kind = JOB_OPTS[key]
        value = inline if inline else (rest.pop(0) if rest else sys.exit(f"remote-host: {key} needs a value"))
        setattr(args, dest, kind(value))
    args.command = rest
    return args


def cmd_job(args):
    take_job_opts(args)
    follow = getattr(args, "follow", False)
    if getattr(args, "timeout", None) is None:
        args.timeout = FOLLOW_TIMEOUT if args.action == "start" and follow else WAIT_TIMEOUT
    host = host_of(args)
    if args.action == "start":
        if len(args.command) > 1 and any(word in ("&&", "|", ";") for word in args.command):
            sys.exit("remote-host: job command words are literal arguments, not shell syntax — put a multi-command script on stdin (remote-host job start <name> --follow <<'EOF' ... EOF); literal symbols can be passed inside that script")
        name = job_name(args.name or time.strftime("job-%H%M%S"))
        iname, spec = interp_of(args)
        body = read_body(args.command)
        script = job_start_script(name, spec, body, args.progress, args.every,
                                  deps_of(args), cwd_of(args))
        code = run_remote(host, script)
        if code or not follow:
            return code
        # One call from start to finish: its output is the live log and its
        # exit status is the job's, so background tooling that notifies on
        # exit reports the job itself — no polling loop needed.
        return run_remote(host, job_wait_script(name, args.timeout, True, args.lines))
    if args.action == "list":
        return run_remote(host, job_list_script())
    name = job_name(args.name)
    if args.action in ("wait", "follow"):
        return run_remote(host, job_wait_script(name, args.timeout, args.action == "follow", args.lines))
    if args.action == "tail":
        return run_remote(host, f"python3 -c {shlex.quote(JOB_PY)} tail {shlex.quote(name)} 0 {int(args.lines)}\n")
    if args.action == "kill":
        return run_remote(host, job_kill_script(name))
    sys.exit(f"remote-host: unknown job action {args.action}")
