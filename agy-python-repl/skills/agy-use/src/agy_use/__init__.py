"""在本机用官方 Antigravity CLI 查询插件、安装本地插件和执行单次会话。"""
from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import signal
from typing import Any

__all__ = ["status", "plugins", "validate_plugin", "install_plugin", "run"]


def _seconds(timeout: float) -> float:
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ValueError("timeout 必须是正的有限秒数")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout 必须是正的有限秒数")
    return float(timeout)


def _local_path(value: str | Path, *, directory: bool = False) -> Path:
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise ValueError("请指定本地路径")
    path = Path(value).expanduser().resolve(strict=True)
    if directory and not path.is_dir():
        raise NotADirectoryError(str(path))
    return path


def _stop(process: asyncio.subprocess.Process) -> None:
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass


async def _command(args: list[str], *, timeout: float, cwd: Path | None = None) -> dict[str, Any]:
    timeout = _seconds(timeout)
    installed = shutil.which("agy")
    executable = str(Path(installed).absolute() if installed else Path.home() / ".local/bin/agy")
    receipt = {"executable": executable, "ok": False, "exit_code": None, "timed_out": False,
               "stdout": "", "stderr": ""}
    launch = asyncio.create_task(asyncio.create_subprocess_exec(
        executable, *args, cwd=cwd, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=os.name == "posix",
    ))
    output = None
    try:
        process = await asyncio.shield(launch)
        output = asyncio.create_task(process.communicate())
        try:
            stdout, stderr = await asyncio.wait_for(asyncio.shield(output), timeout)
        except TimeoutError:
            receipt["timed_out"] = True
            receipt["error"] = f"等待 AGY 超过 {timeout:g} 秒"
            _stop(process)
            stdout, stderr = await output
    except asyncio.CancelledError as cancelled:
        try:
            process = await launch
        except OSError:
            raise cancelled
        _stop(process)
        stdout, stderr = await (output if output is not None else process.communicate())
        receipt.update(exit_code=process.returncode, stdout=stdout.decode(errors="replace"),
                       stderr=stderr.decode(errors="replace"))
        cancelled.receipt = receipt
        raise
    except OSError as error:
        receipt["error"] = str(error)
        return receipt
    receipt.update(exit_code=process.returncode, stdout=stdout.decode(errors="replace"),
                   stderr=stderr.decode(errors="replace"),
                   ok=process.returncode == 0 and not receipt["timed_out"])
    return receipt


def _json_output(receipt: dict[str, Any], expected: type) -> dict[str, Any]:
    try:
        data = json.loads(receipt["stdout"])
        if not isinstance(data, expected):
            raise ValueError(f"期待 {expected.__name__}，收到 {type(data).__name__}")
        receipt["data"] = data
    except ValueError as error:
        receipt["ok"] = False
        receipt["output_error"] = str(error)
    return receipt


async def status(*, timeout: float = 10) -> dict[str, Any]:
    """运行 agy --version。executable 是所选入口，版本原文在 stdout。"""
    return await _command(["--version"], timeout=timeout)


async def plugins(*, timeout: float = 30) -> dict[str, Any]:
    """读取已安装插件及其启用状态。data 为 AGY 的原始 JSON 数组。"""
    return _json_output(await _command(["plugin", "list", "--json"], timeout=timeout), list)


async def validate_plugin(path: str | Path, *, strict: bool = False, timeout: float = 30) -> dict[str, Any]:
    """检查本地插件目录、plugin.json 或 ZIP。strict 也将警告视为失败。"""
    if not isinstance(strict, bool):
        raise ValueError("strict 必须是布尔值")
    args = ["plugin", "validate", str(_local_path(path)), "--json"]
    if strict:
        args.append("--strict")
    return _json_output(await _command(args, timeout=timeout), dict)


async def install_plugin(path: str | Path, *, timeout: float = 60) -> dict[str, Any]:
    """按已有授权安装指定的本地插件目录一次，返回安装命令的回执。"""
    return await _command(["plugin", "install", str(_local_path(path, directory=True))], timeout=timeout)


async def run(prompt: str, workspace: str | Path, *, conversation_id: str | None = None,
              model: str | None = None, allow_repl: bool = False, timeout: float = 120) -> dict[str, Any]:
    """在指定目录发一次提示。无编号开新会话，指定编号续聊；返回原始事件和官方结果。"""
    cwd = _local_path(workspace, directory=True)
    seconds = _seconds(timeout)
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("提示不能为空")
    args = ["--output-format=stream-json", f"--print-timeout={max(1, round(seconds * 1000))}ms"]
    for flag, value in (("conversation", conversation_id), ("model", model)):
        if value is not None:
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{flag} 不能为空")
            args.append(f"--{flag}={value}")
    if not isinstance(allow_repl, bool):
        raise ValueError("allow_repl 必须是布尔值")
    if allow_repl:
        settings = {"permissions": {"allow": ["mcp(agy-python-repl_agy-python-repl/run_code)"]}}
        args.append("--settings=" + json.dumps(settings, separators=(",", ":")))
    args.append(f"--print={prompt}")
    # 给宿主留出写回原生超时结果并退出的时间。
    receipt = await _command(args, cwd=cwd, timeout=seconds + 2)
    receipt["workspace"] = str(cwd)
    events = []
    receipt["events"] = events
    try:
        for line in receipt["stdout"].splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("event"), str):
                raise ValueError("AGY 输出缺少事件名")
            events.append(event)
        results = [event.get("result") for event in events if event["event"] == "result"]
        if len(results) != 1 or events[-1]["event"] != "result" or not isinstance(results[0], dict):
            raise ValueError("AGY 未以唯一的 result 事件结束")
        result = results[0]
        receipt["result"] = result
        if result.get("denied_actions"):
            receipt["ok"] = False
            receipt["error"] = "AGY 拒绝了操作，详情见 result.denied_actions"
        elif result.get("status") != "SUCCESS":
            receipt["ok"] = False
        elif conversation_id is not None and result.get("conversation_id") != conversation_id:
            receipt["ok"] = False
            receipt["error"] = "AGY 返回的会话编号与指定编号不一致"
        elif not isinstance(result.get("response"), str) or not result["response"].strip():
            receipt["ok"] = False
            receipt["error"] = "AGY 结束了本轮，但没有返回答复"
    except ValueError as error:
        receipt["ok"] = False
        receipt["output_error"] = str(error)
    return receipt
