import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {snapshotBuild} from '../build-manifest.mjs';
import {doctor,inspectData,startupOverlay,lockMismatch,singletonCheck,run,redact,modelAnswer,unverifiedBuilds,failureText,appPnpm,profilePatchCheck} from '../doctor.mjs';
import {app,electron,runtime,available,root,manifest,good,get,probe,startupFixture} from '../test-support/doctor-fixture.mjs';
for(const [id,mutate] of [
 ['duplicate-entry-ids',d=>{d.errors.compose='duplicate loader entry id "fixture"';}],
 ['bundles-active',d=>{d.skipped=[{name:'fixture',reason:'missing'}];}],
 ['bundle-artifacts',d=>{d.bundles[0].mainExists=false;}],
 ['bundle-artifacts',d=>{d.bundles[0].error='broken symlink';}],
 ['dsh-peer-ranges',d=>{d.bundles[0].compatibility={peers:{'@deepseek-ai/dsh-tools':'^0.1.7'}};}],
 ['client-artifacts',d=>{d.bundles[0].clientExists=false;}],
 ['client-artifacts',d=>{d.bundles[0].clientShape=false;}],
 ['client-artifacts',d=>{d.bundles[0].clientRemoteInject=false;}],
 ['link-host-peers',d=>{d.bundles[0].link=true;d.bundles[0].undeclaredHostPeers=['@deepseek-ai/dsh-tool-executor-ptc'];}],
 ['pnpm-store-path',d=>{d.modules.storeDir='/tmp/example/.local/share/pnpm/store/v11';}],
 ['pnpm-global-store-dir',d=>{d.globalConfig.storeDir='~/.local/share/pnpm/store';}],
 ['lockfile-manifest',d=>{d.lock.importers['.'].dependencies.fixture.specifier='1.0.0';}],
])test(id+' 成对报告',()=>{assert.equal(get(good(),id).ok,true);const bad=good();mutate(bad);assert.equal(get(bad,id).ok,false);});
test('dsh-peer-ranges 精确版本放行算通过并写明，未放行失败',()=>{const issue={name:'fixture',version:'1.0.0',runtimeVersion:'0.2.1-rc.2',requirements:{'@deepseek-ai/dsh-tools':'^0.1.7'}};const a=good();a.bundles[0].compatibility={...issue,exempted:true};const ok=get(a,'dsh-peer-ranges');assert.equal(ok.ok,true);assert.match(ok.message,/放行：fixture@1\.0\.0/);const b=good();b.bundles[0].compatibility={...issue,exempted:false};assert.equal(get(b,'dsh-peer-ranges').ok,false);});
test('默认离线明确不验证远程政策',async()=>{const r=await doctor({app:'/missing',home:root,sanitizeEnv:true});assert.equal(r.full,false);assert.equal(r.guiValidated,false);assert(r.unverified.some(v=>v.includes('供应链')));});
test('凭据精确600及显式修复',async()=>{
 const home=path.join(root,'credentials');await fs.mkdir(home);const p=path.join(home,'.credentials.yaml');await fs.writeFile(p,'key: harmless-fixture',{mode:0o644});
 const call=repairCredentials=>doctor({home,app:'/missing',sanitizeEnv:true,repairCredentials});
 assert.equal((await call(false)).checks.find(c=>c.id==='credentials-mode').ok,false);assert.equal((await fs.stat(p)).mode&0o777,0o644);
 assert.equal((await call(true)).checks.find(c=>c.id==='credentials-mode').ok,true);assert.equal((await fs.stat(p)).mode&0o777,0o600);
 assert.equal((await fs.readFile(p,'utf8')),'key: harmless-fixture');
 await fs.chmod(p,0o400);assert.equal((await call(false)).checks.find(c=>c.id==='credentials-mode').ok,false);
});
test('用户补丁链接：完整目标通过，删除目标后失败，切到统一配置后恢复',async()=>{
 const profile=path.join(root,'patch-target');await fs.mkdir(profile);
 const patch=path.join(profile,'cordis.patch.yml'),old=path.join(profile,'cordis.patch.previous.yml'),unified=path.join(profile,'cordis.patch.main.yml');
 await fs.writeFile(old,'[]');await fs.symlink(path.basename(old),patch);
 assert.equal((await profilePatchCheck(profile)).ok,true);
 await fs.unlink(old);const broken=await profilePatchCheck(profile);assert.equal(broken.ok,false);assert.match(broken.message,/链接目标不存在/);
 await fs.writeFile(unified,'[]');await fs.unlink(patch);await fs.symlink(path.basename(unified),patch);
 assert.equal((await profilePatchCheck(profile)).ok,true);
 await fs.unlink(patch);assert.equal((await profilePatchCheck(profile)).ok,true,'没有用户补丁的普通 profile 仍合法');
});
test('profiles 父目录误装成对检查',async()=>{const home=path.join(root,'parent');await fs.mkdir(path.join(home,'profiles'),{recursive:true});let r=await doctor({home,app:'/missing',sanitizeEnv:true});assert.equal(r.checks.find(c=>c.id==='profiles-node-modules').ok,true);await fs.mkdir(path.join(home,'profiles/node_modules'));r=await doctor({home,app:'/missing',sanitizeEnv:true});assert.equal(r.checks.find(c=>c.id==='profiles-node-modules').ok,false);});
test('Electron环境污染必须显式sanitized',async()=>{const prev=process.env.ELECTRON_RUN_AS_NODE;process.env.ELECTRON_RUN_AS_NODE='1';try{const a=await doctor({home:root,app:'/missing'});const b=await doctor({home:root,app:'/missing',sanitizeEnv:true});assert.equal(a.checks.find(c=>c.id==='electron-run-as-node').ok,false);assert.equal(b.checks.find(c=>c.id==='electron-run-as-node').ok,true);}finally{if(prev===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=prev;}});
test('SingletonLock 成对进程检查',async()=>{const home=path.join(root,'singleton');await fs.mkdir(home);await fs.symlink(os.hostname()+'-1234',path.join(home,'SingletonLock'));assert.equal((await singletonCheck(home,root,()=>true)).ok,true);assert.equal((await singletonCheck(home,root,()=>false)).ok,false);});
test('App 自带 pnpm 新旧布局成对：0.2.1 新位置优先、旧位置可用、都没有时报缺',async()=>{
 const layout=async(name,rels)=>{const a=path.join(root,'pnpm-'+name);for(const rel of rels){await fs.mkdir(path.join(a,rel,'bin'),{recursive:true});await fs.writeFile(path.join(a,rel,'bin/pnpm.mjs'),'');}return a;};
 const fresh='Contents/Resources/runtime/primary-runtime/dependencies/pnpm',legacy='Contents/Resources/runtime/pnpm';
 const both=await layout('both',[fresh,legacy]);assert.deepEqual(await appPnpm(both),{bin:path.join(both,fresh,'bin/pnpm.mjs'),dist:path.join(both,fresh,'dist/pnpm.mjs')});
 const old=await layout('old',[legacy]);assert.equal((await appPnpm(old)).bin,path.join(old,legacy,'bin/pnpm.mjs'));
 assert.equal(await appPnpm(await layout('none',[])),undefined);
 if(available)assert.ok(await appPnpm(app),'本机 App 的 pnpm 必须找得到');
});
test('同名但不同scope不误判',()=>{const d=good();d.entries=[{id:'reused'},{id:'reused'}];assert.equal(get(d,'duplicate-entry-ids').ok,true);});
test('锁文件新增删除与dev spec漂移',()=>{assert.equal(lockMismatch({devDependencies:{x:'1'}},{importers:{'.':{}}}).length,1);assert.equal(lockMismatch({},{}).length,1);});
test('模型只接受真实final回答，不接受echo prompt',()=>{assert.equal(modelAnswer({ok:true,stdout:'DSH_DOCTOR_OK'}),false);assert.equal(modelAnswer({ok:true,stdout:JSON.stringify({type:'user',text:'DSH_DOCTOR_OK'})}),false);assert.equal(modelAnswer({ok:true,stdout:JSON.stringify({type:'final',text:'DSH_DOCTOR_OK'})}),true);assert.equal(modelAnswer({ok:false,stdout:JSON.stringify({type:'final',text:'DSH_DOCTOR_OK'})}),false);});
test('日志脱敏',()=>{assert.equal(redact('secret-text Bearer abcdef sk-abcdefghijklmnop',['secret-text']),'[REDACTED] Bearer [REDACTED] [REDACTED]');});
test('子进程timeout与真实exit code',async()=>{let r=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100});assert.equal(r.timedOut,true);assert.equal(r.ok,false);r=await run(process.execPath,['-e','process.exit(3)']);assert.equal(r.code,3);assert.equal(r.ok,false);});
// 2026-10-14 试启动 120 秒超时被停掉，报告只剩一条 Node 废弃警告，会话照着警告查了 35 步才发现是超时。
test('子进程失败说明：超时排在输出前面，正常退出码与输出过多成对',async()=>{
 const slow=await run(process.execPath,['-e','process.emitWarning("fs.Stats constructor is deprecated","DeprecationWarning","DEP0180");setInterval(()=>{},1000)'],{timeoutMs:300});
 assert.equal(slow.timedOut,true);
 const text=failureText(slow,120000,'试启动');
 assert.match(text.split('\n')[0],/试启动没在整次检查的 120 秒时限内跑完/);assert.match(text,/DEP0180/);
 const exit=await run(process.execPath,['-e','console.error("boom");process.exit(3)']);
 const exitText=failureText(exit,120000,'试启动');assert.doesNotMatch(exitText,/时限/);assert.match(exitText.split('\n')[0],/退出码 3/);assert.match(exitText,/boom/);
 assert.match(failureText({ok:false,code:null,timedOut:false,overflow:true,stdout:'',stderr:''},120000,'试启动'),/超过 8MB/);
 assert.equal(failureText({ok:true,code:0,timedOut:false,overflow:false,stdout:'',stderr:''},120000,'试启动'),'');
});
test('真实App link构建新旧成对profile：TS与Python混跑',{skip:!available},async()=>{
  const fresh=await probe('build-good',{linkBuild:'fresh'});assert.equal(get(fresh,'link-build-freshness')?.ok,true);
  for(const kind of ['ts-stale','python-stale']){const stale=await probe('build-'+kind,{linkBuild:kind});const c=get(stale,'link-build-freshness');assert.equal(c?.ok,false);assert.match(c.message,kind==='ts-stale'?/src\/index.ts/:/python\/bootstrap.py/);}
});
test('真实App共用构建输入正常、变化、缺失成对profile',{skip:!available},async()=>{
  const fresh=await probe('repository-good',{linkBuild:'repository-fresh'});assert.equal(get(fresh,'link-build-freshness')?.status,'verified');
  for(const kind of ['stale','missing']) {
    const bad=await probe('repository-'+kind,{linkBuild:'repository-'+kind}),check=get(bad,'link-build-freshness');
    assert.equal(check?.ok,false);assert.equal(check?.status,kind==='stale'?'stale':'unverified');assert.match(check.message,/tooling/);
  }
});
test('真实App link未声明协议只列未验证' ,{skip:!available},async()=>{const data=await probe('build-legacy',{linkBuild:'legacy'});assert.equal(get(data,'link-build-freshness'),undefined);assert.equal(unverifiedBuilds(data).length,1);assert.match(unverifiedBuilds(data)[0],/未声明/);});
test('真实App link缺manifest不假green',{skip:!available},async()=>{const data=await probe('build-missing',{linkBuild:'missing'});const c=get(data,'link-build-freshness');assert.equal(c?.ok,false);assert.equal(c.status,'unverified');});
test('真实App正常与旧peer停用fixture',{skip:!available},async()=>{const a=await probe('peer-good'),b=await probe('peer-bad',{peer:'^0.1.7-rc.2'});assert.equal(a.bundles[0].compatibility,undefined);assert.equal(b.bundles[0].compatibility.runtimeVersion,b.version);assert(b.skipped.length);assert.equal(b.bundles[0].compatibility.exempted,false);const c=await probe('peer-exempt',{peer:'^0.1.7-rc.2',exempt:b.version});assert.equal(c.bundles[0].compatibility.exempted,true);assert.equal(c.skipped.length,0);assert.equal(get(c,'dsh-peer-ranges').ok,true);});
test('真实App缺包与缺lib fixture',{skip:!available},async()=>{assert((await probe('missing',{missing:true})).bundles[0].error);assert.equal((await probe('missing-lib',{main:false})).bundles[0].mainExists,false);assert.equal((await probe('present-lib')).bundles[0].mainExists,true);});
test('真实App duplicate与不同scope fixture',{skip:!available},async()=>{assert.match((await probe('duplicate',{duplicate:true})).errors.compose,/duplicate/);assert.equal((await probe('scope-good',{scopes:true})).errors.compose,undefined);});

