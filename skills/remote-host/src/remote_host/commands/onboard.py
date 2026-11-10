"""First contact with a machine: find it on the LAN, get SSH working, pin it.

The 2026-09-23 session spent ~45 cells before its first successful login to a
home Mac — guessing which IP was which, reading ports with an unreliable `nc`,
probing usernames, writing an expect script to type a password, deriving a
missing .pub, adding the ssh alias by hand — then did it all again for the
next Mac. `discover` and `onboard` are that work, done once and idempotently.
"""

import os
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from agentkit.remote.ssh import PRELUDE, SSH_OPTS, known_hosts, run_remote

#: Bonjour services a Mac announces. `_ssh._tcp` appears only when Remote Login
#: is on; `_companion-link._tcp` (Continuity) is announced regardless, which is
#: what tells "a Mac is there but SSH is off" apart from "no such machine".
SERVICES = {"_ssh._tcp": "ssh", "_companion-link._tcp": "mac", "_rfb._tcp": "screen"}

KEY = Path.home() / ".ssh" / "id_ed25519"

#: tmux, installed only when absent: Homebrew first, then a system package manager
#: only through `sudo -n` — onboard runs unattended, so a password prompt counts as
#: "cannot install".
MUX_LOG = "/tmp/remote-host-mux-install.log"
MUX_SCRIPT = (
    "HOMEBREW_NO_AUTO_UPDATE=1; export HOMEBREW_NO_AUTO_UPDATE\n"
    'has() { command -v "$1" >/dev/null 2>&1; }\n'
    f'try_brew() {{ has brew && brew install "$1" >>{MUX_LOG} 2>&1 && has "$1"; }}\n'
    "try_sys() {\n"
    "  sudo -n true 2>/dev/null || return 1\n"
    '  if has apt-get; then sudo -n apt-get update -qq && sudo -n apt-get install -y "$1"\n'
    '  elif has dnf; then sudo -n dnf install -y "$1"\n'
    '  elif has yum; then sudo -n yum install -y "$1"\n'
    f'  else return 1; fi >>{MUX_LOG} 2>&1\n'
    '  has "$1"\n'
    "}\n"
    'if has tmux; then echo mux=tmux; exit 0; fi\n'
    'if try_brew tmux || try_sys tmux; then echo "mux=tmux installed"; exit 0; fi\n'
    "echo mux=none\n"
)


def browse(service, seconds=3):
    """Instance names announced for one Bonjour service type."""
    if sys.platform == "darwin":
        argv = ["dns-sd", "-B", service, "local."]
    else:
        argv = ["avahi-browse", "-pt", service]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=seconds).stdout
    except FileNotFoundError:
        return []
    except subprocess.TimeoutExpired as e:  # dns-sd never exits on its own
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
    return parse_browse(out, service)


def parse_browse(out, service):
    names = []
    for line in out.splitlines():
        if " Add " in line and service in line:
            # dns-sd: "... Add  3  1 local.  _ssh._tcp.  <instance name>"
            name = line.split(service + ".", 1)[-1].strip()
        elif line.startswith("+;"):  # avahi -p: +;if;proto;name;type;domain
            parts = line.split(";")
            name = parts[3] if len(parts) > 4 else ""
        else:
            continue
        if name and name not in names:
            names.append(name)
    return names


def resolve_instance(name, service, seconds=3):
    """Instance name → (host.local, port)."""
    if sys.platform != "darwin":
        return None, None
    try:
        out = subprocess.run(["dns-sd", "-L", name, service, "local."],
                             capture_output=True, text=True, timeout=seconds).stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
    m = re.search(r"can be reached at (\S+?)\.?:(\d+)", out)
    return (m.group(1), int(m.group(2))) if m else (None, None)


def to_ip(hostname):
    try:
        return socket.getaddrinfo(hostname, None, socket.AF_INET)[0][4][0]
    except (OSError, IndexError):
        return None


def port_open(addr, port=22, timeout=3):
    """A real TCP connect — `nc -z` exit codes proved unreliable on this Mac."""
    from agentkit.remote.reach import tcp_probe

    state, detail = tcp_probe(addr, port, timeout, banner=True)
    return (detail or "open") if state == "open" else None


