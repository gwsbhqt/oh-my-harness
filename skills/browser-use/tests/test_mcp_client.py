"""Exercise the public transport with dedicated newline-delimited MCP processes."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from browser_use.mcp_client import StdioMcp, cra_command, google_command
from browser_use.protocol import BrowserError


_SERVER = r"""
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

journal = Path(sys.argv[1])
mode = sys.argv[2]
ready = False
pair = []


def send(message):
    print(json.dumps({'jsonrpc': '2.0', **message}, ensure_ascii=False), flush=True)


def value(request_id, value):
    send({'id': request_id, 'result': {'content': [], 'structuredContent': value}})


for line in sys.stdin:
    packet = json.loads(line)
    method = packet.get('method')
    params = packet.get('params', {})
    request_id = packet.get('id')
    name = params.get('name')
    with journal.open('a') as history:
        print(json.dumps({'id': request_id, 'method': method, 'tool': name, 'pid': os.getpid()}), file=history)
    if method == 'initialize':
        assert params['protocolVersion'] == '2025-11-25' and params['capabilities'] == {}
        assert params['clientInfo']['name'] and params['clientInfo']['version']
        if mode == 'hang_init':
            continue
        version = '2025-06-18' if mode == 'older' else params['protocolVersion']
        if mode == 'bad_protocol':
            version = 'unsupported'
        identity = {'name': 'fixture', 'version': '1'}
        if mode == 'wrong_google':
            identity = {'name': 'chrome_devtools', 'version': '0.0.0'}
        send({'id': request_id, 'result': {'serverInfo': identity, 'protocolVersion': version, 'capabilities': {'tools': {}}}})
    elif method == 'notifications/initialized':
        ready = True
    elif method == 'tools/call':
        assert ready
        args = params['arguments']
        if name == 'pair':
            pair.append((request_id, args))
            if len(pair) == 2:
                send({'method': 'notifications/tools/list_changed'})
                for i, a in reversed(pair):
                    value(i, a)
                pair.clear()
        elif name == 'ping_client':
            send({'id': request_id, 'method': 'ping'})
        elif name == 'is_error':
            send({'id': request_id, 'result': {'isError': True, 'content': [{'type': 'text', 'text': 'fixture rejection'}]}})
        elif name == 'rpc_error':
            send({'id': request_id, 'error': {'code': -32602, 'message': 'fixture error', 'data': {'field': 'color'}}})
        elif name == 'large':
            sys.stderr.buffer.write(b'noise' * 100000)
            sys.stderr.buffer.flush()
            import struct
            import zlib
            def chunk(tag, data):
                return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
            header = struct.pack('>2I5B', 256, 1024, 8, 0, 0, 0, 0)
            pixels = (b'\x00' + bytes(range(256))) * 1024
            png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels, 0)) + chunk(b'IEND', b'')
            content = [{'type': 'text', 'text': 'abc\n' * 262144},
                       {'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(png).decode()}]
            send({'id': request_id, 'result': {'content': content, 'structuredContent': {'fixture': True}}})
        elif name == 'oversize':
            sys.stdout.buffer.write(b'x' * (2 * 1024 * 1024))
            sys.stdout.buffer.flush()
        elif name == 'incomplete':
            print('{', end='', flush=True)
            sys.exit(0)
        elif name == 'wrong_id':
            value(request_id + 100, {})
        elif name == 'lost':
            print('fixture process stopped', file=sys.stderr, flush=True)
            os._exit(23)
        elif name == 'hang':
            continue
        elif name == 'flags':
            value(request_id, {key: os.environ.get(key) for key in args['keys']})
        elif name == 'lose_launcher':
            subprocess.Popen([sys.executable, '-c', 'import signal; signal.pause()'])
            os._exit(17)
        elif name == 'spawn_child':
            child_code = (
                "import fcntl, signal, sys; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "f = open(sys.argv[1], 'w'); fcntl.flock(f, fcntl.LOCK_EX); "
                "print('ready', flush=True); signal.pause()"
            )
            child = subprocess.Popen([sys.executable, '-c', child_code, args['lock']], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            assert child.stdout.readline() == b'ready\n'
            value(request_id, {'child': child.pid})
        else:
            value(request_id, args)
    elif 'result' in packet and packet['result'] == {}:
        value(request_id, {'pong': True})
with journal.open('a') as history:
    print(json.dumps({'id': None, 'method': 'eof', 'tool': None, 'pid': os.getpid()}), file=history)
"""


class CommandTests(unittest.TestCase):
    def test_cra_app_or_executable_and_socket_are_separate_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / 'Fixture Browser.app'
            binary = bundle / 'Contents/MacOS/Cra'
            socket = Path(temp) / 'fixture profile' / 'mcp.sock'
            expected = [str(binary), '--mcp', str(socket)]
            self.assertEqual(cra_command(executable=bundle, socket=socket), expected)
            self.assertEqual(cra_command(executable=binary, socket=socket), expected)

    def test_google_uses_explicit_http_or_browser_websocket(self):
        with patch('browser_use.mcp_client.shutil.which', side_effect=lambda name: name):
            command = google_command('http://127.0.0.1:12345')
        self.assertEqual(command[0], 'chrome-devtools-mcp')
        self.assertIn('--browser-url=http://127.0.0.1:12345', command)
        for flag in ('--no-usage-statistics', '--no-performance-crux', '--page-id-routing',
                     '--experimental-vision', '--experimental-structured-content', '--category-network-mocks',
                     '--screenshot-max-width=1280', '--screenshot-max-height=1280'):
            self.assertIn(flag, command)
        with patch('browser_use.mcp_client.shutil.which', side_effect=lambda name: name if name == 'npx' else None):
            endpoint = 'ws://[::1]:12345/devtools/browser/fixture'
            command = google_command(endpoint)
        self.assertEqual(command[:4], ['npx', '--offline', '--yes', 'chrome-devtools-mcp@1.13.0'])
        self.assertIn('--ws-endpoint=' + endpoint, command)

    def test_google_rejects_ambiguous_or_nonlocal_endpoints(self):
        cases = ('', None, 'localhost', 'http://localhost', 'http://localhost:0', 'http://example.com:12345',
                 'http://127.0.0.1:12345/json/version', 'ws://127.0.0.1:12345/devtools/page/fixture',
                 'http://user@localhost:12345', 'http://[::1]example.com:12345', 'http://127.0.0.1:65536')
        for endpoint in cases:
            with self.subTest(endpoint=endpoint), self.assertRaises(BrowserError) as failure:
                google_command(endpoint, executable='fixture-mcp')
            self.assertEqual((failure.exception.code, failure.exception.outcome), ('invalid_arguments', 'not_sent'))


class StdioTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.journal = Path(temp.name) / 'requests.jsonl'

    def client(self, mode='normal', timeout=4, env=None):
        argv = [sys.executable, '-u', '-c', _SERVER, str(self.journal), mode]
        client = StdioMcp(argv, timeout=timeout, env=env)
        self.addAsyncCleanup(client.aclose)
        return client

    def requests(self):
        if not self.journal.exists():
            return []
        return [json.loads(line) for line in self.journal.read_text().splitlines()]

    async def wait_for_receipt(self, *, method=None, tool=None):
        async with asyncio.timeout(4):
            while not any(r['tool'] == tool and r['method'] == method for r in self.requests()):
                await asyncio.sleep(0.01)

    async def test_concurrent_out_of_order_replies_and_cross_loop_reuse(self):
        client = self.client(mode='older')
        calls = [client.call('pair', {'label': label}) for label in ('first', 'second')]
        first, second = await asyncio.gather(*calls)
        self.assertEqual([v['structuredContent']['label'] for v in (first, second)], ['first', 'second'])
        result = await asyncio.to_thread(lambda: asyncio.run(client.call('ping_client', {})))
        self.assertEqual(result['structuredContent'], {'pong': True})
        entries = self.requests()
        self.assertEqual(len({row['pid'] for row in entries}), 1)
        self.assertEqual([row['method'] for row in entries].count('initialize'), 1)
        ids = [row['id'] for row in entries if row['method'] == 'tools/call']
        self.assertEqual(len(ids), len(set(ids)))

    async def test_tool_and_rpc_errors_are_not_replayed(self):
        client = self.client()
        raw = await client.call('is_error', {})
        self.assertEqual(raw, {'isError': True, 'content': [{'type': 'text', 'text': 'fixture rejection'}]})
        with self.assertRaises(BrowserError) as failure:
            await client.call('rpc_error', {})
        self.assertEqual(failure.exception.data, {'code': -32602, 'message': 'fixture error', 'data': {'field': 'color'}})
        self.assertEqual(failure.exception.outcome, 'unknown')
        await client.call('echo', {})
        self.assertEqual([r['tool'] for r in self.requests() if r['tool']], ['is_error', 'rpc_error', 'echo'])

    async def test_snapshot_image_and_stderr_remain_separate(self):
        raw = await self.client().call('large', {})
        text, image = raw['content']
        self.assertEqual(text['text'], 'abc\n' * 262144)
        import struct
        import zlib
        png = base64.b64decode(image['data'], validate=True)
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(png[37:41], b'IDAT')
        length = struct.unpack('>I', png[33:37])[0]
        self.assertEqual(zlib.decompress(png[41:41 + length]), (b'\x00' + bytes(range(256))) * 1024)
        self.assertEqual(raw['structuredContent'], {'fixture': True})

    async def test_explicit_environment_and_orderly_eof(self):
        keys = ['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS',
                'CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY']
        client = self.client(env={'FIXTURE_VALUE': 'synthetic', keys[0]: '0'})
        result = await client.call('flags', {'keys': ['FIXTURE_VALUE', *keys]})
        self.assertEqual(result['structuredContent'], {'FIXTURE_VALUE': 'synthetic', **dict.fromkeys(keys, '1')})
        await client.aclose()
        self.assertEqual(self.requests()[-1]['method'], 'eof')

    async def test_unencodable_and_oversize_arguments_never_enter_the_pipe(self):
        with patch('browser_use.mcp_client._MAX_FRAME', 2048):
            client = self.client()
            for value in (float('nan'), object(), 'x' * 2048):
                with self.assertRaises(BrowserError) as failure:
                    await client.call('never', {'value': value})
                self.assertEqual((failure.exception.code, failure.exception.outcome), ('invalid_arguments', 'not_sent'))
            await client.call('echo', {})
        self.assertEqual([r['tool'] for r in self.requests() if r['tool']], ['echo'])

    async def test_rejected_versions_leave_tool_unsent(self):
        for mode in ('bad_protocol', 'wrong_google'):
            with self.subTest(mode=mode), self.assertRaises(BrowserError) as failure:
                await self.client(mode).call('echo', {})
            self.assertEqual((failure.exception.code, failure.exception.outcome), ('protocol_error', 'not_sent'))
        self.assertFalse(any(r['tool'] for r in self.requests()))

    async def test_oversize_incomplete_or_unmatched_reply_closes_connection(self):
        with patch('browser_use.mcp_client._MAX_FRAME', 64 * 1024):
            for tool in ('oversize', 'incomplete', 'wrong_id'):
                client = self.client()
                with self.subTest(tool=tool), self.assertRaises(BrowserError) as failure:
                    await client.call(tool, {})
                self.assertEqual((failure.exception.code, failure.exception.outcome), ('protocol_error', 'unknown'))
                with self.assertRaises(BrowserError) as again:
                    await client.call('again', {})
                self.assertEqual(again.exception.outcome, 'not_sent')
        self.assertEqual([r['tool'] for r in self.requests() if r['tool']], ['oversize', 'incomplete', 'wrong_id'])

    async def test_timeout_before_and_after_tool_write(self):
        for mode, tool, outcome in [('hang_init', 'never', 'not_sent'), ('normal', 'hang', 'unknown')]:
            client = self.client(mode, timeout=0.4)
            with self.subTest(mode=mode), self.assertRaises(BrowserError) as failure:
                await client.call(tool, {})
            self.assertEqual((failure.exception.code, failure.exception.outcome), ('timeout', outcome))
            with self.assertRaises(BrowserError) as again:
                await client.call('again', {})
            self.assertEqual(again.exception.outcome, 'not_sent')
        self.assertEqual([r['tool'] for r in self.requests() if r['tool']], ['hang'])

    async def test_cancellation_releases_all_waiters_and_never_reopens(self):
        client = self.client()
        first = asyncio.create_task(client.call('hang', {}))
        second = asyncio.create_task(client.call('hang', {}))
        async with asyncio.timeout(4):
            while len([r for r in self.requests() if r['tool'] == 'hang']) < 2:
                await asyncio.sleep(0.01)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        with self.assertRaises(BrowserError) as failure:
            await second
        self.assertEqual(failure.exception.outcome, 'unknown')
        await asyncio.gather(client.aclose(), client.aclose())
        with self.assertRaises(BrowserError) as again:
            await client.call('again', {})
        self.assertEqual(again.exception.outcome, 'not_sent')
        self.assertEqual(len({r['pid'] for r in self.requests()}), 1)

    async def test_cancelled_handshake_and_missing_executable(self):
        client = self.client('hang_init')
        pending = asyncio.create_task(client.call('never', {}))
        await self.wait_for_receipt(method='initialize')
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        missing = StdioMcp([str(self.journal.parent / 'missing-command')])
        self.addAsyncCleanup(missing.aclose)
        with self.assertRaises(BrowserError) as failure:
            await missing.call('never', {})
        self.assertEqual((failure.exception.code, failure.exception.outcome), ('connection_failed', 'not_sent'))
        self.assertFalse(any(r['tool'] for r in self.requests()))

    async def test_process_exit_preserves_bounded_stderr(self):
        with self.assertRaises(BrowserError) as failure:
            await self.client().call('lost', {})
        self.assertEqual((failure.exception.code, failure.exception.outcome), ('connection_lost', 'unknown'))
        self.assertIn('fixture process stopped', failure.exception.data['stderr'])

    @unittest.skipUnless(os.name == 'posix', 'Process group ownership is POSIX-specific')
    async def test_launcher_exit_is_reported_while_a_child_holds_pipes(self):
        client = self.client(timeout=3)
        with self.assertRaises(BrowserError) as failure:
            await client.call('lose_launcher', {})
        self.assertEqual((failure.exception.code, failure.exception.outcome), ('connection_lost', 'unknown'))

    @unittest.skipUnless(os.name == 'posix', 'Process group ownership is POSIX-specific')
    async def test_closing_kills_owned_descendant_and_preserves_other_session(self):
        import fcntl
        client = self.client()
        sibling = self.client()
        await sibling.call('echo', {})
        lock_file = self.journal.parent / 'child.lock'
        await client.call('spawn_child', {'lock': str(lock_file)})
        with lock_file.open() as fd:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            await client.aclose()
            async with asyncio.timeout(2):
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        await asyncio.sleep(0.01)
        self.assertEqual((await sibling.call('echo', {'alive': True}))['structuredContent'], {'alive': True})