test('实际App启动审计：正常、apply抛错、依赖服务缺失',{skip:!available},async()=>{
 const good=await startupFixture('healthy','export function apply(){}');assert.equal(good.ok,true,good.stderr);assert.match(good.stdout,/DSH_DOCTOR_READY:/);
 for(const [label,source] of [['throw','export function apply(){throw Error("fixture apply failed")}'],['inject','export const inject=["fixtureMissingService"];export function apply(){}']]){const bad=await startupFixture(label,source);assert.equal(bad.ok,false,bad.stdout+bad.stderr);assert.match(bad.stdout,/"ready":false/);}
});
// 2026-10-21 profile 补丁给 webserver 只写了 port，整块替换掉 App 自带的 host，桌面端起不来；试启动曾用写死的 host 盖住它。
test('实际App启动审计：webserver 补丁漏 host 与写全成对',{skip:!available},async()=>{
  const bad=await startupFixture('web-port-only','export function apply(){}',false,'','- id: webserver\n  config:\n    port: 3080\n');
  assert.equal(bad.ok,false,bad.stdout+bad.stderr);assert.match(bad.stdout+bad.stderr,/host missing required value/);
  const good=await startupFixture('web-full','export function apply(){}',false,'','- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3080\n');
  assert.equal(good.ok,true,good.stderr);assert.match(good.stdout,/DSH_DOCTOR_READY:/);
});
// 条目配置校验失败会导致整个插件未激活：配置非法与合法成对。
const cfgSchema="import z from '@deepseek-ai/schemastery';export const Config=z.object({threshold:z.number().required()});export function apply(){}";
test('实际App启动审计：条目配置校验失败与合法成对',{skip:!available},async()=>{
  const bad=await startupFixture('config-bad',cfgSchema,false,'- id: fixture\n  config:\n    threshold: not-a-number\n');
  assert.equal(bad.ok,false,bad.stdout+bad.stderr);assert.match(bad.stdout,/"ready":false/);
  const good=await startupFixture('config-good',cfgSchema,false,'- id: fixture\n  config:\n    threshold: 1\n');
  assert.equal(good.ok,true,good.stderr);assert.match(good.stdout,/DSH_DOCTOR_READY:/);
});
test('真实App客户端外壳成对fixture，factory从不执行',{skip:!available},async()=>{assert.equal((await probe('client-good')).bundles[0].clientShape,true);assert.equal((await probe('client-bad',{client:'window.__ModuleLoader__.load({id:"fixture",factory:42})'})).bundles[0].clientShape,false);});

