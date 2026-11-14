import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {snapshotBuild,inspectBuild} from '../../tooling/build-manifest.mjs';
import {inspectData,unverifiedBuilds,doctor,run} from '../../tooling/doctor.mjs';

const root=await fs.mkdtemp('/tmp/doc-build-test-');
test.after(()=>fs.rm(root,{recursive:true,force:true}));
async function fixture(label) {
  const dir=path.join(root,label),declaration={manifest:'./lib/dsh-build.json',inputs:['src','python','vendor','package.json','cordis.patch.yml'],outputs:['lib']};
  for(const [name,content] of Object.entries({'package.json':JSON.stringify({dsh:{build:declaration}}),'cordis.patch.yml':'[]','src/index.ts':'export const version = 1','python/kernel.py':'VERSION = 1','vendor/runtime.py':'VERSION = 1','lib/index.js':'export const version = 1','lib/client.js':'void 0'})) {
    await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await fs.writeFile(path.join(dir,name),content);
  }
  const stamp=await snapshotBuild(dir,declaration);
  await fs.writeFile(path.join(dir,'lib/dsh-build.json'),JSON.stringify(stamp));
  return {dir,declaration,stamp,inspect:()=>inspectBuild(dir,declaration,['./lib/index.js','./lib/client.js'])};
}
test('构建前输入快照首次没有lib也可校验',async()=>{
  const f=await fixture('before-build');await fs.rm(path.join(f.dir,'lib'),{recursive:true});
  const {snapshotInputs}=await import('../../tooling/build-manifest.mjs');assert.equal(typeof snapshotInputs,'function');
  assert.deepEqual(await snapshotInputs(f.dir,f.declaration),f.stamp.inputs);
  await fs.appendFile(path.join(f.dir,'python/kernel.py'),'changed');assert.notDeepEqual(await snapshotInputs(f.dir,f.declaration),f.stamp.inputs);
});
test('内容清单使用字节hash且touch不等价源码变化',async()=>{
  const f=await fixture('touch');
  assert.equal(f.stamp.inputs['src/index.ts'],createHash('sha256').update('export const version = 1').digest('hex'));
  const future=new Date(Date.now()+86400000);
  for(const name of ['src/index.ts','python/kernel.py','lib/index.js'])await fs.utimes(path.join(f.dir,name),future,future);
  assert.equal((await f.inspect()).ok,true);
  await fs.writeFile(path.join(f.dir,'src/index.ts'),'export const version = 2');
  await fs.utimes(path.join(f.dir,'src/index.ts'),new Date(0),new Date(0));
  assert.equal((await f.inspect()).status,'stale');
});
for(const name of ['src/index.ts','python/kernel.py','vendor/runtime.py','cordis.patch.yml','lib/index.js','lib/client.js'])test('内容清单新旧成对 '+name,async()=>{
  const f=await fixture(name.replaceAll('/','-'));assert.equal((await f.inspect()).ok,true);
  await fs.appendFile(path.join(f.dir,name),'\nchanged');const bad=await f.inspect();assert.equal(bad.ok,false);assert.equal(bad.status,'stale');assert(bad.message.includes(name));
});
test('内容清单新增和删除输入输出文件都检测',async()=>{
  for(const kind of ['src','lib'])for(const action of ['add','delete']) {
    const f=await fixture(kind+'-'+action);
    if(action==='add')await fs.writeFile(path.join(f.dir,kind,'new.js'),'new');else await fs.unlink(path.join(f.dir,kind,'index.'+(kind==='src'?'ts':'js')));
    const bad=await f.inspect();assert.equal(bad.ok,false);assert.equal(bad.status,action==='delete'&&kind==='lib'?'unverified':'stale');
  }
});
test('内容清单不遍扫node_modules和Python缓存，也不跟随symlink',async()=>{
  const f=await fixture('cache');
  for(const name of ['src/node_modules','src/.cache','python/__pycache__','vendor/.git']){await fs.mkdir(path.join(f.dir,name));await fs.symlink('/missing-harmless-fixture',path.join(f.dir,name,'ignored'));}
  await fs.writeFile(path.join(f.dir,'python/kernel.pyc'),'cache');assert.equal((await f.inspect()).ok,true);
  await fs.symlink('/missing-harmless-fixture',path.join(f.dir,'src/linked.ts'));const bad=await f.inspect();assert.equal(bad.ok,false);assert.equal(bad.status,'unverified');assert.match(bad.message,/符号链接/);
});
test('内容清单缺失非法旧schema都不能假green',async()=>{
  for(const [label,change] of [['missing',async f=>fs.unlink(path.join(f.dir,'lib/dsh-build.json'))],['old',async f=>fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),'{}')],['bad-json',async f=>fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),'{')],['bad-hash',async f=>{f.stamp.inputs['src/index.ts']='wrong';await fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),JSON.stringify(f.stamp));}]]) {
    const f=await fixture(label);await change(f);const bad=await f.inspect();assert.equal(bad.ok,false);assert.equal(bad.status,'unverified');
  }
});
test('内容清单不能省掉Python或宿主客户端入口',async()=>{
  const f=await fixture('incomplete');
  for(const omit of ['src','python','vendor']){const bad=await inspectBuild(f.dir,{...f.declaration,inputs:f.declaration.inputs.filter(v=>v!==omit)});assert.equal(bad.ok,false);assert.match(bad.message,/覆盖运行时目录/);}
  for(const entry of ['./lib/index.js','./lib/client.js']) {
    const declaration={...f.declaration,manifest:'./lib/stamps/dsh-build.json',outputs:[entry==='./lib/index.js'?'lib/client.js':'lib/index.js','lib/stamps']};
    await fs.mkdir(path.join(f.dir,'lib/stamps'),{recursive:true});
    await fs.writeFile(path.join(f.dir,'lib/stamps/dsh-build.json'),JSON.stringify(await snapshotBuild(f.dir,declaration)));
    const bad=await inspectBuild(f.dir,declaration,[entry]);assert.equal(bad.ok,false);assert.match(bad.message,/未覆盖运行时入口/);
  }
  const bad=await inspectBuild(f.dir,f.declaration,['./untracked.js']);assert.equal(bad.ok,false);assert.match(bad.message,/未覆盖运行时入口/);
});
test('内容清单越界依赖根和输入输出重叠均拒绝',async()=>{
  const f=await fixture('paths');
  for(const value of ['../outside','/tmp/outside','node_modules','src/../outside','src/.cache','src\\file'])await assert.rejects(snapshotBuild(f.dir,{...f.declaration,inputs:[...f.declaration.inputs,value]}));
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,inputs:['src','python','vendor']}),/package.json/);
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,outputs:['src','lib']}),/不能重叠/);
});
async function repositoryFixture(label) {
  const f=await fixture('repository-'+label+'/plugin'),repository=path.dirname(f.dir);
  await fs.writeFile(path.join(repository,'.git'),'gitdir: fixture');
  for(const name of ['tooling/build.mjs','tooling/tsconfig.base.json','tooling/build-manifest.mjs']) {
    await fs.mkdir(path.dirname(path.join(repository,name)),{recursive:true});await fs.writeFile(path.join(repository,name),'shared input');
  }
  f.declaration.repositoryInputs=['tooling/build.mjs','tooling/tsconfig.base.json','tooling/build-manifest.mjs'];
  f.stamp=await snapshotBuild(f.dir,f.declaration);
  await fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),JSON.stringify(f.stamp));
  return {...f,repository};
}
test('共用构建工具和TypeScript base变化由doctor发现，touch不误报',async()=>{
  for(const name of ['tooling/build.mjs','tooling/tsconfig.base.json','tooling/build-manifest.mjs']) {
    const f=await repositoryFixture(name.replaceAll('/','-'));assert.equal((await f.inspect()).status,'verified');
    await fs.utimes(path.join(f.repository,name),new Date(0),new Date(0));assert.equal((await f.inspect()).status,'verified');
    await fs.appendFile(path.join(f.repository,name),'changed');const bad=await f.inspect();assert.equal(bad.status,'stale');assert(bad.message.includes('repositoryInputs: '+name));
  }
});
test('repositoryInputs只允许规范tooling文件或精确doctor核心，不放宽包内边界',async()=>{
  const f=await repositoryFixture('paths');
  for(const name of ['../tooling/build.mjs','/tmp/build.mjs','./tooling/build.mjs','tooling','tooling/../src/a','tooling/node_modules/a','tooling/.cache/a','tooling/a\\b','tooling/*.mjs','tooling/file?.mjs','tooling/[a].mjs','dsh-other/src/a','tooling/doctor.mjs'])await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:[name]}));
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:['tooling']}));
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:'tooling/build.mjs'}));
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:['tooling'],inputs:[...f.declaration.inputs,'../tooling/build.mjs']}));
  await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:['tooling'],outputs:['../lib']}));
});
test('repositoryInputs拒绝文件目录及中间段符号链接，即使目标仍在仓库',async()=>{
  for(const segment of ['file','directory','root']) {
    const f=await repositoryFixture('symlink-'+segment);
    if(segment==='file') {await fs.rename(path.join(f.repository,'tooling/build.mjs'),path.join(f.repository,'tooling/real.mjs'));await fs.symlink('real.mjs',path.join(f.repository,'tooling/build.mjs'));}
    if(segment==='directory') {await fs.rename(path.join(f.repository,'tooling'),path.join(f.repository,'real-tooling'));await fs.symlink('real-tooling',path.join(f.repository,'tooling'));}
    if(segment==='root') {await fs.unlink(path.join(f.repository,'.git'));await fs.symlink('tooling/build.mjs',path.join(f.repository,'.git'));}
    const bad=await f.inspect();assert.equal(bad.status,'unverified');assert.match(bad.message,/符号链接/);
  }
  const f=await repositoryFixture('directory');await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:['tooling']}));
  await fs.mkdir(path.join(f.repository,'tooling/folder'));await assert.rejects(snapshotBuild(f.dir,{...f.declaration,repositoryInputs:['tooling/folder']}),/普通文件/);
});
test('缺共用文件、旧清单缺共用hash、脱离仓库产物都必须unverified',async()=>{
  for(const kind of ['missing','old-stamp','detached','no-marker']) {
    const f=await repositoryFixture(kind);
    if(kind==='missing')await fs.unlink(path.join(f.repository,'tooling/build.mjs'));
    if(kind==='old-stamp') {delete f.stamp.repositoryInputs;await fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),JSON.stringify(f.stamp));}
    if(kind==='no-marker')await fs.unlink(path.join(f.repository,'.git'));
    let dir=f.dir;
    if(kind==='detached') {dir=path.join(root,'installed',kind);await fs.cp(f.dir,dir,{recursive:true});}
    const bad=await inspectBuild(dir,f.declaration);assert.equal(bad.status,'unverified',kind+': '+bad.message);assert.equal(bad.ok,false);
  }
});
test('共用清单中的非法路径与hash不被信任',async()=>{
  for(const kind of ['path','hash']) {
    const f=await repositoryFixture('stamp-'+kind);
    if(kind==='path')f.stamp.repositoryInputs['dsh-other/src/index.ts']='0'.repeat(64);else f.stamp.repositoryInputs['tooling/build.mjs']='wrong';
    await fs.writeFile(path.join(f.dir,'lib/dsh-build.json'),JSON.stringify(f.stamp));assert.equal((await f.inspect()).status,'unverified');
  }
});
test('独立报告契约：无协议只列未验证，声明缺清单失败',async()=>{
  const base={version:'fixture',errors:{},bundles:[],modules:{storeDir:'/expected'},globalConfig:{},lock:{importers:{'.':{}}}};
  const f=await fixture('contract');
  const legacy={name:'legacy',link:true,mainExists:true,buildDeclared:false,build:await inspectBuild(f.dir,undefined)};
  const d={...base,bundles:[legacy]};assert.equal(inspectData(d,{},'/expected').some(c=>c.id==='link-build-freshness'),false);assert.equal(unverifiedBuilds(d).length,1);
  await fs.unlink(path.join(f.dir,'lib/dsh-build.json'));d.bundles.push({name:'declared',link:true,buildDeclared:true,mainExists:true,build:await f.inspect()});
  const c=inspectData(d,{},'/expected').find(c=>c.id==='link-build-freshness');assert.equal(c.ok,false);assert.equal(c.status,'unverified');assert.equal(unverifiedBuilds(d).length,2);
  const r=await doctor({home:root,app:'/missing',sanitizeEnv:true});assert.equal(r.ok,false);assert.equal(r.guiValidated,false);assert(r.unverified.some(v=>v.includes('GUI')));assert.equal(r.checks.find(c=>c.id==='credentials-mode').message,'未配置凭据文件');
});
test('唯一失败先显示，正常项不遮住 doctor，完整 details 仍可读取',()=>{
  const bundles=Array.from({length:19},(_,i)=>({name:'good-'+i,link:true,buildDeclared:true,mainExists:true,build:{ok:true,status:'verified',message:'正常'}}));
  bundles.push({name:'dsh-doctor',link:true,buildDeclared:true,mainExists:true,build:{ok:false,status:'stale',message:'构建内容已变化: inputs: core/doctor.mjs'}});
  const data={version:'fixture',errors:{},bundles,modules:{storeDir:'/expected'},globalConfig:{},lock:{importers:{'.':{}}}};
  const result=inspectData(data,{},'/expected').find(c=>c.id==='link-build-freshness');
  assert.equal(result.ok,false);assert.equal(result.status,'stale');assert.match(result.message,/^dsh-doctor:.*core\/doctor.mjs/);
  assert.doesNotMatch(result.message,/good-0/);assert.match(result.message,/19/);assert.equal(result.details.length,20);
  assert.equal(result.details.find(d=>d.name==='dsh-doctor').ok,false);
});
test('doctor 自己是 link 插件：声明构建协议，构建后清单与产物一致',async()=>{
  const dir=path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const m=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  const r=await inspectBuild(dir,m.dsh?.build,[m.exports['.'],m.main]);assert.equal(r.status,'verified',r.message);
  for(const runtime of ['bin'])assert(m.dsh.build.inputs.includes(runtime),runtime+' 直接从磁盘运行，必须列为输入');
});
test('独立CLI错误状态仍为exit1，输出结构不变',async()=>{
  const r=await run(process.execPath,['bin/doctor.mjs','--home',root,'--app','/missing','--json','--sanitize-env'],{env:{HOME:root,PATH:process.env.PATH}});
  assert.equal(r.code,1);const report=JSON.parse(r.stdout);assert.equal(report.ok,false);assert(Array.isArray(report.checks));assert(Array.isArray(report.unverified));assert.equal(report.guiValidated,false);
});
