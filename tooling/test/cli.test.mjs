import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand, discoverPlugins, main, repositoryRoot } from '../cli.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (name, scripts = { check: 'echo check', build: 'echo build' }) => {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ name, scripts }));
  };
  return { root, add };
}

function recorder(statuses = {}) {
  const calls = [], logs = [];
  return { calls, logs, run: (command, args, options) => {
    calls.push({ command, args, ...options });
    return { status: statuses[options.cwd.split('/').at(-1)] ?? 0 };
  }, log: text => logs.push(text), error: text => logs.push(text) };
}

test('按选择顺序在各插件目录运行 check，失败继续并汇总', t => {
  const { root, add } = fixture(t);
  add('dsh-z'); add('dsh-a'); add('dsh-b');
  const record = recorder({ 'dsh-a': 2 });
  assert.equal(runCommand('check', ['dsh-z', 'a', '--dsh-b'], { root, ...record }), 1);
  assert.deepEqual(record.calls.map(c => c.cwd), ['dsh-z', 'dsh-a', 'dsh-b'].map(n => join(root, n)));
});

test('非零状态、缺少脚本、未知插件都不静默跳过', t => {
  const { root, add } = fixture(t);
  add('dsh-a'); add('dsh-b', {}); add('dsh-c');
  const record = recorder({ 'dsh-a': 3 });
  assert.equal(runCommand('check', ['a', 'b', 'missing', 'c'], { root, ...record }), 1);
  assert.deepEqual(record.calls.map(c => c.cwd), [join(root, 'dsh-a'), join(root, 'dsh-c')]);
  assert(record.logs.some(line => line.includes('3 失败')));
  assert(record.calls.every(c => c.command === 'pnpm' && c.args.join(' ') === 'run check' && c.stdio === 'inherit'));
});

test('默认按目录名排序，每个插件都跑自己的 build', t => {
  const { root, add } = fixture(t);
  add('dsh-z'); add('dsh-example-build-all', { check: 'check', build: 'all' }); add('dsh-a');
  const record = recorder();
  assert.equal(runCommand('build', [], { root, ...record }), 0);
  assert.deepEqual(record.calls.map(c => c.args), [['run', 'build'], ['run', 'build'], ['run', 'build']]);
  assert.deepEqual(discoverPlugins(root).map(p => p.directory), ['dsh-a', 'dsh-example-build-all', 'dsh-z']);
});

test('list 展示实际脚本，损坏包与符号链接会报错', t => {
  const { root, add } = fixture(t);
  add('dsh-a'); add('dsh-example-build-all', { check: 'check', build: 'all' });
  mkdirSync(join(root, 'dsh-bad'));
  writeFileSync(join(root, 'dsh-bad', 'package.json'), '{');
  symlinkSync(join(root, 'dsh-a'), join(root, 'dsh-link'));
  const record = recorder();
  assert.equal(runCommand('list', [], { root, ...record }), 1);
  assert(record.logs.some(line => line.includes('build=all')));
  assert(record.logs.some(line => line.includes('dsh-link') && line.includes('符号链接')));
  assert.equal(record.calls.length, 0);
});

test('仓库内公开插件软链可以参与聚合检查，仓库外链接拒绝执行', t => {
  const { root, add } = fixture(t);
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'public', 'dsh-public'), { recursive: true });
  writeFileSync(join(root, 'public', 'dsh-public', 'package.json'), JSON.stringify({ name: 'dsh-public', scripts: { check: 'check' } }));
  symlinkSync('public/dsh-public', join(root, 'dsh-public'));
  add('dsh-private');
  const record = recorder();
  assert.equal(runCommand('check', [], { root, ...record }), 0);
  assert.deepEqual(record.calls.map(c => c.cwd), ['dsh-private', 'dsh-public'].map(n => join(root, n)));

  const external = fixture(t);
  external.add('dsh-external');
  symlinkSync(join(external.root, 'dsh-external'), join(root, 'dsh-external'));
  const blocked = recorder();
  assert.equal(runCommand('check', ['dsh-external'], { root, ...blocked }), 1);
  assert.equal(blocked.calls.length, 0);
  assert(blocked.logs.some(line => line.includes('Git 工作区外')));
});

test('找不到 pnpm 时逐项汇总失败，不吞错误', t => {
  const { root, add } = fixture(t); add('dsh-a'); add('dsh-b');
  const logs = [];
  assert.equal(runCommand('check', [], { root, run: () => ({ error: new Error('spawn pnpm ENOENT'), status: null }), log: s => logs.push(s), error: s => logs.push(s) }), 1);
  assert(logs.some(s => s.includes('ENOENT')));
  assert(logs.some(s => s.includes('2 失败')));
});

test('真实 CLI check 子进程完整转发输出并保留失败退出码', t => {
  const { root, add } = fixture(t); add('dsh-a'); add('dsh-b');
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf "完整日志:%s:%s\\n" "$PWD" "$*"\ncase "$PWD" in *dsh-a) exit 7;; esac\n', { mode: 0o755 });
  const command = `import { main } from ${JSON.stringify(join(repositoryRoot, 'tooling/cli.mjs'))}; process.exitCode = await main(['check'], {root: ${JSON.stringify(root)}});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.stderr);
  assert(result.stdout.includes(`完整日志:${join(root, 'dsh-a')}:run check`));
  assert(result.stdout.includes(`完整日志:${join(root, 'dsh-b')}:run check`));
  assert(result.stdout.includes('1 失败'));
});

test('非法 create 参数不产生文件', async t => {
  const { root } = fixture(t);
  assert.equal(await main(['create', 'dsh-test', '--kind', 'host', '--unexpected', 'x'], { root }), 1);
  assert.equal(await main(['create', 'dsh-test', '--kind', 'host', '--kind', 'web'], { root }), 1);
});
