#!/usr/bin/env node
import { readdirSync, lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPlugin } from './scaffold.mjs';

const ownTooling = realpathSync(dirname(fileURLToPath(import.meta.url)));
const invokedTooling = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
const currentTooling = resolve(process.cwd(), 'tooling');
export const repositoryRoot = invokedTooling && realpathSync(invokedTooling) === ownTooling
  ? resolve(invokedTooling, '..')
  : existsSync(currentTooling) && realpathSync(currentTooling) === ownTooling
    ? process.cwd()
    : resolve(ownTooling, '..');

export function discoverPlugins(root) {
  return readdirSync(root).filter(name => name.startsWith('dsh-')).sort().map(directory => {
    try {
      const entry = resolve(root, directory);
      const stat = lstatSync(entry);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('不是插件目录');
      if (stat.isSymbolicLink()) {
        let workspace = realpathSync(root);
        while (!existsSync(resolve(workspace, '.git')) && dirname(workspace) !== workspace) workspace = dirname(workspace);
        if (!existsSync(resolve(workspace, '.git'))) throw new Error('符号链接必须位于 Git 工作区内');
        const target = relative(workspace, realpathSync(entry));
        if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new Error('符号链接不能指向 Git 工作区外');
      }
      const pkg = JSON.parse(readFileSync(resolve(entry, 'package.json'), 'utf8'));
      if (stat.isSymbolicLink() && pkg.name !== directory) throw new Error('符号链接名称必须与插件包名一致');
      return { directory, pkg };
    } catch (error) {
      return { directory, error: error.message };
    }
  });
}

function selectPlugins(plugins, names) {
  if (!names.length) return plugins;
  return names.map(input => {
    const name = input.replace(/^--/, '');
    return plugins.find(p => p.directory === name || p.directory === `dsh-${name}` || p.pkg?.name === name)
      ?? { directory: input, error: '未找到插件' };
  });
}

export function runCommand(command, names = [], { root = repositoryRoot, run = spawnSync, log = console.log, error = console.error } = {}) {
  if (!['check', 'build', 'list'].includes(command)) throw new Error(`未知命令：${command}`);
  const selected = selectPlugins(discoverPlugins(root), names);
  const failures = [];
  if (!selected.length) { error('没有找到插件目录'); return 1; }
  for (const plugin of selected) {
    let reason = plugin.error;
    const script = command;
    if (!reason && command !== 'list' && typeof plugin.pkg.scripts?.[script] !== 'string') reason = `缺少 scripts.${script}`;
    if (reason) {
      error(`[失败] ${plugin.directory}: ${reason}`);
      failures.push(plugin.directory);
      continue;
    }
    if (command === 'list') {
      log(`${plugin.directory}\t${plugin.pkg.name}\tcheck=${plugin.pkg.scripts?.check ?? '缺失'}\tbuild=${plugin.pkg.scripts?.build ?? '缺失'}`);
      continue;
    }
    log(`\n=== ${plugin.directory}: pnpm run ${script} ===`);
    const result = run('pnpm', ['run', script], { cwd: resolve(root, plugin.directory), stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      error(`[失败] ${plugin.directory}: ${result.error?.message ?? result.signal ?? `退出码 ${result.status}`}`);
      failures.push(plugin.directory);
    } else log(`[通过] ${plugin.directory}`);
  }
  if (command !== 'list' || failures.length) log(`\n汇总：${selected.length - failures.length} 通过，${failures.length} 失败${failures.length ? `（${failures.join(', ')}）` : ''}`);
  return failures.length ? 1 : 0;
}

const help = `用法：
  pnpm run check [-- dsh-xxx ...]
  node tooling/cli.mjs check [dsh-xxx ...]
  node tooling/cli.mjs list [dsh-xxx ...]
  node tooling/cli.mjs build [dsh-xxx ...]
  node tooling/cli.mjs create dsh-xxx --kind host|web [版本参数]
版本参数：--host-version、--cordis-version、--tsdown-version、--typescript-version、--node-types-version
所有插件独立安装；不安装依赖、不联网、不修改 profile。`;

export async function main(args = process.argv.slice(2), options = {}) {
  try {
    const [command, ...rest] = args;
    if (!command || command === '--help' || command === 'help') { console.log(help); return 0; }
    if (command !== 'create') return runCommand(command, rest.filter(arg => arg !== '--'), options);
    const [name, ...flags] = rest;
    const values = {};
    const allowed = new Set(['kind', 'host-version', 'cordis-version', 'tsdown-version', 'typescript-version', 'node-types-version']);
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i]?.replace(/^--/, '');
      if (!flags[i]?.startsWith('--') || !allowed.has(key) || values[key] || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`非法或重复参数：${flags[i]}`);
      values[key] = flags[i + 1];
    }
    const created = await createPlugin({ root: options.root ?? repositoryRoot, name, kind: values.kind, versions: values });
    console.log(`已创建 ${created}；尚未安装依赖、注册到 profile 或构建。`);
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) process.exitCode = await main();
