"""Remote results that need more than passing stdout through: computer-control screenshots fetched back, dsh-control restart receipts watched locally."""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from . import ssh


def _fetch_shot(host, remote):
    if not isinstance(remote, str) or not remote or "\x00" in remote:
        raise ValueError("computer-control: screenshot path must be a non-empty string")
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "remote-host" / "shots"
    cache.mkdir(parents=True, exist_ok=True)
    os.chmod(cache, 0o700)
    suffix = Path(remote).suffix
    if suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        suffix = ".png"
    dest = cache / (uuid.uuid4().hex + suffix)
    # The file bytes stay off stdout. The same real ssh handles config and auth.
    script = ssh.PRELUDE + "cat -- " + ssh.remote_dir(remote) + "\n"
    fd = os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as stream:
        done = subprocess.run(ssh.remote_argv(host), input=script.encode(), stdout=stream)
    ssh.ssh_hint(done.returncode, host)
    if done.returncode:
        dest.unlink(missing_ok=True)
        return None, done.returncode
    return str(dest), 0


def _write_stdout(value):
    if isinstance(value, bytes):
        value = value.decode(errors="replace")
    sys.stdout.write(value)
    sys.stdout.flush()


def _node_row(element):
    return "\t".join(str(element.get(key, "")) for key in ("idx", "role", "label", "axid", "value"))


def _snapshot_text(data):
    if data.get("app"):
        print("APP " + str(data["app"]))
    if data.get("path"):
        print("SHOT " + data["path"])
    elif data.get("screenshot", {}).get("requested") and not data.get("screenshot", {}).get("ok"):
        print("SHOT 失败：" + str(data["screenshot"].get("error") or "未知原因"))
    if data.get("snapshot"):
        print("SNAPSHOT " + data["snapshot"])
    if data.get("mode") == "diff":
        if not data.get("changed"):
            print("DIFF 无变化")
        else:
            added, removed = data.get("added", []), data.get("removed", [])
            print(f"DIFF +{len(added)}新增 / -{len(removed)}消失")
            for prefix, rows in (("+", added), ("-", removed)):
                for row in rows:
                    if isinstance(row, dict):
                        print(prefix + " " + _node_row(row))
    else:
        for row in data.get("elements", []):
            if isinstance(row, dict):
                print(_node_row(row))
    if data.get("warning"):
        print(data["warning"])


