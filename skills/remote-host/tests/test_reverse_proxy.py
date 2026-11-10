"""反向代理生命周期测试：真实子进程替身，不连接用户机器。"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import remote_host
from agentkit.remote import proxy

FAKE_SSH = r"""#!__PYTHON__
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['PROXY_TEST_RECORD'], 'a') as f:
    f.write(json.dumps({'args': args, 'pid': os.getpid()}) + '\n')
mode = os.environ.get('PROXY_TEST_MODE', '')
if '-M' in args:
    if mode == 'master-failure':
        print('test authentication failure', file=sys.stderr)
        sys.exit(255)
    Path(args[args.index('-S')+1]).touch()
    while True: time.sleep(1)
if '-O' in args:
    if mode == 'forward-failure':
        print('test forwarding denied', file=sys.stderr)
        sys.exit(255)
    if mode == 'slow-forward':
        while True: time.sleep(1)
    print('not-a-port' if mode == 'bad-port' else '49123')
else:
    sys.stdin.read()
    print('n*:49123' if mode == 'wildcard' else 'p123\nn127.0.0.1:49123')
"""


class ReverseProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        ssh = root / 'ssh'
        ssh.write_text(FAKE_SSH.replace('__PYTHON__', sys.executable))
        ssh.chmod(0o700)
        self.record = root / 'record'
        config = root / '.ssh' / 'config'
        config.parent.mkdir()
        config.write_text('Host alpha\n  HostName 192.0.2.42\n  User operator\n')
        self.patch = mock.patch.dict(os.environ, {'PATH': str(root) + os.pathsep + os.environ['PATH'],
                                                   'PROXY_TEST_RECORD': str(self.record), 'HOME': str(root)})
        self.patch.start()
        self.resolve = mock.patch.object(proxy, 'resolve_target', side_effect=lambda tool, host: host)
        self.resolve.start()
        self.server = await asyncio.start_server(self.accept, '127.0.0.1', 0)
        self.local_proxy = f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'

    async def accept(self, reader, writer):
        writer.close()
        await writer.wait_closed()

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.resolve.stop()
        self.patch.stop()
        self.tmp.cleanup()

    def handle(self, **kw):
        return remote_host.reverse_proxy(host='alpha', local_proxy=self.local_proxy, **kw)

    def calls(self):
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    async def test_dynamic_loopback_and_independent_master_then_idempotent_close(self):
        handle = self.handle()
        original = dict(os.environ)
        async with handle as opened:
            self.assertIs(handle, opened)
            self.assertTrue(handle.alive)
            self.assertEqual(handle.url, 'http://127.0.0.1:49123')
            self.assertEqual(handle.env['HTTPS_PROXY'], handle.url)
            self.assertEqual(handle.env['NO_PROXY'], '')
            directory = handle._directory
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            calls = self.calls()
            master = calls[0]['args']
            for option in ('ControlPersist=no', 'ForkAfterAuthentication=no', 'ForwardAgent=no', 'ClearAllForwardings=yes'):
                self.assertIn(option, master)
            self.assertIn('-M', master)
            self.assertIn('/dev/null', calls[1]['args'])
            self.assertIn('ProxyCommand=false', calls[1]['args'])
            self.assertIn('127.0.0.1:0:127.0.0.1:', ' '.join(calls[1]['args']))
            self.assertEqual(original, dict(os.environ))
        self.assertTrue(handle.closed)
        self.assertFalse(handle.alive)
        self.assertFalse(directory.exists())
        self.assertIsNotNone(handle._proc.returncode)
        await handle.close()
        with self.assertRaises(RuntimeError):
            _ = handle.url
        with self.assertRaises(RuntimeError):
            await handle.open()

    async def test_run_handle_passes_child_only_proxy_and_enforces_host(self):
        async with self.handle() as handle:
            with mock.patch.object(remote_host, '_exec', new_callable=mock.AsyncMock) as execute:
                await remote_host.run('echo x', proxy=handle, quiet=True)
                args, kw = execute.call_args
                self.assertEqual(args[0], ['-H', 'alpha', 'run', '-P'])
                self.assertEqual(kw['env'], {'REMOTE_HOST_PROXY': '127.0.0.1:49123'})
                self.assertEqual(kw['input'], 'echo x')
                with self.assertRaises(ValueError):
                    await remote_host.run('x', host='another', proxy=handle)
                with self.assertRaises(ValueError):
                    await remote_host.run('x', proxy=handle, table=True)
        with self.assertRaises(RuntimeError):
            await remote_host.run('x', proxy=handle)

    async def test_cli_uses_same_scope_preserves_exit_code_and_closes(self):
        from remote_host.commands import cli
        handles = []
        async def run_payload(body, **kw):
            self.assertEqual(body, 'echo cli')
            self.assertTrue(kw['proxy'].alive)
            handles.append(kw['proxy'])
            return remote_host.Result([], 42, '', '')
        with mock.patch.object(remote_host, 'run', side_effect=run_payload), mock.patch.object(cli, 'log_call'):
            code = await asyncio.to_thread(cli.execute, ['-H', 'alpha', 'proxy-run',
                '--local-proxy', self.local_proxy, '-i', 'sh', 'echo cli'])
        self.assertEqual(code, 42)
        self.assertTrue(handles[0].closed)
        self.assertIsNotNone(handles[0]._proc.returncode)

    async def test_two_handles_do_not_share_socket_or_process(self):
        async with self.handle() as a, self.handle() as b:
            self.assertNotEqual(a._socket, b._socket)
            self.assertNotEqual(a._proc.pid, b._proc.pid)
            await a.close()
            self.assertTrue(b.alive)

    async def test_body_exception_closes(self):
        handle = self.handle()
        with self.assertRaisesRegex(RuntimeError, 'payload failed'):
            async with handle:
                raise RuntimeError('payload failed')
        self.assertTrue(handle.closed)
        self.assertIsNotNone(handle._proc.returncode)

    async def test_startup_failures_and_wildcard_all_reap_master(self):
        for mode in ('master-failure', 'forward-failure', 'bad-port', 'wildcard'):
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {'PROXY_TEST_MODE': mode}):
                handle = self.handle()
                with self.assertRaises(RuntimeError):
                    await handle.open()
                self.assertTrue(handle.closed)
                self.assertIsNotNone(handle._proc.returncode)
                self.assertIsNone(handle._directory)

    async def test_timeout_cleans_up(self):
        with mock.patch.dict(os.environ, {'PROXY_TEST_MODE': 'slow-forward'}):
            handle = self.handle(timeout=0.15)
            with self.assertRaises(TimeoutError):
                await handle.open()
            self.assertTrue(handle.closed)
            self.assertIsNotNone(handle._proc.returncode)

    async def test_cancellation_cleans_up_both_processes(self):
        with mock.patch.dict(os.environ, {'PROXY_TEST_MODE': 'slow-forward'}):
            handle = self.handle()
            opening = asyncio.create_task(handle.open())
            while not self.record.exists() or len(self.calls()) < 2:
                await asyncio.sleep(0.01)
            opening.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await opening
            self.assertTrue(handle.closed)
            self.assertIsNotNone(handle._proc.returncode)
            for call in self.calls():
                with self.assertRaises(ProcessLookupError):
                    os.kill(call['pid'], 0)

    async def test_unavailable_local_proxy_creates_no_ssh(self):
        self.server.close()
        await self.server.wait_closed()
        handle = self.handle()
        with self.assertRaises(OSError):
            await handle.open()
        self.assertTrue(handle.closed)
        self.assertIsNone(handle._proc)

    async def test_input_boundaries(self):
        for host in ('local', '', 'a,b', None):
            with self.assertRaises(ValueError):
                remote_host.reverse_proxy(host=host, local_proxy=self.local_proxy)
        for url in ('https://127.0.0.1:7890', 'http://user:secret@127.0.0.1:7890',
                    'http://198.51.100.1:7890', 'http://localhost:7890/path',
                    'http://localhost:0', 'http://localhost:7890\n'):
            with self.assertRaises(ValueError):
                remote_host.reverse_proxy(host='alpha', local_proxy=url)
        for timeout in (0, -1, float('inf'), None, True):
            with self.assertRaises(ValueError):
                self.handle(timeout=timeout)
        self.assertEqual(proxy._proxy_target('http://[::1]:7890')[2], '[::1]:7890')
        proxy._loopback_listeners('p1\nn127.0.0.1:123\nn[::1]:123', 123)
        for output in ('', 'p1\nn*:123', 'p1\nn127.0.0.1:123\nn[::]:123'):
            with self.assertRaises(RuntimeError):
                proxy._loopback_listeners(output, 123)


if __name__ == '__main__':
    unittest.main()
