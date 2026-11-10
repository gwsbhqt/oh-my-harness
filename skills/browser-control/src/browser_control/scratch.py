"""本服务的临时目录：截图、网络正文、调试产物、输出图和自启 Chrome 资料都放在这里，服务退出时整个删掉。

目录形如 $TMPDIR/browser-control-run-<pid>-<随机>/，下分 shots、network、diagnostics、output、chrome。
主人进程一直持有目录里 owner.lock 的独占锁；进程不管怎么死（包括 kill -9），锁都会被系统释放，
清扫方拿得到锁就说明主人已不在。
"""
from __future__ import annotations

import atexit
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

PREFIX = "browser-control-run-"
LOCK = "owner.lock"
MARKER = "owner.json"
# 旧版直接建在 $TMPDIR 下的目录：没有主人标记，只能按修改时间判断。
LEGACY = ("browser-control-shots-", "browser-control-network-", "browser-control-diagnostics-", "browser-control-output-", "browser-control-chrome-")
LEGACY_AGE = 24 * 3600
# 主人刚建好目录、还没来得及拿锁写标记的空档；超过这个时间仍没有标记，才当成建到一半就死掉的残留。
CREATING_GRACE = 60

_lock = threading.Lock()
_current = None  # (pid, 目录, 锁文件描述符)
_users = 0
_atexit_registered = False


def run_dir():
    """本进程的临时目录，第一次用时创建并拿锁。"""
    global _current, _atexit_registered
    with _lock:
        pid = os.getpid()
        if _current is not None and _current[0] == pid:
            if _current[1].is_dir():
                return _current[1]
            os.close(_current[2])
        path = Path(tempfile.mkdtemp(prefix=f"{PREFIX}{pid}-"))
        fd = None
        try:
            os.chmod(path, 0o700)
            fd = os.open(path / LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            (path / MARKER).write_text(json.dumps({"pid": pid, "created": time.time()}))
        except BaseException:
            if fd is not None:
                os.close(fd)
            shutil.rmtree(path, ignore_errors=True)
            raise
        _current = (pid, path, fd)
        if not _atexit_registered:
            # 不经 engine.close 的进程（单元测试、进程内直接用 Engine）退出时也删掉自己的目录。
            atexit.register(_remove_at_exit)
            _atexit_registered = True
        return path


def subdir(kind):
    """本进程临时目录下的一类产物目录（700）。"""
    path = run_dir() / kind
    path.mkdir(mode=0o700, exist_ok=True)
    return path


def current():
    """本进程已建的临时目录；还没建过返回 None。"""
    with _lock:
        if _current is not None and _current[0] == os.getpid():
            return _current[1]
    return None


def contains(path):
    """path 是否在本进程临时目录里；只有这里的东西 browser-control 才会删。"""
    root = current()
    if root is None:
        return False
    try:
        Path(os.path.realpath(path)).relative_to(os.path.realpath(root))
    except ValueError:
        return False
    return True


def acquire():
    """登记一个使用者（一个 Engine）；全部 release 后才删目录，同进程里多个 Engine 不会互删。"""
    global _users
    with _lock:
        _users += 1


def release():
    """注销一个使用者；最后一个走时删掉本进程临时目录。调用前须先停掉用这里资料目录的 Chrome。"""
    global _users
    with _lock:
        _users = max(0, _users - 1)
        last = _users == 0
    if last:
        remove()


def remove():
    """删掉本进程临时目录并放锁。"""
    global _current
    with _lock:
        if _current is None or _current[0] != os.getpid():
            return
        pid, path, fd = _current
        _current = None
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            pass
        finally:
            os.close(fd)


def _remove_at_exit():
    try:
        remove()
    except Exception as exc:
        print(f"browser-control 临时目录删除失败：{exc}", file=sys.stderr)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


_USER_DATA = re.compile(r"--user-data-dir=(\S+)")


def chrome_processes():
    """带 --user-data-dir 的浏览器主进程：[(pid, 资料目录真实路径, 是否开了调试端口)]。ps 失败时抛 OSError。"""
    result = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True)
    if result.returncode != 0:
        raise OSError(f"ps 失败：{result.stderr.strip()}")
    found = []
    for line in result.stdout.splitlines():
        pid, _, command = line.strip().partition(" ")
        if not pid.isdigit() or " --type=" in command:
            continue
        match = _USER_DATA.search(command)
        if match:
            found.append((int(pid), os.path.realpath(match.group(1)), "--remote-debugging-port" in command))
    return found