def _remote_restart(host, args, local_session):
    from .target import command_script, _error, _wants_json
    from .notifications import start_restart_watch, capture_ssh_target, _session
    # 子代理的 DSH_SESSION_ID 是裸 UUID，没有可接收通知的会话；要在远端排队前判断，排上之后已撤不回
    try:
        _session(local_session)
        watchable = True
    except ValueError:
        watchable = False
    selected_ssh = capture_ssh_target(host)
    requested_json = _wants_json(args, "dsh-control")
    routed = args if requested_json else [*args, "--json"]
    done = ssh.run_remote(host, command_script("dsh-control", routed), capture="stdout")
    if done.returncode:
        if requested_json and done.stdout:
            _write_stdout(done.stdout)
        else:
            _error("dsh-control", "远端重启未成功安排；未启动结果通知", done.returncode, requested_json)
        return done.returncode
    try:
        receipt = json.loads(done.stdout)
        data = receipt["data"]
        if receipt.get("ok") is not True or receipt.get("status") not in ("queued", "attached"):
            raise ValueError("未收到排队或加入已有重启的回执")
        request_id = data["requestId"]
        uuid.UUID(request_id)
    except (ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
        _error("dsh-control", "重启回执无法确认；未自动重试，需查询远端重启状态：" + str(exc), 1, requested_json)
        return 1
    if not watchable:
        query = f"dsh-control -H {host} restart-status --request-id {request_id} --json"
        receipt["watchStarted"] = False
        receipt["watchSkipped"] = f"发起者 {local_session} 不是会话（子代理），不会收到完成通知；用 {query} 查结果"
        if requested_json:
            print(json.dumps(receipt, ensure_ascii=False))
        else:
            print(f"远端 {host} 重启请求 {request_id} 已安排，尚未完成。")
            print(receipt["watchSkipped"])
        return 0
    try:
        watch = start_restart_watch(host, request_id, local_session, ssh_snapshot=selected_ssh)
    except (ValueError, OSError, RuntimeError) as exc:
        receipt["watchError"] = str(exc)
        receipt["watchStarted"] = False
        if requested_json:
            print(json.dumps(receipt, ensure_ascii=False))
        else:
            print(f"远端重启请求 {request_id} 已安排，但本机结果通知未启动：{exc}", file=sys.stderr)
        return 1
    receipt["watch"] = watch
    receipt["watchStarted"] = True
    if requested_json:
        print(json.dumps(receipt, ensure_ascii=False))
    else:
        print(f"远端 {host} 重启请求 {request_id} 已安排，尚未完成。")
        print(f"结果将通知本机发起会话；用 dsh-control restart-watch {watch['watchId']} --json 查看回执。")
    return 0


def notify_self(args):
    """True when ``--notify self`` asks for a done notice back on this machine."""
    words = args[:args.index("--")] if "--" in args else args
    return any(w == "--notify=self" or (w == "--notify" and i + 1 < len(words) and words[i + 1] == "self")
               for i, w in enumerate(words))


def _strip_notify(args):
    out, skip = [], False
    for i, word in enumerate(args):
        if skip:
            skip = False
            continue
        if word == "--notify=self":
            continue
        if word == "--notify" and i + 1 < len(args) and args[i + 1] == "self":
            skip = True
            continue
        out.append(word)
    return out


def _remote_notify(host, args, local_session):
    """Send/new on a remote DSH, then watch it from here so the local session hears when it has really finished."""
    from .target import command_script, _error, _wants_json
    from .notifications import capture_ssh_target, _session
    from .done_watch import start_done_watch
    requested_json = _wants_json(args, "dsh-control")
    command = next(x for x in args if not x.startswith("-"))
    # 这些检查都在发消息之前：发出去以后就撤不回
    if command == "chat":
        _error("dsh-control", "跨机器 chat 不支持 --notify self；改用 send --notify self，或 chat --settled 当场等", 2, requested_json)
        return 2
    try:
        _session(local_session)
    except ValueError:
        _error("dsh-control", "--notify self 要在 DSH 会话里用（子代理或会话外没有可通知的会话）；没有发送", 2, requested_json)
        return 2
    selected_ssh = capture_ssh_target(host)
    routed = _strip_notify(args)
    if "--json" not in routed:
        routed = [*routed, "--json"]
    done = ssh.run_remote(host, command_script("dsh-control", routed, require=("settled-wait",)), capture="stdout")
    if done.returncode:
        if requested_json and done.stdout:
            _write_stdout(done.stdout)
        else:
            _error("dsh-control", f"远端 {command} 没成功（exit {done.returncode}）；未登记做完通知", done.returncode, requested_json)
        return done.returncode
    try:
        receipt = json.loads(done.stdout)
        data = receipt["data"]
        target, since = data["sessionId"], data["since"]
        _session(target)
        if receipt.get("ok") is not True or type(since) is not int:
            raise ValueError("回执缺少会话编号或起点")
    except (ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
        _error("dsh-control", "远端已执行但回执无法确认，未登记做完通知；不要重发，先查远端状态：" + str(exc), 1, requested_json)
        return 1
    try:
        watch = start_done_watch(host, target, since, local_session, title=data.get("title"), ssh_snapshot=selected_ssh)
        data["notify"] = {"watchId": watch["watchId"], "session": local_session, "host": host,
                          "record": watch["statePath"], "observer": "local"}
        if watch.get("reused"):
            data["notify"]["reused"] = True
    except (ValueError, OSError, RuntimeError) as exc:
        # 和同机一样：消息已经发出，通知没登记上就写进回执，退出 0 免得调用方重发
        data["notify"] = {"error": "消息已发出，本机做完通知没登记上：" + str(exc)}
    if requested_json:
        print(json.dumps(receipt, ensure_ascii=False))
    else:
        print(f"已在 {host} {command}：会话 {target}，起点 {since}。")
        print("做完时通知本机会话。" if "watchId" in data["notify"] else data["notify"]["error"])
    return 0


def _computer_control_capture(host, args):
    from .target import command_script, _error
    action = next(word for word in args if word in ("snap", "shot"))
    requested_json = "--json" in args[:args.index("--")] if "--" in args else "--json" in args
    remote_args = args if requested_json else ["--json", *args]
    done = ssh.run_remote(host, command_script("computer-control", remote_args), capture="stdout")
    if done.returncode:
        if requested_json and done.stdout:
            try:
                json.loads(done.stdout)
            except (ValueError, UnicodeDecodeError):
                _error("computer-control", "remote command failed without valid JSON", done.returncode, True)
            else:
                _write_stdout(done.stdout)
        elif requested_json:
            _error("computer-control", "remote command failed", done.returncode, True)
        else:
            print(f"computer-control: remote {action} failed (exit {done.returncode})", file=sys.stderr)
        return done.returncode
    try:
        data = json.loads(done.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("computer-control: remote --json output is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("computer-control: remote --json output must be an object")
    if data.get("ok") is False:
        _error("computer-control", str(data.get("error") or "remote snapshot failed"), data.get("code") or 1, requested_json)
        return data.get("code") or 1
    key = "shot" if action == "snap" else "path"
    remote = data.get(key)
    if remote:
        path, code = _fetch_shot(host, remote)
        if code:
            _error("computer-control", "screenshot download failed", code, requested_json)
            return code
        data["remotePath"], data[key], data["path"] = remote, path, path
    elif action == "shot":
        raise ValueError("computer-control: remote shot JSON has no path")
    if requested_json:
        print(json.dumps(data, ensure_ascii=False))
    elif action == "shot":
        print(data["path"])
    else:
        _snapshot_text(data)
    return 0
