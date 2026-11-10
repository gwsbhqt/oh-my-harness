import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createPlugin, resolveVersions } from '../scaffold.mjs';
const publicRepository = fileURLToPath(new URL('../..',import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-scaffold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [plugin,source] of [['dsh-seed-host','dsh-control'],['dsh-seed-web','dsh-monitor']]) {
    mkdirSync(join(root, plugin));
    cpSync(join(publicRepository, source, 'package.json'), join(root, plugin, 'package.json'));
  }
  return root;
}
const pkg = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));

test('host 与 web 模板名称、patch、配置和依赖完整', async t => {
  const root = fixture(t);
  for (const kind of ['host', 'web']) {
    const name = `dsh-example-${kind}`;
    const path = await createPlugin({ root, name, kind });
    const value = pkg(path);
    assert.equal(value.name, name);
    assert.equal(value.scripts.build, 'node scripts/build.mjs');
    assert.match(readFileSync(join(path, 'scripts/build.mjs'), 'utf8'), /\.\.\/\.\.\/tooling\/build\.mjs/);
    assert.equal(JSON.parse(readFileSync(join(path, 'tsconfig.json'), 'utf8')).extends, '../tooling/tsconfig.node.json');
    assert.match(readFileSync(join(path, 'cordis.patch.yml'), 'utf8'), new RegExp(`id: example-${kind}\\n      name: ${name}`));
    assert(value.dsh.build.repositoryInputs.includes('tooling/tsdown.d.mts'));
    assert(!value.dsh.build.inputs.includes('pnpm-lock.yaml'));
    assert(value.dsh.build.repositoryInputs.includes('tooling/build-manifest.mjs'));
    assert(value.peerDependencies['@deepseek-ai/cordis'].startsWith('>='));
    if (kind === 'web') {
      assert.equal(value.exports['./client'], './lib/client.js');
      assert.equal(value.dsh.client.platform, 'web');
      assert(value.peerDependencies['@deepseek-ai/dsh-client-ui-renderer'].startsWith('>='));
      assert.equal(JSON.parse(readFileSync(join(path, 'tsconfig.web.json'), 'utf8')).extends, '../tooling/tsconfig.web.json');
    } else assert.equal(value.exports['./client'], undefined);
    assert(!existsSync(join(path, 'node_modules')));
  }
});

test('优先显式版本，无宿主或工具版本硬编码', async t => {
  const root = fixture(t);
  const versions = { 'host-version': '1.2.0-rc.7', 'cordis-version': '5.0.0', 'tsdown-version': '^1.2.3', 'typescript-version': '~6.0.0', 'node-types-version': '26.1.0' };
  assert.equal(resolveVersions(root, 'web', versions).host, versions['host-version']);
  const path = await createPlugin({ root, name: 'dsh-explicit', kind: 'web', versions });
  assert.equal(pkg(path).peerDependencies['@deepseek-ai/dsh-client-ui-renderer'], '>=1.2.0-rc.7');
  assert.equal(pkg(path).devDependencies.tsdown, versions['tsdown-version']);
  const bad = { ...versions, 'host-version': '../../evil' };
  await assert.rejects(createPlugin({ root, name: 'dsh-bad-version', kind: 'web', versions: bad }), /非法版本/);
  assert(!existsSync(join(root, 'dsh-bad-version')));
});

test('拒绝非法名称、缺失kind、已有目录、文件及含断链的符号链接', async t => {
  const root = fixture(t);
  for (const name of ['dsh-', 'dsh-A', 'dsh-a/../b', '../dsh-x', 'dsh-a--b', 'dsh-_a', 'other']) {
    await assert.rejects(createPlugin({ root, name, kind: 'host' }), /插件名/);
  }
  await assert.rejects(createPlugin({ root, name: 'dsh-kind' }), /kind/);
  mkdirSync(join(root, 'dsh-existing'));
  writeFileSync(join(root, 'dsh-existing', 'keep'), 'keep');
  writeFileSync(join(root, 'dsh-file'), 'keep');
  symlinkSync(join(root, 'dsh-existing'), join(root, 'dsh-link'));
  symlinkSync(join(root, 'missing'), join(root, 'dsh-dangling'));
  for (const name of ['dsh-existing', 'dsh-file', 'dsh-link', 'dsh-dangling']) await assert.rejects(createPlugin({ root, name, kind: 'host' }), /目标已存在/);
  assert.equal(readFileSync(join(root, 'dsh-existing', 'keep'), 'utf8'), 'keep');
  assert(lstatSync(join(root, 'dsh-link')).isSymbolicLink());
});

