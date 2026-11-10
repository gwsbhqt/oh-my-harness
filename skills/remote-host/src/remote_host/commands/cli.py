"""Argument parsing and dispatch."""

import argparse
import asyncio
import sys
import time

from agentkit.remote.pins import cmd_hosts, cmd_use
from agentkit.remote.ssh import PROXY
from agentkit.remote.target import route

from .basic import cmd_get, cmd_put, cmd_run, cmd_status
from .config import cmd_stats
from .core import ALIASES, CHOICES, cwd_of, host_of, host_pin, interp_of, log_call, read_body
from .doctor import cmd_doctor
from .fanout import FAN_OUT, fan_out, strip_host
from .jobs import cmd_job
from .onboard import cmd_discover, cmd_onboard
from .ready import cmd_app, cmd_wait
from .session import cmd_attach, cmd_peek, cmd_reset, cmd_send, with_names
from .shot import cmd_screenshot
from .transfer import cmd_copy, cmd_manifest, cmd_verify


DESCRIPTION = "Drive a remote host over SSH: one-off scripts, a persistent session, files, jobs, copies."


def cmd_proxy_run(args):
    from .. import reverse_proxy, run

    if getattr(args, "with_", None):
        print("remote-host: proxy-run does not support --with; prepare payload dependencies first", file=sys.stderr)
        return 2
    body = read_body(args.command)
    host = host_of(args)
    interp, _ = interp_of(args)
    async def scoped_run():
        async with reverse_proxy(host=host, local_proxy=args.local_proxy,
                                 timeout=args.connect_timeout) as proxy:
            result = await run(body, host=host, interp=interp, cwd=cwd_of(args),
                               proxy=proxy, timeout=None)
            return result.code
    try:
        return asyncio.run(scoped_run())
    except (ValueError, OSError, RuntimeError) as exc:
        print(f"remote-host: {exc}", file=sys.stderr)
        return 1


