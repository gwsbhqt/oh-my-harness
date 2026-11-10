"""Detached local observers: a task sent to a remote DSH with ``--notify self`` notifies the local session once it has really finished."""

import argparse
import math
import os
import signal
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

from . import ssh
from .notifications import (SHARED, _atomic, _bounded_command, _environment,
                            _json_bytes, _lock, _open_private, _private_dir, _session, _ssh_snapshot, _uuid,
                            _worker_alive)

DEFAULT_TIMEOUT = 86400
WAIT_SLICE = 30
POLL_TIMEOUT = WAIT_SLICE + 30
MAX_ERRORS = 10
REPLY_CHARS = 600
TERMINAL = {"ok", "failed", "aborted", "idle", "gone", "expired", "error"}
#: Remote wait exit codes that only mean "not finished yet": timeout, transport down, remote DSH restarting.
RETRY_CODES = {124, 255, 69}


def _state_dir():
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "dsh-control/remote-done-watches"


def _load(path, watch_id):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("watch state must be a current-user file with mode 0600")
        data = _json_bytes(stream.read())
    if data.get("version") != 1 or data.get("kind") != "done" or data.get("watchId") != watch_id:
        raise ValueError("watch record identity/schema mismatch")
    _session(data.get("localSession"))
    _session(data.get("target"))
    if not isinstance(data.get("host"), str) or not isinstance(data.get("ssh"), dict):
        raise ValueError("invalid watch target record")
    if type(data.get("since")) is not int or data["since"] < 0:
        raise ValueError("invalid since")
    for key in ("createdAt", "deadlineAt", "interval"):
        value = data.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("invalid watch timing field: " + key)
    if data.get("phase") not in TERMINAL | {"starting", "watching", "unknown"}:
        raise ValueError("invalid local watch phase")
    return data


def read_watch(watch_id):
    """Read private local state only; never connect to the remote host."""
    watch_id = _uuid(watch_id)
    data = _load(_state_dir() / (watch_id + ".json"), watch_id)
    alive = _worker_alive(_state_dir(), watch_id, data.get("pid"))
    if data["phase"] in {"starting", "watching"} and not alive:
        data = {**data, "phase": "unknown", "recordedPhase": data["phase"],
                "message": "本机观察进程已结束（例如电脑重启），没确认远端是否做完，也没送出通知"}
    return {**data, "workerAlive": alive}


def _classify(done):
    """Map one remote ``wait --settled --json`` result to a watch event."""
    code = done.returncode
    try:
        envelope = _json_bytes(done.stdout) if done.stdout else {}
    except (ValueError, UnicodeError):
        envelope = {}
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    error = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
    if code == 0:
        return {"kind": "ok", "data": data}
    if code == 1 and envelope.get("status") in ("failed", "aborted"):
        return {"kind": envelope["status"], "data": data}
    if code == 10:
        return {"kind": "waiting-input", "data": data}
    if code == 11:
        return {"kind": "idle", "data": data}
    if code == 2 and error.get("code") == "not-found":
        return {"kind": "gone", "error": error.get("message", "")}
    if code in RETRY_CODES:
        # 「还没做完」的回包里有会话标题，做完时的回包没有，先记下来给通知用
        return {"kind": "retry", "exitCode": code, "data": {"title": data["title"]} if data.get("title") else {}}
    message = error.get("message") or done.stderr.decode("utf-8", "replace")[-300:] or f"exit {code}"
    return {"kind": "invalid", "exitCode": code, "error": message}


def _poll(state):
    from .target import command_script
    if _ssh_snapshot(state["host"]) != state["ssh"]:
        return {"kind": "config-changed", "error": "SSH 配置已改变；没有继续访问其他目标"}
    ssh.PROXY["on"] = False
    args = ["wait", state["target"], "--since", str(state["since"]), "--settled",
            "--timeout", str(WAIT_SLICE), "--json"]
    return _classify(ssh.run_remote(state["host"], command_script("dsh-control", args), capture=True))


