"""控制 DSH 的异步薄封装；全部操作复用现有 dsh-control 命令行。

返回 CLI 原始 JSON 字段和 exit_code/stdout/stderr。非零退出不抛异常，
等待输入、超时与任务失败均由调用者读取退出码和 status；发送回执不会丢弃。
取消传播 asyncio.CancelledError，只终止本地 CLI 进程组，不重发、不自动取消会话。
"""
from __future__ import annotations

import asyncio
import json as _json
import math as _math
import os as _os
import signal as _signal
from pathlib import Path as _Path
from typing import Any as _Any

_SOURCE_COMMAND = _Path(__file__).resolve().parents[4] / "bin" / "dsh-control"
_COMMAND = _SOURCE_COMMAND if _SOURCE_COMMAND.is_file() else "dsh-control"
_TEXT_COMMANDS = {"help", "version", "start"}


def _value(value: _Any) -> str:
    if isinstance(value, (dict, list)):
        return _json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(value, float) and not _math.isfinite(value):
        raise ValueError("参数不能是 NaN 或 Infinity")
    if isinstance(value, (str, int, float, _Path)) and not isinstance(value, bool):
        return str(value)
    raise TypeError(f"参数必须是文本、路径、数值或 JSON 对象，收到 {type(value).__name__}")


def _result(command: str, code: int, stdout: bytes, stderr: bytes) -> dict[str, _Any]:
    out, err = stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    try:
        payload = _json.loads(out)
        if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
            raise ValueError("命令未返回带 ok 的 JSON 对象")
    except (ValueError, _json.JSONDecodeError):
        if command in _TEXT_COMMANDS:
            payload = {"ok": code == 0, "status": "ok" if code == 0 else "failed", "text": out}
            if code != 0:
                payload["error"] = {"code": "cli-failed", "message": err.strip() or out.strip() or f"命令退出码 {code}"}
        else:
            payload = {"ok": False, "error": {"code": "invalid-cli-output", "message": "命令未返回有效 JSON；请检查 stdout 和 stderr，不要自动重发"}}
    return {**payload, "exit_code": code, "stdout": out, "stderr": err}


def _launch_error(error: OSError) -> dict[str, _Any]:
    return {"ok": False, "error": {"code": "launcher-unavailable", "message": str(error)}, "exit_code": None, "stdout": "", "stderr": str(error)}


async def _launch(argv: list[str]) -> tuple[asyncio.subprocess.Process | None, OSError | None]:
    try:
        return await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True), None
    except OSError as error:
        return None, error