test('真实App断链与客户端缺文件成对',{skip:!available},async()=>{
 assert.equal((await probe('link-good')).bundles[0].mainExists,true);assert((await probe('link-broken',{brokenLink:true})).bundles[0].error);
 assert.equal((await probe('client-present')).bundles[0].clientExists,true);assert.equal((await probe('client-missing',{missingClient:true})).bundles[0].clientExists,false);
});
test('真实App读取store/global/lock YAML成对',{skip:!available},async()=>{
 const m={dependencies:{x:'1'}},l={importers:{'.':{dependencies:{x:{specifier:'1'}}}}};
 for(const [label,opts,id] of [['store',{modules:{storeDir:'/other'}},'pnpm-store-path'],['global',{globalConfig:{storeDir:'/other'}},'pnpm-global-store-dir'],['lock',{lock:{importers:{'.':{}}}},'lockfile-manifest']]){
  const base={modules:{storeDir:'/expected'},globalConfig:{},lock:l};
  const healthy=await probe(label+'-read-good',base),bad=await probe(label+'-read-bad',{...base,...opts});
  const check=d=>inspectData(d,m,'/expected').find(c=>c.id===id);assert.equal(check(healthy).ok,true);assert.equal(check(bad).ok,false);
 }
});
test('真实App读取锁文件：临时目录借来的link路径在安装前拒绝，等价规范路径通过',{skip:!available},async()=>{
 const spec='link:../fixture',profileDir='/tmp/example-profile';
 const m={dependencies:{fixture:spec}};
 const lock=version=>({importers:{'.':{dependencies:{fixture:{specifier:spec,version}}}}});
 const healthy=await probe('link-lock-good',{lock:lock('link:../x/../fixture')});
 const bad=await probe('link-lock-borrowed',{lock:lock('link:../../../../../tmp/example/fixture')});
 const check=d=>inspectData(d,m,'/expected',profileDir).find(c=>c.id==='lockfile-manifest');
 assert.equal(check(healthy).ok,true);assert.equal(check(bad).ok,false);assert.match(check(bad).message,/本地插件路径不一致/);
 assert.equal(lockMismatch(m,lock('link:/tmp/fixture'),profileDir).length,0);
 assert.match(lockMismatch(m,lock('1.0.0'),profileDir).join(),/本地插件路径不一致/);
});
test('实际App pnpm最低发布时间本地registry成对',{skip:!available},async()=>{
 const {createServer}=await import('node:http');let recent=false;
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({name:'doctor-age-fixture','dist-tags':{latest:'1.0.0'},versions:{[recent?'1.0.1':'1.0.0']:{name:'doctor-age-fixture',version:recent?'1.0.1':'1.0.0',dist:{tarball:'http://127.0.0.1:'+server.address().port+'/fixture.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}},time:{created:'2000-01-01T00:00:00.000Z',modified:new Date().toISOString(),[recent?'1.0.1':'1.0.0']:recent?new Date().toISOString():'2000-01-01T00:00:00.000Z'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{for(const bad of [false,true]){recent=bad;const dir=path.join(root,'policy-'+bad);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'policy-fixture',dependencies:{'doctor-age-fixture':bad?'1.0.1':'1.0.0'}}));await fs.writeFile(path.join(dir,'pnpm-workspace.yaml'),'minimumReleaseAge: 1440\nregistry: http://127.0.0.1:'+server.address().port+'\nstoreDir: '+path.join(dir,'store')+'\n');
 const r=await run(electron,['--expose-internals',(await appPnpm(app)).bin,'install','--lockfile-only','--ignore-scripts','--fetch-retries=0','--registry=http://127.0.0.1:'+server.address().port,'--config.minimumReleaseAge=1440'],{cwd:dir,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HOME:dir,PNPM_HOME:dir,CI:'true'},timeoutMs:20000});assert.equal(r.ok,!bad,r.stderr+r.stdout);if(bad)assert.match(r.stdout+r.stderr,/minimumReleaseAge/);}
 }finally{await new Promise(resolve=>server.close(resolve));}
});
