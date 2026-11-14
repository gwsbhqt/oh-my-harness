"""Bounded, local-only detached watchers for remote DSH restart receipts."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from . import ssh

TERMINAL = {"completed", "failed", "timed-out", "interrupted"}
PENDING = {"queued", "attached", "pending", "checking", "waiting-idle", "waiting-jobs",
           "before", "stopping", "starting", "resuming", "notifying", "waiting", "restarting",
           "updating", "quitting"}
DEFAULT_TIMEOUT = 7200
#: skills/_shared, the directory that holds the agentkit package.
SHARED = Path(__file__).resolve().parents[2]
POLL_TIMEOUT = 45
INITIAL_GRACE = 30


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError("request/watch ID must be a UUID")
    try:
        canonical = str(uuid.UUID(value))
    except ValueError as exc:
        raise ValueError("request/watch ID must be a UUID") from exc
    if value != canonical:
        raise ValueError("request/watch ID must be a canonical UUID")
    return canonical


def _session(value):
    if not isinstance(value, str) or not value.startswith("session-"):
        raise ValueError("local session must be a full session-UUID, not a name or prefix")
    _uuid(value[8:])
    return value


def _state_dir():
    return Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "dsh-use/restart-watches"


def _private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.getuid():
        raise ValueError("watch directory must be owned by the current user and not a symlink")
    path.chmod(0o700)


def _open_private(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(fd)
        raise ValueError("watch file must be a regular file owned by the current user")
    os.fchmod(fd, 0o600)
    return fd


@contextlib.contextmanager
def _lock(path, blocking=True):
    fd = _open_private(path)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:
        os.close(fd)


def _atomic(path, data):
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _json_bytes(raw):
    if not isinstance(raw, bytes) or not raw:
        raise ValueError("expected nonempty UTF-8 JSON bytes")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError("nonfinite JSON number: " + value)
    data = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)
    if not isinstance(data, dict):
        raise ValueError("JSON must be an object")
    return data


def _load(path, watch_id):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("watch state must be a current-user regular file with mode 0600")
        data = _json_bytes(stream.read())
    if type(data.get("version")) is not int or data["version"] != 1 or data.get("watchId") != watch_id or data.get("requestId") != watch_id:
        raise ValueError("watch record identity/schema mismatch")
    _session(data.get("localSession"))
    if not isinstance(data.get("host"), str) or not isinstance(data.get("ssh"), dict):
        raise ValueError("invalid watch target record")
    for key in ("createdAt", "deadlineAt", "interval"):
        value = data.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("invalid watch timing field: " + key)
    if data.get("phase") not in TERMINAL | {"starting", "watching", "unknown"}:
        raise ValueError("invalid local watch phase")
    if data.get("pid") is not None and (type(data["pid"]) is not int or data["pid"] <= 0):
        raise ValueError("invalid watch process ID")
    return data


def _alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def _worker_alive(directory, watch_id, pid):
    if not _alive(pid):
        return False
    try:
        fd = os.open(directory / (watch_id + ".worker.lock"), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(fd)


def read_watch(watch_id):
    """Read private local state only; never resolve a target or connect over SSH."""
    watch_id = _uuid(watch_id)
    data = _load(_state_dir() / (watch_id + ".json"), watch_id)
    alive = _worker_alive(_state_dir(), watch_id, data.get("pid"))
    if data["phase"] in {"starting", "watching"} and not alive:
        data = {**data, "phase": "unknown", "message": "本机观察进程已结束，未确认远端结果或通知送达",
                "recordedPhase": data["phase"]}
    if not alive and data.get("notification", {}).get("state") == "attempting":
        data = {**data, "notification": {"state": "unconfirmed", "error": "观察进程已结束，无法确认通知是否送达；不要自动重复发送"}}
    return {**data, "workerAlive": alive}


def _ssh_snapshot(host):
    # Use precisely the transport's options, not the user's alias spelling alone.
    previous = ssh.PROXY["on"]
    ssh.PROXY["on"] = False
    try:
        transport = ssh.remote_argv(host)
    finally:
        ssh.PROXY["on"] = previous
    if transport[-2] != host:
        raise ValueError("unexpected SSH transport argv")
    argv = [*transport[:-2], "-G", host]
    done = _bounded_command(argv, 15)
    if done.returncode != 0:
        raise RuntimeError(f"SSH configuration resolution exited {done.returncode}: {done.stderr.decode('utf-8', 'replace')}")
    config = {}
    for line in done.stdout.decode("utf-8").splitlines():
        key, separator, value = line.partition(" ")
        if not separator or not value:
            raise ValueError("invalid ssh -G output")
        config.setdefault(key, []).append(value)
    if not all(config.get(key) for key in ("hostname", "user", "port")):
        raise ValueError("ssh -G omitted hostname/user/port")
    encoded = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    return {"argv": argv, "config": config, "sha256": hashlib.sha256(encoded).hexdigest(),
            "hostname": config["hostname"][0], "user": config["user"][0], "port": config["port"][0]}


def capture_ssh_target(host):
    """Capture the actual resolved SSH configuration before dispatching a restart."""
    if not isinstance(host, str) or not host or host == "local" or host.startswith("-") or any(c.isspace() for c in host):
        raise ValueError("SSH snapshot requires an explicit remote host")
    return _ssh_snapshot(host)


def _receipt(done, request_id):
    if type(done.returncode) is not int:
        raise ValueError("remote result has no integer exit code")
    if not isinstance(done.stdout, bytes) or not isinstance(done.stderr, bytes):
        raise ValueError("remote result streams must be bytes")
    if done.returncode:
        try:
            error = _json_bytes(done.stdout).get("error")
        except (ValueError, UnicodeError):
            error = None
        if done.returncode == 2 and isinstance(error, dict) and error.get("code") == "not-found":
            return {"kind": "not-found", "exitCode": done.returncode}
        return {"kind": "transport-error" if done.returncode == 255 else "remote-error",
                "exitCode": done.returncode, "error": str(error or "remote status command failed")}
    envelope = _json_bytes(done.stdout)
    data = envelope.get("data")
    if envelope.get("ok") is not True or not isinstance(data, dict):
        raise ValueError("invalid restart status envelope")
    if data.get("requestId") != request_id:
        raise ValueError("restart status request identity mismatch")
    phase = data.get("phase")
    if not isinstance(phase, str) or not phase or envelope.get("status") != phase:
        raise ValueError("restart status phase mismatch")
    for key in ("message", "log", "executionRequestId"):
        if key in data and not isinstance(data[key], str):
            raise ValueError("restart status " + key + " must be a string")
    if "executionRequestId" in data:
        _uuid(data["executionRequestId"])
    if phase not in TERMINAL | PENDING:
        raise ValueError("unrecognized restart status phase: " + phase)
    return {"kind": "receipt", "exitCode": 0, "data": data}


def _poll(state):
    from .target import command_script
    if _ssh_snapshot(state["host"]) != state["ssh"]:
        return {"kind": "config-changed", "error": "SSH 配置已改变；没有继续访问其他目标"}
    ssh.PROXY["on"] = False
    args = ["restart-status", "--request-id", state["requestId"], "--json"]
    return _receipt(ssh.run_remote(state["host"], command_script("dsh-use", args), capture=True), state["requestId"])


def _invoke(mode, watch_id, directory):
    return [sys.executable, "-m", "agentkit.remote.notifications", mode, watch_id, "--state-dir", str(directory)]


def _environment():
    env = dict(os.environ)
    for key in ("DSH_SESSION_ID", "DSH_TURN_ID", "DSH_AGENT_ID"):
        env.pop(key, None)
    env["PYTHONPATH"] = str(SHARED)
    return env


def _bounded_command(argv, timeout):
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                             env=_environment(), cwd=SHARED)
    try:
        out, err = child.communicate(timeout=timeout)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
    return subprocess.CompletedProcess(argv, child.returncode, out, err)


def _poll_child(watch_id, directory, timeout):
    try:
        done = _bounded_command(_invoke("--poll", watch_id, directory), timeout)
    except subprocess.TimeoutExpired:
        return {"kind": "transport-error", "error": "查询超过本机单次期限，结果未确认"}
    if done.returncode != 0:
        return {"kind": "invalid", "exitCode": done.returncode, "error": done.stderr.decode("utf-8", "replace")}
    return _json_bytes(done.stdout)


def _notify(state):
    labels = {"completed": "重启已完成", "failed": "重启失败", "timed-out": "远端重启等待超时",
              "interrupted": "远端重启已中断，未确认完成", "unknown": "重启结果未知，未确认完成"}
    summary = f'{state["host"]}：{labels[state["phase"]]}'
    text = f'{summary}。\n请求编号：{state["requestId"]}\n'
    text += state.get("message", "")
    if state.get("remote", {}).get("log"):
        text += f'\n远端日志：{state["remote"]["log"]}'
    text += f'\n本机观察编号：{state["watchId"]}'
    argv = [str(Path.home() / ".local/bin/dsh-use"), "--local", "notice", state["localSession"],
            text, "--summary", summary, "--json"]
    try:
        done = _bounded_command(argv, 30)
        if done.returncode:
            return {"state": "failed", "exitCode": done.returncode,
                    "error": done.stderr.decode("utf-8", "replace"), "stdout": done.stdout.decode("utf-8", "replace")}
        result = _json_bytes(done.stdout)
        if result.get("ok") is not True or not isinstance(result.get("data"), dict) or result["data"].get("sessionId") != state["localSession"]:
            raise ValueError("notice acknowledgement does not match the local session")
        acknowledgement = result["data"]
        if acknowledgement.get("accepted") is True and acknowledgement.get("scheduled") is True:
            return {"state": "scheduled", "exitCode": 0, "scheduledAt": time.time(),
                    "receipt": acknowledgement}
        return {"state": "recorded-unconfirmed", "exitCode": 0, "receipt": acknowledgement,
                "error": "通知回执没有确认安排执行；不自动重复发送"}
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired) as exc:
        # Delivery may have happened before a timeout; retrying could duplicate it.
        return {"state": "unconfirmed", "error": str(exc)}


def _worker(watch_id, directory):
    path = directory / (watch_id + ".json")
    with _lock(directory / (watch_id + ".worker.lock"), blocking=False):
        state = _load(path, watch_id)
        if state["phase"] != "starting":
            raise ValueError("watch was already started; refusing duplicate delivery")
        state.update(pid=os.getpid(), phase="watching", readyAt=time.time())
        _atomic(path, state)
        deadline = time.monotonic() + max(0, state["deadlineAt"] - time.time())
        while time.monotonic() < deadline:
            try:
                result = _poll_child(watch_id, directory, min(POLL_TIMEOUT, deadline - time.monotonic()))
            except (OSError, ValueError, UnicodeError) as exc:
                result = {"kind": "invalid", "error": str(exc)}
            state["lastPoll"] = result
            state["updatedAt"] = time.time()
            kind = result.get("kind")
            if kind == "receipt":
                remote = result["data"]
                state["remote"] = remote
                if remote["phase"] in TERMINAL:
                    state.update(phase=remote["phase"], message=remote.get("message", ""))
                    break
            elif kind == "not-found" and time.time() - state["createdAt"] <= INITIAL_GRACE:
                pass
            elif kind == "transport-error":
                pass
            else:
                state.update(phase="unknown", message=result.get("error", "找不到指定重启记录，未确认结果"))
                break
            _atomic(path, state)
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(state["interval"], remaining))
        else:
            state.update(phase="unknown", message="本机观察期限已到；远端重启仍未确认终态，不能当成失败或成功")
        state["finishedAt"] = time.time()
        state["notification"] = {"state": "attempting"}
        _atomic(path, state)
        state["notification"] = _notify(state)
        state["updatedAt"] = time.time()
        _atomic(path, state)


def start_restart_watch(host, request_id, session_id, *, timeout=DEFAULT_TIMEOUT, interval=3, ssh_snapshot=None):
    """Start one detached local observer after a confirmed remote restart receipt."""
    request_id = _uuid(request_id)
    session_id = _session(session_id)
    if not isinstance(host, str) or not host or host == "local" or host.startswith("-") or any(c.isspace() for c in host):
        raise ValueError("watch requires an explicit remote host")
    for value in (timeout, interval):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError("watch timeout and interval must be positive finite numbers")
    directory = _state_dir().absolute()
    _private_dir(directory)
    path = directory / (request_id + ".json")
    with _lock(directory / ".registry.lock"):
        if path.exists() or path.is_symlink():
            old = _load(path, request_id)
            if old["host"] != host or old["localSession"] != session_id:
                raise ValueError("request is already associated with a different host or local session")
            if old.get("notification", {}).get("state") == "not-attempted":
                raise RuntimeError("previous watch startup failed; inspect local state, do not report it as started")
            if old["phase"] in TERMINAL | {"unknown"} or _worker_alive(directory, request_id, old.get("pid")):
                return {"watchId": request_id, "pid": old.get("pid"), "statePath": str(path)}
            raise RuntimeError("existing watcher did not complete; inspect local state, do not duplicate it")
        snapshot = _ssh_snapshot(host)
        if ssh_snapshot is not None and snapshot != ssh_snapshot:
            raise ValueError("SSH 配置在重启请求后改变；没有向新目标建立观察")
        now = time.time()
        state = {"version": 1, "watchId": request_id, "requestId": request_id, "host": host,
                 "localSession": session_id, "ssh": snapshot, "createdAt": now, "deadlineAt": now + timeout,
                 "interval": interval, "phase": "starting", "pid": None, "notification": {"state": "pending"}}
        _atomic(path, state)
        child = None
        try:
            fd = _open_private(directory / (request_id + ".log"))
            with os.fdopen(fd, "ab") as log:
                child = subprocess.Popen(_invoke("--worker", request_id, directory), stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, start_new_session=True, close_fds=True,
                                         cwd=SHARED, env=_environment())
            ready_deadline = time.monotonic() + 5
            while time.monotonic() < ready_deadline:
                current = _load(path, request_id)
                if current.get("readyAt") and current.get("pid") == child.pid:
                    return {"watchId": request_id, "pid": child.pid, "statePath": str(path)}
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
        print(json.dumps(_poll(_load(directory / (watch_id + ".json"), watch_id)), ensure_ascii=False))


if __name__ == "__main__":
    main()
