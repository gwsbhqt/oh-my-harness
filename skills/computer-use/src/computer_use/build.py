"""找到或编译 computer-use 的本机程序。命令行启动器和 Python 包共用这一份逻辑。

快速路径只看源码、CPU 架构和系统版本：这三样没变就直接用上次编好的程序，
不再每次去问编译器版本（那一步要 0.14 秒，占了一条命令的大半时间）。
只升级 Xcode、源码和系统都没动时不会自动重编；要强制重编就删掉缓存目录。
"""
from __future__ import annotations

import fcntl
import hashlib
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

SOURCE = Path(__file__).with_name("computer-use.swift")
if not SOURCE.is_file():
    SOURCE = Path(__file__).resolve().parents[2] / "bin" / "computer-use.swift"


class BuildError(RuntimeError):
    """编译环境缺失或编译失败。消息写给人看。"""


def cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "computer-use" / "build"


def _quick_key(source: bytes) -> str:
    identity = source + (platform.machine() + platform.mac_ver()[0]).encode()
    return "q-" + hashlib.sha256(identity).hexdigest()[:20]


def _usable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def ensure_binary(log: Callable[[str], None] = _stderr) -> Path:
    """返回可执行程序的路径；需要时先编译。失败抛 BuildError。"""
    if sys.platform != "darwin":
        raise BuildError("computer-use 仅支持 macOS；不能在 Linux 上运行 macOS 驱动")
    source = SOURCE.read_bytes()
    cache = cache_dir()
    quick = cache / _quick_key(source)
    if _usable(quick):
        return quick.resolve()

    compiler = subprocess.run(["xcrun", "--find", "swiftc"], capture_output=True, text=True)
    if compiler.returncode:
        raise BuildError("找不到 Swift 编译器，请安装 Xcode Command Line Tools：xcode-select --install")
    swiftc = compiler.stdout.strip()
    version = subprocess.run([swiftc, "--version"], capture_output=True, text=True, check=True)
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    identity = source + (platform.machine() + platform.mac_ver()[0] + sdk
                         + version.stdout + version.stderr).encode()
    key = hashlib.sha256(identity).hexdigest()[:20]
    cache.mkdir(parents=True, exist_ok=True)
    binary = cache / key
    with (cache / (key + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not _usable(binary):
            log("computer-use: 首次运行或源码/系统/架构变化，正在编译…")
            fd, temporary = tempfile.mkstemp(prefix=key + ".", dir=cache)
            os.close(fd)
            try:
                result = subprocess.run([swiftc, "-sdk", sdk, "-O", str(SOURCE), "-o", temporary],
                                        capture_output=True, text=True)
                if result.returncode:
                    tail = (result.stderr or result.stdout).strip().splitlines()[-20:]
                    raise BuildError("computer-use 编译失败：\n" + "\n".join(tail))
                os.chmod(temporary, 0o755)
                os.replace(temporary, binary)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        link = cache / (quick.name + ".tmp")
        if link.is_symlink() or link.exists():
            link.unlink()
        os.symlink(binary.name, link)
        os.replace(link, quick)
    return binary
