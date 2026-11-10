import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {inspectBuild} from './build-manifest.mjs';
import {officialPlugins, presetDrift, loadedPresetComparisons} from './preset-drift.mjs';
const [runtime, profile, source, globalConfig] = process.argv.slice(2);
const require = createRequire(path.join(runtime, 'package.json'));
const yaml = require('yaml');
const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const anchor = path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const result = { version: boot.getDshRuntimeVersion(), bundles: [], entries: [], errors: {}, skipped: [] };
// 试启动要照抄这两项组合后的 config，只改端口和开浏览器（见 doctor.mjs 的 startupOverlay）。
const STARTUP_PINNED = new Set(['@deepseek-ai/dsh-host-webserver','@deepseek-ai/dsh-web-app']);
const readYaml = p => fs.existsSync(p) ? yaml.parse(fs.readFileSync(p, 'utf8')) : undefined;
const manifest = JSON.parse(fs.readFileSync(path.join(profile,'package.json'),'utf8'));
// Hosts before 0.2.1 have no profile exemptions; the App itself honors compatibility.json from 0.2.1 on.
const exemptions = typeof boot.readProfileVersionExemptions === 'function' ? boot.readProfileVersionExemptions(profile) : {};
/**
 * 本地插件宿主产物里运行时加载、却没写进 peerDependencies 的官方包。宿主只把声明为 peer 的包换成 App 自带的那份，
 * 没声明的会去插件自己的 node_modules 找：开发机装了开发依赖能跑，别的机器拉取后缺包就起不来。
 */
