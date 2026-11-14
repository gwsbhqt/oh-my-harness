import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {fixture,put} from '../../tooling/test-support/rebuild-fixture.mjs';
import {run,appPnpm} from '../../tooling/doctor.mjs';
const source=fileURLToPath(new URL('../',import.meta.url));

test('共享 doctor 核心变化：只重建私有注册包，再跑完整真实试启动',async()=>{
  const f=await fixture('doctor-regression');
  const dir=f.dir('dsh-doctor');
  for(const name of ['package.json','pnpm-lock.yaml','cordis.patch.yml','scripts/build.mjs','src/index.js','bin/doctor.mjs'])await put(dir,name,await fs.readFile(path.join(source,name),'utf8'));
  await fs.cp(await fs.realpath(new URL('../../tooling/',import.meta.url)),path.join(f.repository,'tooling'),{recursive:true});
  f.manifest.dependencies['dsh-doctor']='link:'+dir;f.manifest.dsh.profile.bundles.push('dsh-doctor');
  await put(f.profile,'package.json',JSON.stringify(f.manifest));await fs.symlink(dir,path.join(f.profile,'node_modules/dsh-doctor'));
  const first=await f.build();assert.equal(first.ok,true,JSON.stringify(first));
  await fs.appendFile(path.join(f.repository,'tooling/doctor.mjs'),'\n// changed doctor input\n');
  const report=await f.build();assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.plugins.filter(p=>p.built).map(p=>p.name),['dsh-doctor']);
  const row=report.plugins.find(p=>p.name==='dsh-doctor');assert.match(row.before.message,/tooling\/doctor.mjs/);assert.equal(row.after.status,'verified');
  assert(report.plugins.filter(p=>p.name!=='dsh-doctor').every(p=>p.action==='skip'&&!p.build));
  const app='/Applications/DeepSeek Harness.app',pnpm=await appPnpm(app);assert(pnpm,'完整 doctor 回归需要实际 App');
  const version=(await fs.readFile(pnpm.dist,'utf8')).match(/STORE_VERSION = "(v[0-9]+)"/)[1];
  await put(f.profile,'node_modules/.modules.yaml',JSON.stringify({storeDir:path.join(os.homedir(),'Library/pnpm/store',version)}));
  const dependencies=Object.fromEntries(Object.entries(f.manifest.dependencies).map(([name,specifier])=>[name,{specifier,version:specifier}]));
  await put(f.profile,'pnpm-lock.yaml',JSON.stringify({lockfileVersion:'9.0',importers:{'.':{dependencies}}}));
  const result=await run(process.execPath,[path.join(dir,'bin/doctor.mjs'),'--home',f.home,'--profile','probe','--json','--sanitize-env'],{env:{...process.env,PNPM_HOME:path.join(os.homedir(),'Library/pnpm')}});
  assert.equal(result.code,0,result.stdout+result.stderr);
  const doctor=JSON.parse(result.stdout);assert.equal(doctor.ok,true,JSON.stringify(doctor));
  assert.equal(doctor.checks.find(c=>c.id==='link-build-freshness').status,'verified');assert.equal(doctor.checks.find(c=>c.id==='isolated-startup').ok,true);
});