def _invoke(mode, watch_id, directory):
    return [sys.executable, "-m", "agentkit.remote.done_watch", mode, watch_id, "--state-dir", str(directory)]


def _poll_child(watch_id, directory):
    try:
        done = _bounded_command(_invoke("--poll", watch_id, directory), POLL_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {"kind": "retry", "error": "单次查询超过本机期限"}
    if done.returncode != 0:
        return {"kind": "invalid", "exitCode": done.returncode, "error": done.stderr.decode("utf-8", "replace")[-300:]}
    return _json_bytes(done.stdout)


def _cut(text, limit=REPLY_CHARS):
    text = text.strip()
    return text if len(text) <= limit else f"{text[:limit]}…（后面还有 {len(text) - limit} 字）"


def _name(state):
    title = state.get("targetTitle")
    return f'{state["host"]} 上的会话 {state["target"]}' + (f"「{title}」" if title else "")


def final_notice(state, result):
    """Same reading order as the same-machine done notice: outcome, last reply head, how to read more."""
    host, target, kind = state["host"], state["target"], state["phase"]
    label = f'{host}：{state.get("targetTitle") or target[8:16]}'
    footer = "这条是你跨机器派单时用 --notify self 登记的做完通知，只送这一次。"
    if kind in ("gone", "expired", "error", "unknown"):
        reason = {"gone": "不见了（可能被删除），没法再等它做完",
                  "expired": "到观察期限还没做完，本机停止观察，没确认结果",
                  "error": "查询一直出错，本机停止观察，没确认结果"}.get(kind, "结果未知")
        detail = result.get("error") or state.get("message") or ""
        return (f"dsh-control：{label} {'不见了' if kind == 'gone' else '未确认'}",
                "\n".join(x for x in (f"dsh-control 派单结果：{_name(state)}{reason}。", detail,
                                      f"查状态：dsh-control -H {host} status {target}", footer) if x))
    data = result.get("data") or {}
    turns = data.get("turns") if isinstance(data.get("turns"), list) else []
    last = turns[-1] if turns and isinstance(turns[-1], dict) else None
    reply = next((t.get("reply") for t in reversed(turns) if isinstance(t, dict)
                  and isinstance(t.get("reply"), str) and t["reply"].strip()), None)
    reason = "无" if last is None else str(last.get("ended")) + (f'（{last["detail"]}）' if last.get("detail") else "")
    headline = {"ok": "已经真正做完", "aborted": "停下了，但最后一轮被中止，没有做完",
                "failed": "停下了，但最后一轮没有成功结束",
                "idle": "停着，但派单之后没有新的一轮结束（消息可能被撤回或删掉了）"}[kind]
    word = {"ok": "已做完", "aborted": "被中止", "failed": "失败", "idle": "没有新结果"}[kind]
    lines = [f"dsh-control 派单结果：{_name(state)}{headline}。",
             f"结束原因：{reason}。判定口径：这一轮已结束，没在跑、没有排队消息，名下没有在跑的后台任务和子代理，持续目标不会自动续跑。"]
    lines += ["最后没有文字回复。"] if reply is None else ["最后回复的开头：", _cut(reply)]
    lines += [f"读全文：dsh-control -H {host} last {target}；看目标：dsh-control -H {host} goal {target}。", footer]
    return f"dsh-control：{label} {word}", "\n".join(lines)


def question_notice(state, result):
    questions = (result.get("data") or {}).get("questions") or []
    shown = [str(q.get("question") or q.get("text") or q) if isinstance(q, dict) else str(q) for q in questions]
    return (f'dsh-control：{state["host"]}：{state.get("targetTitle") or state["target"][8:16]} 在等回答',
            "\n".join([f"dsh-control 派单进度：{_name(state)}还没做完，停下来在等回答：", *shown,
                       f'回答：dsh-control -H {state["host"]} answer {state["target"]} …；做完时还会再通知你一次。']))


def question_keys(result):
    questions = (result.get("data") or {}).get("questions") or []
    return [str(q.get("callId") or q.get("id") or i) if isinstance(q, dict) else str(i) for i, q in enumerate(questions)]


def _deliver(state, summary, text, retry_seconds=180):
    """Notify the local session; wait out a local DSH restart, never resend after an unconfirmed attempt."""
    argv = [str(Path.home() / ".local/bin/dsh-control"), "--local", "notice", state["localSession"],
            text, "--summary", summary, "--json"]
    deadline = time.monotonic() + retry_seconds
    while True:
        try:
            done = _bounded_command(argv, 30)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"state": "unconfirmed", "error": str(exc)}
        if done.returncode == 69 and time.monotonic() < deadline:
            time.sleep(5)  # 本机 DSH 正在重启：通信口不在，消息一定没发出，可以等它回来再发
            continue
        if done.returncode:
            return {"state": "failed", "exitCode": done.returncode,
                    "error": done.stderr.decode("utf-8", "replace")[-500:]}
        try:
            ack = _json_bytes(done.stdout).get("data") or {}
        except (ValueError, UnicodeError) as exc:
            return {"state": "unconfirmed", "error": str(exc)}
        if ack.get("sessionId") != state["localSession"]:
            return {"state": "unconfirmed", "error": "通知回执的会话对不上"}
        return {"state": "scheduled" if ack.get("accepted") and ack.get("scheduled") else "recorded-unconfirmed",
                "receipt": ack, "at": time.time()}