function undeclaredHostPeers(dir, m) {
  const peers = new Set(Object.keys(m.peerDependencies ?? {})), found = new Set();
  const lib = path.join(dir, 'lib');
  let files = [];
  try { files = fs.readdirSync(lib).filter(f => f.endsWith('.js') && !f.startsWith('client')); } catch { return []; }
  for (const f of files) {
    const t = fs.readFileSync(path.join(lib, f), 'utf8');
    for (const x of t.matchAll(/^import\s+(?!type\b)[^;]*?from\s*["'](@deepseek-ai\/[a-z0-9-]+)/gm)) found.add(x[1]);
    for (const x of t.matchAll(/import\(\s*["'](@deepseek-ai\/[a-z0-9-]+)/g)) found.add(x[1]);
    for (const x of t.matchAll(/import\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const c = new RegExp(`\\b${x[1].replace(/\$/g, '\\$')}\\s*=\\s*["'](@deepseek-ai\\/[a-z0-9-]+)`).exec(t);
      if (c) found.add(c[1]);
    }
  }
  return [...found].filter(n => !peers.has(n)).sort();
}
function clientRemoteInjection(source, m) {
  if (!/\bctx\.remote\b/.test(source)) return true;
  const graph = m.dsh?.client?.inject ?? [];
  if (!graph.includes('@deepseek-ai/dsh-client-connection')) return false;
  if (/exports\.inject\s*=\s*\[[^\]]*["']remote["']/.test(source)) return true;
  const name = /exports\.inject\s*=\s*([A-Za-z_$][\w$]*)/.exec(source)?.[1];
  if (!name) return false;
  const declaration = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  return declaration ? /["']remote["']/.test(declaration[1]) : false;
}
function target(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return target(value.default ?? value.import ?? value.require);
}
for (const name of manifest.dsh?.profile?.bundles ?? []) {
  const b = {name}; result.bundles.push(b);
  try {
    b.dir = boot.resolveBundleDir('doctor', name, anchor, profile);
    const m = JSON.parse(fs.readFileSync(path.join(b.dir,'package.json'),'utf8'));
    b.main = target(m.exports?.['.']) ?? m.main;
    b.mainExists = !b.main || fs.existsSync(path.join(b.dir,b.main));
    const spec=manifest.dependencies?.[name]??manifest.optionalDependencies?.[name]??manifest.devDependencies?.[name];
    b.link=typeof spec==='string'&&spec.startsWith('link:');
    b.buildDeclared=!!m.dsh?.build;
    b.presetDrift=m.dsh?.presetDrift;
    b.compatibility = boot.evaluatePluginCompatibility(m, exemptions, result.version);
    b.client = !!m.dsh?.client;
    if (b.client) {
      const entry = target(m.exports?.['./client']);
      b.clientEntry = entry;
      b.clientExists = !!entry && fs.existsSync(path.join(b.dir,entry));
      if (b.clientExists) {
        // Only instantiate the browser's closure factory, never apply its side effects.
        let definition;
        const define = d => {definition = d;};
        const context = vm.createContext({ __DSH_DEFINE__: define, window: {__DSH_DEFINE__: define, __ModuleLoader__: {load: define}} });
        try {
          const clientSource = fs.readFileSync(path.join(b.dir,entry),'utf8');
          b.clientRemoteInject = clientRemoteInjection(clientSource,m);
          vm.runInContext(clientSource,context,{timeout:1000});
          if (!definition?.factory) throw new Error('missing __DSH_DEFINE__ factory');
          b.clientShape = typeof definition.factory === 'function';
          if (!b.clientShape) b.clientError = 'missing closure factory';
        } catch(e) { b.clientShape = false; b.clientError = e.message; }
      }
    }
    if(b.link)b.build=await inspectBuild(b.dir,m.dsh?.build,[b.main,b.clientEntry]);
    if(b.link)b.undeclaredHostPeers=undeclaredHostPeers(b.dir,m);
  } catch(e) { b.error = e.message; }
}
try {
  const loaded = boot.loadProfileDirectory('doctor',profile,anchor);
  result.skipped = loaded.skippedBundles.map(b => ({name:b.packageName ?? b.name,reason:b.reason,detail:b.detail,compatibility:b.compatibility}));
  const comparisons = loadedPresetComparisons(result.bundles,result.skipped);
  if (comparisons.length) {
    try {
      const tags = [{tag: 'tag:yaml.org,2002:js', resolve: source => ({__js: source})}];
      const parse = p => yaml.parse(fs.readFileSync(p, 'utf8'), {customTags: tags});
      const web = boot.resolveBundleDir('doctor', '@deepseek-ai/dsh-web-app', anchor, profile);
      result.presetDrift = {problems: presetDrift(officialPlugins(parse(path.join(web, 'presets/ptc.patch.yml')), 'preset-ptc'), officialPlugins(parse(path.join(web, 'presets/cordis.patch.yml')), 'preset-cordis'))};
    } catch (e) { result.presetDrift = {problems: [`对照官方模式清单失败：${e.message}`]}; }
  }
  const context = {dir:profile,home:path.dirname(path.dirname(profile)),patchPath:loaded.patchPath,installAnchor:anchor,overlays:[],telemetryDisabledEnv:'1'};
  const all = [];
  const walk = entries => { for(const e of entries ?? []) { all.push({id:e.id,name:e.name,disabled:typeof e.disabled==='boolean'?e.disabled:null,...(STARTUP_PINNED.has(e.name)?{config:e.config??{}}:{})}); if(Array.isArray(e.config))walk(e.config); }};
  // Preserve nested IDs for individual diagnostics while host composition validates them.
  const composed=boot.composeEntries([boot.readProfilePatches('doctor',context,loaded)]);
  const validate=entries=>{const seen=new Set();for(const e of entries){if(e.id&&seen.has(e.id))throw new Error('duplicate loader entry id '+JSON.stringify(e.id)+' in composed profile scope');seen.add(e.id);if(e.group&&Array.isArray(e.config))validate(e.config);}};
  validate(composed);walk(composed);
  result.entries = all;
} catch(e) { result.errors.compose = e.message; }
try { result.modules = readYaml(path.join(source,'node_modules/.modules.yaml')); } catch(e){result.errors.modules=e.message;}
try { result.globalConfig = readYaml(globalConfig); } catch(e){result.errors.globalConfig=e.message;}
try { result.lock = readYaml(path.join(source,'pnpm-lock.yaml')); } catch(e){result.errors.lock=e.message;}
const secretValues=[];const collect=v=>{if(typeof v==='string'&&v.length>5)secretValues.push(v);else if(v&&typeof v==='object')for(const value of Object.values(v))collect(value);};
try{collect(readYaml(path.join(path.dirname(path.dirname(profile)),'.credentials.yaml')));}catch{}
result.secrets=secretValues;
console.log('DSH_DOCTOR_DATA:'+JSON.stringify(result));