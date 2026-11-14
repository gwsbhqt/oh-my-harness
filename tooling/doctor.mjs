import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const check = (id, ok, message, fix, extra = {}) => ({id,ok,message,...(fix?{fix}:{}),...extra});
export function redact(text,secrets=[]) {
  for(const value of [...new Set(secrets)].sort((a,b)=>b.length-a.length))if(value?.length>5)text=text.split(value).join('[REDACTED]');
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi,'$1[REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
}
export function modelAnswer(result) {
  if(!result.ok)return false;
  const finals=result.stdout.split('\n').flatMap(line=>{try{const v=JSON.parse(line);return v.type==='final'?[v]:[];}catch{return [];}});
  return finals.length===1&&finals[0].text?.trim()==='DSH_DOCTOR_OK';
}
export async function exists(p) { try { await fs.lstat(p); return true; } catch(e) {if(e.code==='ENOENT') return false; throw e;} }
export async function run(file,args,{env=process.env,cwd,timeoutMs=120000}={}) {
  return new Promise(resolve => {
    let stdout='',stderr='',overflow=false,timedOut=false,settled=false;
    const child=spawn(file,args,{env,cwd,detached:true,stdio:['ignore','pipe','pipe']});
    const stop=signal=>{try{process.kill(-child.pid,signal);}catch{}};
    const capture=key=>chunk=>{if((stdout.length+stderr.length)>8*1024*1024){overflow=true;stop('SIGTERM');return;}if(key==='stdout')stdout+=chunk;else stderr+=chunk;};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',capture('stdout')); child.stderr.on('data',capture('stderr'));
    const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');},timeoutMs);
    const hard=setTimeout(()=>stop('SIGKILL'),timeoutMs+3000);
    const finish=(code,signal,error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(hard);stop('SIGKILL');resolve({ok:code===0&&!timedOut&&!overflow&&!error,code,signal,timedOut,overflow,stdout,stderr,...(error?{error:error.message}:{})});};
    child.on('error',e=>finish(null,null,e)); child.on('close',(c,s)=>finish(c,s));
  });
}
/** 子进程没成功时的说明：超时、输出过多、进程没起来、退出码，排在程序输出前面。 */
export function failureText(result,budgetMs,label) {
  const cause=result.timedOut?`${label}没在整次检查的 ${Math.round(budgetMs/1000)} 秒时限内跑完，被停掉。下面是被停掉前的输出，里面的警告不一定是原因`
    :result.overflow?`${label}输出超过 8MB 被停掉`
    :result.error?`${label}没能启动：${result.error}`
    :result.code!==0?`${label}退出码 ${result.code}${result.signal?`（信号 ${result.signal}）`:''}`:'';
  return [cause,result.stderr,result.stdout].filter(s=>s&&s.trim()!=='').join('\n');
}
export function lockMismatch(manifest, lock, profileDir=process.cwd()) {
  const importer=lock?.importers?.['.']; if(!importer)return ['lockfile 缺少根 importer'];
  const issues=[];
  for(const section of ['dependencies','devDependencies','optionalDependencies']) {
    const requested=manifest[section]??{},locked=importer[section]??{};
    for(const key of new Set([...Object.keys(requested),...Object.keys(locked)])){
      const spec=requested[key],row=locked[key];
      if(spec!==row?.specifier)issues.push(`${section}.${key}: package=${spec??'<missing>'}, lock=${row?.specifier??'<missing>'}`);
      if(typeof spec==='string'&&spec.startsWith('link:')&&(typeof row?.version!=='string'||!row.version.startsWith('link:')||path.resolve(profileDir,spec.slice(5))!==path.resolve(profileDir,row.version.slice(5))))issues.push(`${section}.${key}: 本地插件路径不一致，package=${spec}, lock version=${row?.version??'<missing>'}`);
    }
  }
  return issues;
}
export function unverifiedBuilds(data) {
  return (data.bundles??[]).filter(b=>b.link&&!b.build?.ok&&(!b.buildDeclared||b.build?.status==='unverified')).map(b=>`${b.name} 构建一致性：${b.build?.message??'无法证明源码与产物一致'}`);
}
const flowYaml=v=>Array.isArray(v)?`[${v.map(flowYaml).join(', ')}]`
  :v&&typeof v==='object'?(typeof v.__jsExpr==='string'?`!!js ${JSON.stringify(v.__jsExpr)}`:`{${Object.entries(v).map(([k,x])=>`${JSON.stringify(k)}: ${flowYaml(x)}`).join(', ')}}`)
  :JSON.stringify(v);
