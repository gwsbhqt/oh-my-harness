import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {rebuildLinkedPlugins} from '../rebuild.mjs';
import {run,appPnpm} from '../doctor.mjs';

export const checkout=fileURLToPath(new URL('../..',import.meta.url));
export const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-rebuild-test-'));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
export async function put(dir,name,text) {
  const file=path.join(dir,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);
}
export async function fixture(label,names=['dsh-first','dsh-second']) {
  const repository=path.join(root,label,'repository'),home=path.join(root,label,'home'),profile=path.join(home,'profiles/probe');
  await put(repository,'.git','gitdir: fixture');
  for(const name of ['tooling/build.mjs','tooling/build-manifest.mjs'])await put(repository,name,await fs.readFile(path.join(checkout,name),'utf8'));
  const manifest={name:'rebuild-profile',dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...names]}}};
  for(const name of names) {
    const dir=path.join(repository,name);
    const declaration={manifest:'lib/dsh-build.json',inputs:['src','scripts','package.json','cordis.patch.yml'],outputs:['lib'],repositoryInputs:['tooling/build.mjs','tooling/build-manifest.mjs']};
    await put(dir,'package.json',JSON.stringify({name,version:'1.0.0',type:'module',main:'lib/index.js',dsh:{build:declaration,bundle:{patch:'cordis.patch.yml'}},scripts:{build:'node scripts/build.mjs'}}));
    await put(dir,'src/index.js','export function apply(){}');
    await put(dir,'cordis.patch.yml',`- insert:\n    - id: ${name}\n      name: ${name}\n`);
    await put(dir,'scripts/build.mjs',`import fs from 'node:fs/promises';import path from 'node:path';import {buildPlugin} from '../../tooling/build.mjs';await buildPlugin(import.meta.url,{steps:[async({dir})=>{await fs.mkdir(path.join(dir,'lib'),{recursive:true});await fs.copyFile(path.join(dir,'src/index.js'),path.join(dir,'lib/index.js'));await fs.appendFile(path.join(dir,'calls'),'build\\n');}]});`);
    manifest.dependencies[name]='link:'+dir;
    const result=await run(process.execPath,['scripts/build.mjs'],{cwd:dir});assert.equal(result.ok,true,result.stderr);
    await fs.mkdir(path.join(profile,'node_modules'),{recursive:true});await fs.symlink(dir,path.join(profile,'node_modules',name));
  }
  await put(profile,'package.json',JSON.stringify(manifest));
  return {repository,home,profile,manifest,build:()=>rebuildLinkedPlugins({repository,profile}),dir:name=>path.join(repository,name)};
}
export async function changeBuilder(f,name,source) {await put(f.dir(name),'scripts/build.mjs',source);}

