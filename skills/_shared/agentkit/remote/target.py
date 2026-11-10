"""Machine selection shared by remote-host, computer-control, dsh-control, browser-control and clash-control, and forwarding computer-control/dsh-control/clash-control commands to the same tool on that machine."""

import argparse
import contextlib
import io
import json
import os
import shlex
import sys

from . import pins, ssh

TOOLS = ("remote-host", "computer-control", "dsh-control", "browser-control", "clash-control")
BROWSER_CONTROL_VALUE_OPTIONS = {"--session", "--browser", "--socket", "--tab", "--rpc-timeout"}


def resolve_target(tool: str, host: str | None = None) -> str:
    """Return this tool's alias or local; reject an unknown or missing target."""
    if tool not in TOOLS:
        raise ValueError(f"unsupported tool {tool!r}")
    if host is not None and (not isinstance(host, str) or not host.strip()):
        raise ValueError(f"{tool}: explicit host must not be empty")
    target = host if host is not None else pins.read_pin(tool).get("host")
    if target is None and tool != "remote-host":
        target = "local"
    if target is None:
        raise ValueError("remote-host: no host — pass -H <host>, or pin one with: remote-host use <host>")
    if target == "local":
        if tool == "remote-host":
            raise ValueError("remote-host: local execution is not supported — choose a remote host")
        return target
    if target not in ssh.known_hosts():
        raise ValueError(f"{tool}: unknown host {target!r} — add it to ~/.ssh/config")
    return target


def _route_word(word):
    return word in ("-H", "--host", "--local") or word.startswith("--host=") or (word.startswith("-H") and len(word) > 2)


def _extract(argv, tool="remote-host"):
    args, host, local = [], None, False
    i, command = 0, None
    value_options = {"-i", "--interp", "-C", "--cwd", "-w", "--with", "-s", "--session", "-t", "--timeout", "-n", "--lines"}
    remote_host_options = value_options | {"-P", "--proxy", "--table", "-d", "--detach", "-h", "--help"}
    while i < len(argv):
        word = argv[i]
        if word == "--":
            args.extend(argv[i:])
            break
        if tool == "remote-host" and command in ("run", "send") and word not in remote_host_options and not _route_word(word):
            args.extend(argv[i:])
            break
        if word in ("-H", "--host"):
            i += 1
            if i == len(argv) or not argv[i] or argv[i].startswith("-"):
                raise ValueError(f"{word} requires a host")
            if host is not None and host != argv[i]:
                raise ValueError("conflicting host selections")
            host = argv[i]
        elif word.startswith("--host="):
            value = word.split("=", 1)[1]
            if not value:
                raise ValueError("--host requires a host")
            if host is not None and host != value:
                raise ValueError("conflicting host selections")
            host = value
        elif word.startswith("-H") and len(word) > 2:
            if host is not None and host != word[2:]:
                raise ValueError("conflicting host selections")
            host = word[2:]
        elif word == "--local":
            local = True
        else:
            args.append(word)
            if (tool == "remote-host" and word in value_options or tool == "browser-control" and word in BROWSER_CONTROL_VALUE_OPTIONS) and i + 1 < len(argv):
                i += 1
                args.append(argv[i])
                i += 1
                continue
            if command is None and not word.startswith("-"):
                command = word
                if tool != "remote-host":
                    args.extend(argv[i + 1:])
                    if tool != "browser-control":
                        _reject_misplaced_route(args, tool)
                    break
                if command in ("job", "proxy-run"):
                    # These parsers own their options and payload; never inspect those words here.
                    args.extend(argv[i + 1:])
                    break
        i += 1
    return args, host, local