/**
 * 试启动的补丁。补丁会整块替换条目的 config，所以网页服务和网页入口照抄实际组合出的 config，只把端口换成随机、不开浏览器；
 * 用户补丁漏掉的必填项照样缺着，试启动才会和真实启动一样失败（2026-10-21 webserver 缺 host 曾被这里写死的 host 盖住）。
 */
export function startupOverlay(entries,readyProbe) {
  const pinned={'@deepseek-ai/dsh-host-webserver':{port:0},'@deepseek-ai/dsh-web-app':{openBrowser:false}};
  let patch='';
  for(const e of entries)if(pinned[e.name])patch+=`- id: ${JSON.stringify(e.id)}\n  config: ${flowYaml({...e.config,...pinned[e.name]})}\n`;
  // Desktop surface cannot start inside CLI; web keeps host plugins intact without launching another GUI.
  for(const e of entries)if(e.name==='@deepseek-ai/dsh-desktop-app')patch+=`- id: ${JSON.stringify(e.id)}\n  disabled: true\n`;
  return patch+`- insert:\n    - id: doctor-ready-probe\n      name: ${JSON.stringify(readyProbe)}\n`;
}
export function inspectData(data,manifest,expectedStore,profileDir=process.cwd()) {
  const checks=[];
  checks.push(check('profile-compose',!data.errors.compose,data.errors.compose??'实际 App 已组合所有 profile 层', '修正 profile 补丁；同 id 只保留一个 insert'));
  const duplicateMessage=data.errors.compose?.includes('duplicate')?data.errors.compose:'';
  checks.push(check('duplicate-entry-ids',!duplicateMessage,duplicateMessage||'组合后的 loader id 唯一','bundle 已注册的 id 不要再次 insert'));
  checks.push(check('bundles-active',!data.skipped?.length,data.skipped?.length?JSON.stringify(data.skipped):'没有 bundle 被 App 静默跳过','修复被跳过 bundle 的依赖、补丁或 peer 范围'));
  const broken=(data.bundles??[]).filter(b=>b.error||!b.mainExists);
  checks.push(check('bundle-artifacts',!broken.length,broken.length?broken.map(b=>`${b.name}: ${b.error??'入口产物缺失 '+b.main}`).join('; '):'所有 bundle 与宿主入口产物可读','在相应插件目录运行 pnpm run check；修复断链或缺失依赖'));
  const declared=(data.bundles??[]).filter(b=>b.link&&b.buildDeclared);
  if(declared.length){
    const bad=declared.filter(b=>!b.build?.ok);
    const details=declared.map(b=>({name:b.name,...b.build}));
    const message=bad.length?bad.map(b=>`${b.name}: ${b.build?.message??'无法证明构建一致'}`).join('; ')+`；另有 ${declared.length-bad.length} 项构建一致`:`${declared.length} 项本地插件的源码与产物内容清单一致`;
    checks.push(check('link-build-freshness',!bad.length,message,'在会话空闲后运行自动补齐构建并复验；不要只 touch 文件或伪造清单',{status:bad.some(b=>b.build?.status==='unverified')?'unverified':bad.length?'stale':'verified',details}));
  }
  const missingPeers=(data.bundles??[]).filter(b=>b.link&&b.undeclaredHostPeers?.length);
  checks.push(check('link-host-peers',!missingPeers.length,missingPeers.length?missingPeers.map(b=>`${b.name}: ${b.undeclaredHostPeers.join('、')}`).join('; '):'本地插件运行时加载的官方包都已声明为 peer','把这些包加进插件的 peerDependencies（含预发布版的下限），宿主才会用 App 自带的那份；只装在开发依赖里，别的机器拉取后会缺包'));
  const peers=(data.bundles??[]).filter(b=>b.compatibility&&!b.compatibility.exempted),exempted=(data.bundles??[]).filter(b=>b.compatibility?.exempted);
  const exemptedText=exempted.length?`；已按 profile 的 compatibility.json 放行：${exempted.map(b=>`${b.compatibility.name}@${b.compatibility.version}`).join('、')}`:'';
  checks.push(check('dsh-peer-ranges',!peers.length,peers.length?JSON.stringify(peers.map(b=>({name:b.name,...b.compatibility}))):`所有 dsh peer 支持 App ${data.version}${exemptedText}`,'将 dsh peer 改为支持实际 App 预发布版的下限并验证；不要只改 npm 版本'));
  const clients=(data.bundles??[]).filter(b=>b.client&&(!b.clientExists||!b.clientShape||b.clientRemoteInject===false));
  checks.push(check('client-artifacts',!clients.length,clients.length?clients.map(b=>`${b.name}: ${b.clientError??(b.clientRemoteInject===false?'使用 ctx.remote 但缺少连接组件或 remote 注入声明':'缺失 ./client 入口')}`).join('; '):'客户端打包入口、外壳及 remote 注入声明通过；apply/组件/实际激活仍须在 GUI 验证','修复 ./client 产物、apply 导出与注入声明；实际浏览器 React #130 不能由此静态检查排除'));
  const stored=data.modules?.storeDir;
  checks.push(check('pnpm-store-path',!data.errors.modules&&typeof stored==='string'&&stored===expectedStore, data.errors.modules??`安装记录=${stored??'<missing>'}；Dock 规范期望=${expectedStore}（按路径字符串比较，不取 realpath）`,'用 App 自带 pnpm 在具体 profile 目录重装，CI=true，必要时 --force；供应链阻止则保留失败，放宽须用户另行授权'));
  checks.push(check('pnpm-global-store-dir',!data.errors.globalConfig&&!Object.hasOwn(data.globalConfig??{},'storeDir'),data.errors.globalConfig??(data.globalConfig?.storeDir!==undefined?`全局 config.yaml 覆盖 storeDir: ${data.globalConfig.storeDir}`:'全局配置未覆盖 storeDir'),'删除全局 storeDir；不要写 ~ 或 $HOME 字面值'));
  const mismatch=data.errors.lock?[data.errors.lock]:lockMismatch(manifest,data.lock,profileDir);
  checks.push(check('lockfile-manifest',!mismatch.length,mismatch.length?mismatch.join('; '):'锁文件 specifier 和本地插件目标与 package.json 一致','新增或改依赖后在具体 profile 目录用 App pnpm CI=true install --no-frozen-lockfile'));
  return checks;
}
/** PTC 创造模式继承不到的官方改动只列为未验证，不挡启动和重启：要人判断要不要跟进，不是启动故障。 */
export function presetDriftCheck(data) {
  const drift=data.presetDrift;
  if(!drift)return {};
  if(drift.problems?.length)return {unverified:`PTC 创造模式有继承不到的官方改动：${drift.problems.join('；')}。请检查已加载插件声明的派生模式调整规则`};
  return {check:check('preset-ptc-cordis',true,'PTC 创造模式继承创造模式；DSH 自带 PTC 模式没有创造模式缺的东西')};
}
/** App 自带 pnpm 的位置：0.2.1 起在 primary-runtime/dependencies/pnpm，之前在 runtime/pnpm。 */
export async function appPnpm(app) {
  for(const rel of ['Contents/Resources/runtime/primary-runtime/dependencies/pnpm','Contents/Resources/runtime/pnpm']){
    const dir=path.join(app,rel);
    if(await exists(path.join(dir,'bin/pnpm.mjs')))return {bin:path.join(dir,'bin/pnpm.mjs'),dist:path.join(dir,'dist/pnpm.mjs')};
  }
  return undefined;
}
export async function profilePatchCheck(profileDir) {
  const file=path.join(profileDir,'cordis.patch.yml');
  try {
    const entry=await fs.lstat(file);
    const target=await fs.stat(file).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    const ok=target?.isFile()===true;
    return check('profile-patch-target',ok,ok?'用户补丁可读，链接目标存在':`${file} ${entry.isSymbolicLink()?'链接目标不存在':'不是普通文件'}`,'先恢复完整补丁并切换链接，再删除旧文件；用你的配置部署工具恢复链接');
  } catch(error) {
    if(error.code==='ENOENT')return check('profile-patch-target',true,'未设置用户补丁，使用 bundle 默认配置');
    throw error;
  }
}
export async function singletonCheck(home,userHome,alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}) {
  const roots=[home,path.join(userHome,'Library/Application Support/DeepSeek Harness')];const locks=[];
  for(const root of roots)for(const suffix of ['SingletonLock','electron/SingletonLock','desktop/SingletonLock']){
    const p=path.join(root,suffix);if(!await exists(p))continue;
    let target;try{target=await fs.readlink(p);}catch{target=await fs.readFile(p,'utf8');}
    const match=target.trim().match(/^(.*)-(\d+)$/);const pid=match?Number(match[2]):null;
    const local=match&&match[1]===os.hostname();
    locks.push({path:p,target,pid,stale:!!local&&!alive(pid),uncertain:!local});
  }
  const bad=locks.filter(l=>l.stale||l.uncertain);
  return check('singleton-lock',!bad.length,bad.length?JSON.stringify(bad):'未发现失效 SingletonLock（运行中的锁不算故障）','确认 App 已完全退出、锁对应进程不存在后再移除失效锁');
}
function policy(temp,full) {
  const roots=[temp,path.resolve(temp)];
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${roots.map(p=>`(subpath ${JSON.stringify(p)})`).join(' ')} (literal "/dev/null"))${full?'':'(deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*")) (allow network* (local unix-socket (subpath '+JSON.stringify(temp)+')))'}`;
}
export async function doctor(options={}) {
  const started=Date.now(),home=path.resolve(options.home??process.env.DSH_HOME??path.join(os.homedir(),'.dsh'));
  const profile=options.profile??'desktop',app=path.resolve(options.app??'/Applications/DeepSeek Harness.app');
  const checks=[],buildUnverified=[],userHome=os.homedir(),timeoutMs=options.timeoutMs??120000,secrets=Object.entries(process.env).filter(([k])=>/token|secret|password|api.?key|authorization/i.test(k)).map(([,v])=>v).filter(v=>v.length>5);
  const done=()=>JSON.parse(redact(JSON.stringify({ok:checks.every(c=>c.ok),checks,home,profile,app,elapsedMs:Date.now()-started,full:!!options.full,guiValidated:false,unverified:[...buildUnverified,'客户端实际 GUI 激活与渲染',...(!options.full?['远程供应链发布日期政策（需要 --full 联网验证）']:[])]}),secrets));
  if(!/^[a-zA-Z0-9_-]+$/.test(profile)||!Number.isInteger(timeoutMs)||timeoutMs<1000){checks.push(check('options',false,'profile 必须为单一名称，timeoutMs 必须为至少 1000 的整数'));return done();}
  const original=path.join(home,'profiles',profile),credentials=path.join(home,'.credentials.yaml');
  try {
    if(await exists(credentials)){
      const stat=await fs.stat(credentials);let mode=stat.mode&0o7777;
      if(options.repairCredentials&&stat.isFile()&&mode!==0o600){await fs.chmod(credentials,0o600);mode=(await fs.stat(credentials)).mode&0o7777;}
      checks.push(check('credentials-mode',stat.isFile()&&mode===0o600,`凭据权限 ${mode.toString(8)}${options.repairCredentials?'（已获显式修复授权）':''}`,'显式传 --repair-credentials 只修成 600；不改内容'));
    }else checks.push(check('credentials-mode',true,'未配置凭据文件'));
    const risk=process.env.ELECTRON_RUN_AS_NODE==='1';
    checks.push(check('electron-run-as-node',!risk||!!options.sanitizeEnv,risk?(options.sanitizeEnv?'检测到 ELECTRON_RUN_AS_NODE=1；隔离子进程环境已清理，CLI包装器仅为内部Node执行重新设置':'ELECTRON_RUN_AS_NODE=1 会使 App 以 Node 而不是 GUI 启动'):'未继承 ELECTRON_RUN_AS_NODE=1','启动 GUI 前 unset ELECTRON_RUN_AS_NODE；dsh-use sanitized 入口可用 --sanitize-env'));
    checks.push(check('profiles-node-modules',!await exists(path.join(home,'profiles/node_modules')),'profiles 父目录不应安装 node_modules','在具体 profiles/<profile> 中安装；确认误装目录后清理'));
    checks.push(await singletonCheck(home,userHome));
    checks.push(await profilePatchCheck(original));
    const cli=path.join(app,'Contents/Resources/runtime/cli/bin/dsh'),electron=path.join(app,'Contents/MacOS',path.basename(app,'.app')),runtime=path.join(app,'Contents/Resources/app.asar/dsh');
    if(!await exists(cli)||!await exists(electron)){checks.push(check('app-runtime',false,`缺少实际 App CLI 或 Electron: ${app}`));return done();}
    if(process.platform!=='darwin'||!await exists('/usr/bin/sandbox-exec')){checks.push(check('isolation',false,'需要 macOS sandbox-exec 保证共享依赖与真实全局目录只读'));return done();}
    const manifest=JSON.parse(await fs.readFile(path.join(original,'package.json'),'utf8'));
    const temp=await fs.realpath(await fs.mkdtemp('/tmp/dsh-doc-'));await fs.chmod(temp,0o700);
    try {
      const isolated=path.join(temp,'home'),copy=path.join(isolated,'profiles','probe');await fs.mkdir(copy,{recursive:true});
      for(const name of ['package.json','cordis.yml','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml','compatibility.json'])if(await exists(path.join(original,name)))await fs.copyFile(path.join(original,name),path.join(copy,name));
      for(const name of ['.env','cordis.patch.yml'])if(await exists(path.join(home,name)))await fs.copyFile(path.join(home,name),path.join(isolated,name));
      if(await exists(credentials)){await fs.copyFile(credentials,path.join(isolated,'.credentials.yaml'));await fs.chmod(path.join(isolated,'.credentials.yaml'),0o600);}
      if(await exists(path.join(original,'node_modules'))){
        const modules=path.join(copy,'node_modules');await fs.mkdir(modules);
        for(const entry of await fs.readdir(path.join(original,'node_modules'),{withFileTypes:true})){const source=path.join(original,'node_modules',entry.name);if(entry.name.startsWith('@')&&entry.isDirectory()){await fs.mkdir(path.join(modules,entry.name));for(const child of await fs.readdir(source))await fs.symlink(path.join(source,child),path.join(modules,entry.name,child));}else await fs.symlink(source,path.join(modules,entry.name));}
      }
      const env={...process.env,DSH_HOME:isolated,DSH_TELEMETRY_DISABLED:'1',TMPDIR:temp,CI:'true'};delete env.ELECTRON_RUN_AS_NODE;delete env.DSH_WEB_URL;
      const execute=(file,args,more={})=>run('/usr/bin/sandbox-exec',['-p',policy(temp,!!options.full),file,...args],{env,cwd:copy,...more,timeoutMs:Math.max(1,timeoutMs-(Date.now()-started))});
      const probe=await execute(electron,['--expose-internals',path.join(here,'app-probe.mjs'),runtime,copy,original,path.join(userHome,'Library/Preferences/pnpm/config.yaml')],{env:{...env,ELECTRON_RUN_AS_NODE:'1'}});
      const line=probe.stdout.split('\n').find(l=>l.startsWith('DSH_DOCTOR_DATA:'));
      if(!probe.ok||!line){checks.push(check('app-inspection',false,failureText(probe,timeoutMs,'App 组合探针')||'App 组合探针无结果',undefined,{exitCode:probe.code,timedOut:probe.timedOut}));return done();}
      const data=JSON.parse(line.slice('DSH_DOCTOR_DATA:'.length));secrets.push(...(data.secrets??[]));delete data.secrets;
      const located=await appPnpm(app);
      if(!located){checks.push(check('app-pnpm',false,`App 里找不到自带的 pnpm（primary-runtime/dependencies/pnpm 和旧的 runtime/pnpm 都没有）：${app}`,'App 换了打包布局：在 App 的 Contents/Resources/runtime 下找 pnpm/bin/pnpm.mjs，把新位置加进 appPnpm'));return done();}
      const pnpm=located.bin;
      const dockEnv={HOME:userHome,PATH:process.env.PATH,CI:'true',TMPDIR:temp,PNPM_HOME:path.join(userHome,'Library/pnpm')};
      const pnpmSource=await fs.readFile(located.dist,'utf8');
      const storeVersion=pnpmSource.match(/STORE_VERSION = "(v[0-9]+)"/)?.[1];
      if(!storeVersion)throw new Error('App pnpm STORE_VERSION 无法读取');
      const expectedStore=path.join(userHome,'Library/pnpm/store',storeVersion);
      buildUnverified.push(...unverifiedBuilds(data));
      const presetCheck=presetDriftCheck(data);
      if(presetCheck.unverified)buildUnverified.push(presetCheck.unverified);
      if(presetCheck.check)checks.push(presetCheck.check);
       checks.push(...inspectData(data,manifest,expectedStore,original));
      const terminalStore=path.join(process.env.PNPM_HOME??(process.env.XDG_DATA_HOME?path.join(process.env.XDG_DATA_HOME,'pnpm'):path.join(userHome,'Library/pnpm')),'store',storeVersion);
      checks.push(check('pnpm-terminal-store',terminalStore===expectedStore,`终端=${terminalStore}；Dock规范期望=${expectedStore}（App pnpm getDataDir 优先 PNPM_HOME，然后 XDG_DATA_HOME）`,'macOS shell 导出 PNPM_HOME=$HOME/Library/pnpm；全局 config.yaml 不要设置 storeDir'));
      // pnpm only sees a separate lockfile project; it never sees shared node_modules.
      const frozen=path.join(temp,'frozen');await fs.mkdir(frozen);
      for(const name of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml'])if(await exists(path.join(original,name)))await fs.copyFile(path.join(original,name),path.join(frozen,name));
      if(options.full){
        const fm=structuredClone(manifest),fl=structuredClone(data.lock);
        for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const [name,spec] of Object.entries(fm[section]??{}))if(spec.startsWith('link:')){const absolute='link:'+path.resolve(original,spec.slice(5));fm[section][name]=absolute;fl.importers['.'][section][name]={specifier:absolute,version:absolute};}
        await fs.writeFile(path.join(frozen,'package.json'),JSON.stringify(fm));await fs.writeFile(path.join(frozen,'pnpm-lock.yaml'),JSON.stringify(fl));
        const verify=await execute(process.execPath,[pnpm,'install','--lockfile-only','--frozen-lockfile','--ignore-scripts','--fetch-retries=0','--fetch-timeout=15000'],{cwd:frozen,env:{...dockEnv,ELECTRON_RUN_AS_NODE:'1',...Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)))}});
        checks.push(check('pnpm-frozen-lockfile',verify.ok,verify.ok?'App pnpm 冻结及真实供应链政策验证通过':failureText(verify,timeoutMs,'冻结安装'),'在具体 profile 修复锁文件或供应链策略；供应链拒绝时等待满足政策或由用户另行授权，不自动放宽',{exitCode:verify.code,timedOut:verify.timedOut}));
      }
      const overlay=path.join(temp,'startup.patch.yml');
      const patch=startupOverlay(data.entries,path.join(here,'ready-probe.mjs'));
      await fs.writeFile(overlay,patch);
      const startup=await execute(cli,['--profile','probe','--patch',overlay]);
      checks.push(check('isolated-startup',startup.ok&&startup.stdout.includes('DSH_DOCTOR_READY:'),startup.ok&&startup.stdout.includes('DSH_DOCTOR_READY:')?'实际 App CLI 已完成宿主挂载与启动审计；未调用模型':failureText(startup,timeoutMs,'试启动'),startup.timedOut?'试启动超过时限被停掉，输出里的警告多半不是原因：先用 dsh-use doctor --timeout-ms 300000 重查；放宽后通过就是启动变慢，查是哪个插件拖慢了启动':'修复启动日志中的根因；显式 disabled 条目不当成静默禁用',{exitCode:startup.code,timedOut:startup.timedOut}));
      if(options.full){
        const fullManifest=structuredClone(manifest);fullManifest.dsh.profile.bundles=fullManifest.dsh.profile.bundles.filter(n=>n!=='@deepseek-ai/dsh-desktop-app'&&n!=='@deepseek-ai/dsh-web-app');fullManifest.dsh.profile.bundles.push('@deepseek-ai/dsh-headless');await fs.writeFile(path.join(copy,'package.json'),JSON.stringify(fullManifest));
        const fullOverlay=path.join(temp,'model.patch.yml');await fs.writeFile(fullOverlay,patch.split('- insert:')[0]);
        const full=await execute(cli,['--profile','probe','--patch',fullOverlay,'--json','只回复：DSH_DOCTOR_OK']);
        const answer=modelAnswer(full);
        checks.push(check('model-roundtrip',answer,answer?'单次模型请求通过':failureText(full,timeoutMs,'模型请求')||'没有收到 DSH_DOCTOR_OK 回答','检查模型选择、凭据与网络',{exitCode:full.code,timedOut:full.timedOut}));
      }
    }finally{await fs.rm(temp,{recursive:true,force:true});}
  }catch(e){checks.push(check('doctor-error',false,e.message));}
  return done();
}
