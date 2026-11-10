"""The persistent multiplexer session: send, peek, reset, attach."""

import subprocess
import sys
import uuid
import shlex

from agentkit.remote.ssh import PRELUDE, path_line, remote_dir, run_remote, stash_here

from .core import INTERPRETERS, build_exec, check_session, cwd_of, deps_of, find_mux, host_of, interp_of, new_mark, pane_path_line, read_body, resolve_interp


def emit_stream(path, fd, cap):
    """Copy a captured stream back verbatim, capping only when asked."""
    body = f"cat {path}" if not cap else (
        f'__remote_host_n=$(wc -l < {path}); '
        f'if [ "$__remote_host_n" -gt {cap} ]; then '
        f'echo "remote-host: showing the last {cap} of $__remote_host_n lines" >&2; tail -n {cap} {path}; '
        f"else cat {path}; fi"
    )
    return f"[ -s {path} ] && {{ {body}; }} >&{fd}\n"


def pane_shell(spec):
    """Non-shell payloads still need a shell to live in; bash is the safe host."""
    return spec if spec["shell"] else INTERPRETERS["bash"]


def with_names():
    for key, spec in INTERPRETERS.items():
        spec.setdefault("name", key)


def cmd_send(args):
    host = host_of(args)
    name, spec = interp_of(args)
    if name in ("powershell", "pwsh"):
        print("remote-host: PowerShell supports run only; persistent sessions are unsupported", file=sys.stderr)
        return 2
    pane = pane_shell(spec)
    session = check_session(args.session)
    mark = new_mark()
    call = uuid.uuid4().hex
    lock = f"~/.cache/remote-host/{session}.busy"
    # The channel is per call too: a latched signal from an earlier -d job would
    # otherwise release this wait instantly, before its own payload had run.
    chan = f"rh_{session}_{mark.strip('_')}"
    cwd = cwd_of(args)
    stash = f'~/.cache/remote-host/{session}.{call}.{spec["ext"]}'
    shellfile = f"~/.cache/remote-host/{session}.shell"

    script = (
        PRELUDE
        + find_mux()
        + "mkdir -p ~/.cache/remote-host\n"
        + f'mkdir {lock} 2>/dev/null || {{ echo "remote-host: session {session} is busy or has an unfinished call; use remote-host peek or remote-host reset" >&2; exit 2; }}\n'
        + f"__remote_host_handed=; trap '[ -n \"$__remote_host_handed\" ] || {{ rm -f {lock}/rc; rmdir {lock} 2>/dev/null; }}' EXIT\n"
        + stash_here(stash, read_body(args.command))
        + resolve_interp(pane, "__remote_host_pane")
        + '[ -n "$__remote_host_missing" ] && exit 127\n'
        # A pane whose shell exited is kept for its output, then recycled here.
        + f'if [ "$("$MUX" display-message -p -t {session} \'#{{pane_dead}}\' 2>/dev/null)" = 1 ]; then\n'
        + f'  "$MUX" kill-session -t {session} 2>/dev/null\n'
        + "fi\n"
        + f'if ! "$MUX" has-session -t {session} 2>/dev/null; then\n'
        + "  python3 -c " + shlex.quote("import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:], start_new_session=True).returncode)")
        + f' "$MUX" new-session -d -s {session} -x 200 -y 50'
        + (f" -c {remote_dir(cwd)}" if cwd else "")
        + " -- $__remote_host_pane || exit 125\n"
        + f'  "$MUX" set-option -t {session} remain-on-exit on >/dev/null 2>&1\n'
        + f'  "$MUX" send-keys -t {session} \'{pane_path_line(pane)}\' Enter\n'
        + f"  printf '%s\\n' {pane['name']} > {shellfile}\n"
        + "fi\n"
        # Typing into a busy pane would interleave with the running job and
        # clear-history would eat its output.
        + f"__remote_host_fg=$(\"$MUX\" display-message -p -t {session} '#{{pane_current_command}}' 2>/dev/null)\n"
        + 'case "$__remote_host_fg" in bash|sh|fish|zsh|"") ;; *)\n'
        + f'  echo "remote-host: session {session} is busy running $__remote_host_fg — use -s <other>, '
        + 'or watch it with remote-host peek" >&2; exit 2;; esac\n'
    )

    # The pane command goes into a file and is sourced, so nothing this script
    # writes is ever re-expanded by the outer shell on its way to the pane.
    cmdfile = f"~/.cache/remote-host/{session}.{call}.cmd"
    out, err, rc = (f"~/.cache/remote-host/{session}.{call}.{x}" for x in ("out", "err", "rc"))
    status = pane["status"] if spec["shell"] else "$?"

    if spec["shell"]:
        script += (
            f"__remote_host_is=$(cat {shellfile} 2>/dev/null || echo bash)\n"
            f'[ "$__remote_host_is" = {name} ] || {{ echo "remote-host: session {session} runs $__remote_host_is, '
            f'not {name} — use -s <other> or remote-host reset" >&2; exit 2; }}\n'
        )
        body_line = f"source {stash} > {out} 2> {err}"
    else:
        script += (
            build_exec(spec, deps_of(args))
            + '[ -n "$__remote_host_missing" ] && exit 127\n'
            + resolve_interp(INTERPRETERS["bash"], "__remote_host_bash")
            + '[ -n "$__remote_host_missing" ] && exit 127\n'
        )
        body_line = f"$__remote_host_exec {stash} < /dev/null > {out} 2> {err}"

    # Redirecting to files is what makes the result exact: real stdout and
    # stderr, byte for byte, instead of whatever the terminal happened to render.
    script += (
        "{ printf '%s\\n' clear\n"
        + (f"  printf '%s\\n' '{path_line(pane['ext'] == 'fish')}'\n" if spec["shell"] else "")
        + f'  printf \'%s\\n\' "{body_line}"\n'
        + f'  printf \'%s\\n\' \'echo "{status}" > {rc}\'\n'
        + f"  printf '%s\\n' 'rm -f {lock}/rc; rmdir {lock}'\n"
        + f'  printf \'%s\\n\' "$MUX wait-for -S {chan}"\n'
        + f"}} > {cmdfile}\n"
        + f"printf '%s\n' {call} > ~/.cache/remote-host/{session}.current\n"
        + f"printf '%s\n' {rc.replace('~', '$HOME', 1)} > {lock}/rc\n"
        + f"rm -f {out} {err} {rc}\n"
        + (
            f'"$MUX" send-keys -t {session} \'source {cmdfile}\' Enter\n'
            if spec["shell"]
            else f'"$MUX" send-keys -t {session} "$__remote_host_bash {cmdfile}" Enter\n'
        )
        + '[ $? -eq 0 ] || { echo "remote-host: enqueue failed" >&2; exit 125; }\n__remote_host_handed=1\n'
    )

    if args.detach:
        return run_remote(host, script)

    # wait-for latches, so a signal landing between polls is not lost.
    script += (
        f"__remote_host_left={int(args.timeout)}\n__remote_host_ok=\n__remote_host_dead=\n"
        "while [ $__remote_host_left -gt 0 ]; do\n"
        + "  if python3 -c " + shlex.quote('import subprocess,sys\ntry: sys.exit(subprocess.run(sys.argv[1:],timeout=2).returncode)\nexcept subprocess.TimeoutExpired: sys.exit(124)')
        + f' "$MUX" wait-for {chan} 2>/dev/null; then __remote_host_ok=1; break; fi\n'
        f'  "$MUX" has-session -t {session} 2>/dev/null || {{ __remote_host_dead=gone; break; }}\n'
        f'  [ "$("$MUX" display-message -p -t {session} \'#{{pane_dead}}\' 2>/dev/null)" = 1 ] '
        "&& { __remote_host_dead=exited; break; }\n"
        "  __remote_host_left=$((__remote_host_left - 2))\n"
        "done\n"
        # The payload's own streams, unmodified — no terminal in the path.
        + emit_stream(out, "1", args.lines)
        + emit_stream(err, "2", args.lines)
        + 'if [ "$__remote_host_dead" = exited ]; then\n'
        f'  __remote_host_st=$("$MUX" display-message -p -t {session} \'#{{pane_dead_status}}\' 2>/dev/null)\n'
        f'  "$MUX" capture-pane -t {session} -p -S - 2>/dev/null | grep -v "^[[:space:]]*$" | tail -n 20 >&2\n'
        f'  "$MUX" kill-session -t {session} 2>/dev/null\n'
        '  echo "remote-host: the session shell exited (status ${__remote_host_st:-?}); its state is gone, '
        'the next send starts fresh" >&2\n'
        '  exit "${__remote_host_st:-1}"\n'
        'elif [ "$__remote_host_dead" = gone ]; then\n'
        f'  if [ -f {rc} ]; then echo "remote-host: session cancelled or ended" >&2; exit "$(cat {rc})"; fi\n'
        '  echo "remote-host: the session disappeared while waiting; result lost" >&2; exit 125\n'
        'elif [ -z "$__remote_host_ok" ]; then\n'
        f'  echo "remote-host: still running after {args.timeout}s — watch it with: remote-host peek" >&2; exit 124\n'
        "fi\n"
        f'[ -f {rc} ] || {{ echo "remote-host: result missing; call lost" >&2; exit 125; }}\nexit "$(cat {rc})"\n'
    )
    code = run_remote(host, script)
    if code:
        print(f"remote-host: {host} ({name}) exit {code}", file=sys.stderr)
    return code


