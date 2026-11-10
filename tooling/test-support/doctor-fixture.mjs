import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {snapshotBuild} from '../build-manifest.mjs';
import {doctor,inspectData,startupOverlay,lockMismatch,singletonCheck,run,redact,modelAnswer,unverifiedBuilds,failureText,appPnpm,profilePatchCheck} from '../doctor.mjs';
import {fileURLToPath} from 'node:url';
const app='/Applications/DeepSeek Harness.app',electron=app+'/Contents/MacOS/DeepSeek Harness',runtime=app+'/Contents/Resources/app.asar/dsh';
const available=await fs.access(electron).then(()=>true,()=>false);
const root=await fs.mkdtemp('/tmp/doc-test-');
test.after(()=>fs.rm(root,{recursive:true,force:true}));
const manifest={dependencies:{fixture:'link:../fixture'}};
const good=()=>({version:'0.2.0-rc.2',errors:{},entries:[{id:'ok'}],skipped:[],bundles:[{name:'fixture',mainExists:true,client:true,clientExists:true,clientShape:true}],modules:{storeDir:'/tmp/example/Library/pnpm/store/v11'},globalConfig:{},lock:{importers:{'.':{dependencies:{fixture:{specifier:'link:../fixture',version:'link:../fixture'}}}}}});
const get=(data,id)=>inspectData(data,manifest,'/tmp/example/Library/pnpm/store/v11').find(c=>c.id===id);
async function probe(label,{peer='>=0.2.0-rc.1',exempt,client='window.__ModuleLoader__.load({id:"fixture",factory:require=>{throw Error("must not execute")}});',main=true,missing=false,duplicate=false,scopes=false,brokenLink=false,missingClient=false,modules,globalConfig,lock,linkBuild}={}){
 const dir=path.join(root,label),pkg=path.join(dir,'node_modules/fixture');await fs.mkdir(pkg,{recursive:true});
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'fixture-profile',dsh:{profile:{bundles:['fixture']}}}));
 const patch=duplicate?'- insert:\n    - id: fixture\n      name: fixture\n    - id: fixture\n      name: fixture\n':scopes?'- insert:\n    - id: a\n      group: true\n      config:\n        - id: reused\n          name: fixture\n    - id: b\n      group: true\n      config:\n        - id: reused\n          name: fixture\n':'- insert:\n    - id: fixture\n      name: fixture\n';
 await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',type:'module',exports:{'.':'./lib/index.js','./package.json':'./package.json','./client':'./client.js'},dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'}},peerDependencies:{'@deepseek-ai/dsh-tools':peer}}));
 if(exempt)await fs.writeFile(path.join(dir,'compatibility.json'),JSON.stringify({'fixture@1.0.0':[exempt]}));await fs.writeFile(path.join(pkg,'cordis.patch.yml'),patch);await fs.writeFile(path.join(pkg,'client.js'),client);if(main){await fs.mkdir(path.join(pkg,'lib'));await fs.writeFile(path.join(pkg,'lib/index.js'),'export function apply(){}');}
 if(linkBuild){
    const declaration={manifest:'./lib/dsh-build.json',inputs:['src','python','package.json'],outputs:['lib','client.js']};
    const file=path.join(pkg,'package.json'),m=JSON.parse(await fs.readFile(file,'utf8'));if(linkBuild!=='legacy')m.dsh.build=declaration;await fs.writeFile(file,JSON.stringify(m));
    await fs.mkdir(path.join(pkg,'src'));await fs.mkdir(path.join(pkg,'python'));
    await fs.writeFile(path.join(pkg,'src/index.ts'),'export function apply(){}');await fs.writeFile(path.join(pkg,'python/bootstrap.py'),'VERSION = 1');
    const hashes=async names=>Object.fromEntries(await Promise.all(names.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(pkg,name))).digest('hex')])));
    let stamp={schemaVersion:1,algorithm:'sha256',inputs:await hashes(['src/index.ts','python/bootstrap.py','package.json']),outputs:await hashes(['lib/index.js','client.js'])};
    if(linkBuild.startsWith('repository-')) {
      const repository=path.join(dir,'repository');await fs.mkdir(path.join(repository,'tooling'),{recursive:true});
      await fs.writeFile(path.join(repository,'.git'),'gitdir: fixture');
      await fs.writeFile(path.join(repository,'tooling/tsconfig.base.json'),'{}');
      declaration.repositoryInputs=['tooling/tsconfig.base.json'];m.dsh.build=declaration;await fs.writeFile(file,JSON.stringify(m));
      await fs.rename(pkg,path.join(repository,'fixture'));await fs.symlink(path.join(repository,'fixture'),pkg);
      stamp=await snapshotBuild(pkg,declaration);
      if(linkBuild==='repository-stale')await fs.writeFile(path.join(repository,'tooling/tsconfig.base.json'),'changed');
      if(linkBuild==='repository-missing')await fs.unlink(path.join(repository,'tooling/tsconfig.base.json'));
    }
    if(!['missing','legacy'].includes(linkBuild))await fs.writeFile(path.join(pkg,'lib/dsh-build.json'),JSON.stringify(stamp));
    if(linkBuild==='ts-stale')await fs.writeFile(path.join(pkg,'src/index.ts'),'export function apply(){return 2}');
    if(linkBuild==='python-stale')await fs.writeFile(path.join(pkg,'python/bootstrap.py'),'VERSION = 2');
    if(!linkBuild.startsWith('repository-')){await fs.rename(pkg,path.join(dir,'linked-fixture'));await fs.symlink(path.join(dir,'linked-fixture'),pkg);}
    const profileFile=path.join(dir,'package.json'),profileManifest=JSON.parse(await fs.readFile(profileFile,'utf8'));profileManifest.dependencies={fixture:'link:./linked-fixture'};await fs.writeFile(profileFile,JSON.stringify(profileManifest));
  }
 if(missing)await fs.rename(pkg,path.join(dir,'not-installed'));
 if(brokenLink){await fs.rename(pkg,path.join(dir,'not-installed'));await fs.symlink(path.join(dir,'nonexistent'),pkg);}
  if(missingClient)await fs.unlink(path.join(pkg,'client.js'));
  for(const [file,value] of [['node_modules/.modules.yaml',modules],['config.yaml',globalConfig],['pnpm-lock.yaml',lock]])if(value)await fs.writeFile(path.join(dir,file),JSON.stringify(value));
  return appProbe(dir);
}
async function appProbe(dir){
 const r=await run(electron,['--expose-internals',fileURLToPath(new URL('../app-probe.mjs',import.meta.url)),runtime,dir,dir,path.join(dir,'config.yaml')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeoutMs:60000});
 assert.equal(r.ok,true,r.stderr);return JSON.parse(r.stdout.split('\n').find(l=>l.startsWith('DSH_DOCTOR_DATA:')).slice(16));
}
async function startupFixture(label,source,extraBundle=null,extraOverlay='',profilePatch=''){
 const home=path.join(root,'startup-'+label),profile=path.join(home,'profiles/probe'),pkg=path.join(profile,'node_modules/fixture');await fs.mkdir(pkg,{recursive:true});
 await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'fixture-profile',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','fixture',...(extraBundle?[extraBundle.name]:[])]}}}));
 await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));await fs.writeFile(path.join(pkg,'index.js'),source);await fs.writeFile(path.join(pkg,'cordis.patch.yml'),'- insert:\n    - id: fixture\n      name: fixture\n');
 if(extraBundle)await fs.symlink(extraBundle.path,path.join(profile,'node_modules',extraBundle.name));
 if(profilePatch)await fs.writeFile(path.join(profile,'cordis.patch.yml'),profilePatch);
 const overlay=path.join(home,'ready.yml');await fs.writeFile(overlay,startupOverlay((await appProbe(profile)).entries,fileURLToPath(new URL('../ready-probe.mjs',import.meta.url)))+extraOverlay);
 const r=await run(app+'/Contents/Resources/runtime/cli/bin/dsh',['--profile','probe','--patch',overlay],{cwd:profile,env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},timeoutMs:60000});
 // The host prints this line right before handing the URL to the user's default browser.
 assert.doesNotMatch(r.stdout,/opening the default browser/,'startup fixture must not open the default browser');
 return r;
}

export {app,electron,runtime,available,root,manifest,good,get,probe,appProbe,startupFixture};