def _reject_misplaced_route(args, tool):
    words = args[:args.index("--")] if "--" in args else args
    command_at = next((i for i, value in enumerate(words) if not value.startswith("-")), None)
    if command_at is None:
        return
    command = words[command_at]
    # Only actual text positions may contain literal routing words; no global rescan of payload.
    text_slots = ({"send": (2,), "chat": (2,), "notice": (2,), "new": (2,), "rename": (2,), "answer": (2,)}
                  if tool == "dsh-control" else {"type": (2,), "paste": (2,), "clip": (1,), "set": (3,), "selecttext": (3,)})
    positional = 0
    i = command_at + 1
    booleans = {"--json", "--now", "--steer", "--interrupt", "--force", "--all", "--tools", "--running", "--ungrouped", "--include-blank", "--when-idle", "--detach", "--kill", "--refresh", "--full", "--shot", "--diff", "--coord", "--gone", "--front", "--off", "--selected", "--no-settle", "--no-webmode", "--allow-newline", "--request", "--help", "-h",
                "--dry-run", "--restart", "--reveal", "--dead", "--no-ip", "--used", "--no-check"}
    while i < len(words):
        word = words[i]
        if _route_word(word):
            positional += 1
            if positional not in text_slots.get(command, ()):
                raise ValueError(f"{tool}: machine options must precede the command; use {tool} -H HOST {command} …")
        elif word.startswith("--"):
            if "=" not in word and word not in booleans and i + 1 < len(words):
                i += 1
        else:
            positional += 1
        i += 1


def _control(tool, args, host, *, json_output=False):
    as_json = json_output or tool != "remote-host" and _wants_json(args, tool)
    if as_json:
        end = args.index("--") if "--" in args else len(args)
        args = [word for i, word in enumerate(args) if i >= end or word != "--json"]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = _control(tool, args, host)
        pin = pins.read_pin(tool)
        result = {"ok": code == 0, "tool": tool, "target": pin.get("host") or "local"}
        if args[0] == "hosts":
            result["hosts"] = (["local"] if tool != "remote-host" else []) + ssh.known_hosts()
        print(json.dumps(result, ensure_ascii=False))
        return code
    action = args[0]
    parser = argparse.ArgumentParser(prog=f"{tool} {action}")
    if action == "hosts":
        parsed = parser.parse_args(args[1:])
        parsed.tool = tool
        return pins.cmd_hosts(parsed)
    parser.add_argument("name", nargs="?")
    parser.add_argument("--clear", action="store_true")
    parser.add_argument("-i", "--interp")
    parser.add_argument("-C", "--cwd")
    parser.add_argument("-P", "--proxy", action="store_true")
    parser.add_argument("--no-proxy", action="store_true")
    parsed = parser.parse_args(args[1:])
    parsed.tool = tool
    parsed.name = parsed.name or host
    if tool != "remote-host" and (parsed.interp or parsed.cwd or parsed.proxy or parsed.no_proxy):
        raise ValueError(f"{tool}: only remote-host supports interpreter, directory and proxy pins")
    return pins.cmd_use(parsed)


def _route(tool, argv, *, json_output=False):
    args = list(argv)
    try:
        if tool not in TOOLS:
            raise ValueError(f"unsupported tool {tool!r}")
        args, host, local = _extract(argv, tool)
        if local and host is not None and host != "local":
            raise ValueError(f"{tool}: --local conflicts with -H/--host {host!r}")
        command_at = 0
        if tool == "browser-control":
            while command_at < len(args) and args[command_at].startswith("-"):
                word = args[command_at]
                if word == "--":
                    break
                command_at += 2 if word in BROWSER_CONTROL_VALUE_OPTIONS else 1
        controls = args[command_at:]
        if controls and controls[0] in ("use", "pin", "hosts"):
            if "--json" in args[:command_at]:
                controls = [*controls, "--json"]
            return args, None, False, _control(tool, controls, host, json_output=json_output)
        if json_output:
            raise ValueError(f"{tool}: expected use, pin or hosts")
        if tool == "remote-host" and (local or host == "local"):
            raise ValueError("remote-host: local execution is not supported — choose a remote host")
        return args, host, local, None
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (1 if exc.code is not None else 0)
        if code:
            _error(tool, "invalid command arguments", code, json_output or _wants_json(args, tool))
        return args, None, False, code
    except (ValueError, OSError) as exc:
        _error(tool, str(exc), 2, json_output or _wants_json(args, tool))
        return args, None, False, 2


def route(tool: str, argv: list[str]) -> tuple[list[str], str | None, int | None]:
    """Consume -H/--host/--local and run use/pin/hosts; the host is returned unresolved.

    remote-host resolves it itself: it accepts `-H a,b` for several machines at once and
    has commands that need no machine at all.
    """
    args, host, _, code = _route(tool, argv)
    return args, host, code


