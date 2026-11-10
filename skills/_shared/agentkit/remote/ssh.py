"""Real ssh calls shared by remote-host, computer-control, dsh-control and browser-control: options, PATH prelude, payload staging, LAN proxy, failure hints."""

import os
import re
import shlex
import socket
import subprocess
import sys
import uuid
from pathlib import Path

SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]

EOF_MARK = "__REMOTE_HOST_EOF__"

# A non-interactive login shell sees neither Homebrew nor mise, so the toolchain
# the host is actually configured with would be invisible. Listed low to high:
# mise comes last and therefore wins, since it owns the runtime versions.
TOOL_DIRS = (
    "/home/linuxbrew/.linuxbrew/bin /opt/homebrew/bin /usr/local/bin "
    '"$HOME/.local/bin" "$HOME/.local/share/mise/shims"'
)

PRELUDE = (
    f"for __remote_host_d in {TOOL_DIRS}; do "
    '[ -d "$__remote_host_d" ] && PATH="$__remote_host_d:$PATH"; done; unset __remote_host_d; export PATH\n'
    # No tty means programs fall back to 80x24 and wrap their tables into
    # something unparseable; a payload can still override these itself.
    'export COLUMNS="${COLUMNS:-200}" LINES="${LINES:-50}"\n'
)


def state_dir(tool):
    """This tool's local state directory, e.g. ~/.local/state/computer-control."""
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / tool


def path_line(fish=False):
    """One-liner that puts the host's real toolchain on PATH, in sh or fish syntax.

    A login shell re-reads the system profile and drops whatever PATH we exported,
    so every shell payload has to reapply this itself.
    """
    if fish:
        return f"for d in {TOOL_DIRS}; test -d $d; and set -gx PATH $d $PATH; end"
    return f'for d in {TOOL_DIRS}; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH'


def remote_dir(path):
    """A remote directory as a shell word. A leading ~ is the REMOTE home, so it
    must reach the host unquoted — `shlex.quote("~")` makes `cd` look for a
    directory literally named ~."""
    if path == "~":
        return '"$HOME"'
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    return shlex.quote(path)


def stash_here(path, body):
    mark = EOF_MARK
    while mark in body.splitlines():
        mark = EOF_MARK + uuid.uuid4().hex
    return f"(umask 077; cat > {path} <<'{mark}'\n{body}\n{mark}\n) || exit $?\n"


def ssh_hint(code, host, detail=None):
    """Explain transport failures without replacing SSH's actual error with a guess."""
    if code != 255:
        return code
    if detail is None:
        print(f"remote-host: {host} 退出 255；以上 SSH 错误或远端退出状态是判断依据，可运行 remote-host -H {host} doctor 进一步检查", file=sys.stderr)
        from .reach import diagnose
        why = diagnose(host)
        if why:
            print(f"remote-host: cannot reach {host}: {why}", file=sys.stderr)
        return code
    text = detail.decode(errors="replace") if isinstance(detail, bytes) else str(detail)
    lowered = text.lower()
    if any(word in lowered for word in ("host key verification failed", "remote host identification has changed")):
        print(f"remote-host: {host} 主机身份校验失败；核实远端指纹后登记，未绕过 SSH 身份校验", file=sys.stderr)
    elif any(word in lowered for word in ("permission denied", "authentication failed", "no supported authentication")):
        print(f"remote-host: {host} 登录认证失败；先核对实际目标、IPv4/IPv6 与服务端 AllowUsers 来源限制，"
              "再检查既有磁盘密钥、SSH agent 或 Kerberos 票据；publickey 拒绝不证明缺密钥", file=sys.stderr)
    elif any(word in lowered for word in ("connection refused", "timed out", "no route to host", "could not resolve hostname",
                                           "connection closed by unknown", "kex_exchange_identification")):
        from .reach import diagnose
        why = diagnose(host)
        if why:
            print(f"remote-host: cannot reach {host}: {why}", file=sys.stderr)
    return code


