"""browser-control 的普通命令、RPC 与常驻服务入口。"""
from __future__ import annotations

import sys


def main():
    if sys.argv[1:2] == ["rpc"]:
        if sys.argv[2:] not in ([], ["--json"]):
            print("browser-control rpc 仅接受 --json；机器和任务来自结构化载荷", file=sys.stderr)
            return 2
        from .rpc import main as rpc_main
        return rpc_main()
    if sys.argv[1:2] == ["serve"]:
        import argparse
        parser = argparse.ArgumentParser(description="browser-control 本机浏览器服务")
        parser.add_argument("command", choices=["serve"])
        parser.add_argument("--socket", required=True)
        args = parser.parse_args()
        from .server import serve
        serve(args.socket)
        return 0
    from .commands import main as commands_main
    return commands_main()


if __name__ == "__main__":
    raise SystemExit(main())