def cmd_peek(args):
    host, session = host_of(args), check_session(args.session)
    tag = f"{host}/{session}"
    out, err = (f"~/.cache/remote-host/{session}.$__remote_host_call.{x}" for x in ("out", "err"))
    script = (
        PRELUDE
        + find_mux()
        + f'"$MUX" has-session -t {session} 2>/dev/null || '
        + f'{{ echo "remote-host: no session {session} on {host} yet, start one with: remote-host send" >&2; exit 1; }}\n'
        # The pane's foreground command tells a finished job from a running one.
        + f"__remote_host_call=$(cat ~/.cache/remote-host/{session}.current 2>/dev/null)\n"
        + f"__remote_host_cur=$(\"$MUX\" display-message -p -t {session} '#{{pane_current_command}}')\n"
        + f'[ -d ~/.cache/remote-host/{session}.busy ] && __remote_host_cur=running\n'
        + f'case "$__remote_host_cur" in bash|sh|fish|zsh) echo "[{tag}] idle";; '
        + f'*) echo "[{tag}] busy: $__remote_host_cur";; esac\n'
        # Read the job's own streams, not the terminal's rendering of them.
        + f"[ -s {out} ] && tail -n {args.lines} {out}\n"
        + f'[ -s {err} ] && {{ echo "-- stderr --"; tail -n {args.lines} {err}; }} >&2\n'
        + "true\n"
    )
    return run_remote(host, script)