PROXY = {"on": False}


def lan_proxy(host):
    """This machine's proxy as the host dials it: REMOTE_HOST_PROXY, else this machine's
    LAN address toward the host plus the Clash mixed port. This path requires
    direct LAN reachability; reverse SSH forwarding is handled by proxy.py."""
    if os.environ.get("REMOTE_HOST_PROXY"):
        return os.environ["REMOTE_HOST_PROXY"]
    conf = ssh_config(host)
    if relay(conf):
        raise OSError(f"{host} is reached through {relay(conf)}, so it cannot dial this machine back; it uses its own network")
    name = conf.get("hostname") or host
    # IPv4 on purpose: a .local name tends to resolve to an IPv6 link-local
    # address with a zone id, which proxy URLs cannot carry.
    ip = socket.getaddrinfo(name, 22, socket.AF_INET)[0][4][0]
    # A UDP connect sends nothing; it only asks the routing table which local
    # address faces the host, and the LAN route beats Clash's TUN routes.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((ip, 22))
        return f"{s.getsockname()[0]}:7890"


def proxy_prelude(host):
    if not PROXY["on"]:
        return ""
    try:
        url = f"http://{lan_proxy(host)}"
    except OSError as exc:
        sys.exit(f"remote-host: --proxy needs {host} on this machine's LAN ({exc}); or set REMOTE_HOST_PROXY=addr:port")
    if any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise ValueError("proxy URL must not contain control characters")
    quoted = shlex.quote(url)
    return (
        f"export http_proxy={quoted} https_proxy={quoted} all_proxy={quoted} "
        f"HTTP_PROXY={quoted} HTTPS_PROXY={quoted} ALL_PROXY={quoted}\n"
    )


def remote_argv(host, command="bash -l -s"):
    return ["ssh", *SSH_OPTS, host, command]


def run_remote(host, script, capture=False):
    script = proxy_prelude(host) + script
    if capture:
        # capture="stdout" lets stderr through live, so ssh's own error reads
        # before the diagnosis of it.
        streams = {"stdout": subprocess.PIPE} if capture == "stdout" else {"capture_output": True}
        done = subprocess.run(remote_argv(host), input=script.encode(), **streams)
        ssh_hint(done.returncode, host, done.stderr if capture != "stdout" else None)
        return done
    return ssh_hint(
        subprocess.run(remote_argv(host), input=script.encode()).returncode,
        host,
    )


def relay(conf):
    """The ProxyJump or ProxyCommand ssh goes through for this host, or None when it dials the address itself."""
    for key in ("proxyjump", "proxycommand"):
        if conf.get(key, "none") != "none":
            return conf[key]
    return None


def ssh_config(host):
    done = subprocess.run(["ssh", "-G", host], capture_output=True, text=True)
    conf = {}
    for line in done.stdout.splitlines():
        k, _, v = line.partition(" ")
        conf.setdefault(k, v)
    return conf


def known_hosts():
    seen = []
    for path in _config_files(Path.home() / ".ssh" / "config"):
        for line in path.read_text(errors="replace").splitlines():
            m = re.match(r"\s*Host\s+(\S.*)$", line, re.IGNORECASE)
            if not m:
                continue
            for name in m.group(1).split():
                if "*" not in name and "?" not in name and name not in seen:
                    seen.append(name)
    return seen


def _config_files(path, depth=0):
    if not path.is_file() or depth > 3:
        return
    yield path
    for line in path.read_text(errors="replace").splitlines():
        m = re.match(r"\s*Include\s+(\S.*)$", line, re.IGNORECASE)
        if not m:
            continue
        for pattern in m.group(1).split():
            base = Path(os.path.expanduser(pattern))
            if not base.is_absolute():
                base = path.parent / base
            for hit in sorted(base.parent.glob(base.name)):
                yield from _config_files(hit, depth + 1)