def _worker(watch_id, directory):
    path = directory / (watch_id + ".json")
    with _lock(directory / (watch_id + ".worker.lock"), blocking=False):
        state = _load(path, watch_id)
        if state["phase"] != "starting":
            raise ValueError("watch was already started; refusing duplicate delivery")
        state.update(pid=os.getpid(), phase="watching", readyAt=time.time(), asked=[], deliveries=[], errors=0)
        _atomic(path, state)
        deadline = time.monotonic() + max(0, state["deadlineAt"] - time.time())
        result = {}
        while time.monotonic() < deadline:
            try:
                result = _poll_child(watch_id, directory)
            except (OSError, ValueError, UnicodeError) as exc:
                result = {"kind": "invalid", "error": str(exc)}
            state.update(lastPoll={k: v for k, v in result.items() if k != "data"}, updatedAt=time.time())
            if (result.get("data") or {}).get("title"):
                state["targetTitle"] = result["data"]["title"]
            kind = result.get("kind")
            pause = state["interval"]
            if kind in ("ok", "failed", "aborted", "idle", "gone"):
                state["phase"] = kind
                break
            if kind == "waiting-input":
                fresh = [k for k in question_keys(result) if k not in state["asked"]]
                if fresh:
                    state["asked"] += fresh
                    summary, text = question_notice(state, result)
                    state["deliveries"].append({"kind": "question", **_deliver(state, summary, text)})
                pause = max(pause, state.get("questionInterval", WAIT_SLICE))  # 等回答时远端立即返回，放慢询问
            elif kind in ("invalid", "config-changed"):
                state["errors"] += 1
                if kind == "config-changed" or state["errors"] >= MAX_ERRORS:
                    state.update(phase="error", message=result.get("error", ""))
                    break
            else:
                state["errors"] = 0
            _atomic(path, state)
            time.sleep(max(0, min(pause, deadline - time.monotonic())))
        else:
            state["phase"] = "expired"
        state["finishedAt"] = time.time()
        state["notification"] = {"state": "attempting"}
        _atomic(path, state)
        summary, text = final_notice(state, result)
        state["notification"] = _deliver(state, summary, text)
        state["updatedAt"] = time.time()
        _atomic(path, state)


