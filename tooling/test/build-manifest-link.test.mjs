import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'shared-tooling-'));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
let index=0;
async function fixture() {
  const base=path.join(root,String(index++)),shared=path.join(base,'shared'),privateRoot=path.join(base,'private'),dir=path.join(privateRoot,'dsh-fixture');
  for(const name of [path.join(shared,'tooling'),path.join(dir,'src'),path.join(dir,'lib')])await fs.mkdir(name,{recursive:true});
  await fs.writeFile(path.join(shared,'.git'),'gitdir: fixture');
  await fs.writeFile(path.join(privateRoot,'.git'),'gitdir: fixture');
  await fs.copyFile(new URL('../build-manifest.mjs',import.meta.url),path.join(shared,'tooling/build-manifest.mjs'));
  await fs.writeFile(path.join(shared,'tooling/base.json'),'{}');
  const declaration={manifest:'lib/dsh-build.json',inputs:['src','package.json'],outputs:['lib'],repositoryInputs:['tooling/build-manifest.mjs','tooling/base.json']};
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({dsh:{build:declaration}}));
  await fs.writeFile(path.join(dir,'src/index.js'),'export const value=1');
  await fs.writeFile(path.join(dir,'lib/index.js'),'export const value=1');
  const link=path.join(privateRoot,'tooling');
  await fs.symlink(path.relative(privateRoot,path.join(shared,'tooling')),link);
  const api=await import(pathToFileURL(path.join(shared,'tooling/build-manifest.mjs')).href);
  return {base,shared,privateRoot,dir,link,declaration,...api};
}
test('private builds can fingerprint the exact shared tooling that executes them',async()=>{
  const f=await fixture(),stamp=await f.snapshotBuild(f.dir,f.declaration);
  await fs.writeFile(path.join(f.dir,f.declaration.manifest),JSON.stringify(stamp));
  assert.equal((await f.inspectBuild(f.dir,f.declaration)).status,'verified');
  await fs.appendFile(path.join(f.shared,'tooling/base.json'),' ');
  const stale=await f.inspectBuild(f.dir,f.declaration);
  assert.equal(stale.status,'stale');assert.match(stale.message,/tooling\/base.json/);
});
test('absolute or different tooling links remain outside the trust boundary',async()=>{
  for(const kind of ['absolute','different']) {
    const f=await fixture();await fs.unlink(f.link);
    const target=kind==='absolute'?path.join(f.shared,'tooling'):path.join(f.base,'other/tooling');
    if(kind==='different')await fs.mkdir(target,{recursive:true});
    await fs.symlink(kind==='absolute'?target:path.relative(f.privateRoot,target),f.link);
    await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/relative|executing shared tooling/);
  }
});
test('shared tooling cannot hide file, directory or repository-marker links',async()=>{
  for(const kind of ['file','directory','marker']) {
    const f=await fixture(),tooling=path.join(f.shared,'tooling');
    if(kind==='file') {await fs.unlink(path.join(tooling,'base.json'));await fs.symlink('build-manifest.mjs',path.join(tooling,'base.json'));}
    if(kind==='directory') {await fs.mkdir(path.join(tooling,'real'));await fs.writeFile(path.join(tooling,'real/base.json'),'{}');await fs.symlink('real',path.join(tooling,'config'));f.declaration.repositoryInputs=['tooling/config/base.json'];}
    if(kind==='marker') {await fs.unlink(path.join(f.shared,'.git'));await fs.symlink('../private/.git',path.join(f.shared,'.git'));}
    await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/符号链接/);
  }
});
test('package symlinks and upward repository input paths are still rejected',async()=>{
  const f=await fixture();await fs.rename(path.join(f.dir,'src'),path.join(f.dir,'real-src'));await fs.symlink('real-src',path.join(f.dir,'src'));
  await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/符号链接/);
  f.declaration.repositoryInputs=['tooling/../package.json'];
  await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/越界/);
});
test('repository shared files are hashed from the declaring repository beside a tooling link',async()=>{
  const f=await fixture(),shared=path.join(f.privateRoot,'shared');
  await fs.mkdir(shared);await fs.writeFile(path.join(shared,'example.mjs'),'private source');
  f.declaration.repositoryInputs.push('shared/example.mjs');
  const stamp=await f.snapshotBuild(f.dir,f.declaration);
  await fs.writeFile(path.join(f.dir,f.declaration.manifest),JSON.stringify(stamp));
  assert.equal((await f.inspectBuild(f.dir,f.declaration)).status,'verified');
  await fs.appendFile(path.join(shared,'example.mjs'),' changed');
  const stale=await f.inspectBuild(f.dir,f.declaration);
  assert.equal(stale.status,'stale');assert.match(stale.message,/shared\/example.mjs/);
});
test('repository shared file declarations reject directory and file links',async()=>{
  for(const kind of ['root','directory','file']) {
    const f=await fixture(),shared=path.join(f.privateRoot,'shared'),real=path.join(f.privateRoot,'actual');
    await fs.mkdir(real);await fs.writeFile(path.join(real,'example.mjs'),'source');
    if(kind==='root')await fs.symlink('actual',shared);
    else {await fs.mkdir(shared);if(kind==='file')await fs.symlink('../actual/example.mjs',path.join(shared,'example.mjs'));else await fs.symlink('../actual',path.join(shared,'nested'));}
    f.declaration.repositoryInputs=[kind==='directory'?'shared/nested/example.mjs':'shared/example.mjs'];
    await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/符号链接/);
  }
});
test('repository shared declarations still require exact normal files',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.privateRoot,'shared'));
  for(const name of ['shared/*','shared/../package.json','shared']) {
    f.declaration.repositoryInputs=[name];await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/通配符|越界|only accepts/);
  }
  f.declaration.repositoryInputs=['shared/empty'];await fs.mkdir(path.join(f.privateRoot,'shared/empty'));
  await assert.rejects(f.snapshotBuild(f.dir,f.declaration),/普通文件/);
});