def _profile_pids(profile, processes):
    """正在用这个资料目录的浏览器主进程号；SingletonLock 指向的进程只在命令行也对得上时才算。"""
    real = os.path.realpath(profile)
    pids = {pid for pid, directory, _ in processes if directory == real}
    lock = Path(profile) / "SingletonLock"
    if lock.is_symlink():
        tail = os.readlink(lock).rpartition("-")[2]
        if tail.isdigit() and _alive(int(tail)) and int(tail) not in pids:
            command = subprocess.run(["ps", "-p", tail, "-o", "command="], capture_output=True, text=True).stdout
            if f"--user-data-dir={profile}" in command or f"--user-data-dir={real}" in command:
                pids.add(int(tail))
    return pids


def _stop(pids, wait=5):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + wait
    while any(_alive(p) for p in pids) and time.monotonic() < deadline:
        time.sleep(0.1)
    for pid in pids:
        if _alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def _size(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                pass
    return total


def _newest(path):
    """目录本身和第一层内容里最新的修改时间。"""
    newest = path.lstat().st_mtime
    for child in path.iterdir():
        try:
            newest = max(newest, child.lstat().st_mtime)
        except OSError:
            pass
    return newest


def _owner_gone(path, now):
    """browser-control-run 目录的主人是否已不在。返回 (是否已不在, 拿到的锁描述符)；锁描述符要在删完后关闭。"""
    try:
        fd = os.open(path / LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return now - path.lstat().st_mtime > CREATING_GRACE, None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return False, None
    if not (path / MARKER).exists() and now - path.lstat().st_mtime <= CREATING_GRACE:
        os.close(fd)
        return False, None
    return True, fd


def sweep(root=None, *, now=None, processes=None):
    """清掉主人已不在的 browser-control-run 目录（先停掉还在用它资料目录的 Chrome），以及超过一天、没有进程在用的旧版目录。

    不抛异常；返回 {"removed": [...], "kept": [...], "stopped": [pid...], "bytes": 删掉的字节数, "errors": [...]}。
    """
    root = Path(root or tempfile.gettempdir())
    now = time.time() if now is None else now
    report = {"removed": [], "kept": [], "stopped": [], "bytes": 0, "errors": []}
    mine = current()
    try:
        entries = sorted(root.iterdir())
    except OSError as exc:
        report["errors"].append({"path": str(root), "error": str(exc)})
        return report
    if processes is None:
        try:
            processes = chrome_processes()
        except OSError as exc:
            # 看不到进程表就判断不了旧版 Chrome 资料是否在用，只清 browser-control-run 目录。
            report["errors"].append({"path": "ps", "error": str(exc)})
            processes = None
    for path in entries:
        name = path.name
        try:
            if not (name.startswith(PREFIX) or name.startswith(LEGACY)):
                continue
            info = path.lstat()
            if not path.is_dir() or path.is_symlink() or info.st_uid != os.getuid():
                continue
            if mine is not None and os.path.realpath(path) == os.path.realpath(mine):
                continue
            if name.startswith(PREFIX):
                gone, fd = _owner_gone(path, now)
                if not gone:
                    report["kept"].append(str(path))
                    continue
                try:
                    chrome = path / "chrome"
                    if chrome.is_dir():
                        if processes is None:
                            report["kept"].append(str(path))
                            continue
                        for profile in chrome.iterdir():
                            # 服务被强杀时它启动的 Chrome 不会跟着退出；这份临时资料没人能再接管，停掉再删。
                            pids = sorted(_profile_pids(profile, processes))
                            if pids:
                                _stop(pids)
                                report["stopped"].extend(pids)
                    report["bytes"] += _size(path)
                    shutil.rmtree(path)
                    report["removed"].append(str(path))
                finally:
                    if fd is not None:
                        os.close(fd)
                continue
            if now - _newest(path) <= LEGACY_AGE:
                report["kept"].append(str(path))
                continue
            if name.startswith("browser-control-chrome-"):
                if processes is None or _profile_pids(path, processes):
                    report["kept"].append(str(path))
                    continue
            report["bytes"] += _size(path)
            shutil.rmtree(path)
            report["removed"].append(str(path))
        except Exception as exc:
            report["errors"].append({"path": str(path), "error": f"{type(exc).__name__}: {exc}"})
    return report


def live_chrome_scopes(processes=None):
    """开着调试端口的 Chrome 各自的浏览器 UUID（取自资料目录里的 DevToolsActivePort）。

    返回 (UUID 集合, 是否有读不出 UUID 的)；读不出时调用方不该据此删记录。
    """
    processes = chrome_processes() if processes is None else processes
    scopes, unknown = set(), False
    for _pid, directory, debugging in processes:
        if not debugging:
            continue
        try:
            lines = (Path(directory) / "DevToolsActivePort").read_text().splitlines()
        except OSError:
            unknown = True
            continue
        if len(lines) >= 2 and lines[1].startswith("/devtools/browser/"):
            scopes.add(lines[1][len("/devtools/browser/"):].lower())
        else:
            unknown = True
    return scopes, unknown
