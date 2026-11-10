import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'linked-cli-'));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
test('a CLI called through shared tooling operates on its calling repository',async()=>{
  const shared=path.join(root,'shared'),privateRoot=path.join(root,'private');
  await fs.mkdir(path.join(shared,'tooling'),{recursive:true});
  for(const name of ['cli.mjs','scaffold.mjs'])await fs.copyFile(new URL('../'+name,import.meta.url),path.join(shared,'tooling',name));
  for(const [repository,name] of [[shared,'dsh-public-example'],[privateRoot,'dsh-private-example']]){
    await fs.mkdir(path.join(repository,name),{recursive:true});
    await fs.writeFile(path.join(repository,name,'package.json'),JSON.stringify({name,scripts:{check:'node --version',build:'node --version'}}));
  }
  await fs.symlink(path.relative(privateRoot,path.join(shared,'tooling')),path.join(privateRoot,'tooling'));
  const result=spawnSync(process.execPath,[path.join(privateRoot,'tooling/cli.mjs'),'list'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/dsh-private-example/);
  assert.doesNotMatch(result.stdout,/dsh-public-example/);
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`import {repositoryRoot} from ${JSON.stringify(pathToFileURL(path.join(shared,'tooling/cli.mjs')).href)};console.log(repositoryRoot)`],{cwd:privateRoot,encoding:'utf8'});
  assert.equal(imported.status,0,imported.stderr);
  assert.equal(imported.stdout.trim(),await fs.realpath(privateRoot));
});
