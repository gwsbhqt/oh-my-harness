"""remote-host's own plumbing: interpreters, the persistent session, payload dependencies, usage log.

The SSH layer and the per-tool default machine live in agentkit.remote.
"""

import json
import os
import re
import shlex
import hashlib
import sys
import time
import uuid
from pathlib import Path

from agentkit.remote.pins import read_pin
from agentkit.remote.ssh import EOF_MARK, known_hosts, path_line, state_dir


#: The command-line entry point; fan-out re-invokes it once per host.
from .. import _CLI_ENTRY as ENTRY

# The done marker is drawn fresh per call, so payload output can never collide
# with it; DONE_RE is what recognises any of them afterwards.
DONE_RE = "__REMOTE_HOST_[0-9A-F]\\{8\\}__="


def new_mark():
    return "__REMOTE_HOST_" + uuid.uuid4().hex[:8].upper() + "__"


# How each interpreter is invoked and what a payload file is called.
# A shell interpreter can also host the persistent session's pane.
INTERPRETERS = {
    "powershell": {"cmds": ["powershell.exe"], "ext": "ps1", "shell": False},
    "pwsh": {"cmds": ["pwsh.exe"], "ext": "ps1", "shell": False},
    "bash": {"cmds": ["bash -l"], "ext": "sh", "shell": True, "status": "$?"},
    "fish": {"cmds": ["fish -l"], "ext": "fish", "shell": True, "status": "$status"},
    "zsh": {"cmds": ["zsh -l"], "ext": "zsh", "shell": True, "status": "$?"},
    "sh": {"cmds": ["sh"], "ext": "sh", "shell": True, "status": "$?"},
    "python": {"cmds": ["python3"], "ext": "py", "shell": False},
    # bun first: it is the more compatible runtime, node is the fallback.
    "js": {"cmds": ["bun", "node"], "ext": "js", "shell": False},
    "bun": {"cmds": ["bun"], "ext": "js", "shell": False},
    "node": {"cmds": ["node"], "ext": "js", "shell": False},
}


ALIASES = {"py": "python", "python3": "python", "javascript": "js"}


CHOICES = sorted(set(INTERPRETERS) | set(ALIASES))


def resolve_interp(spec, var="__remote_host_run"):
    """Shell that resolves the first candidate the host has, to an absolute path.

    Absolute matters: a pane inherits the multiplexer server's PATH, not ours.
    """
    lines = [f"{var}="]
    for cand in spec["cmds"]:
        parts = cand.split()
        flags = (" " + " ".join(parts[1:])) if len(parts) > 1 else ""
        lines.append(
            f'[ -z "${var}" ] && __remote_host_p=$(command -v {parts[0]} 2>/dev/null) && '
            f'{var}="$__remote_host_p{flags}"'
        )
    names = " ".join(c.split()[0] for c in spec["cmds"])
    lines.append(
        f'[ -n "${var}" ] || {{ echo "remote-host: none of [{names}] found on this host" >&2; '
        "__remote_host_missing=1; }"
    )
    return "\n".join(lines) + "\n"


def pane_path_line(pane):
    return path_line(pane["ext"] == "fish") + "; clear"


def find_mux():
    return 'MUX=$(command -v tmux) || { echo "remote-host: no tmux on this host" >&2; exit 127; }\n'


CALL = {}


KEYWORDS = {
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
    "case", "esac", "end", "function", "return", "local", "set", "export",
}


def log_file():
    return state_dir("remote-host") / "usage.jsonl"


def signature(body, interp):
    """A payload's shape: the verbs it runs, in order, deduped and capped.

    Two calls that do the same kind of work land on the same signature even when
    their paths and arguments differ, which is what makes counting them useful.
    """
    if not body:
        return "-"
    if interp not in ("bash", "fish", "sh", "zsh"):
        interp = os.path.basename(interp)
    if interp not in ("bash", "fish", "sh", "zsh"):
        return f"{interp}:script"
    verbs = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        for seg in re.split(r"[;|&]+|\$\(", line):
            seg = seg.strip()
            if not seg:
                continue
            tok = seg.split()[0].strip("(){}")
            if tok and tok not in KEYWORDS and re.fullmatch(r"[A-Za-z_][\w.:+-]*", tok):
                if not verbs or verbs[-1] != tok:
                    verbs.append(tok)
    return " ".join(verbs[:8]) or "-"