def guess_user(label):
    """`alexdeMac-alpha` / `alex的Mac alpha` → `alex`
    (macOS names a machine after its first account)."""
    m = re.match(r"(.+?)(?:de|的|'s[- ])\s*(?:Mac|MacBook|iMac)", label)
    # A Chinese display name (示例用户的Mac mini) is not the account name — the
    # account there is pinyin; only an ASCII guess is worth offering.
    user = re.sub(r"[^A-Za-z0-9_.-]", "", m.group(1)).lower() if m else ""
    return user or None


def discover(seconds=3):
    """Every machine announcing itself: name, address, and what is enabled."""
    found = {}
    lock = threading.Lock()

    def scan(service, what):
        for inst in browse(service, seconds):
            host, port = resolve_instance(inst, service)
            key = (host or inst).lower().removesuffix(".local")
            with lock:
                row = found.setdefault(key, {"name": inst, "host": host, "services": set(), "port": port})
                row["services"].add(what)
                row["host"] = row["host"] or host
                if what == "ssh":
                    row["port"] = port

    threads = [threading.Thread(target=scan, args=kv) for kv in SERVICES.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for row in found.values():
        row["ip"] = to_ip(row["host"]) if row["host"] else None
    return found


def aliases_for(ip, host):
    """ssh config aliases already pointing at this machine."""
    hits = []
    for alias in known_hosts():
        conf = subprocess.run(["ssh", "-G", alias], capture_output=True, text=True).stdout
        m = re.search(r"^hostname (\S+)", conf, re.M)
        if m and m.group(1) in {ip, host, (host or "") + ".local"}:
            hits.append(alias)
    return hits


def cmd_discover(args):
    rows = discover(args.seconds)
    if not rows:
        print("remote-host: nothing announced itself — is this machine on the same LAN? "
              "(Bonjour does not cross VPNs or subnets)")
        return 1
    print(f"{'machine':<28} {'address':<16} {'ssh':<5} {'alias':<10} user guess")
    for row in sorted(rows.values(), key=lambda r: r["ip"] or "~"):
        ssh = "on" if "ssh" in row["services"] else "OFF"
        alias = ",".join(aliases_for(row["ip"], row["host"])) or "-"
        user = guess_user(row["name"]) or guess_user(row["host"] or "") or "?"
        print(f"{row['name'][:28]:<28} {row['ip'] or '?':<16} {ssh:<5} {alias:<10} {user}")
    if any("ssh" not in r["services"] for r in rows.values()):
        print("\nssh OFF: the Mac is there but Remote Login is not enabled — "
              "remote-host onboard <alias> --ip <address> walks you through it.")
    return 0


# ── onboard ──────────────────────────────────────────────────────────────────

def say(step, msg):
    print(f"[{step}] {msg}", flush=True)


def ensure_pubkey():
    """ssh-copy-id needs the .pub; derive it from the private key when absent."""
    pub = KEY.with_suffix(".pub")
    if pub.exists():
        return pub
    if not KEY.exists():
        sys.exit(f"remote-host: no {KEY} — create one first: ssh-keygen -t ed25519")
    text = subprocess.run(["ssh-keygen", "-y", "-f", str(KEY)], capture_output=True, text=True, check=True).stdout
    pub.write_text(text)
    say("key", f"derived {pub} from the private key")
    return pub


def with_askpass(password, argv, **kw):
    """Run an ssh-family command that asks for a password, answering it from
    memory: OpenSSH reads SSH_ASKPASS when told to (SSH_ASKPASS_REQUIRE=force),
    so no tty and no expect script are needed. The password never appears on a
    command line; the helper only echoes an environment variable."""
    with tempfile.TemporaryDirectory() as tmp:
        helper = Path(tmp) / "askpass"
        helper.write_text('#!/bin/sh\nprintf "%s\\n" "$REMOTE_HOST_ASKPASS_SECRET"\n')
        helper.chmod(0o700)
        env = dict(os.environ, SSH_ASKPASS=str(helper), SSH_ASKPASS_REQUIRE="force",
                   DISPLAY=os.environ.get("DISPLAY", ":0"), REMOTE_HOST_ASKPASS_SECRET=password)
        return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, **kw)


