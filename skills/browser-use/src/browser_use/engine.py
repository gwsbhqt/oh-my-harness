"""browser-use 资源归属与浏览器连接；所有动作必须绑定确切标签页。"""
from __future__ import annotations
import importlib
import json
import os
import select
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid
from .cdp import CDP, discover

ATTACH_OPEN_TIMEOUT = 35
from .browsers import BROWSERS, chrome_executable, lookup
from .errors import BrowserUseError
from .resources import ResourceLedger, scope_from_websocket
from . import scratch


_UPLOAD_ACTIONS = frozenset({"page_upload", "page_upload_via_chooser"})


def _log(message):
    print(f"browser-use: {message}", file=sys.stderr, flush=True)


class Engine:
    def __init__(self, ledger=None, *, sweep=False):
        self.ledger = ledger
        self._lock = threading.RLock()
        self.browsers = {}
        self.bindings = {}
        self._closed = False
        self._owners = set()
        self.uploads = None
        # 日常浏览器按浏览器名各接管一份：同一浏览器的多个会话共用一条连接。
        self._attach_restarted = {}
        self._attach_shared = {}
        self._attach_auto_approved = {}
        # 持有名单：bindings/browsers 每次增删都同步改它，只用这把小锁，长动作持有引擎大锁时也能立即读到准确的归属。
        self._held_lock = threading.Lock()
        self._held_pages = {}
        self._held_browsers = set()
        self.draining = threading.Event()
        scratch.acquire()
        self._scratch_held = True
        self._sweeper = None
        if sweep:
            # 放后台：删几百 MB 旧目录、等孤儿 Chrome 退出都可能要几秒，不能拖慢服务就绪。
            self._sweeper = threading.Thread(target=self.sweep_leftovers, name="browser-use-sweep", daemon=True)
            self._sweeper.start()

    def _default_ledger(self):
        """已有的资源账；本机从没建过账就返回 None，不为清扫去建目录。"""
        if self.ledger is not None:
            return self.ledger
        path = Path.home() / ".local/state/browser-use/resources.json"
        return ResourceLedger(path) if path.exists() else None

    def sweep_leftovers(self, tmp_root=None):
        """清掉以前的 browser-use 服务没收拾的东西：临时目录、孤儿 Chrome、账本里浏览器已不在的记录。不抛异常，只记日志。"""
        report = {"files": None, "records": []}
        try:
            report["files"] = files = scratch.sweep(tmp_root)
            if files["removed"] or files["stopped"]:
                _log(f"清掉 {len(files['removed'])} 个旧临时目录（{files['bytes'] // 1024} KB），结束 {len(files['stopped'])} 个没人管的 browser-use Chrome")
            for error in files["errors"]:
                _log(f"清扫 {error['path']} 失败：{error['error']}")
        except Exception as exc:
            _log(f"清扫临时目录失败：{type(exc).__name__}: {exc}")
        try:
            ledger = self._default_ledger()
            if ledger is not None:
                report["records"] = self._prune_ledger(ledger)
                if report["records"]:
                    _log(f"资源账删掉 {len(report['records'])} 条浏览器已不在的记录")
        except Exception as exc:
            _log(f"清扫资源账失败：{type(exc).__name__}: {exc}")
        return report

    def _prune_ledger(self, ledger, owner=None):
        """删掉对应 Chrome 已不在的记录；owner 给定时只看这个任务。"""
        scopes, unknown = scratch.live_chrome_scopes()
        if unknown:
            # 有开着调试端口、却读不出浏览器编号的 Chrome；分不清记录是不是它的，宁可留着。
            scopes = None
        else:
            scopes |= self._attach_scopes()

        def stale(records):
            return [item for item in records
                    if (owner is None or item["owner"] == owner)
                    and scopes is not None and item["scope"] not in scopes]
        return ledger.prune(stale)

    def _hold_page(self, key, owner):
        with self._held_lock:
            self._held_pages[key] = owner

    def _drop_page(self, key):
        with self._held_lock:
            self._held_pages.pop(key, None)

    def _hold_browser(self, key):
        with self._held_lock:
            self._held_browsers.add(key)

    def _drop_browser(self, key):
        with self._held_lock:
            self._held_browsers.discard(key)

    def _snapshot(self):
        with self._held_lock:
            return dict(self._held_pages), set(self._held_browsers)

    def holdings(self):
        """各任务仍在本进程持有的页面绑定和浏览器连接；排空时只看不动。"""
        pages, browsers = self._snapshot()
        owners = {}
        for owner in pages.values():
            item = owners.setdefault(owner, {"pages": 0, "browsers": []})
            item["pages"] += 1
        for name, session in browsers:
            owners.setdefault(session, {"pages": 0, "browsers": []})["browsers"].append(name)
        return [{"session": s, **v} for s, v in sorted(owners.items())]

    def idle(self):
        """本进程不再持有任何任务的页面和独立浏览器。磁盘上的页面记录、上传暂存由新服务接着处理。"""
        pages, browsers = self._snapshot()
        if pages:
            return False
        return all(self.browsers.get(key, {}).get("mode") == "attach" for key in browsers)

    def blockers(self):
        """排空时还在等谁：任务名和它占着的东西，给人看的一句话。"""
        parts = []
        for item in self.holdings():
            if not item["pages"] and any(key[1] == item["session"] and record.get("mode") == "attach" for key, record in self.browsers.items()):
                continue
            what = [f"{item['pages']} 个页面"] if item["pages"] else []
            what += [f"{b} 浏览器" for b in item["browsers"]]
            parts.append(f"{item['session']}（{'、'.join(what)}）")
        return parts

    def _refuse_new_holder(self, session):
        """排空后只许已有持有的旧任务再开页或连浏览器；在引擎锁内、真正新建资源前再核一次，防止查询和执行之间的空隙。"""
        if self.draining.is_set() and not self.holds({"session": session}):
            waiting = "、".join(self.blockers()) or "正在收尾"
            raise BrowserUseError(f"旧版 browser-use 服务正在排空，不接新任务；本次未执行。还在等：{waiting}；这些任务 release 后新版服务接手", 5, outcome="not_sent",
                          data={"draining": True, "holdings": self.holdings(), "waitingFor": self.blockers()})

    def holds(self, request):
        """这个请求所属的任务是否已在本服务持有页面或浏览器；排空时只放行这些旧任务。"""
        if not isinstance(request, dict):
            return False
        session = request.get("session")
        pages, browsers = self._snapshot()
        return any(owner == session for _, owner in browsers) or any(owner == session for owner in pages.values())

    @staticmethod
    def _session(value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", value):
            raise BrowserUseError("请指定独立 --session 名称（1~64个字母、数字、下划线或短横线）", 2)
        return value

    @staticmethod
    def _endpoint(value):
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port or parsed.path not in {"", "/"}:
            raise BrowserUseError("仅允许本机 loopback 浏览器调试地址；远程功能尚未验收", 2)
        return value.rstrip("/")

    def _key(self, browser, session):
        return (browser, session)

    @staticmethod
    def _matches(query, rows):
        words = query.casefold().split()
        return [r for r in rows if all(w in (r["url"] + " " + r["title"]).casefold() for w in words)]

    def _find_tab(self, browser_name, session, browser, params):
        """按网址或标题里的文字找到唯一的已加载标签并绑定。"""
        query = params.get("query")
        if not isinstance(query, str) or not query.strip():
            raise BrowserUseError("tab find 需要网址或标题里的文字", 2)
        pages = [t for t in self._targets(browser) if t.get("type") == "page"]
        hits = self._matches(query, [{"url": t.get("url", ""), "title": t.get("title", ""), "targetId": t["targetId"]} for t in pages])
        if len(hits) != 1:
            raise BrowserUseError(f"「{query}」匹配到 {len(hits)} 个标签，需要恰好一个", 3 if not hits else 2,
                          data={"matches": [{k: h[k] for k in ("title", "url")} for h in hits[:10]]})
        return {**self._summary(self._bind(browser_name, session, hits[0]["targetId"], browser)), "loaded": "already", "mode": browser.get("mode", "isolated")}

    # 前缀 -> (模块, 类)；服务按需创建，释放页面时依次 close。
    _SERVICES = {"state": ("state", "StateService"), "inspect": ("inspect", "InspectService"), "output": ("output", "OutputService")}

    _LAUNCH = {"proxy", "proxy_bypass", "ignore_https_errors", "lang", "user_agent", "window_size"}

    @classmethod
    def _launch_options(cls, params):
        launch = params.get("launch") or {}
        if not isinstance(launch, dict) or set(launch) - cls._LAUNCH:
            raise BrowserUseError("launch 只允许 " + "、".join(sorted(cls._LAUNCH)), 2)
        result = {}
        for name, value in launch.items():
            if value is None:
                continue
            if name == "ignore_https_errors":
                if not isinstance(value, bool):
                    raise BrowserUseError("ignore_https_errors 需要布尔值", 2)
                if value:
                    result[name] = True
                continue
            if name == "window_size":
                if not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, int) and not isinstance(v, bool) and 100 <= v <= 10000 for v in value)):
                    raise BrowserUseError("window_size 需要 [宽, 高]，100~10000 的整数", 2)
                result[name] = list(value)
                continue
            if not isinstance(value, str) or not value or any(c in value for c in "\r\n\x00"):
                raise BrowserUseError(f"{name} 需要不含换行的非空字符串", 2)
            if name == "proxy" and urllib.parse.urlparse(value).scheme not in {"http", "https", "socks4", "socks5"}:
                raise BrowserUseError("proxy 需要 http/https/socks4/socks5 地址", 2)
            if name == "lang" and not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*", value):
                raise BrowserUseError("lang 需要语言标签，例如 zh-CN", 2)
            result[name] = value
        return result

    @staticmethod
    def _launch_flags(launch):
        flags = []
        if launch.get("proxy"):
            flags.append("--proxy-server=" + launch["proxy"])
        if launch.get("proxy_bypass"):
            flags.append("--proxy-bypass-list=" + launch["proxy_bypass"])
        if launch.get("ignore_https_errors"):
            flags.append("--ignore-certificate-errors")
        if launch.get("lang"):
            flags += ["--lang=" + launch["lang"], "--accept-lang=" + launch["lang"]]
        if launch.get("user_agent"):
            flags.append("--user-agent=" + launch["user_agent"])
        if launch.get("window_size"):
            flags.append("--window-size={},{}".format(*launch["window_size"]))
        return flags

    @staticmethod
    def _profile_in_use(profile):
        # Chrome 用 SingletonLock 软链记录「主机名-进程号」；进程退出后软链可能残留，只看进程是否还在。
        lock = profile / "SingletonLock"
        if not lock.is_symlink():
            return False
        pid = os.readlink(lock).rpartition("-")[2]
        if not pid.isdigit():
            return True
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _profile_dir(self, name):
        root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")).expanduser() / "browser-use" / "chrome-profiles"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        path = root / name
        if path.is_symlink():
            raise BrowserUseError("Chrome 资料目录不能是软链", 5)
        path.mkdir(exist_ok=True, mode=0o700)
        if path.stat().st_uid != os.getuid():
            raise BrowserUseError("Chrome 资料目录不属于当前用户", 6)
        return path

    @staticmethod
    def _data_root(kind):
        return kind.data_root()

    def _attach_endpoint(self, kind):
        port_file = self._data_root(kind) / "DevToolsActivePort"
        try:
            lines = port_file.read_text(encoding="utf-8").splitlines() if port_file.is_file() else []
        except PermissionError:
            lines = []
        if lines and (not lines[0].isdigit() or not 0 < int(lines[0]) < 65536):
            raise BrowserUseError(f"{kind.name} 的 DevToolsActivePort 内容无效；未尝试连接其他浏览器", 5)
        if not lines and kind.fallback_port is None:
            help_text = kind.attach_help or f"在 {kind.name} 里打开 {kind.debug_page} 勾选允许后再试"
            raise BrowserUseError(f"日常 {kind.name} 没有有效的远程调试端口；{help_text}", 5)
        return "http://127.0.0.1:" + (lines[0] if lines else kind.fallback_port)

    def _attach_ws_path(self, kind):
        try:
            lines = (self._data_root(kind) / "DevToolsActivePort").read_text(encoding="utf-8").splitlines()
            if len(lines) > 1 and lines[1].startswith("/devtools/browser/"):
                return lines[1]
        except (OSError, PermissionError):
            pass
        return "/devtools/browser"

    def _attach_connection(self, kind):
        endpoint = self._attach_endpoint(kind)
        try:
            return endpoint, discover(endpoint)
        except Exception:
            return endpoint, endpoint.replace("http", "ws", 1) + self._attach_ws_path(kind)

    def _attach_scopes(self):
        """各日常浏览器的接管实例编号：已接管的取记录，没接管的探它的调试端口，探不到就不算。"""
        scopes = set()
        for kind in BROWSERS.values():
            if "attach" not in kind.modes:
                continue
            held = next((record["scope"] for (name, _), record in self.browsers.items()
                         if name == kind.name and record.get("mode") == "attach"), None)
            if held is not None:
                scopes.add(held)
                continue
            try:
                scopes.add(scope_from_websocket(self._attach_connection(kind)[1]))
            except Exception:
                pass
        return scopes

    def _browser_scope(self, cdp, websocket_url, endpoint):
        try:
            return scope_from_websocket(websocket_url)
        except BrowserUseError:
            version = cdp.call("Browser.getVersion")
            if "Chrome" not in version.get("product", ""):
                raise BrowserUseError("调试端口不属于 Chromium 系浏览器，拒绝接管", 5)
            process = next((item for item in cdp.call("SystemInfo.getProcessInfo")["processInfo"] if item.get("type") == "browser"), None)
            if process is None:
                raise BrowserUseError("无法确认浏览器进程身份", 5)
            started = subprocess.run(["ps", "-p", str(process["id"]), "-o", "lstart="], capture_output=True, text=True, check=True).stdout.strip()
            if not started:
                raise BrowserUseError("无法确认浏览器实例启动时间", 5)
            return str(uuid.uuid5(uuid.NAMESPACE_URL, f"browser-use-attach|{endpoint}|{process['id']}|{started}"))

    def _browser_pids(self, kind):
        result = subprocess.run(["pgrep", "-f", kind.process], capture_output=True, text=True)
        if result.returncode not in {0, 1}:
            raise BrowserUseError(result.stderr.strip() or f"无法确认 {kind.name} 是否在运行", 5)
        return [int(pid) for pid in result.stdout.split() if pid.isdigit()]

    def _restart_browser(self, kind):
        if sys.platform != "darwin":
            raise BrowserUseError(f"当前平台不支持安全重启日常 {kind.name}", 5)
        running = self._browser_pids(kind)
        if running:
            subprocess.run(["osascript", "-e", f'tell application "{kind.app}" to quit'], capture_output=True, text=True, timeout=30)
            deadline = time.monotonic() + 20
            while self._browser_pids(kind) and time.monotonic() < deadline:
                time.sleep(0.2)
            leftover = self._browser_pids(kind)
            if leftover:
                for pid in leftover:
                    try:
                        os.kill(pid, 15)
                    except ProcessLookupError:
                        pass
                deadline = time.monotonic() + 15
                while self._browser_pids(kind) and time.monotonic() < deadline:
                    time.sleep(0.2)
                if self._browser_pids(kind):
                    raise BrowserUseError(f"{kind.name} 未能在 35 秒内正常退出；未强制结束，未重试", 5)
        subprocess.run(["open", "-g", "-a", kind.app], check=True, capture_output=True)

    @staticmethod
    def _requested_profile(params, mode):
        profile = params.get("profile")
        if profile is None:
            return "Default" if mode == "clone" else None
        if not isinstance(profile, str) or not profile.strip() or "\x00" in profile:
            raise BrowserUseError("profile 需要非空资料名", 2)
        return profile.strip()

    def _clone_profile(self, kind, name):
        root = self._data_root(kind)
        if not re.fullmatch(r"[a-zA-Z0-9 _-]{1,64}", name):
            raise BrowserUseError(f"clone 的 profile 是日常 {kind.name} 的资料名，例如 Default 或 Profile 1，不接受路径", 2)
        source = root / name
        if not source.is_dir() or source.is_symlink() or source.stat().st_uid != os.getuid():
            raise BrowserUseError(f"找不到可安全复制的 {kind.name} 资料：{name}", 3)
        destination = Path(tempfile.mkdtemp(prefix="clone-", dir=scratch.subdir("chrome-clone"))) / "user-data"
        destination.mkdir(mode=0o700)
        local_state = root / "Local State"
        ignore = shutil.ignore_patterns("Cache", "Code Cache", "GPUCache", "Crashpad", "ShaderCache", "GrShaderCache")
        try:
            if local_state.is_file() and not local_state.is_symlink():
                shutil.copy2(local_state, destination / "Local State")
            shutil.copytree(source, destination / "Default", ignore=ignore)
        except PermissionError as exc:
            shutil.rmtree(destination.parent, ignore_errors=True)
            # macOS 的「访问其他 App 的数据」保护会挡住整个 Chrome 资料目录，跳过单个文件无济于事。
            raise BrowserUseError(f"macOS 拒绝读取日常 {kind.name} 资料，无法 clone：需在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」"
                                  "给启动 browser-use 的程序（如 DeepSeek Harness）打开权限；或改用 attach、isolated 持久资料", 5) from exc
        except Exception:
            shutil.rmtree(destination.parent, ignore_errors=True)
            raise
        return str(destination)

    def _start_approval_watcher(self, kind):
        process = subprocess.Popen(["computer-use", "--local", "approve-debug", kind.app, "--watch", "30", "--scope", f"browser-use-{kind.name.lower()}-approval", "--json"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # 授权框一弹出浏览器就自己跳到前台；等 computer-use 先记下用户原来的前台程序和最小化窗口，再发起连接。
        early, deadline = b"", time.monotonic() + 5
        while b"approve-debug ready" not in early and process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([process.stderr], [], [], remaining)[0]:
                break
            chunk = os.read(process.stderr.fileno(), 4096)
            if not chunk:
                break
            early += chunk
        process.early_stderr = "".join(line for line in early.decode(errors="replace").splitlines(True)
                                       if "approve-debug ready" not in line)
        return process

    @staticmethod
    def _finish_approval_watcher(process, *, terminate):
        if process is None:
            return False
        if terminate and process.poll() is None:
            # 连接成功往往就发生在 computer-use 点完「允许」的瞬间；让它先核对弹窗消失并把前台还给用户，再收尾。
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
        out, error = process.communicate(timeout=35)
        error = getattr(process, "early_stderr", "") + error
        if process.returncode > 0:
            _log(f"自动确认远程调试授权失败：{error.strip() or out.strip()}")
        try:
            return bool(json.loads(out).get("approved"))
        except Exception:
            return False

    @staticmethod
    def _verify_attach_browser(kind, cdp):
        if sys.platform != "darwin":
            return
        processes = cdp.call("SystemInfo.getProcessInfo")["processInfo"]
        pid = next((item["id"] for item in processes if item.get("type") == "browser"), None)
        if type(pid) is not int or pid <= 0:
            raise BrowserUseError(f"无法确认 {kind.name} 调试端口的进程身份", 5)
        result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=True)
        if not re.search(kind.process, result.stdout.strip()):
            raise BrowserUseError(f"调试端口不是 {kind.name} 的主进程；拒绝接管其他浏览器", 6)

    def _connect_attach(self, kind, session):
        if kind.name == "Chrome" and os.environ.get("BROWSER_USE_TEST_CHROME_ENDPOINT"):
            endpoint = self._endpoint(os.environ["BROWSER_USE_TEST_CHROME_ENDPOINT"])
            websocket_url = discover(endpoint)
            return CDP(websocket_url), endpoint, websocket_url
        # 没开远程调试就直接报错，不白起一个 30 秒的授权监听。
        self._attach_endpoint(kind)
        watcher = self._start_approval_watcher(kind)
        endpoint, websocket_url = self._attach_connection(kind)
        try:
            # 授权框没人点（如锁屏）时要留出改用 clone 的时间，整次 up 才能在调用方 60 秒等待内返回。
            cdp = CDP(websocket_url, open_timeout=ATTACH_OPEN_TIMEOUT)
        except Exception:
            if self._finish_approval_watcher(watcher, terminate=False):
                cdp = CDP(websocket_url, open_timeout=ATTACH_OPEN_TIMEOUT)
                self._attach_auto_approved[kind.name] = True
            else:
                raise
        else:
            self._attach_auto_approved[kind.name] = self._finish_approval_watcher(watcher, terminate=True)
        try:
            self._verify_attach_browser(kind, cdp)
        except Exception:
            cdp.close()
            raise
        return cdp, endpoint, websocket_url

    def _attach_browser(self, kind, session, params):
        restart = "never" if params.get("fallback", kind.fallback) == "clone" else params.get("restart") or kind.restart
        if restart not in {"never", "if_needed"}:
            raise BrowserUseError("restart 只能是 never 或 if_needed", 2)
        if self.ledger is None:
            self.ledger = ResourceLedger()
        shared = self._attach_shared.get(kind.name)
        if shared is not None and not self._connection_closed(shared["cdp"]):
            shared["users"].add(session)
        else:
            try:
                cdp, endpoint, websocket_url = self._connect_attach(kind, session)
            except Exception as exc:
                if isinstance(exc, BrowserUseError) and exc.code == 6:
                    raise
                if "HTTP 403" in str(exc):
                    help_text = kind.attach_help or f"请核对 {kind.debug_page} 和浏览器授权"
                    raise BrowserUseError(f"{kind.name} 拒绝了远程调试连接（HTTP 403）；{help_text}。未执行页面动作", 5) from exc
                if restart == "if_needed" and (self._data_root(kind) / "DevToolsActivePort").is_file():
                    self._restart_browser(kind)
                    cdp, endpoint, websocket_url = self._connect_attach(kind, session)
                    self._attach_restarted[kind.name] = True
                else:
                    raise
            scope = self._browser_scope(cdp, websocket_url, endpoint)
            self._attach_shared[kind.name] = {"scope": scope, "context_id": None, "cdp": cdp, "endpoint": endpoint,
                                              "process": None, "profile": None, "log": None, "launch": {}, "mode": "attach",
                                              "profileName": None, "browserRestarted": self._attach_restarted.get(kind.name, False),
                                              "users": {session}, "authorizationAutoApproved": self._attach_auto_approved.get(kind.name, False)}
            for (name, _), record in self.browsers.items():
                if name == kind.name and record.get("mode") == "attach":
                    record["cdp"] = cdp
        return {**self._attach_shared[kind.name], "lock": threading.RLock()}

    def _browser(self, browser, session, params=None):
        params = params or {}
        kind = lookup(browser)
        key = self._key(browser, session)
        requested_mode = params.get("mode")
        if requested_mode is not None and requested_mode not in {"attach", "isolated", "clone"}:
            raise BrowserUseError("mode 只能是 attach、isolated 或 clone", 2)
        existing = self.browsers.get(key)
        mode = requested_mode or (existing or {}).get("mode") or kind.default_mode
        kind.check_mode(mode)
        profile_name = self._requested_profile(params, mode)
        if existing is not None:
            if mode != existing.get("mode", "isolated") or profile_name is not None and profile_name != existing.get("profileName"):
                raise BrowserUseError(f"本会话的 {browser} 已按其他运行方式或资料启动；先 release 再更换", 2)
            if params.get("launch") and self._launch_options(params) != existing.get("launch"):
                raise BrowserUseError(f"本会话的 {browser} 已按其他启动选项运行；先 release 再用新选项启动", 2)
            if self._connection_closed(existing["cdp"]):
                raise BrowserUseError("浏览器连接已断开；先对原 Page 显式 recover，再只读核对，未重发操作", 5, outcome="not_sent", data={"recoveryRequired": True, "recoveryTargets": [b["targetId"] for b in self.bindings.values() if b["browser"] == browser and b["owner"] == session]})
            return existing
        if mode == "attach" and (params.get("launch") or (params.get("executable") and params.get("fallback", kind.fallback) == "never") or (params.get("headed") and params.get("fallback", kind.fallback) == "never") or profile_name is not None):
            raise BrowserUseError(f"attach 使用当前 {browser}，不接受 profile、launch、executable 或 headed", 2)
        if (params.get("launch") or {}).get("profile"):
            raise BrowserUseError("资料名请使用顶层 profile；launch.profile 已移除", 2)
        if mode == "isolated" and profile_name is not None and not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", profile_name):
            raise BrowserUseError("isolated 的 profile 是持久资料名：1~64 个字母、数字、下划线或短横线", 2)
        self._refuse_new_holder(session)
        process = None
        profile = None
        log = None
        launch = self._launch_options(params)
        fallback_from = None
        if mode == "attach":
            fallback = params.get("fallback", kind.fallback)
            if fallback not in {"clone", "never"}:
                raise BrowserUseError("fallback 只能是 clone 或 never", 2)
            if fallback == "clone":
                kind.check_mode("clone")
            try:
                record = self._attach_browser(kind, session, params)
            except (OSError, BrowserUseError) as exc:
                if fallback != "clone" or isinstance(exc, BrowserUseError) and exc.code == 6:
                    if isinstance(exc, BrowserUseError):
                        raise
                    raise BrowserUseError(f"无法连接日常 {browser}；请检查远程调试授权。未重复执行页面动作", 5) from exc
                fallback_from = "attach"
                mode = "clone"
                profile_name = "Default"
            else:
                self.browsers[key] = record
                self._hold_browser(key)
                return record
        if mode != "attach" or fallback_from:
            if os.environ.get("BROWSER_USE_TEST_CHROME_ENDPOINT"):
                # 只给 live 测试用：连测试自己启动的 Chrome，用户接口里没有这个入口。
                if params.get("launch") or params.get("executable"):
                    raise BrowserUseError("BROWSER_USE_TEST_CHROME_ENDPOINT 下连的是测试启动的 Chrome，不接受启动选项", 2)
                endpoint = self._endpoint(os.environ["BROWSER_USE_TEST_CHROME_ENDPOINT"])
            else:
                executable = params.get("executable") or chrome_executable()
                if not executable or not Path(executable).is_file():
                    raise BrowserUseError("未找到 Chrome；请安装浏览器或显式 executable= 指定", 5)
                if mode == "clone":
                    profile = self._clone_profile(kind, profile_name)
                elif profile_name:
                    profile = str(self._profile_dir(profile_name))
                else:
                    profile = tempfile.mkdtemp(prefix="profile-", dir=scratch.subdir("chrome"))
                (Path(profile) / "DevToolsActivePort").unlink(missing_ok=True)
                if self._profile_in_use(Path(profile)):
                    raise BrowserUseError("该 Chrome 资料正被另一个 Chrome 进程使用；先 release 占用它的会话", 6)
                flags = [executable, "--remote-debugging-port=0", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "--disable-features=AutomationControlled"]
                if mode == "isolated" and not profile_name:
                    # 只有临时干净资料禁用扩展；持久资料和克隆资料保持用户扩展。
                    flags += ["--disable-extensions", "--use-mock-keychain", "--password-store=basic"]
                flags += self._launch_flags(launch)
                if not params.get("headed", False):
                    flags.append("--headless=new")
                log = tempfile.TemporaryFile()
                try:
                    process = subprocess.Popen(flags, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
                    port_file = Path(profile) / "DevToolsActivePort"
                    deadline = time.monotonic() + 15
                    while not port_file.exists():
                        if process.poll() is not None:
                            log.seek(0)
                            detail = log.read().decode(errors="replace")[-2000:]
                            raise BrowserUseError(f"Chrome 启动失败：{detail}", 5)
                        if time.monotonic() > deadline:
                            raise BrowserUseError("Chrome 启动超时", 5)
                        time.sleep(0.05)
                    port_lines = port_file.read_text().splitlines()
                    if not port_lines or not port_lines[0].isdigit() or not 0 < int(port_lines[0]) < 65536:
                        raise BrowserUseError("Chrome 返回的调试端口文件无效", 5)
                    endpoint = "http://127.0.0.1:" + port_lines[0]
                except Exception:
                    self._cleanup_process(process, profile)
                    log.close()
                    raise
        try:
            if process is not None or os.environ.get("BROWSER_USE_TEST_CHROME_ENDPOINT"):
                websocket_url = discover(endpoint)
            cdp = CDP(websocket_url)
            scope = self._browser_scope(cdp, websocket_url, endpoint)
        except Exception as exc:
            if process is not None:
                self._cleanup_process(process, profile)
            if log is not None:
                log.close()
            if isinstance(exc, BrowserUseError):
                raise
            if mode == "attach":
                raise BrowserUseError(f"无法连接日常 {browser}；请检查远程调试授权。未重复执行页面动作", 5) from exc
            raise
        try:
            # 只有临时干净实例使用私有 context；持久资料和克隆资料需要写回默认 context。
            private = process is not None and mode == "isolated" and not profile_name
            context_id = cdp.call("Target.createBrowserContext", {"disposeOnDetach": True})["browserContextId"] if private else None
        except Exception:
            try:
                cdp.close()
            finally:
                self._cleanup_process(process, profile)
                if log is not None:
                    log.close()
            raise
        record = {"scope": scope, "context_id": context_id, "cdp": cdp, "endpoint": endpoint, "process": process, "profile": profile, "log": log, "lock": threading.RLock(),
                  "launch": launch, "mode": mode, "profileName": profile_name, "browserRestarted": self._attach_restarted.get(browser, False), "fallbackFrom": fallback_from}
        try:
            if self.ledger is None:
                self.ledger = ResourceLedger()
        except Exception:
            try:
                cdp.close()
            finally:
                self._cleanup_process(process, profile)
                if log is not None:
                    log.close()
            raise
        self.browsers[key] = record
        self._hold_browser(key)
        return record

    @staticmethod
    def _connection_closed(cdp):
        return getattr(cdp, "closed", getattr(cdp, "_closed", False)) is True

    @staticmethod
    def _needs_recovery(binding, browser):
        return binding["driver"].cdp is not browser["cdp"] or Engine._connection_closed(binding["driver"].cdp)

    @staticmethod
    def _remember_configuration(binding, action, params):
        # 先记再发：失败回执也可能意味着配置已经部分生效。
        configured = action.startswith(("debug_", "element_", "state_", "output_")) or action in {
            "page_init_add", "page_init_remove", "page_viewport", "page_key_down", "page_mouse_down",
            "page_upload_via_chooser", "network_route", "network_unroute", "network_override", "network_unoverride",
            "network_cache", "network_service_worker", "network_headers_set", "network_headers_clear",
            "network_auth_set", "network_auth_clear", "network_har_start", "network_har_stop", "lane_set", "lane_clear",
        } or action == "page_download" and params.get("action") == "directory"
        if configured:
            binding.setdefault("recovery_blockers", set()).add(action)

    def _recover(self, browser_name, session, target):
        browser = self.browsers.get(self._key(browser_name, session))
        binding = self.bindings.get((browser_name, target))
        if browser is None or binding is None or binding["owner"] != session:
            raise BrowserUseError("恢复需要本服务仍持有的原页面绑定；持久归属账不能证明自定义设置，未接管页面", 6, outcome="not_sent")
        with binding["lock"]:
            blockers = sorted(binding.get("recovery_blockers", ()))
            if blockers:
                raise BrowserUseError("页面使用过不能确认无损恢复的设置；保留原页面和归属，未继续操作", 6,
                                      outcome="not_sent", data={"targetId": target, "settings": blockers})
            saved = next((r for r in self.ledger.list(browser["scope"]) if r["targetId"] == target), None) if self.ledger else None
            if not saved or saved["owner"] != session or saved["owned"] != binding["owned"] or saved["browser"] != browser_name:
                raise BrowserUseError("原页面持久归属无法确认；未恢复", 6, outcome="not_sent")
            old_cdp = browser["cdp"]
            replacement = None
            websocket_url = browser["endpoint"]
            if browser.get("mode") == "attach":
                shared = self._attach_shared.get(browser_name)
                if shared is not None and not self._connection_closed(shared["cdp"]):
                    candidate_cdp = shared["cdp"]
                else:
                    websocket_url = self._attach_connection(lookup(browser_name))[1]
                    replacement = CDP(websocket_url)
                    if shared is not None:
                        shared["cdp"] = replacement
                        for (name, _), record in self.browsers.items():
                            if name == browser_name and record.get("mode") == "attach":
                                record["cdp"] = replacement
                    candidate_cdp = replacement
            else:
                websocket_url = discover(websocket_url)
                if self._connection_closed(old_cdp):
                    replacement = CDP(websocket_url)
                candidate_cdp = replacement or old_cdp
            if self._browser_scope(candidate_cdp, websocket_url, browser["endpoint"]) != browser["scope"]:
                raise BrowserUseError("浏览器实例已经改变；未改绑同端口的新浏览器", 6, outcome="not_sent")
            candidate = {**browser, "cdp": candidate_cdp}
            try:
                if not self._needs_recovery(binding, candidate):
                    try:
                        old_cdp.call("Page.getFrameTree", session_id=binding["driver"].session_id)
                    except BrowserUseError as exc:
                        message = str(exc).lower()
                        if exc.code != 1 or not any(s in message for s in ("session", "not attached", "target closed")):
                            raise
                    else:
                        return self._summary(binding) | {"recovered": False}
                targets = self._targets(candidate)
                if not any(t["targetId"] == target and t.get("type") == "page" for t in targets):
                    raise BrowserUseError("原页面已经不存在；未新建或改绑页面", 4, outcome="not_sent")
                # 私有 context 使用 disposeOnDetach；断线可能已销毁它，绝不补建。
                fresh = self._bind(browser_name, session, target, candidate, owned=binding["owned"], replace=binding)
            except BaseException:
                if replacement is not None and browser.get("mode") != "attach":
                    replacement.close()
                raise
            browser["cdp"] = candidate["cdp"]
            # 旧对象只使用原来的 CDP，不会向新会话发送撤销或业务动作。
            binding["driver"].close()
            return self._summary(fresh) | {"recovered": True, "observationsReset": True, "snapshotRequired": True}

    def _targets(self, browser):
        process = browser.get("process")
        if process is not None and process.poll() is not None:
            return []
        return browser["cdp"].call("Target.getTargets")["targetInfos"]

    def _new_target_params(self, browser, params):
        new_window = params.get("new_window", False)
        if type(new_window) is not bool:
            raise BrowserUseError("new_window 必须是 bool", 2)
        source = params.get("source_target")
        if source is not None and (not isinstance(source, str) or not source or not new_window):
            raise BrowserUseError("source_target 需要确切页面 ID，且只用于新窗口", 2)
        create = {"url": "about:blank", "background": True}
        if browser.get("context_id"):
            create["browserContextId"] = browser["context_id"]
        if new_window:
            create["newWindow"] = True
            if browser.get("mode") == "attach" or source is not None:
                pages = [t for t in self._targets(browser) if t.get("type") == "page"]
                if source is not None:
                    selected = next((t for t in pages if t["targetId"] == source), None)
                    if selected is None:
                        raise BrowserUseError("指定的资料来源页面已不存在；未创建窗口", 4)
                    context = selected.get("browserContextId")
                else:
                    contexts = {t.get("browserContextId") for t in pages}
                    if len(contexts) > 1:
                        raise BrowserUseError("浏览器同时打开了多份资料；请用 source_target 指定要共享登录的页面，未猜测资料", 6)
                    context = next(iter(contexts), None)
                if context is not None:
                    create["browserContextId"] = context
        return create

    def _close_target(self, browser, target):
        result = browser["cdp"].call("Target.closeTarget", {"targetId": target})
        if result.get("success") is False:
            raise BrowserUseError("浏览器拒绝关闭本任务页面", 1, data={"targetId": target})
        deadline = time.monotonic() + 5
        while any(t["targetId"] == target for t in self._targets(browser)):
            if time.monotonic() >= deadline:
                raise BrowserUseError("关闭已发出，但标签页仍存在；未重发关闭", 4, outcome="unknown", data={"targetId": target})
            time.sleep(0.03)

    def _bind(self, browser_name, session, target, browser, *, owned=False, replace=None):
        if not isinstance(target, str) or not target:
            raise BrowserUseError("必须指定确切标签页标识，不使用当前活动页面", 2)
        key = (browser_name, target)
        current = self.bindings.get(key)
        if current and replace is None:
            if current["owner"] != session:
                raise BrowserUseError("该标签页已由另一个 browser-use 任务绑定，拒绝交叉操作", 6)
            if self._needs_recovery(current, browser):
                raise BrowserUseError("原页面调试绑定已失效；先显式 recover，未重发操作", 5, outcome="not_sent", data={"recoveryRequired": True})
            return current
        self._refuse_new_holder(session)
        if self.ledger is not None and browser.get("scope"):
            recorded = next((r for r in self.ledger.list(browser["scope"]) if r["targetId"] == target), None)
            if recorded and recorded["owner"] != session:
                raise BrowserUseError("该标签页属于其他任务的持久记录，拒绝接管", 6)
            if recorded:
                owned = recorded["owned"]
        target_info = next((t for t in self._targets(browser) if t["targetId"] == target and t.get("type") == "page"), None)
        if target_info is None:
            raise BrowserUseError("标签页已关闭或不存在；未改为其他页面", 4)
        from .driver import PageDriver
        from .network import NetworkRecorder
        if self.ledger is not None and browser.get("scope"):
            self.ledger.record(browser["scope"], session, target, owned, browser_name)
        attached = browser["cdp"].call("Target.attachToTarget", {"targetId": target, "flatten": True})
        driver = network = None
        try:
            driver = PageDriver(browser["cdp"], target, attached["sessionId"])
            driver.browser_context_id = target_info.get("browserContextId", browser.get("context_id"))
            driver.browser_owned = browser.get("process") is not None
            driver.owned = owned
            network = NetworkRecorder(driver)
            driver.network = network
        except Exception:
            for component in (network, driver):
                if component is not None:
                    try:
                        component.close()
                    except Exception:
                        pass
            try:
                browser["cdp"].call("Target.detachFromTarget", {"sessionId": attached["sessionId"]})
            except BrowserUseError:
                pass
            if replace is None and not owned and self.ledger is not None and browser.get("scope"):
                self.ledger.remove(browser["scope"], session, target)
            raise
        binding = {"owner": session, "owned": owned, "driver": driver, "network": network, "targetId": target, "browser": browser_name, "url": target_info.get("url", ""), "lock": threading.RLock()}
        self.bindings[key] = binding
        self._hold_page(key, session)
        return binding

    @staticmethod
    def _summary(binding):
        return {k: binding[k] for k in ("targetId", "owned", "browser", "url")} | {"session": binding["owner"]}

    def _lane_status(self, browser_name, session):
        """本任务在这个浏览器里设了泳道的页面，各自的头和核对统计。"""
        pages = []
        for (name, target), binding in list(self.bindings.items()):
            if name != browser_name or binding["owner"] != session:
                continue
            state = binding["network"].lane("get", {})
            if state["headers"]:
                pages.append({"targetId": target, "url": binding["url"], **state})
        return {"pages": pages}

    @staticmethod
    def _with_lane_warning(binding, result):
        """页面动作的结果里带上新出现的泳道不一致警告；结果不是对象时留到下一次动作。"""
        if not isinstance(result, dict):
            return result
        warning = binding["network"].lane_warning()
        return {**result, "laneWarning": warning} if warning else result

    def _release_uploads(self, owner=None, browser=None, target=None):
        base = self.ledger.path.parent if self.ledger is not None else Path.home() / ".local/state/browser-use"
        if self.uploads is None and not (base / "uploads.json").exists():
            return {"cleaned": []}
        return self._upload_ledger().release(owner, browser, target)

    def _upload_ledger(self):
        if self.uploads is None:
            from .uploads import UploadLedger
            base = self.ledger.path.parent if self.ledger is not None else Path.home() / ".local/state/browser-use"
            self.uploads = UploadLedger(base / "uploads.json")
        return self.uploads

    def _close_binding(self, browser, binding, *, close_tab=True, preserve=False):
        """撤掉 browser-use 在页面上的修改并解除绑定；页面在此之前已被别处关掉时返回 True。"""
        target = binding["targetId"]
        process = browser.get("process")
        process_gone = process is not None and process.poll() is not None
        cleanup_errors = []
        for name in ("diagnostics", "elements", *self._SERVICES):
            if name in binding:
                try:
                    binding[name].close()
                    cleanup_errors.extend(getattr(binding[name], "close_errors", []))
                except Exception as exc:
                    cleanup_errors.append({"domain": name, "error": str(exc)})
        try:
            binding["network"].close()
            cleanup_errors.extend(getattr(binding["network"], "close_errors", []))
        except Exception as exc:
            cleanup_errors.append({"domain": "network", "error": str(exc)})
        if hasattr(binding["driver"], "close"):
            try:
                binding["driver"].close()
                # 已退出进程里的焦点、脚本和按键状态随进程消失，无需再向它撤销。
                if not process_gone:
                    cleanup_errors.extend(getattr(binding["driver"], "close_errors", []))
            except Exception as exc:
                cleanup_errors.append({"domain": "page", "error": str(exc)})
        detach_error = None
        if not process_gone:
            try:
                browser["cdp"].call("Target.detachFromTarget", {"sessionId": binding["driver"].session_id})
            except BrowserUseError as exc:
                detach_error = exc
        live = any(t["targetId"] == target for t in self._targets(browser))
        if detach_error is not None and live:
            cleanup_errors.append({"domain": "detach", **detach_error.as_dict()})
            raise BrowserUseError("未能确认页面调试绑定已解除；保留归属供核对", detach_error.code, outcome=detach_error.outcome,
                          data={"targetId": target, "errors": cleanup_errors}) from detach_error
        if close_tab and live:
            try:
                self._close_target(browser, target)
            except BrowserUseError as exc:
                cleanup_errors.append({"domain": "target_close", **exc.as_dict()})
                raise BrowserUseError("未能确认页面已关闭；保留归属供核对", exc.code, outcome=exc.outcome,
                              data={"targetId": target, "errors": cleanup_errors}) from exc
        # disconnect 保留归属是为了以后 release 能关页面；页面已经没了，留着记录只会变成残留。
        preserve = preserve and live
        if not preserve:
            try:
                self._release_uploads(binding["owner"], binding["browser"], target)
            except BrowserUseError as exc:
                cleanup_errors.append({"domain": "uploads", **exc.as_dict()})
                raise BrowserUseError("页面已处理，但上传暂存清理失败；保留归属", exc.code, outcome=exc.outcome,
                              data={"targetId": target, "errors": cleanup_errors}) from exc
        if not preserve and self.ledger is not None and browser.get("scope"):
            self.ledger.remove(browser["scope"], binding["owner"], target)
        self.bindings.pop((binding["browser"], target), None)
        self._drop_page((binding["browser"], target))
        if cleanup_errors:
            raise BrowserUseError("页面已解除绑定，但部分调试修改需要核对", 1,
                          data={"errors": cleanup_errors, "targetId": target, "closedExternally": not live})
        return not live

    def dispatch(self, request):
        try:
            result = self.execute(request)
            return {"ok": True, "result": result}
        except BrowserUseError as exc:
            if isinstance(request, dict):
                exc.command = exc.command or request.get("action")
                exc.host = exc.host or request.get("host", "local")
            return exc.as_dict()
        except (TypeError, ValueError, KeyError) as exc:
            # 这类异常多半出在内部状态，消息本身常常看不出上下文（例如 KeyError 只剩一个键名）；把栈写进服务日志便于定位。
            traceback.print_exc()
            return BrowserUseError(str(exc), 2).as_dict()
        except Exception as exc:
            traceback.print_exc()
            return BrowserUseError(f"browser-use 执行失败：{type(exc).__name__}: {exc}", 1).as_dict()

    def execute(self, request):
        if not isinstance(request, dict):
            raise BrowserUseError("请求必须为 JSON 对象", 2)
        action = request.get("action")
        if request.get("remoteStages") is not None and action not in _UPLOAD_ACTIONS:
            raise BrowserUseError("暂存归属只用于上传动作", 2, outcome="not_sent")
        params = request.get("params") or {}
        if not isinstance(params, dict):
            raise BrowserUseError("params 必须为对象", 2)
        if action not in {"up", "tab_new", "tab_find"}:
            params = {**params, "restart": "never"}
        host = request.get("host") or "local"
        if host != "local":
            raise BrowserUseError("browser-use 远程机器功能尚未实现；拒绝静默操作本机", 5)
        browser_name = request.get("browser", "Chrome")
        kind = lookup(browser_name)
        session = self._session(request.get("session"))
        self._owners.add((browser_name, session))
        if action == "status":
            cached = self.browsers.get(self._key(browser_name, session))
            connected = cached is not None and not self._connection_closed(cached["cdp"])
            return {"ready": connected, "connected": connected, "browser": browser_name, "owned": cached is not None and cached.get("process") is not None, "mode": (cached or {}).get("mode", params.get("mode") or kind.default_mode)}
        if action == "up":
            with self._lock:
                browser = self._browser(browser_name, session, params)
                result = {"ready": True, "browser": browser_name, "endpoint": browser["endpoint"], "mode": browser.get("mode", "isolated"), "owned": browser.get("process") is not None, "browserRestarted": browser.get("browserRestarted", False)}
                if browser.get("fallbackFrom"):
                    result["fallbackFrom"] = browser["fallbackFrom"]
                if browser.get("authorizationAutoApproved"):
                    result["authorizationAutoApproved"] = True
                return result
        if action == "tab_recover":
            with self._lock:
                return self._recover(browser_name, session, request.get("target"))
        valid = {"tab_list", "disconnect", "release", "tab_new", "tab_bind", "tab_find", "tab_close", "tab_window", "lane_status"}
        if action not in valid and not (isinstance(action, str) and action.startswith(("page_", "network_", "lane_", "element_", "debug_", *(p + "_" for p in self._SERVICES)))):
            raise BrowserUseError(f"未知动作：{action}", 2)
        with self._lock:
            if action == "lane_status" and not request.get("target"):
                return self._lane_status(browser_name, session)
            if action == "disconnect" and self._key(browser_name, session) not in self.browsers:
                return {"disconnected": []}
            if action == "release" and self._key(browser_name, session) not in self.browsers:
                self._release_uploads(session, browser_name)
                # 本服务没开这个任务的浏览器，账上还有它的记录，就是以前的服务没收拾干净；对应浏览器已不在就删掉。
                try:
                    ledger = self._default_ledger()
                    stale = [r["targetId"] for r in self._prune_ledger(ledger, owner=session)] if ledger is not None else []
                except (OSError, BrowserUseError) as exc:
                    _log(f"release 时核对资源账失败，记录保留：{exc}")
                    stale = []
                if stale:
                    return {"released": [], "closedExternally": stale, "note": f"这些页面所在的 {browser_name} 已经不在，记录已清理"}
                return {"released": []}
            cached = self.browsers.get(self._key(browser_name, session))
            process = (cached or {}).get("process")
            browser = cached if action == "release" and process is not None and process.poll() is not None else self._browser(browser_name, session, params)
            if action not in {"up", "tab_new", "tab_find"}:
                params = {k: v for k, v in params.items() if k != "restart"}
            if action == "disconnect":
                results, closed = [], []
                for binding in list(self.bindings.values()):
                    if binding["browser"] == browser_name and binding["owner"] == session:
                        with binding["lock"]:
                            gone_before = self._close_binding(browser, binding, close_tab=False, preserve=True)
                        (closed if gone_before else results).append(binding["targetId"])
                reply = {"disconnected": results, "targetsPreserved": True}
                return reply | {"closedExternally": closed} if closed else reply
            if action == "tab_list":
                return [t | {"owned": self.bindings.get((browser_name, t["targetId"]), {}).get("owner") == session and self.bindings.get((browser_name, t["targetId"]), {}).get("owned", False)} for t in self._targets(browser) if t.get("type") == "page"]
            if action == "release":
                results, closed, errors = [], [], []
                if self.ledger is not None and browser.get("scope"):
                    active = {b["targetId"] for b in self.bindings.values()}
                    targets = {t["targetId"] for t in self._targets(browser)}
                    for saved in self.ledger.list(browser["scope"], session):
                        target_id = saved["targetId"]
                        if target_id in active:
                            continue
                        if not saved["owned"]:
                            self.ledger.remove(browser["scope"], session, target_id)
                            results.append(target_id)
                            continue
                        try:
                            if target_id in targets:
                                self._close_target(browser, target_id)
                            self.ledger.remove(browser["scope"], session, target_id)
                            (results if target_id in targets else closed).append(target_id)
                        except Exception as exc:
                            errors.append({"targetId": target_id, "error": str(exc)})
                for key, binding in list(self.bindings.items()):
                    if key[0] != browser_name or binding["owner"] != session:
                        continue
                    try:
                        with binding["lock"]:
                            gone_before = self._close_binding(browser, binding, close_tab=binding["owned"])
                        (closed if gone_before else results).append(key[1])
                    except Exception as exc:
                        errors.append({"targetId": key[1], "error": str(exc)})
                if not errors:
                    try:
                        self._release_uploads(session, browser_name)
                    except BrowserUseError as exc:
                        errors.append({"scope": "uploads", "error": exc.as_dict()})
                if errors:
                    data = {"released": results, "errors": errors}
                    raise BrowserUseError("部分资源未能清理，保留记录供再次核对", 1, data=data | {"closedExternally": closed} if closed else data)
                self._stop_browser(browser_name, session)
                reply = {"released": results}
                return reply | {"closedExternally": closed, "note": "这些页面在释放前已被别处关闭，记录已清理"} if closed else reply
            if action == "tab_new":
                lane = None
                if params.get("lane") is not None:
                    from .network import lane_headers
                    lane = lane_headers(params["lane"])
                # 先开空白页、设好泳道再导航，首个文档请求才会带上泳道头。
                create_params = self._new_target_params(browser, params)
                target = browser["cdp"].call("Target.createTarget", create_params)["targetId"]
                try:
                    if self.ledger is not None and browser.get("scope"):
                        self.ledger.record(browser["scope"], session, target, True, browser_name)
                    binding = self._bind(browser_name, session, target, browser, owned=True)
                except Exception:
                    browser["cdp"].call("Target.closeTarget", {"targetId": target})
                    if self.ledger is not None and browser.get("scope"):
                        self.ledger.remove(browser["scope"], session, target)
                    raise
                try:
                    for script in ([params["init_script"]] if isinstance(params.get("init_script"), str) else params.get("init_script", [])):
                        self._remember_configuration(binding, "page_init_add", {})
                        binding["driver"].dispatch("init_add", {"script": script})
                    if lane:
                        self._remember_configuration(binding, "lane_set", {})
                        binding["network"].lane("set", {"headers": lane})
                    if params.get("url"):
                        binding["driver"].dispatch("goto", {"url": params["url"]})
                        binding["url"] = params["url"]
                except Exception as original:
                    try:
                        self._close_binding(browser, binding)
                    except Exception as cleanup:
                        raise BrowserUseError(f"创建页面失败：{original}；清理也失败：{cleanup}", 1, data={"targetId": target, "owner": session}) from original
                    raise
                summary = self._summary(binding) | {"mode": browser.get("mode", "isolated")}
                if browser.get("fallbackFrom"):
                    summary["fallbackFrom"] = browser["fallbackFrom"]
                if lane:
                    summary["lane"] = {"headers": lane}
                return summary
            target = request.get("target")
            if action == "tab_find":
                return self._find_tab(browser_name, session, browser, params)
            if action == "tab_bind":
                return self._summary(self._bind(browser_name, session, target, browser))
            binding = self.bindings.get((browser_name, target))
            if binding is None or binding["owner"] != session:
                raise BrowserUseError("标签页未属于本会话；先创建或明确 tab bind，不能使用活动页", 6)
        if self._needs_recovery(binding, browser):
            raise BrowserUseError("原页面调试绑定已失效；先显式 recover，未重发操作", 5, outcome="not_sent", data={"recoveryRequired": True})
        self._remember_configuration(binding, action, params)
        if action and action.startswith("debug_"):
            # 断点会阻塞evaluate的响应；resume/stack必须不等待同一页面动作锁。
            with self._lock:
                if "diagnostics" not in binding:
                    from .diagnostics import Diagnostics
                    binding["diagnostics"] = Diagnostics(binding["driver"])
                diagnostics = binding["diagnostics"]
            return self._with_lane_warning(binding, diagnostics.dispatch(action[6:], params))
        with binding["lock"]:
            if action == "tab_window":
                info = browser["cdp"].call("Browser.getWindowForTarget", {"targetId": target})
                target_info = next((t for t in self._targets(browser) if t["targetId"] == target), None)
                if target_info is None:
                    raise BrowserUseError("固定页面已不存在；未选择其他窗口", 4)
                return {"browserWindowId": info["windowId"], "bounds": info["bounds"],
                        "targetId": target, "title": target_info.get("title", ""),
                        "browserContextId": target_info.get("browserContextId")}
            if action == "tab_close":
                if not binding["owned"] and not params.get("authorized", False):
                    raise BrowserUseError("这是用户原有标签页，默认不关闭；release 只断开绑定", 6)
                if self._close_binding(browser, binding):
                    return {"closed": target, "closedExternally": True, "note": "页面在此之前已被别处关闭，记录已清理"}
                return {"closed": target}
            if action and action.startswith("lane_"):
                result = binding["network"].lane(action[5:], params)
                if action == "lane_set":
                    result["note"] = "已经加载的页面内容不带这个头；需要的话刷新页面"
                return result
            return self._with_lane_warning(binding, self._page_action(action, params, request, binding, session, browser_name, target))

    def _page_action(self, action, params, request, binding, session, browser_name, target):
        """页面会话上的普通动作：调试、元素、页面服务、页面动作和网络。"""
        if action and action.startswith("debug_"):
            if "diagnostics" not in binding:
                from .diagnostics import Diagnostics
                binding["diagnostics"] = Diagnostics(binding["driver"])
            return binding["diagnostics"].dispatch(action[6:], params)
        if action and action.startswith("element_"):
            if "elements" not in binding:
                from .elements import ElementService
                binding["elements"] = ElementService(binding["driver"])
            return binding["elements"].dispatch(action[8:], params)
        for prefix, (module, cls) in self._SERVICES.items():
            if action and action.startswith(prefix + "_"):
                if prefix not in binding:
                    service_class = getattr(importlib.import_module("." + module, __package__), cls)
                    binding[prefix] = service_class(binding["driver"])
                return binding[prefix].dispatch(action[len(prefix)+1:], params)
        if request.get("remoteStages") is not None:
            if action not in _UPLOAD_ACTIONS:
                raise BrowserUseError("暂存归属仅允许上传动作", 2)
            self._upload_ledger().register(session, browser_name, target, request["remoteStages"], params.get("files"))
        if action and action.startswith("page_"):
            # 弹窗或调试暂停会暂停JS；dispatch先处理恢复入口。
            return binding["driver"].dispatch(action[5:], params)
        if action and action.startswith("network_"):
            return binding["network"].dispatch(action[8:], params)
        raise BrowserUseError(f"未知动作：{action}", 2)

    def _attach_lost(self):
        """接管连接已断开的日常浏览器名。"""
        return {name for name, shared in list(self._attach_shared.items()) if self._connection_closed(shared["cdp"])}

    def attach_lost(self):
        return bool(self._attach_lost())

    def has_live_browser(self):
        """服务是否仍持有可用浏览器；一个接管连接断开不能结束另一浏览器的任务。"""
        return self.keep_shared_alive() or any(not self._connection_closed(record["cdp"]) for record in list(self.browsers.values()))

    def keep_shared_alive(self):
        return any(not self._connection_closed(shared["cdp"]) for shared in list(self._attach_shared.values()))

    def _stop_browser(self, name, session):
        key = self._key(name, session)
        browser = self.browsers.get(key)
        if browser is None:
            return
        if browser.get("mode") == "attach":
            shared = self._attach_shared.get(name)
            if shared is not None:
                shared["users"].discard(session)
            self.browsers.pop(key, None)
            self._drop_browser(key)
            return
        errors = []
        if browser.get("process") is not None and browser["process"].poll() is None and browser.get("profileName"):
            # 持久资料要靠浏览器正常退出才把 Cookie 等写回磁盘；直接 SIGTERM 会丢掉最近的登录态。
            try:
                browser["cdp"].call("Browser.close", timeout=5)
                browser["process"].wait(timeout=15)
            except Exception as exc:
                errors.append(f"持久资料 Chrome 未能正常退出，最近的状态可能未写回：{exc}")
        for operation in (browser["cdp"].close, lambda: self._cleanup_process(browser["process"], browser["profile"])):
            try:
                operation()
            except Exception as exc:
                errors.append(str(exc))
        if browser.get("log") is not None:
            browser["log"].close()
        process = browser["process"]
        if process is None or process.poll() is not None:
            self.browsers.pop(key, None)
            self._drop_browser(key)
        if errors:
            raise BrowserUseError("浏览器清理遇到错误：" + "; ".join(errors), 1)

    @staticmethod
    def _cleanup_process(process, profile_path):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if profile_path and scratch.contains(profile_path):
            shutil.rmtree(profile_path, ignore_errors=False)

    def close(self):
        self._closed = True
        try:
            self._close()
        finally:
            # 先停 Chrome 再删目录：Chrome 还在写资料目录时删，会留下它随后又建出的半个目录。
            if self._scratch_held:
                self._scratch_held = False
                scratch.release()

    def _close(self):
        errors = []
        owned_scopes = {b["scope"] for b in self.browsers.values() if b.get("process") is not None and b.get("scope")}
        lost = self._attach_lost()
        for binding in list(self.bindings.values()):
            if binding["browser"] in lost:
                self.bindings.pop((binding["browser"], binding["targetId"]), None)
                self._drop_page((binding["browser"], binding["targetId"]))
                continue
            browser = self.browsers.get(self._key(binding["browser"], binding["owner"]))
            if browser:
                try:
                    self._close_binding(browser, binding, close_tab=binding["owned"])
                except Exception as exc:
                    errors.append({"targetId": binding["targetId"], "error": str(exc)})
        for name, session in list(self.browsers):
            try:
                self._stop_browser(name, session)
            except Exception as exc:
                errors.append({"browser": name, "session": session, "error": str(exc)})
        for browser_name, owner in self._owners:
            try:
                self._release_uploads(owner, browser_name)
            except BrowserUseError as exc:
                errors.append({"browser": browser_name, "session": owner, "scope": "uploads", "error": exc.as_dict()})
        if owned_scopes and self.ledger is not None:
            # 本服务自启的 Chrome 已经停了，disconnect 留下的记录再也用不上。
            try:
                self.ledger.prune(lambda records: [r for r in records if r["scope"] in owned_scopes])
            except BrowserUseError as exc:
                errors.append({"scope": "ledger", "error": exc.as_dict()})
        for name, shared in self._attach_shared.items():
            try:
                shared["cdp"].close()
            except Exception as exc:
                errors.append({"scope": "attach", "browser": name, "error": str(exc)})
        self._attach_shared = {}
        if errors:
            raise BrowserUseError("部分浏览器清理出错，其他任务资源已继续清理", 1, data={"errors": errors})
