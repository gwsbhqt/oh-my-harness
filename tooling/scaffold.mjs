import { readdirSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fstatSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const json = value => JSON.stringify(value, null, 2) + '\n';
const readPackage = (root, name) => JSON.parse(readFileSync(resolve(root, name, 'package.json'), 'utf8'));

export function resolveVersions(root, kind, overrides = {}) {
  const plugins = readdirSync(root, {withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name.startsWith('dsh-')).map(entry=>entry.name).sort();
  const cache = new Map();
  const get = (option, dependency) => {
    if (overrides[option]) return overrides[option];
    for (const plugin of plugins) {
      if (!cache.has(plugin)) cache.set(plugin, readPackage(root, plugin));
      const value = cache.get(plugin).devDependencies?.[dependency];
      if (value) return value;
    }
    throw new Error(`无法读取 ${dependency} 版本，请提供 --${option}`);
  };
  const result = {
    cordis: get('cordis-version', '@deepseek-ai/cordis'),
    tsdown: get('tsdown-version', 'tsdown'),
    typescript: get('typescript-version', 'typescript'),
    nodeTypes: get('node-types-version', '@types/node'),
  };
  if (kind === 'web') result.host = get('host-version', '@deepseek-ai/dsh-client-ui-renderer');
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string' || !/^[~^]?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`非法版本 ${key}: ${value}；只接受完整版本号或 ^ / ~ 范围`);
  }
  return result;
}

export function pluginTemplate(name, kind, versions) {
  const id = name.slice(4);
  const web = kind === 'web';
  const inputs = ['src', 'package.json', 'scripts/build.mjs', 'cordis.patch.yml', 'tsconfig.json', 'tsdown.config.mjs'];
  if (web) inputs.push('tsconfig.web.json');
  const repositoryInputs = ['tooling/build-manifest.mjs', 'tooling/build-manifest.d.mts', 'tooling/build.mjs', 'tooling/tsdown.mjs', 'tooling/tsdown.d.mts', 'tooling/tsconfig.base.json', 'tooling/tsconfig.node.json'];
  if (web) repositoryInputs.push('tooling/tsconfig.web.json');
  const peers = { '@deepseek-ai/cordis': `>=${versions.cordis.replace(/^[~^]/, '')}` };
  const dev = { '@deepseek-ai/cordis': versions.cordis, '@types/node': versions.nodeTypes, tsdown: versions.tsdown, typescript: versions.typescript };
  if (web) {
    peers['@deepseek-ai/dsh-client-ui-renderer'] = `>=${versions.host.replace(/^[~^]/, '')}`;
    dev['@deepseek-ai/dsh-client-ui-renderer'] = versions.host.replace(/^[~^]/, '');
  }
  const pkg = {
    name, version: '0.1.0', private: true, description: 'DeepSeek Harness 插件', type: 'module', main: './lib/index.js',
    exports: { '.': './lib/index.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json', ...(web ? { './client': './lib/client.js' } : {}) },
    files: ['lib', 'cordis.patch.yml', 'AGENTS.md'],
    engines: { node: '^22.19.0 || >=24.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, ...(web ? { client: { platform: 'web', inject: [] } } : {}), build: { manifest: './lib/dsh-build.json', inputs, outputs: ['lib'], repositoryInputs } },
    scripts: { build: 'node scripts/build.mjs', typecheck: `tsc -p tsconfig.json --noEmit${web ? ' && tsc -p tsconfig.web.json --noEmit' : ''}`, check: 'pnpm run typecheck && pnpm run build' },
    peerDependencies: peers, devDependencies: dev,
  };
  const files = {
    'package.json': json(pkg),
    '.gitignore': 'node_modules/\nlib/\n',
    'cordis.patch.yml': `- insert:\n    - id: ${id}\n      name: ${name}\n`,
    'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'\n\nexport const name = '${name}'\n\nexport function apply(ctx: Context): void {\n  ctx.logger(name).info('插件已加载')\n}\n`,
    'scripts/build.mjs': `import { buildPlugin } from '../../tooling/build.mjs';\n\nawait buildPlugin(import.meta.url);\n`,
    'tsconfig.json': json({ extends: '../tooling/tsconfig.node.json', compilerOptions: { types: ['node'] }, include: ['src'], ...(web ? { exclude: ['src/client'] } : {}) }),
    'tsdown.config.mjs': `import { ${web ? 'hostConfig, clientConfig' : 'hostConfig'} } from '../tooling/tsdown.mjs';\n\nexport default ${web ? `[hostConfig(), clientConfig({ id: '${name}', entry: { client: 'src/client/index.ts' } })]` : 'hostConfig()'};\n`,
    'AGENTS.md': `# ${name}\n\n这是${web ? '宿主与网页两部分' : '宿主'}插件的最简起点，尚无业务功能。\n\n- 在本目录独立安装依赖，再运行 \`pnpm run check\`。不在仓库根安装或合并依赖。\n- 开发源码需要相邻的 \`../tooling\`；构建后的单插件包运行不依赖仓库工具目录。\n- 首次安装产生锁文件后，将 \`pnpm-lock.yaml\` 加入 \`dsh.build.inputs\`。\n- 要挂到 profile，请按仓库运行维护约定通过 bundles 注册；不要再手写同 id 的 insert。\n- 当前模板不修改 profile、不安装依赖、不联网。新增业务先明确范围，再补测试。\n`,
  };
  if (web) {
    files['src/client/index.ts'] = `import type { Context } from '@deepseek-ai/cordis'\nimport type {} from '@deepseek-ai/dsh-client-ui-renderer/client'\n\nexport const name = '${name}/client'\n\nexport function apply(_ctx: Context): void {}\n`;
    files['tsconfig.web.json'] = json({ extends: '../tooling/tsconfig.web.json', compilerOptions: { types: ['node'] }, include: ['src/client'] });
  }
  return files;
}

export async function createPlugin({ root, name, kind, versions = {}, write = writeFileSync }) {
  if (typeof name !== 'string' || !/^dsh-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error('插件名必须为 dsh- 开头的小写短横线名称，如 dsh-example');
  if (!['host', 'web'].includes(kind)) throw new Error('--kind 必须是 host 或 web');
  root = resolve(root);
  if (!lstatSync(root).isDirectory()) throw new Error('仓库根必须是真实目录，不能是符号链接');
  const target = resolve(root, name);
  try { lstatSync(target); throw new Error(`目标已存在，拒绝覆盖：${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = pluginTemplate(name, kind, resolveVersions(root, kind, versions));
  const added = [];
  const record = (path, directory, stat) => added.push({ path, directory, dev: stat.dev, ino: stat.ino });
  try {
    mkdirSync(target);
    record(target, true, lstatSync(target));
    for (const [relative, content] of Object.entries(files)) {
      const path = resolve(target, relative);
      const ancestors = [];
      for (let dir = dirname(path); dir !== target; dir = dirname(dir)) ancestors.unshift(dir);
      for (const dir of ancestors) {
        if (added.some(item => item.path === dir)) continue;
        mkdirSync(dir);
        record(dir, true, lstatSync(dir));
      }
      const fd = openSync(path, 'wx');
      record(path, false, fstatSync(fd));
      try { write(fd, content, 'utf8'); } finally { closeSync(fd); }
    }
    return target;
  } catch (error) {
    const cleanupErrors = [];
    for (const item of added.reverse()) {
      try {
        const stat = lstatSync(item.path);
        if (stat.dev !== item.dev || stat.ino !== item.ino) continue;
        if (item.directory) rmdirSync(item.path); else unlinkSync(item.path);
      } catch (cleanup) {
        if (cleanup.code !== 'ENOENT') cleanupErrors.push(`${item.path}: ${cleanup.message}`);
      }
    }
    if (cleanupErrors.length) error.message += `\n清理未完成（保留非本次新增项）：${cleanupErrors.join('; ')}`;
    throw error;
  }
}