def _pending_for(directory, host, target, session_id):
    for path in sorted(directory.glob("*.json")):
        try:
            data = _load(path, path.stem)
        except (OSError, ValueError, UnicodeError):
            continue
        if (data["host"], data["target"], data["localSession"]) != (host, target, session_id):
            continue
        if data["phase"] in {"starting", "watching"} and _worker_alive(directory, data["watchId"], data.get("pid")):
            return data
    return None


def start_done_watch(host, target, since, session_id, *, title=None, timeout=DEFAULT_TIMEOUT, interval=2, ssh_snapshot=None):
    """Start one detached local observer after a confirmed remote send/new receipt."""
    session_id, target = _session(session_id), _session(target)
    if type(since) is not int or since < 0:
        raise ValueError("since must be a non-negative integer")
    if not isinstance(host, str) or not host or host == "local" or host.startswith("-") or any(c.isspace() for c in host):
        raise ValueError("watch requires an explicit remote host")
    for value in (timeout, interval):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("watch timeout and interval must be positive finite numbers")
    directory = _state_dir().absolute()
    _private_dir(directory)
    # 查重、登记和启动确认必须同属一个临界区：启动中的记录还没有可检查的 worker。
    with _lock(directory / ".registry.lock"):
        existing = _pending_for(directory, host, target, session_id)
        if existing is not None:
            # 同一个远端会话已有本机观察进程在盯同一个发起会话：做完只通知一次
            return {"watchId": existing["watchId"], "pid": existing.get("pid"),
                    "statePath": str(directory / (existing["watchId"] + ".json")), "reused": True}
        watch_id = str(uuid.uuid4())
        path = directory / (watch_id + ".json")
        snapshot = _ssh_snapshot(host)
        if ssh_snapshot is not None and snapshot != ssh_snapshot:
            raise ValueError("SSH 配置在派单后改变；没有向新目标建立观察")
        now = time.time()
        state = {"version": 1, "kind": "done", "watchId": watch_id, "host": host, "ssh": snapshot,
                 "localSession": session_id, "target": target, "since": since, "targetTitle": title,
                 "createdAt": now, "deadlineAt": now + timeout, "interval": interval, "questionInterval": WAIT_SLICE,
                 "phase": "starting", "pid": None, "notification": {"state": "pending"}}
        _atomic(path, state)
        child = None
        try:
            fd = _open_private(directory / (watch_id + ".log"))
            with os.fdopen(fd, "ab") as log:
                child = subprocess.Popen(_invoke("--worker", watch_id, directory), stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, start_new_session=True, close_fds=True,
                                         cwd=SHARED, env=_environment())
            ready_deadline = time.monotonic() + 5
            while time.monotonic() < ready_deadline:
                current = _load(path, watch_id)
                if current.get("readyAt") and current.get("pid") == child.pid:
                    return {"watchId": watch_id, "pid": child.pid, "statePath": str(path)}
                if child.poll() is not None:
                    raise RuntimeError(f"watch worker exited before ready, exit {child.returncode}")
                time.sleep(0.02)
            raise RuntimeError("watch worker did not confirm startup")
        except (OSError, ValueError, RuntimeError) as exc:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            state.update(phase="unknown", message="本机观察器启动失败：" + str(exc), finishedAt=time.time(),
                         notification={"state": "not-attempted"})
            _atomic(path, state)
            raise


def main(argv=None):
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--worker")
    modes.add_argument("--poll")
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args(argv)
    watch_id = _uuid(args.worker or args.poll)
    directory = Path(args.state_dir)
    if args.worker:
        def stop_worker(signum, frame):
            raise SystemExit(128 + signum)
        signal.signal(signal.SIGTERM, stop_worker)
        _worker(watch_id, directory)
    else:
        import json
        print(json.dumps(_poll(_load(directory / (watch_id + ".json"), watch_id)), ensure_ascii=False))


if __name__ == "__main__":
    main()