def execute(argv):
    with_names()
    # SUPPRESS keeps an unset flag from overwriting one given before the subcommand.
    ctx = argparse.ArgumentParser(add_help=False)
    ctx.add_argument("-H", "--host", default=argparse.SUPPRESS,
                     help="SSH alias; overrides this tool's pin for one call")
    ctx.add_argument("-i", "--interp", default=argparse.SUPPRESS,
                     help=f"{'|'.join(CHOICES)} or a path to an interpreter")
    ctx.add_argument("-C", "--cwd", default=argparse.SUPPRESS)
    ctx.add_argument("-P", "--proxy", action="store_true", default=argparse.SUPPRESS,
                     help="the host uses this machine's proxy at its LAN address, port 7890")
    ctx.add_argument(
        "-w", "--with", dest="with_", action="append", default=argparse.SUPPRESS,
        metavar="PKG", help="python packages to make available (repeatable, or comma-separated)",
    )

    ses = argparse.ArgumentParser(add_help=False)
    ses.add_argument("-s", "--session", default="agent")

    ap = argparse.ArgumentParser(prog="remote-host", description=DESCRIPTION, parents=[ctx])
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser(
        "run", parents=[ctx], help="run a script and wait; reads stdin when omitted"
    )
    p.add_argument("--table", action="store_true", default=argparse.SUPPRESS,
                   help="with several -H hosts: align their key=value lines into one table")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("proxy-run", parents=[ctx],
                       help="run through a task-owned reverse SSH HTTP proxy; closes on exit")
    p.add_argument("--local-proxy", required=True, help="verified http://LOOPBACK:PORT on this machine")
    p.add_argument("--connect-timeout", type=float, default=30)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_proxy_run)

    p = sub.add_parser(
        "send", parents=[ctx, ses], help="run it in the session, keeping shell state"
    )
    p.add_argument("-d", "--detach", action="store_true", help="do not wait")
    p.add_argument("-t", "--timeout", default="300", help="seconds to wait")
    p.add_argument("-n", "--lines", type=int, default=0,
                   help="cap printed lines per stream (0 = everything)")
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_send)

    p = sub.add_parser("peek", parents=[ctx, ses], help="show the session's recent output")
    p.add_argument("-n", "--lines", type=int, default=30)
    p.set_defaults(fn=cmd_peek)

    p = sub.add_parser("reset", parents=[ctx, ses], help="kill the session")
    p.set_defaults(fn=cmd_reset)

    p = sub.add_parser("attach", parents=[ctx, ses], help="open the session in this terminal")
    p.set_defaults(fn=cmd_attach)

    p = sub.add_parser("put", parents=[ctx], help="copy a file to the host")
    p.add_argument("local")
    p.add_argument("remote", nargs="?")
    p.add_argument("--expect-sha256", help="refuse unless the existing destination has this SHA-256")
    p.set_defaults(fn=cmd_put)

    p = sub.add_parser("get", parents=[ctx], help="copy a file from the host")
    p.add_argument("remote")
    p.add_argument("local", nargs="?")
    p.add_argument("--expect-sha256", help="refuse unless the existing destination has this SHA-256")
    p.set_defaults(fn=cmd_get)

    p = sub.add_parser("status", parents=[ctx], help="host, interpreter, ticket, sessions")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("job", parents=[ctx], help="background jobs that need no multiplexer")
    p.add_argument("action", choices=["start", "list", "wait", "follow", "tail", "kill"])
    p.add_argument("name", nargs="?")
    p.add_argument("--progress", help="shell run every --every seconds; its last line is logged as progress")
    p.add_argument("--every", type=int, default=30)
    p.add_argument("--follow", action="store_true",
                   help="start: stay attached — stream the log until the job exits, then exit with its code")
    p.add_argument("-t", "--timeout", type=int, default=None,
                   help="wait/follow: seconds before giving up, the job keeps running (default 600; start --follow 6h)")
    p.add_argument("-n", "--lines", type=int, default=40)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_job)

    p = sub.add_parser("wait", parents=[ctx], help="block until a port, process, file or command is ready")
    p.add_argument("--port", help="PORT or HOST:PORT, probed from the remote side")
    p.add_argument("--proc", help="pgrep -f pattern")
    p.add_argument("--file")
    p.add_argument("--cmd", dest="check", help="shell that must succeed")
    p.add_argument("--gone", action="store_true", help="wait for the condition to become FALSE")
    p.add_argument("-t", "--timeout", type=int, default=120)
    p.add_argument("--every", type=int, default=2)
    p.set_defaults(fn=cmd_wait)

    p = sub.add_parser("app", parents=[ctx], help="start/stop/restart/status a macOS app, or show its recent errors (logs)")
    p.add_argument("action", choices=["start", "stop", "restart", "status", "logs"])
    p.add_argument("app", help='app name as in /Applications, e.g. "FlClash"')
    p.add_argument("-t", "--timeout", type=int, default=30)
    p.add_argument("--port", help="start/restart: also wait for this port")
    p.add_argument("--since", type=int, default=60, help="logs: minutes back (default 60)")
    p.add_argument("-n", "--lines", type=int, default=20, help="logs: lines per source (default 20)")
    p.set_defaults(fn=cmd_app)

    p = sub.add_parser("screenshot", parents=[ctx], help="capture a remote Mac's screen via its Snipaste; prints the local path")
    p.add_argument("--screen", type=int, help="only display N (0 = main); default: all displays")
    p.add_argument("--max", type=int, default=2400, help="longest edge of the JPEG, px (default 2400)")
    p.add_argument("--png", action="store_true", help="full-resolution PNG instead of a shrunk JPEG")
    p.add_argument("-o", "--output", help="local file (default ~/.cache/remote-host/shots/<host>-<time>.jpg)")
    p.set_defaults(fn=cmd_screenshot)

    p = sub.add_parser("doctor", parents=[ctx], help="why a host is unreachable or awkward, with fixes")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("manifest", help="canonical listing of a tree: hashes, dirs, links")
    p.add_argument("loc", help="host:path, or a local path")
    p.add_argument("--quick", action="store_true", help="sizes only, no content hashes")
    p.add_argument("--full", action="store_true", help="print every entry, not just the summary")
    p.set_defaults(fn=cmd_manifest)

    p = sub.add_parser("verify", help="compare two trees entry by entry (host:path or local)")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--quick", action="store_true")
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser("copy", help="stream a file or tree between hosts, staged and verified")
    p.add_argument("src", help="host:path or local path of the file/dir to copy")
    p.add_argument("dst", help="host:dir or local dir it goes INTO")
    p.add_argument("--replace", action="store_true", help="move an existing target aside instead of refusing")
    p.add_argument("--no-verify", action="store_true")
    p.add_argument("--quick", action="store_true", help="verify sizes only")
    p.add_argument("--no-compress", action="store_true")
    p.add_argument("--every", type=int, default=30, help="progress interval in seconds, 0 for none")
    p.set_defaults(fn=cmd_copy)

    p = sub.add_parser("discover", help="machines on this LAN (Bonjour): address, whether SSH is on, alias")
    p.add_argument("--seconds", type=int, default=3)
    p.set_defaults(fn=cmd_discover)

    p = sub.add_parser("onboard", help="first contact: locate, Remote Login, host key, key login, alias")
    p.add_argument("alias", help="the name to use from now on (ssh alias)")
    p.add_argument("--ip", help="address or name.local; found via Bonjour when omitted")
    p.add_argument("--user", help="account on that machine; guessed from its Bonjour name")
    p.add_argument("--wait", type=int, default=0, help="seconds to wait for Remote Login to be switched on")
    p.add_argument("--password-stdin", action="store_true",
                   help="read the account password from stdin to install the key (and --sudo) once")
    p.add_argument("--sudo", action="store_true", help="also set up passwordless sudo")
    p.add_argument("--seconds", type=int, default=3)
    p.set_defaults(fn=cmd_onboard)

    p = sub.add_parser("use", aliases=["pin"], help="pin the default host and interpreter; local clears the host")
    p.add_argument("name", nargs="?")
    p.add_argument("-i", "--interp")
    p.add_argument("-C", "--cwd")
    p.add_argument("-P", "--proxy", action="store_true", help="this host uses this machine's proxy by default")
    p.add_argument("--no-proxy", action="store_true")
    p.add_argument("--clear", action="store_true")
    p.set_defaults(fn=cmd_use)

    p = sub.add_parser("stats", help="what recurs often enough to deserve a subcommand")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--top", type=int, default=12)
    p.add_argument("--threshold", type=int, default=10)
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser("hosts", help="list hosts from ~/.ssh/config")
    p.set_defaults(fn=cmd_hosts)

    args = ap.parse_args(argv)
    args.tool = "remote-host"
    if args.cmd in ("use", "pin") and args.interp:
        args.interp = ALIASES.get(args.interp, args.interp)
    if args.cmd in ("run", "send", "proxy-run") and args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.cmd:
        ap.print_help()
        return 0
    host = getattr(args, "host", None)
    if host and "," in host and args.cmd in FAN_OUT:
        code = fan_out(strip_host(argv), [h for h in host.split(",") if h],
                       getattr(args, "table", False))
        return code
    if args.cmd not in ("use", "pin", "hosts", "stats", "manifest", "verify", "copy", "discover", "onboard"):
        PROXY["on"] = bool(getattr(args, "proxy", False) or host_pin(host_of(args)).get("proxy"))
    elif args.cmd in ("manifest", "verify", "copy"):
        PROXY["on"] = bool(getattr(args, "proxy", False))
    if args.cmd not in ("use", "pin", "hosts", "stats", "manifest", "verify", "copy", "discover", "onboard"):
        print(f"remote-host: target {host_of(args)}", file=sys.stderr, flush=True)
    started = time.monotonic()
    code = args.fn(args)
    log_call(args, code, started)
    return code


def main():
    args, host, code = route("remote-host", sys.argv[1:])
    if code is None:
        code = execute((["-H", host] if host else []) + args)
    sys.exit(code)
