"""Why a host is unreachable or awkward, each failure with its fix."""

import subprocess

from agentkit.remote.reach import LOCAL_NETWORK_BLOCKED, tcp_probe
from agentkit.remote.ssh import PRELUDE, SSH_OPTS, lan_proxy, relay, run_remote, ssh_config

from .core import host_of, parse_kv


def cmd_doctor(args):
    import socket

    host = host_of(args)
    conf = ssh_config(host)
    name, port, user = conf.get("hostname", host), int(conf.get("port", 22)), conf.get("user", "?")
    ok = True

    def say(good, label, detail="", fix=""):
        nonlocal ok
        ok = ok and good
        print(f"  {'✓' if good else '✗'} {label}" + (f": {detail}" if detail else ""))
        if not good and fix:
            print(f"      fix: {fix}")

    print(f"{host} → {user}@{name}:{port}")
    if relay(conf):
        # Probing the address from here would hit whatever shares it on this network, not the host.
        print(f"  · reached through {relay(conf)} — address and port are not probed from here")
    else:
        try:
            family = {"inet": socket.AF_INET, "inet6": socket.AF_INET6}.get(
                conf.get("addressfamily"), socket.AF_UNSPEC)
            addr = socket.getaddrinfo(name, port, family=family, proto=socket.IPPROTO_TCP)[0][4][0]
            say(True, "resolves", addr)
        except OSError as e:
            say(False, "resolves", str(e), "check the HostName in ~/.ssh/config, or that you are on the right network")
            return 1
        state, detail = tcp_probe(addr, port, 5, banner=True)
        if state != "open":
            say(False, f"port {port} open", detail,
                "on a Mac: System Settings → General → Sharing → Remote Login; otherwise wrong network or firewall")
            return 1
        say(True, f"port {port} open", detail)
    if LOCAL_NETWORK_BLOCKED["python"]:
        print("  · python here may not use the LAN (macOS Local Network privacy for the app that started it); "
              "probed through /bin/bash instead — ssh itself is exempt")
    known = subprocess.run(["ssh-keygen", "-F", name if port == 22 else f"[{name}]:{port}"],
                           capture_output=True, text=True).stdout.strip()
    say(bool(known), "host key known", "" if known else "first connection will record it",
        "") if known else print("  · host key not yet in known_hosts (recorded on first connect)")
    probe = subprocess.run(["ssh", *SSH_OPTS, "-o", "ConnectTimeout=8",
                            "-o", "ControlMaster=no", "-o", "ControlPath=none", host, "true"],
                           capture_output=True, text=True)
    if probe.returncode != 0:
        why = probe.stderr.strip().splitlines()[-1] if probe.stderr.strip() else f"exit {probe.returncode}"
        fix = ("先核对实际目标、IPv4/IPv6 和服务端 AllowUsers 来源限制；"
               "publickey 拒绝不证明缺密钥。确认来源获准后再检查既有磁盘密钥或 SSH agent"
               if "publickey" in why else
               "a Kerberos host needs a fresh ticket: kauth" if "gssapi" in why.lower() else "")
        if "REMOTE HOST IDENTIFICATION HAS CHANGED" in probe.stderr:
            fix = f"the host was reinstalled: ssh-keygen -R {name}, then connect again"
        say(False, "login", why, fix)
        return 1
    say(True, "login", "key/ticket accepted")
    try:
        proxy = lan_proxy(host)
    except OSError as exc:
        proxy = None
        proxy_why = str(exc)
    remote = run_remote(host, PRELUDE + (
        'echo "shell=$(basename "${SHELL:-?}")"\n'
        'sudo -n true 2>/dev/null && echo sudo=yes || echo sudo=no\n'
        'for c in brew mise python3 zstd tmux; do command -v $c >/dev/null && echo "has_$c=yes" || echo "has_$c=no"; done\n'
        + (f'(exec 3<>/dev/tcp/{proxy.replace(":", "/")}) 2>/dev/null && echo proxy=yes || echo proxy=no\n' if proxy else '')
    ), capture=True)
    kv = {k: v[0] for k, v in parse_kv(remote.stdout.decode(errors="replace")).items()}
    say(True, "login shell", kv.get("shell", "?") + (" — use remote-host run (bash) or -i fish; a bare ssh 'cmd' is parsed by fish"
                                                    if kv.get("shell") == "fish" else ""))
    say(kv.get("sudo") == "yes", "passwordless sudo", "" if kv.get("sudo") == "yes" else "installs and chsh will prompt",
        "on the host: remotelogin sudo (kept on)")
    tools = [c for c in ("brew", "mise", "python3", "zstd") if kv.get(f"has_{c}") == "yes"]
    print(f"  · tools on PATH: {' '.join(tools) or 'none'}")
    print(f"  · tmux: {'yes' if kv.get('has_tmux') == 'yes' else 'no — remote-host send/peek unavailable; remote-host job works without it. remote-host onboard <alias> installs it'}")
    print("  · this machine's proxy from the host (remote-host -P): " + (f"{proxy} reachable" if kv.get("proxy") == "yes" else
          f"{proxy} unreachable — is Clash on this machine allowing LAN?" if proxy else f"unavailable ({proxy_why})"))
    return 0 if ok else 1
