"""agy-use 命令行，所有动作均调用同名的公开 Python 函数。"""
import argparse
import asyncio
import json
import sys

from . import install_plugin, models, plugins, run, status, validate_plugin


async def _invoke(function, args):
    try:
        return await function(**args)
    except asyncio.CancelledError as cancelled:
        receipt = getattr(cancelled, "receipt", None)
        if receipt is not None:
            print(json.dumps(receipt, ensure_ascii=False))
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="agy-use", allow_abbrev=False)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in (status, models, plugins, validate_plugin, install_plugin, run):
        help_text = action.__doc__.splitlines()[0]
        child = commands.add_parser(action.__name__.replace("_", "-"), help=help_text,
                                    description=help_text, allow_abbrev=False)
        child.set_defaults(function=action)
        timeout_help = "等待秒数，默认 120 秒。0 等待本轮自然结束" if action is run else "等待秒数，须大于 0"
        child.add_argument("--timeout", type=float, default=argparse.SUPPRESS, metavar="SECONDS", help=timeout_help)
        if action in (validate_plugin, install_plugin):
            child.add_argument("path", help="本地插件路径")
        if action is validate_plugin:
            child.add_argument("--strict", action="store_true")
        if action is run:
            child.add_argument("--workspace", required=True)
            child.add_argument("--conversation-id")
            child.add_argument("--model")
            child.add_argument("--allow-repl", action="store_true",
                               help="仅在本轮允许工作台的 run_code 执行 Python")
            child.add_argument("prompt")
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
    if receipt["timed_out"]:
        return 124
    code = receipt["exit_code"]
    if code is None:
        return 1
    if code < 0:
        return 128 - code
    return code or int(not receipt["ok"])