test('创建失败只清理自己新增项，不删外部新写入文件', async t => {
  const root = fixture(t);
  const before = readdirSync(root);
  let count = 0;
  await assert.rejects(createPlugin({ root, name: 'dsh-failed', kind: 'host', write: (fd, content, encoding) => {
    if (++count === 4) throw new Error('模拟写入失败');
    writeFileSync(fd, content, encoding);
  } }), /模拟写入失败/);
  assert.deepEqual(readdirSync(root), before);
  await assert.rejects(createPlugin({ root, name: 'dsh-foreign', kind: 'host', write: () => {
    writeFileSync(join(root, 'dsh-foreign', 'foreign'), '外部写入');
    throw new Error('模拟并发失败');
  } }), /保留非本次新增项/);
  assert.deepEqual(readdirSync(join(root, 'dsh-foreign')), ['foreign']);
  assert.equal(readFileSync(join(root, 'dsh-foreign', 'foreign'), 'utf8'), '外部写入');
});

test('拒绝符号链接仓库根，不删除同名旧文件', async t => {
  const root = fixture(t);
  const link = join(root, 'linked-root');
  symlinkSync(root, link, 'dir');
  await assert.rejects(createPlugin({ root: link, name: 'dsh-root-link', kind: 'host' }), /真实目录/);
  assert(!existsSync(join(root, 'dsh-root-link')));
  assert(lstatSync(link).isSymbolicLink());
});

test('代表插件版本读取失败时不留下新目录', async t => {
  const root = fixture(t);
  rmSync(join(root, 'dsh-seed-host'), { recursive: true });
  rmSync(join(root, 'dsh-seed-web'), { recursive: true });
  await assert.rejects(createPlugin({ root, name: 'dsh-no-version', kind: 'host' }), /无法读取/);
  assert(!existsSync(join(root, 'dsh-no-version')));
});

test('临时fixture真实类型检查、构建并验证 host/client apply 导出', async t => {
  const root = fixture(t);
  mkdirSync(join(root, '.git'));
  cpSync(join(publicRepository, 'tooling'), join(root, 'tooling'), { recursive: true, filter: source => !source.includes('/test') });
  const modules = join(publicRepository, 'dsh-monitor', 'node_modules');
  assert(existsSync(join(modules, '.bin', 'tsc')), '测试需要现有插件本地 node_modules，不会自动安装');
  for (const kind of ['host', 'web']) {
    const name = `dsh-compile-${kind}`;
    const path = await createPlugin({ root, name, kind });
    symlinkSync(modules, join(path, 'node_modules'), 'dir');
    const run = (command, args, options = {}) => {
      // node_modules 链到真实插件；pnpm 12 默认运行前补装，会顺着链接改写那个插件的依赖。
      const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false' };
      const result = spawnSync(command, args, { cwd: path, encoding: 'utf8', env, ...options });
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result;
    };
    run('pnpm', ['run', 'check']);
    const host = await import(pathToFileURL(join(path, 'lib', 'index.js')).href);
    assert.equal(host.name, name);
    assert.equal(typeof host.apply, 'function');
    let loaded = false;
    host.apply({ logger: () => ({ info: () => { loaded = true; } }) });
    assert(loaded);
    const manifest = JSON.parse(readFileSync(join(path, 'lib', 'dsh-build.json'), 'utf8'));
    assert(manifest.repositoryInputs);
    if (kind === 'web') {
      let bundle;
      vm.runInNewContext(readFileSync(join(path, 'lib', 'client.js'), 'utf8'), { window: { __ModuleLoader__: { load: value => { bundle = value; } } } });
      assert.equal(bundle.id, name);
      const client = bundle.factory(() => { throw new Error('空模板不应有运行时依赖'); });
      assert.equal(typeof client.apply, 'function');
      client.apply({});
    }
  }
});
