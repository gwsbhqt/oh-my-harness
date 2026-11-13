import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {rebuildLinkedPlugins,checkLinkedPlugins} from '../rebuild.mjs';
import {run} from '../doctor.mjs';
import {fixture,put,changeBuilder,root,checkout} from '../test-support/rebuild-fixture.mjs';

test('只跳过真实 verified，缺清单与旧输入各调用一次真实 builder',async()=>{
  const f=await fixture('selection');
  const fresh=await f.build();assert.equal(fresh.ok,true);assert.equal(fresh.summary.built,0);
  await fs.appendFile(path.join(f.dir('dsh-first'),'src/index.js'),'\nexport const changed=1;');
  await fs.unlink(path.join(f.dir('dsh-second'),'lib/dsh-build.json'));
  const report=await f.build();assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.summary.built,2);
  assert.deepEqual(report.plugins.map(p=>p.before.status),['stale','unverified']);assert(report.plugins.every(p=>p.after.status==='verified'&&p.build.code===0));
  assert.equal((await f.build()).summary.built,0);
});

for(const [label,source,pattern] of [
  ['exit','console.error("warning last");process.exit(7)',/退出码 7/],
  ['no-build','console.error("only warning")',/复验失败/],
  ['input-change',`import fs from 'node:fs/promises';await fs.appendFile('src/index.js','changed');`,/输入内容变化/],
])test('构建失败或只退出成功都不能算成功：'+label,async()=>{
  const f=await fixture(label,['dsh-first']);await changeBuilder(f,'dsh-first',source);
  const report=await f.build();assert.equal(report.ok,false);assert.equal(report.summary.built,0);assert.match(report.plugins[0].error,pattern);
  if(label==='exit')assert.match(report.plugins[0].error.split('\n')[0],/退出码 7/);
});

test('有限复扫发现稍后 builder 改了已跳过插件，不循环重建',async()=>{
  const f=await fixture('rescan');
  const script=await fs.readFile(path.join(f.dir('dsh-second'),'scripts/build.mjs'),'utf8');
  await changeBuilder(f,'dsh-second',script+`await fs.appendFile('../dsh-first/src/index.js','changed');`);
  const report=await f.build();assert.equal(report.ok,false);assert.equal(report.plugins[0].action,'failed');assert.equal(report.plugins[0].after.status,'stale');
  assert.equal(await fs.readFile(path.join(f.dir('dsh-first'),'calls'),'utf8'),'build\n');
});

test('只运行指定仓库内明确登记的 link，不执行第三方、隐式目录或任意 shell',async()=>{
  const f=await fixture('boundaries',['dsh-first']);
  const outside=path.join(root,'external');await put(outside,'package.json','{}');
  f.manifest.dependencies.external='link:'+outside;f.manifest.dependencies.registry='1.0.0';
  await fs.symlink(outside,path.join(f.repository,'escaped'));f.manifest.dependencies.escaped='link:'+path.join(f.repository,'escaped');
  await put(f.profile,'package.json',JSON.stringify(f.manifest));
  const report=await f.build();assert.equal(report.ok,true);assert.equal(report.skipped.length,3);assert.equal(report.summary.built,0);
  const pkg=JSON.parse(await fs.readFile(path.join(f.dir('dsh-first'),'package.json'),'utf8'));pkg.scripts.build='node scripts/build.mjs && touch unsafe';await put(f.dir('dsh-first'),'package.json',JSON.stringify(pkg));
  const unsafe=await f.build();assert.equal(unsafe.ok,false);assert.match(unsafe.plugins[0].error,/只接受/);await assert.rejects(fs.stat(path.join(f.dir('dsh-first'),'unsafe')),{code:'ENOENT'});
});


test('profile 构建中变化会失败，即使所有原有产物已 verified',async()=>{
  const f=await fixture('manifest-change',['dsh-first']);
  const script=await fs.readFile(path.join(f.dir('dsh-first'),'scripts/build.mjs'),'utf8');
  await changeBuilder(f,'dsh-first',script+`await fs.appendFile(${JSON.stringify(path.join(f.profile,'package.json'))},' ');`);
  const report=await f.build();assert.equal(report.ok,false);assert.match(report.errors.join(),/manifest 变化/);
  assert.equal(report.plugins[0].after.status,'verified');
});

