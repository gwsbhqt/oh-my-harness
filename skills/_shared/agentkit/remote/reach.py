"""Why ssh could not get through, told apart in a few seconds.

Away from home, asleep, a changed address and Remote Login switched off all
look the same from ssh: a timeout or `exit 255`. A real session spent several
rounds guessing which (2026-09-23). One name lookup, one TCP connect and the
route this machine would use tell them apart without running `doctor`.
"""

import errno
import ipaddress
import json
import os
import re
import socket
import subprocess
from pathlib import Path

from .ssh import SSH_OPTS, relay, ssh_config

#: Set once a probe had to go around Python: macOS Local Network privacy
#: blocks LAN connects from interpreters started under an app that was not
#: granted it (an Electron desktop app, 2026-09-23: python and node got EHOSTUNREACH for
#: every private-network host while the router, the internet, ssh and /bin/bash
#: all worked). Apple's own binaries are exempt, so /bin/bash is the witness.
LOCAL_NETWORK_BLOCKED = {"python": False}

_BASH_PROBE = (
    'exec 3<>"/dev/tcp/$1/$2" || exit 1\n'
    '[ "$3" = 1 ] && IFS= read -r -t "$4" __l <&3 && printf "%s" "$__l"\n'
    "exit 0\n"
)


def _bash_probe(addr, port, timeout, banner):
    try:
        done = subprocess.run(["/bin/bash", "-c", _BASH_PROBE, "probe", addr, str(port),
                               "1" if banner else "0", str(timeout)],
                              capture_output=True, text=True, timeout=timeout + 1)
    except (subprocess.TimeoutExpired, OSError):
        return "timeout", "timed out"
    if done.returncode == 0:
        return "open", done.stdout.strip()
    err = done.stderr.lower()
    if "refused" in err:
        return "refused", "Connection refused"
    return "error", done.stderr.strip().rsplit(": ", 1)[-1] or f"exit {done.returncode}"


def tcp_probe(addr, port, timeout=4, banner=False):
    """(state, detail) of one TCP connect: state is open | refused | timeout |
    error; detail is the banner line when open and asked for, else the reason.
    A private address that Python cannot route to is tried again through
    /bin/bash before it counts as unreachable."""
    try:
        with socket.create_connection((addr, port), timeout=timeout) as s:
            text = ""
            if banner:
                s.settimeout(timeout)
                text = s.recv(64).decode(errors="replace").strip()
            return "open", text
    except ConnectionRefusedError:
        return "refused", "Connection refused"
    except (socket.timeout, TimeoutError):
        return "timeout", "timed out"
    except OSError as e:
        first = ("error", e.strerror or str(e))
        if e.errno not in (errno.EHOSTUNREACH, errno.ENETUNREACH):
            return first
    try:
        private = ipaddress.ip_address(addr).is_private
    except ValueError:
        private = False
    if not private:
        return first
    state, detail = _bash_probe(addr, port, timeout, banner)
    if state in ("open", "refused"):
        LOCAL_NETWORK_BLOCKED["python"] = True
        return state, detail
    return first


def local_addr_towards(addr):
    """The source address this machine would use to reach addr (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET6 if ":" in addr else socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((addr, 9))
            return s.getsockname()[0]
    except OSError:
        return None


def network_name(mine):
    """Return an optional label from the user's remote-host/networks.json."""
    config = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "remote-host" / "networks.json"
    try:
        networks = json.loads(config.read_text())
    except FileNotFoundError:
        return None
    if not isinstance(networks, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in networks.items()):
        raise ValueError(f"{config}: expected a JSON object mapping CIDRs to labels")
    parsed = [(ipaddress.ip_network(net), name) for net, name in networks.items()]
    try:
        addr = ipaddress.ip_address(mine)
    except ValueError:
        return None
    return next((name for net, name in parsed if addr in net), None)