def cmd_reset(args):
    session = check_session(args.session)
    script = (
        PRELUDE + find_mux()
        + f'if "$MUX" has-session -t {session} 2>/dev/null; then\n'
        + f'  "$MUX" kill-session -t {session} || {{ echo "remote-host: cancellation failed; lock retained" >&2; exit 125; }}\n'
        + '  __remote_host_reset=143\nelse __remote_host_reset=125; fi\n'
        + f'if [ -f ~/.cache/remote-host/{session}.busy/rc ]; then __remote_host_rc=$(cat ~/.cache/remote-host/{session}.busy/rc); printf "%s\n" "$__remote_host_reset" > "$__remote_host_rc"; fi\n'
        + f'rm -f ~/.cache/remote-host/{session}.busy/rc; rmdir ~/.cache/remote-host/{session}.busy 2>/dev/null; echo "remote-host: session reset; result $__remote_host_reset"\n'
        + 'if [ "$__remote_host_reset" = 125 ]; then echo "remote-host: session missing; previous call lost, stale lock cleared" >&2; exit 125; fi\n'

    )
    return run_remote(host_of(args), script)


def cmd_attach(args):
    inner = f"exec tmux new -A -s {args.session}"
    return subprocess.run(
        ["ssh", "-A", "-t", host_of(args), "bash", "-lc", inner]
    ).returncode