test('构建中输入变化由真实 buildPlugin 拒绝，不生成新清单',async()=>{
  const f=await fixture('build-race',['dsh-first']);
  const script=await fs.readFile(path.join(f.dir('dsh-first'),'scripts/build.mjs'),'utf8');
  await changeBuilder(f,'dsh-first',script.replace("await fs.copyFile", "await fs.appendFile(path.join(dir,'src/index.js'),'changed');await fs.copyFile"));
  const old=await fs.readFile(path.join(f.dir('dsh-first'),'lib/dsh-build.json'),'utf8');
  const report=await f.build();assert.equal(report.ok,false);assert.equal(report.summary.built,0);assert.match(report.plugins[0].error,/构建期间输入内容变化/);
  assert.equal(await fs.readFile(path.join(f.dir('dsh-first'),'lib/dsh-build.json'),'utf8'),old);
});

test('符号链接构建入口和缺构建声明都不执行',async()=>{
  const f=await fixture('unsafe-files',['dsh-first']);
  const script=path.join(f.dir('dsh-first'),'scripts/build.mjs');await fs.rename(script,script+'.saved');await fs.symlink(script+'.saved',script);
  await fs.appendFile(path.join(f.dir('dsh-first'),'src/index.js'),'changed');
  const symlink=await f.build();assert.equal(symlink.ok,false);assert.match(symlink.plugins[0].error,/符号链接/);
  const pkg=JSON.parse(await fs.readFile(path.join(f.dir('dsh-first'),'package.json'),'utf8'));delete pkg.dsh.build;await put(f.dir('dsh-first'),'package.json',JSON.stringify(pkg));
  const undeclared=await f.build();assert.equal(undeclared.ok,false);assert.match(undeclared.plugins[0].error,/未声明/);
  assert.equal(await fs.readFile(path.join(f.dir('dsh-first'),'calls'),'utf8'),'build\n');
});

test('构建超时报告保留主因与退出状态',async()=>{
  const f=await fixture('timeout',['dsh-first']);await changeBuilder(f,'dsh-first','console.error("warning");setInterval(()=>{},1000)');
  const report=await rebuildLinkedPlugins({...f,timeoutMs:1000});assert.equal(report.ok,false);assert.equal(report.plugins[0].build.timedOut,true);assert.equal(report.summary.built,0);
  assert.match(report.plugins[0].error.split('\n')[0],/时限/);
});

test('从符号链接父目录调用真实 CLI：帮助非空，profile 错误非零',async()=>{
  const alias=path.join(root,'checkout-alias');await fs.symlink(checkout,alias);
  const entry=path.join(alias,'tooling/rebuild.mjs');
  const help=await run(process.execPath,[entry,'--help']);assert.equal(help.code,0,help.stderr);assert.match(help.stdout,/--repository/);assert.match(help.stdout,/--profile/);
  const invalid=await run(process.execPath,[entry,'--profile','.']);assert.equal(invalid.code,2);assert.match(invalid.stderr,/绝对/);
});

test('CLI JSON 可直接读取，失败非零，参数必须显式绝对路径',async()=>{
  const f=await fixture('cli',['dsh-first']);await fs.unlink(path.join(f.dir('dsh-first'),'lib/dsh-build.json'));
  const args=[path.join(checkout,'tooling/rebuild.mjs'),'--repository',f.repository,'--profile',f.profile,'--json'];
  const good=await run(process.execPath,args);assert.equal(good.code,0,good.stderr);assert.equal(JSON.parse(good.stdout).summary.built,1);
  await changeBuilder(f,'dsh-first','process.exit(9)');
  const bad=await run(process.execPath,args);assert.equal(bad.code,1);assert.equal(JSON.parse(bad.stdout).ok,false);
  const invalid=await run(process.execPath,[path.join(checkout,'tooling/rebuild.mjs'),'--profile','.']);assert.equal(invalid.code,2);assert.match(invalid.stderr,/绝对/);
});

