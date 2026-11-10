#!/usr/bin/env python3
"""Build the native driver for this host, then pass arguments through unchanged."""
import importlib.util
import json
import os
from pathlib import Path
import sys

# 直接按文件加载编译逻辑，不导入整个 Python 包：包里的 asyncio 会拖慢每条命令。
_BUILD = Path(__file__).with_name('build.py')



def wrapper(argv):
    import argparse
    import asyncio
    import subprocess
    sys.path.insert(0, str(_BUILD.parent.parent))
    import computer_control
    # wrapper 的内部原生命令直接走二进制，不再经过本启动器。
    computer_control._USE_SERVE = False
    command = argv[0] if argv else ''
    if command in ('--help', '-h'):
        result = subprocess.run([str(build_binary()), *argv], capture_output=True, text=True)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        print('\n扩展命令（同样支持 --json）：version / capabilities / disconnect / release / target-close APP --authorized [--timeout 秒] / element APP ACTION --selector JSON [--handle JSON] [--value TEXT] [--direction down] / autofill APP [--account TEXT]（点 1Password 填充浮层里的账号） / approve-debug APP（允许 Chrome 远程调试）')
        return result.returncode
    class Parser(argparse.ArgumentParser):
        def error(self, message):
            print(json.dumps({'ok': False, 'error': message, 'code': 2, 'command': command,
                              'host': 'local', 'outcome': 'not_sent'}, ensure_ascii=False))
            raise SystemExit(2)
    parser = Parser(prog='computer-control '+command)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--scope')
    parser.add_argument('--lease')
    parser.add_argument('--window-ref', type=json.loads)
    if command in ('element', 'target-close', 'autofill', 'approve-debug'):
        parser.add_argument('app')
    if command == 'element':
        parser.add_argument('action', choices=['resolve', 'read', 'click', 'set_value', 'scroll', 'act', 'measure'])
        parser.add_argument('--selector', type=json.loads)
        parser.add_argument('--handle', type=json.loads)
        parser.add_argument('--value')
        parser.add_argument('--direction', default='down')
        parser.add_argument('--pages', type=float, default=1)
    elif command == 'target-close':
        parser.add_argument('--authorized', action='store_true')
        parser.add_argument('--timeout', type=float, default=10)
    elif command == 'autofill':
        parser.add_argument('--account')
        parser.add_argument('--timeout', type=float, default=5)
    elif command == 'approve-debug':
        parser.add_argument('--watch', type=float, default=30)
    ns = parser.parse_args(argv[1:])
    if ns.scope is not None: os.environ["COMPUTER_CONTROL_CONTEXT_ID"] = ns.scope
    computer_control._task_scope.set(computer_control._scope(ns.scope))
    if ns.lease is not None: computer_control._task_lease.set(ns.lease)
    if ns.window_ref is not None: computer_control._window_ref.set(computer_control._normalize_window(ns.window_ref))
    async def execute():
        if command in ('version', 'capabilities', '--capabilities'):
            return await computer_control.version(host='local')
        if command in ('disconnect', 'release'):
            return await getattr(computer_control, command)()
        if command == 'autofill':
            return await computer_control.autofill(ns.app, account=ns.account, timeout=ns.timeout, host='local')
        if command == 'approve-debug':
            # 收到结束信号时正常取消；监听不激活浏览器，也不恢复桌面。
            import signal
            task = asyncio.current_task()
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
            try:
                return await computer_control.approve_chrome_debugging(
                    ns.app, watch=ns.watch, host='local',
                    on_ready=lambda: print('computer-control: approve-debug ready', file=sys.stderr, flush=True))
            except asyncio.CancelledError:
                return {'approved': False, 'reason': 'stopped'}
        handle = getattr(ns, 'handle', None) or {}
        target = computer_control.app(ns.app, host='local', window=ns.window_ref or handle.get('boundWindow'))
        target.lease = ns.lease or handle.get('lease')
        if command == 'target-close':
            return await target.close(authorized=ns.authorized, timeout=ns.timeout)
        element = computer_control.Element(target, ns.selector, handle=ns.handle)
        action = ns.action
        if action in ('set_value', 'act'):
            if ns.value is None:
                raise ValueError('--value 是必填项')
            return await getattr(element, action)(ns.value)
        if action == 'scroll':
            return await element.scroll(ns.direction, pages=ns.pages)
        result = await getattr(element, action)()
        return {'text': result} if action == 'read' else result
    try:
        data = asyncio.run(execute())
        code = 0
        print(json.dumps({'ok': code == 0, **data}, ensure_ascii=False))
        return code
    except computer_control.ComputerControlError as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        print(json.dumps({'ok': False, 'error': str(exc), 'code': code, **({'data': exc.data} if exc.data else {}),
                          'command': command, 'host': 'local', 'outcome': exc.outcome}, ensure_ascii=False))
        return code
    except (ValueError, TypeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc), 'code': 2, 'command': command, 'host': 'local', 'outcome': 'not_sent'}, ensure_ascii=False))
        return 2


def build_binary():
    spec = importlib.util.spec_from_file_location('computer_control_build', _BUILD)
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    return build.ensure_binary()


def _main():
    options = sys.argv[1:]
    options = options[:options.index("--")] if "--" in options else options
    if options[:1] == ["--local"]:
        options = options[1:]
    if options[:1] == ["--capabilities"]:
        sys.path.insert(0, str(_BUILD.parent.parent))
        import computer_control
        print(json.dumps({"ok": True, **computer_control.probe()}))
        return 0
    private_shared = _BUILD.parent / '_shared'
    sys.path.insert(0, str(private_shared if private_shared.is_dir() else _BUILD.parents[3] / '_shared'))
    from agentkit.remote.target import dispatch
    argv, handled = dispatch('computer-control', sys.argv[1:])
    if handled is not None:
        return handled
    if argv and argv[0] in ('version', 'capabilities', '--capabilities', 'disconnect', 'release', 'target-close', 'element', 'autofill', 'approve-debug', '--help', '-h'):
        return wrapper(argv)
    binary = build_binary()
    os.execv(str(binary), [str(binary), *argv])


def main():
    try:
        return _main()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc), 'code': 1}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