def append_alias(alias, ip, user):
    cfg = Path.home() / ".ssh" / "config"
    if alias in known_hosts():
        return False
    block = (f"\nHost {alias}\n    HostName {ip}\n    User {user}\n"
             "    ControlMaster auto\n    ControlPath ~/.ssh/cm-%r@%h:%p\n    ControlPersist 2h\n"
             "    ServerAliveInterval 15\n    ServerAliveCountMax 3\n    ConnectTimeout 10\n")
    with cfg.open("a") as f:
        f.write(block)
    return True


def parse_mux(out):
    """`mux=tmux`, `mux=tmux installed`, `mux=none` → (name or None, installed)."""
    m = re.search(r"^mux=(\w+)( installed)?$", out, re.M)
    if not m:
        return None, False
    return (None if m.group(1) == "none" else m.group(1)), bool(m.group(2))


def ensure_mux(alias):
    done = run_remote(alias, PRELUDE + MUX_SCRIPT, capture=True)
    out = done.stdout.decode(errors="replace")
    return parse_mux(out) if "mux=" in out else ("?", False)


def cmd_onboard(args):
    alias = args.alias
    password = sys.stdin.readline().rstrip("\n") if args.password_stdin else None
    # 1. locate
    ip, label, conf_user, name_for_alias = args.ip, None, None, None
    if not ip and alias in known_hosts():
        conf = subprocess.run(["ssh", "-G", alias], capture_output=True, text=True).stdout
        ip = re.search(r"^hostname (\S+)", conf, re.M).group(1)
        conf_user = re.search(r"^user (\S+)", conf, re.M).group(1)
    if not ip:
        rows = discover(3)
        match = [r for r in rows.values() if alias.lower() in (r["name"] + (r["host"] or "")).lower()]
        if len(match) != 1:
            print("remote-host: cannot tell which machine is meant — pass --ip; what is on the LAN:")
            cmd_discover(args)
            return 1
        ip, label = match[0]["ip"], match[0]["name"]
        # The alias names the machine, not today's DHCP lease: a router moved
        # alpha from .11 to .10 mid-session (2026-09-23) and a fixed-IP alias died.
        host = match[0]["host"]
        name_for_alias = f"{host}.local" if host and not host.endswith(".local") else host
    addr = to_ip(ip) or ip
    user = args.user or conf_user or guess_user(label or "")
    if not user:
        sys.exit("remote-host: which account? pass --user (macOS short name: whoami on that Mac)")
    say("locate", f"{alias} = {user}@{addr}" + (f" ({label})" if label else ""))

    # 2. Remote Login
    banner = port_open(addr)
    if not banner:
        say("ssh", "port 22 is closed — Remote Login is off on that Mac. On it, either:")
        print("        System Settings → General → Sharing → Remote Login (on)\n"
              "        or in Terminal:  sudo systemsetup -setremotelogin on")
        if not args.wait:
            return 1
        say("ssh", f"waiting up to {args.wait}s for it to open …")
        deadline = time.time() + args.wait
        while not banner and time.time() < deadline:
            time.sleep(3)
            banner = port_open(addr)
        if not banner:
            return 124
    say("ssh", banner)

    # 3. host key
    if not subprocess.run(["ssh-keygen", "-F", addr], capture_output=True).stdout:
        keys = subprocess.run(["ssh-keyscan", "-t", "ed25519", "-T", "5", addr],
                              capture_output=True, text=True).stdout
        if keys.strip():
            with (Path.home() / ".ssh" / "known_hosts").open("a") as f:
                f.write(keys)
            fp = subprocess.run(["ssh-keygen", "-lf", "-"], input=keys, capture_output=True, text=True).stdout.split()
            say("hostkey", f"recorded {fp[1] if len(fp) > 1 else '(fingerprint unavailable)'}")

    # 4. key login
    target = f"{user}@{addr}"
    probe = lambda: subprocess.run(["ssh", *SSH_OPTS, "-o", "ControlPath=none", target, "true"],
                                   capture_output=True, text=True)
    first = probe()
    if first.returncode != 0:
        why = (first.stderr.strip().splitlines() or ["?"])[-1]
        if "publickey" not in why and "password" not in why:
            say("login", why)
            return 1
        pub = ensure_pubkey()
        if password is not None:
            done = with_askpass(password, ["ssh-copy-id", "-i", str(pub), "-o", "ControlPath=none", target],
                                capture_output=True, text=True)
            if done.returncode != 0:
                say("key", "ssh-copy-id failed: " + (done.stderr.strip().splitlines() or ["?"])[-1])
                return 1
            say("key", "installed this machine's key")
        else:
            say("key", "the key is not installed yet — it takes the account password ONCE. Either:")
            print(f"        run in your terminal:   ssh-copy-id -i {pub} {target}\n"
                  f"        or let remote-host type it:       printf '%s\\n' '<password>' | remote-host onboard {alias} "
                  f"--ip {addr} --user {user} --password-stdin\n"
                  "        (the second puts the password in this conversation's log)")
            return 1
        if probe().returncode != 0:
            say("login", "key installed but login still fails — check that account's ~/.ssh permissions")
            return 1
    say("login", "key accepted")

    # 5. alias
    if alias not in known_hosts():
        target_name = name_for_alias or addr
        append_alias(alias, target_name, user)
        if name_for_alias:
            # Record the host key under the name too, or the first connect by name asks again.
            keys = subprocess.run(["ssh-keyscan", "-T", "5", name_for_alias], capture_output=True, text=True).stdout
            if keys.strip() and not subprocess.run(["ssh-keygen", "-F", name_for_alias], capture_output=True).stdout:
                with (Path.home() / ".ssh" / "known_hosts").open("a") as f:
                    f.write("".join(l + "\n" for l in keys.splitlines() if l and not l.startswith("#")))
        say("alias", f"added Host {alias} → {target_name} to ~/.ssh/config")
    else:
        say("alias", f"{alias} already in ~/.ssh/config")

    # 6. passwordless sudo (only when asked: it changes the target's security)
    if args.sudo:
        rule = f"{user} ALL=(ALL) NOPASSWD: ALL"
        check = subprocess.run(["ssh", *SSH_OPTS, alias, "sudo -n true"], capture_output=True)
        if check.returncode == 0:
            say("sudo", "already passwordless")
        elif password is not None:
            cmd = (f"sudo -S -p '' sh -c {shlex.quote(f'echo {shlex.quote(rule)} > /etc/sudoers.d/{user}')} "
                   f"&& sudo -n true && echo sudo-ok")
            done = subprocess.run(["ssh", *SSH_OPTS, alias, cmd], input=password + "\n",
                                  capture_output=True, text=True)
            say("sudo", "enabled" if "sudo-ok" in done.stdout else "failed: " + done.stderr.strip()[-200:])
        else:
            say("sudo", f"on that Mac, once:  echo '{rule}' | sudo tee /etc/sudoers.d/{user}")
    # 7. session backend for send/peek/attach
    say("mux", "checking tmux (installs it when missing; brew can take a few minutes) …")
    mux, installed = ensure_mux(alias)
    if mux == "?":
        say("mux", f"could not check — remote-host -H {alias} doctor shows why")
    elif mux:
        say("mux", f"{'installed ' if installed else ''}{mux}")
    else:
        say("mux", "tmux could not be installed (no Homebrew, and no passwordless sudo "
                   f"for apt/dnf/yum; log on the host: {MUX_LOG}) — remote-host send/peek/attach are unavailable; "
                   "remote-host run and remote-host job work without one. Re-run onboard after installing Homebrew or "
                   "with --sudo to try again")
    say("done", f"ready: remote-host -H {alias} run … — remote-host -H {alias} doctor for the rest")
    return 0
