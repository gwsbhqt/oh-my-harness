"""browser-control 能操作的浏览器。每种浏览器的应用名、日常资料目录、主进程和可用运行方式只在这里登记，引擎按名字查表。

加一种 Chromium 系浏览器只需在 BROWSERS 里加一项；它的日常实例要能像 Chrome 一样打开远程调试（chrome://inspect#remote-debugging）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
import glob
import os
from pathlib import Path
import re
import shutil
import sys

from .errors import BrowserControlError


@dataclass(frozen=True)
class Browser:
    name: str
    """browser= 参数里的名字。"""
    app: str
    """macOS 应用名：退出、启动和 computer-control 点授权框都用它。"""
    bundle_id: str
    process: str
    """pgrep -f 识别日常实例主进程的正则，不能匹配到它的辅助进程。"""
    modes: tuple
    """支持的运行方式，第一项是默认。"""
    fallback: str
    """attach 连不上时的默认后路：clone 或 never。"""
    restart: str
    """attach 连不上、但调试端口文件还在时，默认是否重启日常实例：if_needed 或 never。"""
    debug_page: str
    """日常实例里打开远程调试开关的页面。"""
    attach_help: str | None = None
    """连接被浏览器拒绝时的操作提示；省略时提示检查设置页与授权。"""
    fallback_port: str | None = None
    """日常实例没写 DevToolsActivePort 时试连的端口；None 表示不猜，直接报没开远程调试。"""
    data_roots: dict = field(default_factory=dict)
    """平台（darwin、win32、linux）到日常资料目录的写法；~ 和 %LOCALAPPDATA% 在取用时展开。"""

    @property
    def default_mode(self):
        return self.modes[0]

    def data_root(self):
        """日常实例的资料目录（DevToolsActivePort 和各资料都在这里）。"""
        platform = "win32" if os.name == "nt" else sys.platform if sys.platform == "darwin" else "linux"
        raw = self.data_roots.get(platform)
        if raw is None:
            raise BrowserControlError(f"{self.name} 在当前系统上不支持接管日常实例", 5)
        if raw.startswith("%LOCALAPPDATA%"):
            return Path(os.environ["LOCALAPPDATA"]) / raw.removeprefix("%LOCALAPPDATA%/")
        return Path(raw).expanduser()

    def check_mode(self, mode):
        if mode not in self.modes:
            if self.modes == ("attach",):
                raise BrowserControlError(f"{self.name} 只能 attach 接管日常实例；独立实例和复制资料请用 browser='Chrome'", 2)
            raise BrowserControlError(f"{self.name} 的 mode 只能是 {'、'.join(self.modes)}", 2)


BROWSERS = {
    "Chrome": Browser(
        name="Chrome", app="Google Chrome", bundle_id="com.google.Chrome",
        process=r"Google Chrome\.app/Contents/MacOS/Google Chrome( |$)",
        modes=("isolated", "attach", "clone"), fallback="clone", restart="if_needed",
        debug_page="chrome://inspect/#remote-debugging", fallback_port="9222",
        data_roots={"darwin": "~/Library/Application Support/Google/Chrome",
                    "win32": "%LOCALAPPDATA%/Google/Chrome/User Data",
                    "linux": "~/.config/google-chrome"}),
    # Arc 使用自己的原生外壳和资料格式；只接管现有实例，不把 Chrome 的启动和资料复制规则套在它上面。
    "Arc": Browser(
        name="Arc", app="Arc", bundle_id="company.thebrowser.Browser",
        process=r"Arc\.app/Contents/MacOS/Arc(Binary)?( |$)",
        modes=("attach",), fallback="never", restart="never",
        debug_page="arc://inspect/#remote-debugging",
        attach_help="请正常退出并重新打开更新后的本地 Arc；仅在 inspect 设置页开启调试可能仍被拒绝",
        data_roots={"darwin": "~/Library/Application Support/Arc/User Data"}),
}

NAMES = tuple(BROWSERS)


def lookup(name):
    """按 browser= 名字取浏览器描述；不认识的名字报参数错误。"""
    try:
        return BROWSERS[name]
    except (KeyError, TypeError):
        raise BrowserControlError(f"browser 只能是 {'、'.join(NAMES)}", 2) from None


_INSTALLED = ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")

_TESTING_BUILDS = (
    "~/.cache/chrome-for-testing/chrome/*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "~/.cache/puppeteer/chrome/*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
)


def _version(build):
    """下载目录名里的版本：Chrome for Testing 是 mac_arm-157.0.8103.38，Playwright 是 chromium-1234。"""
    found = re.findall(r"\d+(?:\.\d+)+", build) or re.findall(r"chromium-(\d+)", build)
    return tuple(int(part) for part in found[-1].split(".")) if found else ()


def chrome_executable():
    """独立实例和 clone 用的 Chrome 内核：先找正式版 Chrome、Chromium，再找本机下载的最新 Chrome for Testing，最后找 PATH。"""
    found = next((p for p in _INSTALLED if Path(p).is_file()), None)
    if found:
        return found
    builds = [p for pattern in _TESTING_BUILDS for p in glob.glob(os.path.expanduser(pattern)) if Path(p).is_file()]
    if builds:
        return max(builds, key=lambda p: _version(p.split("/Google Chrome for Testing.app")[0].rsplit("/", 2)[-2]))
    return shutil.which("google-chrome") or shutil.which("chromium")