async def run(command: str, *args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    """调用任意既有命令，返回原始结果和退出码；选项下划线转短横线。

    host/local 只选择本次目标；默认使用命令行自己的默认机器。
    True 生成开关，False/None 不传；list 重复选项，dict 编码为 JSON。
    answer 的 json 选项可传完整答案对象。位置参数经 -- 保留原文。
    取消后原 CancelledError.result 包含已收到输出，远端是否完成需另查；
    要先保留发送回执再等待，请分开调用 send 与 wait。
    """
    if not isinstance(command, str) or not command or command.startswith("-") and command != "--capabilities":
        raise ValueError("command 必须是命令名")
    if host is not None and (not isinstance(host, str) or not host.strip()):
        raise ValueError("host 不能为空")
    if local and host is not None:
        raise ValueError("host 与 local 不能同时指定")
    argv = [str(_COMMAND)]
    if host is not None:
        argv += ["-H", host]
    if local:
        argv.append("--local")
    argv += [command, "--json"]
    for name, value in options.items():
        key = name.rstrip("_").replace("_", "-")
        if not key or not all(c.isalnum() or c == "-" for c in key):
            raise ValueError(f"无效选项名 {name!r}")
        if key == "json" and command != "answer":
            raise ValueError("封装固定使用 JSON 输出，只有 answer 可传 json 答案")
        if value is None or value is False:
            continue
        if value is True:
            argv.append(f"--{key}")
        else:
            values = value if isinstance(value, (list, tuple)) else [value]
            argv.extend(f"--{key}={_value(item)}" for item in values)
    if args:
        argv += ["--", *(_value(arg) for arg in args)]
    process = None
    spawning = asyncio.create_task(_launch(argv))
    collecting = None
    try:
        process, launch_error = await asyncio.shield(spawning)
        if launch_error is not None:
            return _launch_error(launch_error)
        collecting = asyncio.create_task(process.communicate())
        out, err = await asyncio.shield(collecting)
        return _result(command, process.returncode, out, err)
    except asyncio.CancelledError as cancelled:
        # 只收回本地进程组，已经提交的消息或独立后台重启不会回滚。
        if process is None:
            process, launch_error = await spawning
            if launch_error is not None:
                cancelled.result = {**_launch_error(launch_error), "cancelled": True}
                raise cancelled
        try:
            _os.killpg(process.pid, _signal.SIGKILL)
        except ProcessLookupError:
            pass
        if collecting is None:
            collecting = asyncio.create_task(process.communicate())
        out, err = await collecting
        cancelled.result = {**_result(command, process.returncode, out, err), "cancelled": True}
        raise
    except OSError as error:
        return _launch_error(error)


async def health(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    'DSH 在不在线、几个会话在跑、几个在等你回答。用法：health'
    return await run('health', *args, host=host, local=local, **options)

async def workspaces(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '列出工作区。用法：workspaces'
    return await run('workspaces', *args, host=host, local=local, **options)

async def sessions(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '列出会话（默认不含归档、空白会话和子代理，末尾说明省略了多少）。用法：sessions [--running] [--workspace <工作区 id、名字或路径> | --ungrouped] [--include-blank] [--cwd <目录>] [--query <标题关键词>] [--limit N] [--all]'
    return await run('sessions', *args, host=host, local=local, **options)

async def archive(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '存档会话；有活动任务时拒绝，不会中止任务。用法：archive <会话>'
    return await run('archive', *args, host=host, local=local, **options)

async def unarchive(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '取消会话存档。用法：unarchive <会话>'
    return await run('unarchive', *args, host=host, local=local, **options)

async def rename(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '重命名会话。用法：rename <会话> <新标题>'
    return await run('rename', *args, host=host, local=local, **options)

async def fork(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '分叉会话；默认复制到最近完成的一轮，可用 --at-seq 指定事件边界，不会自动发消息。用法：fork <会话> [--at-seq N]'
    return await run('fork', *args, host=host, local=local, **options)

async def status(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '一个会话的状态：在不在跑、模型、待办、排队、是否在等你回答（在等回答时退出码 10）。用法：status <会话>'
    return await run('status', *args, host=host, local=local, **options)

async def cwd(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '看会话现在的工作目录；给了目录就换过去（模型之后在新目录干活，已经开着的终端和后台命令还在原目录）。用法：cwd <会话> [新目录，绝对路径或 ~/ 开头]'
    return await run('cwd', *args, host=host, local=local, **options)

async def goal(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '看会话的持续目标；pause 暂停、resume 恢复、clear 清掉，等同在界面目标面板上点（模型自己恢复不了被暂停的目标；会话正在跑时 pause 会中止这一轮）；hold 只停自动续跑，这一轮照常跑完，用 resume 恢复。用法：goal <会话> [pause|resume|clear|hold]'
    return await run('goal', *args, host=host, local=local, **options)

async def schedule(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '定时提醒（界面「自动化任务」）：列出全部或某个会话的，看一条的发送记录，删掉一条。新建要在会话里让模型建，宿主没开放外部新建。用法：schedule [list] [会话] | schedule history <提醒> [--limit N] | schedule delete <提醒>'
    return await run('schedule', *args, host=host, local=local, **options)

async def last(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '最后一段助手回复。用法：last <会话> [--chars N]'
    return await run('last', *args, host=host, local=local, **options)

async def read(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '逐轮概览；--turn N 看某一轮（-1 = 最后一轮）。用法：read <会话> [--turn N] [--tools] [--last N] [--chars N] [--max N]'
    return await run('read', *args, host=host, local=local, **options)

async def send(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '给会话发消息。默认排到下一轮；--now 插进当前这一轮（模型做完手上这一步就看到，等同界面「插话发送」，旧名 --steer）；--interrupt 先停下当前这一步再发（这条成为下一轮开头）；notify="会话" 或 "self" 在目标真做完（口径同 wait settled）后给那个会话送一次插件通知，失败或中止也送，DSH 重启不丢。用法：send <会话> <消息> [--now|--interrupt] [--tier normal|fast] [--model provider/model] [--notify <会话>|self]'
    return await run('send', *args, host=host, local=local, **options)

async def queue(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '看和改排队消息（对应界面排队条的三个按钮），一条一条单独生效：list 列出（每条带编号）；steer 编号… 只把点名的几条插进当前这一轮，其余照常排队（不写或 all 是全部）；remove 编号… 删掉；edit 编号 改写。编号不随队列前移变化，也可以写序号。用法：queue <会话> [list | steer [编号…|all] | remove 编号… | edit 编号 <新内容>]'
    return await run('queue', *args, host=host, local=local, **options)

async def wait(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '等会话结束，保留回复和轮次详情；最后一轮失败或中止退出 1，只有成功完成退出 0；空闲又没有新内容立即返回（退出码 11），不空等。默认一轮结束就返回；settled=True 等到真做完：没在跑、没排队，名下和子代理名下没有在跑的后台任务，子代理不在干活，目标不会自动续跑，保持 3 秒；不看回复内容。用法：wait <会话> [--since SEQ] [--settled] [--timeout 秒，默认 1800] [--slice MS]'
    return await run('wait', *args, host=host, local=local, **options)

async def new(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '在工作区开新会话（默认 normal 档模型），可同时发第一条消息；输出等待用的起点 seq。档位没有可用模型就不建会话。notify 同 send，要和第一条消息一起用。用法：new <工作区名字，或绝对路径> [消息] [--tier normal|fast] [--model provider/model] [--preset 名字] [--if-idle] [--notify <会话>|self]'
    return await run('new', *args, host=host, local=local, **options)

async def notify(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '以 DSH 身份发送 macOS 系统通知；正文可作第一个参数，标题、正文和声音各传 False 可单独关闭。'
    for field in ('title', 'body', 'sound'):
        if options.get(field) is False:
            options.pop(field)
            options['no_' + field] = True
    return await run('notify', *args, host=host, local=local, **options)


async def notice(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '以插件通知（不是用户消息）给会话送一段话：界面显示成一行通知，模型知道不是用户说的；会话闲着会被唤醒开一轮。用法：notice <会话> <消息> [--summary 一行摘要]'
    return await run('notice', *args, host=host, local=local, **options)

async def wait_idle(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '等指定会话停下；不指定则等所有会话。--timeout 秒可持续等待；指定会话等回答退出 10，超时退出 124。空闲不代表任务成功。用法：wait-idle [会话] [--timeout 秒] [--slice 毫秒]'
    return await run('wait-idle', *args, host=host, local=local, **options)

async def quit_check(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '现在退出 DSH 会不会弹确认框，卡在哪（在跑的会话、排队消息、后台任务、已打开会话的定时提醒）。用法：quit-check'
    return await run('quit-check', *args, host=host, local=local, **options)


async def web_url(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '这次启动的网页登录网址，带一次性口令（等同登录凭据，别外传；DSH 重启后失效）。从别的机器经 SSH 转发打开时用 --base 换成转发后的地址。用法：web-url [--base 网址]'
    return await run('web-url', *args, host=host, local=local, **options)

async def open(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '拉起到别的机器上某个服务的隧道，并在本机浏览器打开（和设置「远程机器」页的「打开」一样）。用法：open <机器> <服务>'
    return await run('open', *args, host=host, local=local, **options)

async def tunnel(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '关掉到别的机器上某个服务的隧道。用法：tunnel close <机器> <服务>'
    return await run('tunnel', *args, host=host, local=local, **options)

async def restart_prepare(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '重启前用：让能接回的后台任务（持久监听）记下自己并暂停，新进程起来后自动接回。dsh-control restart 自己会调，一般不用手动跑。用法：restart-prepare'
    return await run('restart-prepare', *args, host=host, local=local, **options)

async def restart_abort(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '重启没成时用：把 restart-prepare 暂停的任务马上接回。用法：restart-abort'
    return await run('restart-abort', *args, host=host, local=local, **options)

async def requeue_lost(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '把 --since 之后被中止吞掉的用户消息原样放回下一轮排队区；dsh-control restart 自己会调。用法：requeue-lost <会话> --since <毫秒时间戳>'
    return await run('requeue-lost', *args, host=host, local=local, **options)

async def kill_jobs(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '停掉后台任务（不管属于哪个会话）；写 all 停掉所有在跑的。用法：kill-jobs <任务 id...>|all'
    return await run('kill-jobs', *args, host=host, local=local, **options)

async def monitor(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '直接给指定会话启动持久后台服务，重启后自动接回原会话，不发送消息。用法：monitor <会话> --command <命令> --cwd <绝对目录> [--label <名称>] [--restart never|on-failure] [--quiet]（--quiet 时输出不推进会话）'
    if 'command' in options:
        if 'command_' in options:
            raise ValueError('command 与 command_ 不能同时指定')
        options['command_'] = options.pop('command')
    return await run('monitor', *args, host=host, local=local, **options)


async def cancel(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '中止正在跑的会话。用法：cancel <会话>'
    return await run('cancel', *args, host=host, local=local, **options)

async def answer(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '回答会话里的提问；--select 可写选项的开头或其中几个字，对上多个会报歧义。用法：answer <会话> [自由回答] [--select 选项]... [--json 完整答案] [--call-id ID]'
    return await run('answer', *args, host=host, local=local, **options)

async def quota(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '各家额度（只看挑模型用的窗口）。用法：quota [--refresh]'
    return await run('quota', *args, host=host, local=local, **options)

async def models(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '两档候选模型现在能不能用、为什么。用法：models'
    return await run('models', *args, host=host, local=local, **options)

async def pick(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '只算不改：这一档现在该用哪个模型（整档没有可用的退出码 2）。用法：pick [normal|fast]'
    return await run('pick', *args, host=host, local=local, **options)

async def model(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '给会话换模型（按档位挑，或直接指定）；已开始的会话默认拒绝（退出码 2），除非额度用光。用法：model <会话> [--tier normal|fast] [--model provider/model] [--force]'
    return await run('model', *args, host=host, local=local, **options)

async def plugins(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '列出插件（组合包）。用法：plugins'
    return await run('plugins', *args, host=host, local=local, **options)

async def plugin(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '装、卸、启用、停用插件。用法：plugin install|remove|enable|disable <包名或路径> [--force]'
    return await run('plugin', *args, host=host, local=local, **options)

async def config(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '看或改设置（立即生效）。用法：config [命名空间] | config <命名空间> --set \\\'{"字段":值}\\\''
    return await run('config', *args, host=host, local=local, **options)

async def api(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '万能兜底：列出、查看、调用任意内部接口。用法：api list [namespace] | api describe <ns/method> | api call <ns/method> [\\\'{"参数":值}\\\']'
    return await run('api', *args, host=host, local=local, **options)

async def use(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '查看或设置默认机器。'
    return await run('use', *args, host=host, local=local, **options)

async def pin(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '设置默认机器。'
    return await run('pin', *args, host=host, local=local, **options)

async def hosts(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '列出 SSH 机器昵称。'
    return await run('hosts', *args, host=host, local=local, **options)

async def capabilities(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '读取离线能力协议。'
    return await run('--capabilities', *args, host=host, local=local, **options)


async def chat(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '发消息并等它跑完（send + wait 一步做完），退出码同 wait；settled=True 等到真做完，notify 同 send。用法：chat <会话> <消息> [--now|--interrupt] [--tier normal|fast] [--model provider/model] [--settled] [--notify <会话>|self] [--timeout 秒，默认 1800]'
    return await run('chat', *args, host=host, local=local, **options)


async def start(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '确保 DSH 在运行：已在运行直接返回；没在运行就先做离线检查再拉起来，等通信口就绪。在远程登录里运行也会用桌面会话的环境打开。用法：start'
    return await run('start', *args, host=host, local=local, **options)


async def restart(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '一律强制退出再拉起，没有等空闲模式。先离线检查，中止在跑的会话、普通后台任务和子代理；正常退出没走成就结束进程再拉起，随后恢复被中止的会话、目标和可接回的任务。DSH 会话自动转到后台并默认通知原会话；--detach 显式转后台，--notify 指定结果通知，--before <命令> 在会话中止后、退出前执行一次且失败不重启。--kill 直接结束进程；--quit-via apple-event|menu 选择普通退出入口。已有执行者时只附着结果通知。用法：restart [--before <命令>] [--detach] [--notify <会话>] [--kill] [--quit-via apple-event|menu]'
    return await run('restart', *args, host=host, local=local, **options)


async def upgrade(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '升级 DSH App：读更新源、下载、校验大小和 sha512、核对签名公证和开发者，用新版 App 对实际配置跑离线检查，全过才走重启；旧 App 退出后才替换，新版拉不起来自动换回旧版。已是最新直接退出 0。--check 只备好并检查、不替换；--rollback 换回上一版；--force 同版本也重装；--before、--detach、--notify、--quit-via 同 restart（--before 在换 App 之前、会话都中止后跑）。用法：upgrade [--feed <清单网址>] [--check] [--rollback] [--force] [--before <命令>] [--detach] [--notify <会话>] [--quit-via apple-event|menu]'
    return await run('upgrade', *args, host=host, local=local, **options)


async def restart_watch(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '读取本机跨机器重启通知记录，显示远端执行结果和是否送回发起会话；由共享目标入口处理，不连接默认机器。用法：restart-watch WATCHID [--json]'
    return await run('restart-watch', *args, host=host, local=local, **options)


async def restart_status(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '读取最近一次重启的真实阶段、阻碍、结果和日志；进程消失但无完成记录不算成功。用法：restart-status [--request-id UUID] [--json]'
    return await run('restart-status', *args, host=host, local=local, **options)


async def doctor(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '离线检查并隔离试启动；运行时还会调用在线 doctor 工具；全部通过才退出 0。用法：doctor [--full] [--profile 名字] [--timeout-ms MS]'
    return await run('doctor', *args, host=host, local=local, **options)


async def version(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '命令行版本。用法：version'
    return await run('version', *args, host=host, local=local, **options)


async def help(*args: _Any, host: str | None = None, local: bool = False, **options: _Any) -> dict[str, _Any]:
    '列出全部命令，或看一条命令的用法。用法：help [命令]'
    return await run('help', *args, host=host, local=local, **options)


__all__ = ['run', 'health', 'workspaces', 'sessions', 'archive', 'unarchive', 'rename', 'fork', 'status', 'cwd', 'goal', 'schedule', 'last', 'read', 'send', 'queue', 'wait', 'new', 'notify', 'notice', 'wait_idle', 'quit_check', 'web_url', 'open', 'tunnel', 'restart_prepare', 'restart_abort', 'requeue_lost', 'kill_jobs', 'cancel', 'answer', 'quota', 'models', 'pick', 'model', 'plugins', 'plugin', 'config', 'api', 'use', 'pin', 'hosts', 'capabilities', 'chat', 'start', 'restart', 'upgrade', 'restart_watch', 'restart_status', 'doctor', 'version', 'help']
