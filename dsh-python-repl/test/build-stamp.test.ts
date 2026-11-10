import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectBuild} from '../../tooling/build-manifest.mjs';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const declaration={manifest:'./lib/dsh-build.json',inputs:['src','python','vendor','scripts','package.json'],outputs:['lib'],repositoryInputs:['tooling/build.mjs','tooling/build-manifest.mjs']};
async function fixture(mode:'good'|'fail'|'mutate'){
  const root=await mkdtemp(join(tmpdir(),'dsh-build-stamp-'));
  const pkg=join(root,'dsh-python-repl');
  for(const dir of ['src','python','vendor','scripts','node_modules/.bin'])await mkdir(join(pkg,dir),{recursive:true});
  await mkdir(join(root,'tooling'),{recursive:true});
  await mkdir(join(root,'tooling'),{recursive:true});
  await writeFile(join(root,'.git'),'gitdir: fixture');
  await cp(join(sourceRoot,'../tooling/build.mjs'),join(root,'tooling/build.mjs'));
  await cp(join(sourceRoot,'../tooling/build-manifest.mjs'),join(root,'tooling/build-manifest.mjs'));
  await cp(join(sourceRoot,'scripts/build.mjs'),join(pkg,'scripts/build.mjs'));
  await writeFile(join(pkg,'package.json'),JSON.stringify({type:'module',dsh:{build:declaration}}));
  await writeFile(join(pkg,'src/index.ts'),'export const value=1;');
  await writeFile(join(pkg,'python/runtime.py'),'value=1\n');
  await writeFile(join(pkg,'vendor/runtime.py'),'value=1\n');
  const fake=join(pkg,'fake-compiler.mjs');
  await writeFile(fake,`#!/usr/bin/env node\nimport {mkdirSync,writeFileSync} from 'node:fs';\n${mode==='fail'?'process.exit(2);':''}\nmkdirSync('lib',{recursive:true});writeFileSync('lib/index.js','export const value=1;');\n${mode==='mutate'?"writeFileSync('src/index.ts','export const value=2;');":''}\n`,{mode:0o755});
  await symlink(fake,join(pkg,'node_modules/.bin/tsdown'));
  return {root,pkg};
}
for(const mode of ['good','fail','mutate'] as const)test('stamp '+mode,async()=>{
  const {root,pkg}=await fixture(mode);
  try{
    const result=spawnSync(process.execPath,[join(pkg,'scripts/build.mjs')],{cwd:pkg,encoding:'utf8',timeout:5000});
    assert.equal(result.signal,null,result.stderr);
    if(mode==='good'){
      assert.equal(result.status,0,result.stderr);
      const stamp=JSON.parse(await readFile(join(pkg,'lib/dsh-build.json'),'utf8'));
      assert.equal(stamp.schemaVersion,1);
      assert.equal((await inspectBuild(pkg,declaration,['lib/index.js'])).ok,true);
    }else{
      assert.notEqual(result.status,0);
      assert.match(result.stderr,mode==='fail'?/编译失败/:/构建期间输入内容变化/);
      await assert.rejects(readFile(join(pkg,'lib/dsh-build.json')),{code:'ENOENT'});
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