test('只检查模式不运行 builder，列出过期、缺清单、缺目录和缺依赖，口径与构建模式一致',async()=>{
  const f=await fixture('check');
  const clean=await checkLinkedPlugins(f);assert.equal(clean.ok,true,JSON.stringify(clean));assert.equal(clean.mode,'check');
  assert.deepEqual(clean.plugins.map(p=>[p.name,p.status,p.action]),[['dsh-first','verified','skip'],['dsh-second','verified','skip']]);
  await fs.appendFile(path.join(f.dir('dsh-first'),'src/index.js'),'\nexport const changed=1;');
  await fs.unlink(path.join(f.dir('dsh-second'),'lib/dsh-build.json'));
  f.manifest.dependencies['dsh-absent']='link:'+f.dir('dsh-absent');
  f.manifest.dependencies.elsewhere='link:'+path.join(root,'check-elsewhere','dsh-gone');
  f.manifest.dependencies.registry='1.0.0';
  await put(f.profile,'package.json',JSON.stringify(f.manifest));
  const report=await checkLinkedPlugins(f);assert.equal(report.ok,false);
  assert.deepEqual(report.plugins.map(p=>[p.name,p.status,p.action]),[['dsh-first','stale','build'],['dsh-second','unverified','build'],['dsh-absent','missing','failed']]);
  assert.match(report.plugins[0].message,/src\/index\.js/);assert.match(report.plugins[2].message,/不存在/);
  assert.deepEqual(report.skipped.map(s=>s.name).sort(),['elsewhere','registry']);
  assert.deepEqual(report.missingDependencies,['dsh-absent','elsewhere','registry']);
  assert.deepEqual(report.summary,{scanned:3,verified:0,stale:1,unverified:1,missing:1,error:0,wouldBuild:2,failed:1,skipped:2,missingDependencies:3});
  for(const name of ['dsh-first','dsh-second'])assert.equal(await fs.readFile(path.join(f.dir(name),'calls'),'utf8'),'build\n');
  const built=await f.build();
  assert.deepEqual(built.plugins.map(p=>[p.name,p.before?.status,p.built]),[['dsh-first','stale',true],['dsh-second','unverified',true],['dsh-absent',undefined,false]]);
  assert.deepEqual(built.skipped.map(s=>s.name).sort(),['elsewhere','registry']);
});

test('只检查 CLI：全部一致退出 0，有要处理的退出 1 且 JSON 可读，不构建',async()=>{
  const f=await fixture('check-cli',['dsh-first']);
  const args=[path.join(checkout,'tooling/rebuild.mjs'),'--check','--repository',f.repository,'--profile',f.profile];
  const good=await run(process.execPath,[...args,'--json']);assert.equal(good.code,0,good.stderr);assert.equal(JSON.parse(good.stdout).ok,true);
  await fs.unlink(path.join(f.dir('dsh-first'),'lib/dsh-build.json'));
  const bad=await run(process.execPath,[...args,'--json']);assert.equal(bad.code,1,bad.stderr);
  assert.deepEqual(JSON.parse(bad.stdout).plugins.map(p=>[p.name,p.status]),[['dsh-first','unverified']]);
  const text=await run(process.execPath,args);assert.equal(text.code,1);assert.match(text.stdout,/需要处理/);assert.match(text.stdout,/dsh-first（unverified）/);
  await assert.rejects(fs.stat(path.join(f.dir('dsh-first'),'lib/dsh-build.json')),{code:'ENOENT'});
  const invalid=await run(process.execPath,[path.join(checkout,'tooling/rebuild.mjs'),'--check','--profile','.']);assert.equal(invalid.code,2);assert.match(invalid.stderr,/绝对/);
});

test('插件嵌在单体仓库深处时按仓库根构建，插件目录自身没 .git 也能向上找到',async()=>{
  const f=await fixture('nested',['dsh-first']);
  const plugin=path.join(f.repository,'packages/dsh/.agents/dsh-plugins','dsh-first');
  await fs.mkdir(path.dirname(plugin),{recursive:true});await fs.rename(f.dir('dsh-first'),plugin);
  const builder=await fs.readFile(path.join(plugin,'scripts/build.mjs'),'utf8');
  await put(plugin,'scripts/build.mjs',builder.replace("'../../tooling/build.mjs'","'../../../../../../tooling/build.mjs'"));
  f.manifest.dependencies['dsh-first']='link:'+plugin;
  await put(f.profile,'package.json',JSON.stringify(f.manifest));
  await fs.rm(path.join(f.profile,'node_modules/dsh-first'));await fs.symlink(plugin,path.join(f.profile,'node_modules/dsh-first'));
  const report=await f.build();assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.summary.built,1);
  const scoped=await checkLinkedPlugins({repository:path.dirname(plugin),profile:f.profile});assert.equal(scoped.ok,true,JSON.stringify(scoped));
});
