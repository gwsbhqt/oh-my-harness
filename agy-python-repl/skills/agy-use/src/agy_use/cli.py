"""agy-use 命令行，所有动作均调用同名的公开 Python 函数。"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from . import (
    archive,
    delete,
    get,
    health,
    last,
    new,
    read,
    rename,
    send,
    sessions,
    update,
    wait,
)


async def _invoke(function: Any, args: dict[str, Any]) -> dict[str, Any]:
    try:
        return await function(**args)
    except asyncio.CancelledError as cancelled:
        receipt = getattr(cancelled, "receipt", None)
        if receipt is not None:
            print(json.dumps(receipt, ensure_ascii=False))
        raise


def _add_app_common(parser: argparse.ArgumentParser, *, unbounded_timeout: bool = False) -> None:
    parser.add_argument("--socket", dest="socket_path", help="指定 Sidecar Unix 套接字路径")
    timeout_help = "等待秒数；0 表示一直等到本轮完成" if unbounded_timeout else "等待秒数，须大于 0"
    parser.add_argument("--timeout", type=float, default=argparse.SUPPRESS, metavar="SECONDS", help=timeout_help)


def _exit_code(receipt: dict[str, Any]) -> int:
    if receipt.get("timed_out"):
        return 124
    if receipt.get("ok"):
        return 0
    err = receipt.get("error_code")
    if err in ("sidecar-unavailable", "ls-unreachable"):
        return 69
    if err in ("invalid-argument", "target-not-found", "ambiguous-target", "incomplete-prefix-scan"):
        return 2
    return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agy-use", allow_abbrev=False)
    commands = parser.add_subparsers(dest="action", required=True)

    p = commands.add_parser("health", help=health.__doc__, description=health.__doc__, allow_abbrev=False)
    p.set_defaults(function=health)
    _add_app_common(p)

    p = commands.add_parser("sessions", help=sessions.__doc__, description=sessions.__doc__, allow_abbrev=False)
    p.set_defaults(function=sessions)
    p.add_argument("--query", help="按编号、标题或摘要关键词过滤")
    p.add_argument("--project-id", help="只列出指定项目的会话")
    p.add_argument("--tag", dest="tags", action="append", help="按标签筛选（可重复）")
    p.add_argument("--include-archived", action="store_true", help="包含已归档会话")
    p.add_argument("--limit", type=int, default=argparse.SUPPRESS, help="最多返回条数，0 返回全部")
    _add_app_common(p)

    p = commands.add_parser("get", help=get.__doc__, description=get.__doc__, allow_abbrev=False)
    p.set_defaults(function=get)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀（至少 4 位）")
    p.add_argument("--active-only", dest="include_archived", action="store_false", help="仅在未归档会话中匹配简写")
    p.add_argument("--no-metadata", dest="include_metadata", action="store_false", help="跳过 agentapi 元数据查询")
    _add_app_common(p)

    p = commands.add_parser("new", help=new.__doc__, description=new.__doc__, allow_abbrev=False)
    p.set_defaults(function=new)
    p.add_argument("prompt", nargs="?", default="", help="可选首条提示")
    p.add_argument("--project-id", help="目标项目编号")
    p.add_argument("--environment-id", help="项目内执行环境编号")
    p.add_argument("--title", help="自定义标题")
    p.add_argument("--model", help="模型或档位（flash_lite / flash / pro / 模型 ID）")
    p.add_argument("--tag", dest="tags", action="append", help="会话标签（可重复）")
    p.add_argument("--wait", action="store_true", help="等待首轮完成并返回回复")
    p.add_argument("--poll-interval", type=float, default=argparse.SUPPRESS, help="轮询间隔秒数")
    _add_app_common(p, unbounded_timeout=True)

    p = commands.add_parser("send", help=send.__doc__, description=send.__doc__, allow_abbrev=False)
    p.set_defaults(function=send)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("prompt", help="发送给指定会话的内容")
    p.add_argument("--title", help="消息标题")
    p.add_argument("--wait", action="store_true", help="发送后等待本轮完成并返回回复")
    p.add_argument("--poll-interval", type=float, default=argparse.SUPPRESS, help="轮询间隔秒数")
    _add_app_common(p, unbounded_timeout=True)

    p = commands.add_parser("wait", help=wait.__doc__, description=wait.__doc__, allow_abbrev=False)
    p.set_defaults(function=wait)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("--since-step", type=int, default=argparse.SUPPRESS, help="基准 step_index（来自 send 回执）")
    p.add_argument("--since-time", help="基准更新时间 ISO 字符串")
    p.add_argument("--expected-prompt", help="要求在基线后匹配到该正文的 App 收件步骤才确认完成")
    p.add_argument("--poll-interval", type=float, default=argparse.SUPPRESS, help="轮询间隔秒数")
    _add_app_common(p, unbounded_timeout=True)

    p = commands.add_parser("read", help=read.__doc__, description=read.__doc__, allow_abbrev=False)
    p.set_defaults(function=read)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("--from-step", type=int, default=argparse.SUPPRESS, help="起始 step_index")
    p.add_argument("--limit", type=int, default=argparse.SUPPRESS, help="最多返回步数，0 返回全部")
    p.add_argument("--full", action="store_true", help="读取 transcript_full.jsonl")
    _add_app_common(p)

    p = commands.add_parser("last", help=last.__doc__, description=last.__doc__, allow_abbrev=False)
    p.set_defaults(function=last)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("--chars", type=int, default=argparse.SUPPRESS, help="回复文本最大字符数，0 不截断")
    _add_app_common(p)

    p = commands.add_parser("rename", help=rename.__doc__, description=rename.__doc__, allow_abbrev=False)
    p.set_defaults(function=rename)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("title", help="新标题")
    _add_app_common(p)

    p = commands.add_parser("archive", help=archive.__doc__, description=archive.__doc__, allow_abbrev=False)
    p.set_defaults(function=archive)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("--unarchive", dest="archived", action="store_false", help="取消归档")
    _add_app_common(p)

    p = commands.add_parser("update", help=update.__doc__, description=update.__doc__, allow_abbrev=False)
    p.set_defaults(function=update)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    p.add_argument("--title", help="标题")
    p.add_argument("--archived", action="store_true", default=argparse.SUPPRESS, help="归档")
    p.add_argument("--unarchived", dest="archived", action="store_false", default=argparse.SUPPRESS, help="取消归档")
    p.add_argument("--pinned", action="store_true", default=argparse.SUPPRESS, help="置顶")
    p.add_argument("--unpinned", dest="pinned", action="store_false", default=argparse.SUPPRESS, help="取消置顶")
    p.add_argument("--starred", action="store_true", default=argparse.SUPPRESS, help="加星")
    p.add_argument("--unstarred", dest="starred", action="store_false", default=argparse.SUPPRESS, help="取消加星")
    p.add_argument("--tag", dest="tags", action="append", help="替换标签（可重复）")
    p.add_argument("--group-id", help="分组编号（空串清除分组）")
    _add_app_common(p)

    p = commands.add_parser("delete", help=delete.__doc__, description=delete.__doc__, allow_abbrev=False)
    p.set_defaults(function=delete)
    p.add_argument("conversation_id", help="桌面会话完整编号或唯一前缀")
    _add_app_common(p)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = vars(parser.parse_args(argv))
    function = args.pop("function")
    args.pop("action")
    try:
        receipt = asyncio.run(_invoke(function, args))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    print(json.dumps(receipt, ensure_ascii=False))
    return _exit_code(receipt)