def select_target(tool: str, argv: list[str]) -> tuple[list[str], str | None, int | None]:
    """Consume routing controls and return local/alias without executing a business command."""
    args, host, local, code = _route(tool, argv)
    if code is not None:
        return args, None, code
    try:
        return args, resolve_target(tool, "local" if local else host), None
    except (ValueError, OSError) as exc:
        _error(tool, str(exc), 2, _wants_json(args, tool))
        return args, None, 2


def control_target(tool: str, argv: list[str]) -> dict:
    """Run only use/pin/hosts and return their structured result without stdout output."""
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        _, _, _, code = _route(tool, argv, json_output=True)
    raw = output.getvalue()
    if not raw.strip() and code == 0:
        return {"ok": True, "tool": tool, "help": True}
    result = json.loads(raw)
    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
        raise ValueError(f"{tool}: invalid target control result")
    return result


def command_script(tool, args, require=()):
    """Stage a quoted argv payload that runs the same tool on the remote machine after a capability handshake; ``require`` adds capabilities the remote entry must declare."""
    body = ssh.path_line() + "\n"
    if tool == "dsh-control":
        body += "unset DSH_SESSION_ID\n"
        source = os.environ.get("DSH_SHELL") or ("1" if os.environ.get("DSH_SESSION_ID") else None)
        if source:
            body += "export DSH_SHELL=" + shlex.quote(source) + "\n"
    body += (f'__remote_host_tool="$HOME/.local/bin/{tool}"\n'
             + f'[ -x "$__remote_host_tool" ] || {{ echo "{tool}: remote tool missing: $__remote_host_tool" >&2; exit 127; }}\n'
             + '__remote_host_cap=$("$__remote_host_tool" --capabilities --json) || { echo "远端工具不支持能力检查，未执行命令" >&2; exit 78; }\n'
             + 'printf "%s" "$__remote_host_cap" | python3 -c ' + shlex.quote('import json, sys\ntry:\n d=json.load(sys.stdin)\n required={"local-routing"}\n if sys.argv[1]=="dsh-control": required.add("task-outcomes")\n if len(sys.argv)>2 and sys.argv[2]=="restart": required.add("restart-receipts")\n required.update(sys.argv[3:])\n if sys.argv[1]=="computer-control": required.update(("snapshot-token","snapshot-status"))\n if not isinstance(d,dict) or d.get("ok") is not True or d.get("tool")!=sys.argv[1] or d.get("protocol")!=1:\n  raise ValueError("protocol mismatch")\n features=d.get("features",[])\n if not isinstance(features,list) or not all(isinstance(x,str) for x in features) or not required.issubset(features):\n  raise ValueError("missing capabilities")\nexcept Exception:\n print("远端工具入口过旧或能力协议不匹配，请更新入口和共用连接代码；未执行命令",file=sys.stderr)\n sys.exit(78)\n') + ' ' + shlex.quote(tool) + ' ' + shlex.quote("restart" if tool == "dsh-control" and args and args[0] == "restart" else "command") + ''.join(' ' + shlex.quote(f) for f in require) + ' || exit $?\n'
             + 'exec "$__remote_host_tool" ' + shlex.join(["--local", *args]))
    path = "~/.cache/remote-host/tool.$$.sh"
    return (ssh.PRELUDE + "mkdir -p ~/.cache/remote-host || exit $?\n"
            + ssh.stash_here(path, body)
            + f"sh {path} < /dev/null\n__remote_host_rc=$?\nrm -f {path}\nexit $__remote_host_rc\n")


from .adapters import _computer_control_capture, _fetch_shot, _write_stdout, _remote_restart, _remote_notify, notify_self


def _wants_json(args, tool="computer-control"):
    words = args[:args.index("--")] if "--" in args else args
    if tool != "dsh-control" or not words or words[0] != "answer":
        return "--json" in words
    for i, word in enumerate(words):
        if word != "--json":
            continue
        following = words[i + 1] if i + 1 < len(words) else ""
        if not following.lstrip().startswith(("{", "[")):
            return True
    return False