def same_lan(addr, mine):
    """Whether two addresses share an IPv4 /24 or IPv6 /64 prefix."""
    try:
        a, b = ipaddress.ip_address(addr), ipaddress.ip_address(mine)
    except ValueError:
        return False
    if a.version != b.version:
        return False
    prefix = 24 if a.version == 4 else 64
    return ipaddress.ip_network(f"{addr}/{prefix}", strict=False) == ipaddress.ip_network(f"{mine}/{prefix}", strict=False)


#: `ProxyCommand ssh [opts] <relay> nc ...`: the host is reached from <relay>, not from here.
_RELAY = re.compile(r"\bssh\b(?:\s+-\S+)*\s+(\S+)\s+nc\b")


def _ssh_reaches(host, timeout):
    """Whether ssh itself gets through to host's sshd; a refused key still proves the network works."""
    try:
        done = subprocess.run(["ssh", *SSH_OPTS, "-o", f"ConnectTimeout={timeout * 2}", host, "true"],
                              capture_output=True, text=True, timeout=timeout * 4)
    except subprocess.TimeoutExpired:
        return False
    return done.returncode == 0 or "permission denied" in done.stderr.lower()


def _relayed(host, conf, name, port, timeout):
    """Cause for a host ssh reaches through a relay or a local proxy, where
    probing its address from here would test the wrong network."""
    if _ssh_reaches(host, timeout):
        return None
    command = conf.get("proxycommand", "none")
    relay = conf.get("proxyjump", "none")
    if relay == "none":
        m = _RELAY.search(command)
        relay = m.group(1) if m else None
    if relay:
        why = diagnose(relay, timeout)
        if why:
            return f"it is reached through {relay}, and {relay} is not reachable: {why}"
        return (f"{relay} answers, but {relay} cannot get to {name}:{port} — the machine is asleep or off, "
                f"or not on {relay}'s LAN (remote-host -H {relay} discover lists what it sees)")
    m = re.search(r"(\d+\.\d+\.\d+\.\d+):(\d+)", command)
    if m and tcp_probe(m.group(1), int(m.group(2)), timeout)[0] != "open":
        return f"it goes through the local proxy {m.group(0)}, and nothing listens there — Clash is not running"
    return (f"it goes through `{command}`, which answered but did not get to {name}:{port} — "
            "the hop behind the proxy (the home entry, or what the far end allows) is where it stops")


def diagnose(host, timeout=4):
    """One line naming the likely cause, or None when the port answers (then it
    is login or the payload, not the network)."""
    conf = ssh_config(host)
    name, port = conf.get("hostname", host), int(conf.get("port", 22) or 22)
    if relay(conf):
        return _relayed(host, conf, name, port, timeout)
    try:
        addresses = list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(name, port, proto=socket.IPPROTO_TCP)))
        if not addresses:
            raise OSError("no address candidates")
    except OSError:
        where = "the same LAN (a .local name only resolves there; remote-host discover lists what is visible)" \
            if name.endswith(".local") else "a network whose DNS knows it"
        return f"{name} does not resolve — this machine is not on {where}"
    results = [(addr, *tcp_probe(addr, port, timeout)) for addr in addresses]
    if any(state == "open" for _, state, _ in results):
        return None
    addr, state, why = next((result for result in results if result[1] == "refused"), results[0])
    if state == "refused":
        return (f"{addr} is up but refuses port {port} — Remote Login is off "
                "(System Settings → General → Sharing → Remote Login)")
    mine = local_addr_towards(addr)
    if ipaddress.ip_address(addr).is_private and mine and not same_lan(addr, mine):
        where = network_name(mine)
        here = f"{mine}, {where}" if where else mine
        return (f"{addr}:{port} {why}, and this machine ({here}) is not on that LAN — "
                "you are away from it; it is reachable only from there (or over a VPN/mesh)")
    return (f"{addr}:{port} {why} — the machine is asleep or off, or its address changed "
            "(remote-host discover finds it again on the LAN; remote-host -H <host> doctor for the full check)")
