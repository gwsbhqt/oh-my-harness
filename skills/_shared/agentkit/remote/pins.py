"""Each tool's own default machine: the pin file, its lock, and the use/pin/hosts commands."""

import fcntl
import json
import os
import sys
import threading
import uuid
from contextlib import contextmanager

from . import ssh


def pin_file(tool):
    return ssh.state_dir(tool) / "pin.json"


def read_pin(tool):
    path = pin_file(tool)
    try:
        text = path.read_text()
    except FileNotFoundError:
        return {}
    try:
        pin = json.loads(text)
    except ValueError as exc:
        raise ValueError(f"{tool}: invalid target settings in {path}") from exc
    if not isinstance(pin, dict):
        raise ValueError(f"{tool}: target settings must be an object: {path}")
    if "host" in pin and (not isinstance(pin["host"], str) or not pin["host"].strip()):
        raise ValueError(f"{tool}: invalid default host in {path}")
    hosts = pin.get("hosts", {})
    if not isinstance(hosts, dict) or any(
        not isinstance(name, str) or not name.strip() or not isinstance(settings, dict)
        for name, settings in hosts.items()
    ):
        raise ValueError(f"{tool}: invalid per-host settings in {path}")
    for settings in hosts.values():
        for key in ("interp", "cwd"):
            if key in settings and not isinstance(settings[key], str):
                raise ValueError(f"{tool}: invalid {key} in {path}")
        if "proxy" in settings and not isinstance(settings["proxy"], bool):
            raise ValueError(f"{tool}: invalid proxy in {path}")
    return pin


_pin_threads = threading.local()
_pin_guard = threading.RLock()


@contextmanager
def pin_lock(tool):
    """Serialize an entire default-target update across threads and processes."""
    with _pin_guard:
        active = getattr(_pin_threads, "active", set())
        if tool in active:
            yield
            return
        path = pin_file(tool)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            _pin_threads.active = active | {tool}
            yield
        finally:
            _pin_threads.active = active
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def write_pin(pin, tool):
    with pin_lock(tool):
        path = pin_file(tool)
        temp = path.with_name("." + path.name + "." + uuid.uuid4().hex)
        try:
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(json.dumps(pin) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def cmd_use(args):
    with pin_lock(args.tool):
        return _use_locked(args)


def _use_locked(args):
    tool = args.tool
    pin = read_pin(tool)
    hosts = pin.setdefault("hosts", {})
    if args.clear:
        if args.name:
            hosts.pop(args.name, None)
            if pin.get("host") == args.name:
                pin.pop("host")
            write_pin(pin, tool)
            print(f"{tool}: forgot {args.name}")
        else:
            pin_file(tool).unlink(missing_ok=True)
            print(f"{tool}: nothing pinned")
        return 0
    if not args.name and not args.interp and not args.cwd and not args.proxy and not args.no_proxy:
        current = pin.get("host")
        print(f"host:   {current or ('none' if tool == 'remote-host' else 'local')}")
        if tool != "remote-host":
            return 0
        mine = hosts.get(current, {})
        print(f"interp: {mine.get('interp') or 'bash (default)'}")
        print(f"cwd:    {mine.get('cwd') or 'home (default)'}")
        for name, other in sorted(hosts.items()):
            if name != current and other:
                print(f"also:   {name} / {other.get('interp') or 'bash'} / {other.get('cwd') or 'home'}")
        return 0
    if args.name == "local":
        if args.interp or args.cwd or args.proxy or args.no_proxy:
            raise ValueError(f"{tool}: local cannot pin remote interpreter, directory or proxy")
        pin.pop("host", None)
        write_pin(pin, tool)
        print(f"{tool}: nothing pinned" if tool == "remote-host" else f"{tool}: pinned local")
        return 0
    if args.name:
        if args.name not in ssh.known_hosts():
            raise ValueError(f"{tool}: unknown host {args.name!r} — add it to ~/.ssh/config")
        pin["host"] = args.name
    host = pin.get("host")
    if not host:
        sys.exit("remote-host: no host to pin -i/-C for — name one: remote-host use <host> ...")
    mine = hosts.setdefault(host, {})
    if args.interp:
        mine["interp"] = args.interp
    if args.cwd:
        mine["cwd"] = args.cwd
    if args.proxy:
        mine["proxy"] = True
    if args.no_proxy:
        mine.pop("proxy", None)
    write_pin(pin, tool)
    if tool == "remote-host":
        print(f"remote-host: pinned {host} / {mine.get('interp') or 'bash'}"
              f"{' / ' + mine['cwd'] if mine.get('cwd') else ''}")
    else:
        print(f"{tool}: 默认主机已设为 {host}")
    return 0


def cmd_hosts(args):
    pinned = read_pin(args.tool).get("host")
    if args.tool != "remote-host":
        print("local  (pinned)" if not pinned or pinned == "local" else "local")
    for name in ssh.known_hosts():
        print(f"{name}  (pinned)" if name == pinned else name)
    return 0
