import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildPlugin} from '../build.mjs';
import {inspectBuild} from '../build-manifest.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-build-test-'));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
async function fixture(label) {
  const repository=path.join(root,label),dir=path.join(repository,'plugin');
  const declaration={manifest:'lib/dsh-build.json',inputs:['src','scripts','package.json'],outputs:['lib'],repositoryInputs:['tooling/build.mjs','tooling/build-manifest.mjs','tooling/tsconfig.base.json']};
  const files={'.git':'gitdir: fixture','tooling/build.mjs':'build','tooling/tsconfig.base.json':'{}','tooling/build-manifest.mjs':'snapshot','plugin/package.json':JSON.stringify({dsh:{build:declaration}}),'plugin/scripts/build.mjs':'build','plugin/src/index.ts':'source'};
  for(const [name,content] of Object.entries(files)) {
    const target=path.join(repository,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);
  }
  const emit=async()=>{await fs.mkdir(path.join(dir,'lib'),{recursive:true});await fs.writeFile(path.join(dir,'lib/index.js'),'output');};
  const build=(steps=[emit])=>buildPlugin(pathToFileURL(path.join(dir,'scripts/build.mjs')),{steps});
  return {dir,repository,declaration,emit,build,manifest:path.join(dir,'lib/dsh-build.json')};
}
async function command(f,name,source) {
  const bin=path.join(f.dir,'node_modules/.bin',name);await fs.mkdir(path.dirname(bin),{recursive:true});
  await fs.writeFile(bin,'#!'+process.execPath+'\n'+source);await fs.chmod(bin,0o755);
}
test('共用构建写出doctor可核实的完整清单，命令按声明顺序执行',async()=>{
  const f=await fixture('sequence');
  await command(f,'tsc',`require('node:fs').writeFileSync('order','tsc')`);
  await command(f,'tsdown',`const fs=require('node:fs');if(fs.readFileSync('order','utf8')!=='tsc')process.exit(2);fs.mkdirSync('lib');fs.writeFileSync('lib/index.js','output')`);
  const stamp=await f.build([['tsc','-p','tsconfig.json'],['tsdown']]);
  assert.equal((await inspectBuild(f.dir,f.declaration,['lib/index.js'])).status,'verified');
  assert.deepEqual(Object.keys(stamp.repositoryInputs),[...f.declaration.repositoryInputs].sort());
  assert.equal(await fs.readFile(f.manifest,'utf8'),JSON.stringify(stamp,null,2)+'\n');
});
for(const [label,source,pattern] of [
  ['exit',`process.exit(7)`,/exit=7/],
  ['signal',`process.kill(process.pid,'SIGTERM')`,/signal=SIGTERM/],
])test('命令失败不生成新清单：'+label,async()=>{
  const f=await fixture(label);await command(f,'fail',source);
  await assert.rejects(f.build([['fail']]),pattern);
  await assert.rejects(fs.stat(f.manifest),{code:'ENOENT'});
});
test('启动失败、回调失败和非法步骤都不写清单',async()=>{
  const f=await fixture('errors');
  await assert.rejects(f.build([['missing']]),{code:'ENOENT'});
  await assert.rejects(f.build([async()=>{throw new Error('copy failed');}]),/copy failed/);
  for(const steps of [[],[['../outside']],[[process.execPath]],[[42]]])await assert.rejects(f.build(steps));
  await assert.rejects(fs.stat(f.manifest),{code:'ENOENT'});
});
for(const kind of ['local','repository'])test('构建中输入变化不生成清单：'+kind,async()=>{
  const f=await fixture('changed-'+kind);
  await assert.rejects(f.build([async()=>{await f.emit();await fs.appendFile(path.join(kind==='local'?f.dir:f.repository,kind==='local'?'src/index.ts':'tooling/tsconfig.base.json'),'changed');}]),/输入内容变化/);
  await assert.rejects(fs.stat(f.manifest),{code:'ENOENT'});
});
test('原子替换保留完整旧清单，rename失败清除临时文件',async()=>{
  const f=await fixture('atomic');await f.build();const old=await fs.readFile(f.manifest,'utf8');
  await assert.rejects(f.build([async()=>{await f.emit();throw new Error('failed');}]),/failed/);
  assert.equal(await fs.readFile(f.manifest,'utf8'),old);
  await fs.unlink(f.manifest);await fs.mkdir(f.manifest);
  await assert.rejects(f.build(),e=>['EISDIR','ENOTEMPTY','EEXIST'].includes(e.code));
  assert.deepEqual((await fs.readdir(path.join(f.dir,'lib'))).sort(),['dsh-build.json','index.js']);
});
test('临时文件已创建后写入失败，旧清单不变且临时文件被清理',async(t)=>{
  const f=await fixture('write-error');await f.build();const old=await fs.readFile(f.manifest,'utf8');
  const open=fs.open;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await open(...args);
    if(String(args[0]).endsWith('.tmp'))return {writeFile:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});},close:()=>handle.close()};
    return handle;
  });
  await assert.rejects(f.build(),{code:'ENOSPC'});
  assert.equal(await fs.readFile(f.manifest,'utf8'),old);
  assert.deepEqual((await fs.readdir(path.join(f.dir,'lib'))).sort(),['dsh-build.json','index.js']);
});
test('并发成功构建使用独占临时文件且不残留半份清单',async()=>{
  const f=await fixture('concurrent');await f.emit();
  await Promise.all([f.build([async()=>{}]),f.build([async()=>{}])]);
  assert.equal((await inspectBuild(f.dir,f.declaration)).status,'verified');
  assert.deepEqual((await fs.readdir(path.join(f.dir,'lib'))).sort(),['dsh-build.json','index.js']);
});
test('共用构建实现不能从声明漏掉',async()=>{
  for(const omit of ['tooling/build.mjs','tooling/build-manifest.mjs']) {
    const f=await fixture('omit-'+omit.replaceAll('/','-'));
    f.declaration.repositoryInputs=f.declaration.repositoryInputs.filter(name=>name!==omit);
    await fs.writeFile(path.join(f.dir,'package.json'),JSON.stringify({dsh:{build:f.declaration}}));
    await assert.rejects(f.build(),/必须覆盖共用构建实现/);
  }
});
