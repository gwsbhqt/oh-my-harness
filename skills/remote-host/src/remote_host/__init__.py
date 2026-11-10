"""remote_host: 通过 SSH 操作另一台主机 —— 内核里一条调用跑完远程命令。

这是本技能 remote-host CLI（scripts/remote-host）的薄封装：只做参数拼装、进程调用和结果包装，
命令语义一律留在 remote-host 自己那里，改 remote-host 不用改这里。脚本一律走 stdin，所以引号、
$(...)、循环不经过本机 shell，原样送到远端。
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import time
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent
_SHARED = _PACKAGE / "_shared"
if not _SHARED.is_dir():
    _SHARED = _PACKAGE.parents[2] / "_shared"
if _SHARED.is_dir() and str(_SHARED) not in sys.path:
    sys.path.insert(0, str(_SHARED))

__all__ = [
    "Result", "cli", "run", "send", "peek", "reset", "status", "doctor", "hosts",
    "wait", "app", "screenshot", "job", "copy", "verify", "manifest", "use", "discover",
    "reverse_proxy",
]

#: 进程侧默认超时（秒）。长任务显式传 timeout=None，或改用 job。
DEFAULT_TIMEOUT = 600.0

#: 源码树与安装包都携带同一份命令行启动器。
_CLI_ENTRY = _PACKAGE.parents[1] / "scripts" / "remote-host"
if not _CLI_ENTRY.is_file():
    _CLI_ENTRY = _PACKAGE / "_resources" / "remote-host"


class Result:
    """一次 remote-host 调用的结果。

    ok/code/lines/last_line 给程序判断用；输出默认已经打到终端，所以 repr 只
    留摘要，免得长输出被 REPL 再回显一遍。
    """

    __slots__ = ("argv", "code", "out", "err", "seconds", "timed_out")

    def __init__(self, argv, code, out, err, seconds=0.0, timed_out=False):
        self.argv = argv
        self.code = code
        self.out = out
        self.err = err
        self.seconds = seconds
        self.timed_out = timed_out

    @property
    def remote_unknown(self) -> bool:
        """本地等待超时或连接丢失，不能据此确认远端已停止。"""
        return self.timed_out or self.code in (124, 125, 255) or self.code is None or self.code < 0

    @property
    def outcome(self) -> str:
        """unknown 表示须查远端终态；exited 表示此调用已有退出码。"""
        return "unknown" if self.remote_unknown else "exited"

    @property
    def ok(self) -> bool:
        """退出码为 0。超时和被信号杀掉都是 False。"""
        return self.code == 0

    @property
    def text(self) -> str:
        """stdout + stderr；stdout 末尾没有换行时补一个，避免两段粘在一行。"""
        out = self.out if (not self.out or self.out.endswith("\n")) else self.out + "\n"
        return out + self.err

    @property
    def lines(self) -> list[str]:
        """stdout 的非空行——`remote-host screenshot` 这类「最后一行是路径」的输出直接取用。"""
        return [line for line in self.out.splitlines() if line.strip()]

    @property
    def last_line(self) -> str:
        """stdout 最后一行非空内容；没有就是空串。"""
        return self.lines[-1] if self.lines else ""

    def __repr__(self) -> str:
        cmd = " ".join(self.argv[:3]) or "remote-host"
        state = "timed out" if self.timed_out else (
            f"exit {self.code}" if self.code is not None else "killed")
        return f"<remote-host {cmd} → {state}, {len(self.lines)} lines, {self.seconds:.1f}s>"

    def __str__(self) -> str:
        return self.text


def _entry() -> list[str]:
    """remote-host 的命令前缀：使用同一份源码包随附的 remote-host 启动器。"""
    if _CLI_ENTRY.is_file():
        return [sys.executable, str(_CLI_ENTRY)]
    raise RuntimeError(
        "找不到 remote-host 随附的命令入口："
        f"{_CLI_ENTRY}（remote-host 技能还在吗？）"
    )


def _host(host):
    return ["-H", host] if host else []


def _kill_group(proc, sig=signal.SIGTERM) -> None:
    """杀整个进程组：remote-host 底下还挂着 ssh/scp，只杀直接子进程会把它们留下。"""
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError):
        pass


async def _exec(args, *, input=None, timeout=DEFAULT_TIMEOUT, quiet=False, env=None) -> Result:
    """跑一次 remote-host、收输出；超时杀掉整组。args 是子命令参数（不含 remote-host 入口），timeout=None 表示不限时。"""
    argv = _entry() + list(args)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        env=None if env is None else {**os.environ, **env},
        stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    started = time.monotonic()
    payload = input.encode() if input is not None else None
    timed_out = False
    # shield：超时后 communicate 继续跑完，进程被杀后它很快返回，输出不丢。
    comm = asyncio.ensure_future(proc.communicate(payload))
    try:
        out, err = await asyncio.wait_for(asyncio.shield(comm), timeout)
    except asyncio.TimeoutError:
        timed_out = True
        _kill_group(proc)
        try:
            out, err = await asyncio.wait_for(comm, 10)
        except asyncio.TimeoutError:
            _kill_group(proc, signal.SIGKILL)
            out, err = await comm
    except BaseException:
        _kill_group(proc)
        raise

    error = err.decode(errors="replace")
    if timed_out:
        error += ("\n[remote-host] 本地等待超时，已终止本地连接进程；远端任务是否停止未知。"
                  "不要自动重跑。后台任务请用 remote-host job list/wait 查询，确认后再决定是否 kill。\n")
    result = Result(list(args), proc.returncode, out.decode(errors="replace"),
                    error, time.monotonic() - started, timed_out)
    if not quiet:
        if result.out:
            sys.stdout.write(result.out if result.out.endswith("\n") else result.out + "\n")
        if result.err:
            sys.stderr.write(result.err if result.err.endswith("\n") else result.err + "\n")
    return result


async def cli(*args, input=None, timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """透传任意 remote-host 子命令：`await remote-host.cli("hosts")`、`await remote-host.cli("verify", a, b, "--quick")`。

    没包成语义函数的子命令（attach/put/get/stats/onboard/...）走这里。
    """
    return await _exec([str(a) for a in args], input=input, timeout=timeout, quiet=quiet)


def reverse_proxy(*, host, local_proxy, timeout=30):
    """Return a task-owned async context forwarding an explicit local HTTP proxy.

    `async with reverse_proxy(host="alpha", local_proxy="http://127.0.0.1:7890") as proxy`
    yields remote-only url/env; alternatively await open(), then close() in finally.
    No global proxy settings, host pins, credential reads or shared SSH masters are changed.
    Startup errors raise and clean up. Remote lsof is required to verify loopback binding.
    """
    from agentkit.remote.proxy import ReverseProxy
    return ReverseProxy(host=host, local_proxy=local_proxy, timeout=timeout)


async def run(script, *, host=None, interp=None, cwd=None, proxy=False, table=False,
              timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """在 host 上跑一段脚本并等它结束；script 从 stdin 原样送过去。

    host 省略时用 `remote-host use` 钉住的主机；table=True 配 host="alpha,beta" 把几台的
    key=value 输出并成一张对照表（不同的值标 ≠）。interp 是 -i：python/js/fish/sh/zsh
    或解释器路径。proxy 可为原有 bool 或已打开的 reverse_proxy 句柄；句柄限定一个目标。
    """
    from agentkit.remote.proxy import ReverseProxy
    env = None
    if isinstance(proxy, ReverseProxy):
        if host is not None and host != proxy.host:
            raise ValueError("proxy handle belongs to another remote host")
        if table:
            raise ValueError("a reverse proxy belongs to one remote host")
        host = proxy.host
        # Child-only override reuses the existing LAN proxy prelude without a global mutation.
        env = {"REMOTE_HOST_PROXY": proxy.url.removeprefix("http://")}
    argv = _host(host) + ["run"]
    if table:
        argv.append("--table")
    if interp:
        argv += ["-i", interp]
    if cwd:
        argv += ["-C", cwd]
    if proxy:
        argv.append("-P")
    return await _exec(argv, input=script, timeout=timeout, quiet=quiet, env=env)


async def send(script, *, host=None, session=None, detach=False, wait=300, lines=0,
               timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """在持久会话里跑，shell 状态（cd、变量）跨调用保留；detach=True 只发不等。

    wait 是 remote-host 自己等结果的秒数（-t），lines 限制每个流打印的行数（-n，0 为全部）。
    """
    argv = _host(host) + ["send"]
    if session:
        argv += ["-s", session]
    if detach:
        argv.append("-d")
    argv += ["-t", str(int(wait)), "-n", str(int(lines))]
    return await _exec(argv, input=script, timeout=timeout, quiet=quiet)


async def peek(*, host=None, session=None, lines=30, timeout=60, quiet=False) -> Result:
    """看持久会话最近的输出。"""
    argv = _host(host) + ["peek", "-n", str(int(lines))]
    if session:
        argv += ["-s", session]
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def reset(*, host=None, session=None, timeout=60, quiet=False) -> Result:
    """杀掉持久会话。"""
    argv = _host(host) + ["reset"]
    if session:
        argv += ["-s", session]
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def status(*, host=None, timeout=90, quiet=False) -> Result:
    """主机、解释器、Kerberos 票据、会话一览——远端没反应时先看这个。"""
    return await _exec(_host(host) + ["status"], timeout=timeout, quiet=quiet)


async def doctor(*, host=None, timeout=120, quiet=False) -> Result:
    """连不上或别扭时给出原因和修法（不在那个网段、睡着了、Remote Login 关了、票据过期）。"""
    return await _exec(_host(host) + ["doctor"], timeout=timeout, quiet=quiet)


async def hosts(*, timeout=30, quiet=False) -> Result:
    """列出 ~/.ssh/config 里的主机。"""
    return await _exec(["hosts"], timeout=timeout, quiet=quiet)


async def wait(*, host=None, port=None, proc=None, file=None, check=None, gone=False,
               timeout=120, every=2, quiet=False) -> Result:
    """等一个端口/进程/文件/命令就绪；gone=True 反过来等它消失。

    timeout 是远端等待的上限（remote-host 的 -t），进程侧留 30s 余量收尾。
    """
    argv = _host(host) + ["wait"]
    if port is not None:
        argv += ["--port", str(port)]
    if proc:
        argv += ["--proc", proc]
    if file:
        argv += ["--file", file]
    if check:
        argv += ["--cmd", check]
    if gone:
        argv.append("--gone")
    argv += ["-t", str(int(timeout)), "--every", str(int(every))]
    return await _exec(argv, timeout=timeout + 30, quiet=quiet)


async def app(action, name, *, host=None, timeout=30, port=None, since=60, lines=20,
              quiet=False) -> Result:
    """启停/重启 macOS 应用或看它最近的报错：action 是 start/stop/restart/status/logs。

    logs 时 since 是往前几分钟、lines 是每个来源多少行。
    """
    argv = _host(host) + ["app", action, name, "-t", str(int(timeout))]
    if port is not None:
        argv += ["--port", str(port)]
    if action == "logs":
        argv += ["--since", str(int(since)), "-n", str(int(lines))]
    return await _exec(argv, timeout=timeout + 60, quiet=quiet)


async def screenshot(*, host=None, screen=None, png=False, output=None, max_edge=None,
                     timeout=180, quiet=False) -> Result:
    """抓远端 Mac 的屏幕存到本地，返回本地路径（r.last_line）——再 `imaging.view(路径)` 就能看。"""
    argv = _host(host) + ["screenshot"]
    if screen is not None:
        argv += ["--screen", str(int(screen))]
    if png:
        argv.append("--png")
    if output:
        argv += ["-o", output]
    if max_edge:
        argv += ["--max", str(int(max_edge))]
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def job(action="list", name=None, script=None, *, host=None, follow=False,
              progress=None, every=30, lines=40, wait=None, timeout=DEFAULT_TIMEOUT,
              quiet=False) -> Result:
    """远端后台任务：action 是 start/list/wait/follow/tail/kill。

    start 时 script 从 stdin 传（多命令写一段脚本，不要塞成字面参数）；follow=True
    一路跟到任务结束、退出码就是任务的，一次调用顶到底。wait 是 remote-host 侧上限秒数。
    """
    argv = _host(host) + ["job", action]
    if name:
        argv.append(name)
    if action == "start":
        if progress:
            argv += ["--progress", progress, "--every", str(int(every))]
        if follow:
            argv.append("--follow")
    if wait is not None:
        argv += ["-t", str(int(wait))]
    if action in ("wait", "follow", "tail"):
        argv += ["-n", str(int(lines))]
    return await _exec(argv, input=script if action == "start" else None,
                       timeout=timeout, quiet=quiet)


async def copy(src, dst, *, replace=False, verify=True, quick=False, compress=True,
               every=30, timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """主机之间或本机与主机之间搬数据：暂存后落位，默认逐文件校验。

    verify=False 跳过校验，quick=True 只比大小，compress=False 不压缩。
    """
    argv = ["copy", src, dst]
    if replace:
        argv.append("--replace")
    if not verify:
        argv.append("--no-verify")
    if quick:
        argv.append("--quick")
    if not compress:
        argv.append("--no-compress")
    argv += ["--every", str(int(every))]
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def verify(src, dst, *, quick=False, timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """逐条对比两棵树（host:path 或本地路径）；quick=True 只比大小。"""
    argv = ["verify", src, dst]
    if quick:
        argv.append("--quick")
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def manifest(loc, *, quick=False, full=False, timeout=DEFAULT_TIMEOUT, quiet=False) -> Result:
    """一棵树的规范清单：哈希、目录、链接；full=True 打印每一条而不只是汇总。"""
    argv = ["manifest", loc]
    if quick:
        argv.append("--quick")
    if full:
        argv.append("--full")
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def use(name=None, *, interp=None, cwd=None, proxy=False, no_proxy=False,
              clear=False, timeout=30, quiet=False) -> Result:
    """钉住默认主机/解释器/起始目录：`await remote-host.use("alpha")`，之后 host 可省略。"""
    argv = ["use"]
    if name:
        argv.append(name)
    if interp:
        argv += ["-i", interp]
    if cwd:
        argv += ["-C", cwd]
    if proxy:
        argv.append("-P")
    if no_proxy:
        argv.append("--no-proxy")
    if clear:
        argv.append("--clear")
    return await _exec(argv, timeout=timeout, quiet=quiet)


async def discover(*, seconds=3, timeout=60, quiet=False) -> Result:
    """Bonjour 扫本网段：地址、SSH 是否开着、能对上哪个别名。"""
    return await _exec(["discover", "--seconds", str(int(seconds))],
                       timeout=timeout, quiet=quiet)