def _error(tool, message, code, as_json):
    if as_json:
        error = ({"ok": False, "error": {"code": str(code), "message": message}}
                 if tool in ("dsh-control", "clash-control") else {"ok": False, "error": message, "code": code})
        print(json.dumps(error, ensure_ascii=False))
    print(f"{tool}: {message}", file=sys.stderr)


def dispatch(tool: str, argv: list[str]) -> tuple[list[str], int | None]:
    """Consume target controls; None means local, otherwise the completed exit code."""
    args = list(argv)
    try:
        if tool not in ("computer-control", "dsh-control", "browser-control", "clash-control"):
            raise ValueError(f"unsupported tool {tool!r}; remote-host routes through route()")
        args, host, local = _extract(argv, tool)
        if local and host is not None and host != "local":
            raise ValueError(f"{tool}: --local conflicts with -H/--host {host!r}")
        if args and args[0] in ("use", "pin", "hosts"):
            return args, _control(tool, args, host)
        if tool == "dsh-control" and args and args[0] == "restart-watch":
            parser = argparse.ArgumentParser(prog="dsh-control restart-watch")
            parser.add_argument("watch_id")
            parser.add_argument("--json", action="store_true")
            parsed = parser.parse_args(args[1:])
            from .notifications import read_watch
            status = read_watch(parsed.watch_id)
            if parsed.json:
                print(json.dumps({"ok":True,"status":status.get("phase"),"data":status}, ensure_ascii=False))
            else:
                print(f"远端重启通知状态：{status.get('phase')}\n{status.get('message', '')}")
            return args, 0
        target = "local" if local else resolve_target(tool, host)
        if target == "local":
            return args, None
        if tool == "browser-control":
            raise ValueError("browser-control business commands require select_target and the browser-control RPC client")
        print(f"{tool}: target {target}", file=sys.stderr, flush=True)
        previous_proxy = ssh.PROXY["on"]
        ssh.PROXY["on"] = False
        try:
            computer_control_command = next((x for x in args if not x.startswith("-")), None)
            if tool == "computer-control" and computer_control_command == "serve":
                raise ValueError("remote computer-control serve does not support a bidirectional stdin stream; use one-shot commands")
            if tool == "dsh-control" and computer_control_command == "restart" and "--detach" in args and os.environ.get("DSH_SESSION_ID"):
                code = _remote_restart(target, args, os.environ["DSH_SESSION_ID"])
            elif tool == "dsh-control" and computer_control_command in ("send", "new", "chat") and notify_self(args):
                code = _remote_notify(target, args, os.environ.get("DSH_SESSION_ID"))
            elif tool == "computer-control" and computer_control_command in ("snap", "shot") and not any(x in args for x in ("-h", "--help")):
                code = _computer_control_capture(target, args)
            else:
                if _wants_json(args, tool):
                    done = ssh.run_remote(target, command_script(tool, args), capture="stdout")
                    code = done.returncode
                    if done.stdout and tool == "dsh-control":
                        _write_stdout(done.stdout)
                    elif done.stdout:
                        try:
                            json.loads(done.stdout)
                        except (ValueError, UnicodeDecodeError):
                            code = code or 2
                            _error(tool, "remote --json output is not valid JSON", code, True)
                        else:
                            _write_stdout(done.stdout)
                    elif code or tool != "dsh-control":
                        code = code or 2
                        _error(tool, "remote command failed" if done.returncode else "remote --json output is empty", code, True)
                else:
                    code = ssh.run_remote(target, command_script(tool, args))
        finally:
            ssh.PROXY["on"] = previous_proxy
        if code:
            print(f"{tool}: {target} exit {code}", file=sys.stderr)
        return args, code
    except SystemExit as exc:
        if isinstance(exc.code, int):
            if exc.code and _wants_json(args, tool):
                _error(tool, "invalid command arguments", exc.code, True)
            return args, exc.code
        if exc.code is not None:
            print(exc.code, file=sys.stderr)
        return args, 1 if exc.code is not None else 0
    except (ValueError, OSError) as exc:
        _error(tool, str(exc), 2, _wants_json(args, tool))
        return args, 2