def log_call(args, code, started):
    if os.environ.get("REMOTE_HOST_NO_LOG") or args.cmd in ("stats", "use", "hosts"):
        return
    body = CALL.get("body", "")
    interp = CALL.get("interp", "")
    rec = {
        "ts": int(time.time()),
        "cmd": args.cmd,
        "host": CALL.get("host", ""),
        "interp": interp,
        "session": getattr(args, "session", ""),
        "ms": int((time.monotonic() - started) * 1000),
        "code": code,
        "bytes": len(body),
        "lines": body.count("\n") + 1 if body else 0,
        "sig": signature(body, interp),
        "hash": hashlib.sha1(body.encode()).hexdigest()[:10] if body else "",
        "head": body.strip().splitlines()[0][:120] if body.strip() else "",
    }
    try:
        f = log_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        if f.exists() and f.stat().st_size > 4_000_000:
            keep = f.read_text(errors="replace").splitlines()[-20000:]
            f.write_text("\n".join(keep) + "\n")
        with f.open("a") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def host_of(args):
    if not hasattr(args, "_remote_host_pin"):
        args._remote_host_pin = read_pin("remote-host")
    host = getattr(args, "host", None) or args._remote_host_pin.get("host")
    args.host = host
    CALL["pin"] = args._remote_host_pin
    CALL["host"] = host or ""
    if not host:
        sys.exit("remote-host: no host — pass -H <host>, or pin one with: remote-host use <host>")
    if host == "local":
        sys.exit("remote-host: local execution is not supported — choose a remote host")
    if host not in known_hosts():
        sys.exit(f"remote-host: unknown host {host!r} — add it to ~/.ssh/config")
    return host


def host_pin(host):
    """Read only this host's pinned directory and interpreter, never another host's."""
    pin = CALL.get("pin") if CALL.get("host") == host else None
    return (pin if pin is not None else read_pin("remote-host")).get("hosts", {}).get(host, {})


def cwd_of(args):
    return getattr(args, "cwd", None) or host_pin(host_of(args)).get("cwd")


def check_session(name):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name):
        sys.exit(f"remote-host: bad session name {name!r} — letters, digits, _ and - only")
    return name


FAMILIES = (
    (("python", "uv"), "python"),
    (("node", "bun", "deno"), "js"),
    (("bash",), "bash"),
    (("fish",), "fish"),
    (("zsh",), "zsh"),
    (("sh", "dash", "ash"), "sh"),
)


def custom_spec(path):
    """An interpreter given as a path — a project venv, a pinned runtime."""
    base = os.path.basename(path).lower()
    for prefixes, family in FAMILIES:
        if any(base.startswith(x) for x in prefixes):
            spec = dict(INTERPRETERS[family])
            flags = spec["cmds"][0].split()[1:]
            spec["cmds"] = [" ".join([path, *flags])]
            spec["name"] = base
            return spec
    return {"cmds": [path], "ext": "txt", "shell": False, "name": base}


def interp_of(args):
    name = getattr(args, "interp", None) or host_pin(host_of(args)).get("interp") or "bash"
    name = ALIASES.get(name, name)
    if name in INTERPRETERS:
        spec = INTERPRETERS[name]
    elif "/" in name:
        spec = custom_spec(name)
    else:
        sys.exit(f"remote-host: unknown interpreter {name!r} — one of {', '.join(CHOICES)}, or a path")
    CALL["interp"] = name
    return name, spec


def read_body(parts):
    # One argument is a script; several are argv words whose quoting the local shell already removed.
    text = (parts[0] if len(parts) == 1 else shlex.join(parts)) if parts else sys.stdin.read()
    CALL["body"] = text
    text = text.strip("\n")
    if not text.strip():
        sys.exit("remote-host: nothing to run")
    if EOF_MARK in text:
        sys.exit(f"remote-host: payload may not contain {EOF_MARK}")
    return text


def deps_of(args):
    out = []
    for item in getattr(args, "with_", None) or []:
        out += [d.strip() for d in item.split(",") if d.strip()]
    return out


def build_exec(spec, deps):
    """Shell that leaves the full interpreter command line in $__remote_host_exec.

    With deps on a Python payload it becomes a uv invocation, so the packages
    are fetched into an ephemeral environment instead of the host's site-packages.
    """
    script = resolve_interp(spec)
    if not deps:
        return script + '__remote_host_exec="$__remote_host_run"\n'
    if spec["ext"] != "py":
        return script + (
            'echo "remote-host: --with only applies to python payloads; bun installs '
            'missing JS imports on its own" >&2\n__remote_host_missing=1\n'
        )
    script += resolve_interp({"cmds": ["uv"]}, "__remote_host_uv")
    flags = " ".join(f"--with {shlex.quote(d)}" for d in deps)
    return script + (
        f'__remote_host_exec="$__remote_host_uv run --no-project --python $__remote_host_run {flags}"\n'
    )


def parse_kv(text):
    """`key=value` lines to an ordered dict; a repeated key keeps every value."""
    out = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k and re.fullmatch(r"[\w.\-/ ]+", k):
            out.setdefault(k, []).append(v.strip())
    return out


def split_loc(loc):
    """`host:path` or a local `path`. A drive-letter-free world: `a:b` is remote."""
    if re.match(r"^[\w.@-]+:", loc) and not loc.startswith("/"):
        h, p = loc.split(":", 1)
        return h, p or "~"
    return None, loc
