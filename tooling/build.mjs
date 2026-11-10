import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {snapshotInputState,snapshotBuild} from './build-manifest.mjs';

const requiredInputs=['tooling/build.mjs','tooling/build-manifest.mjs'];

export async function buildPlugin(scriptUrl,{steps=[['tsdown']]}={}) {
  const dir=path.dirname(path.dirname(fileURLToPath(scriptUrl)));
  const pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  const declaration=pkg.dsh?.build;
  for(const name of requiredInputs) {
    const local=path.relative(dir,path.join(path.dirname(dir),name)).split(path.sep).join('/');
    const covered=declaration?.inputs?.some(root=>local===root.replace(/^\.\//,'')||local.startsWith(root.replace(/^\.\//,'')+'/'));
    if(!covered&&!declaration?.repositoryInputs?.includes(name))throw new Error('repositoryInputs 必须覆盖共用构建实现: '+name);
  }
  if(!Array.isArray(steps)||!steps.length)throw new Error('构建 steps 必须非空');
  const before=await snapshotInputState(dir,declaration);
  for(const step of steps) {
    if(typeof step==='function') {
      await step({dir});
      continue;
    }
    if(!Array.isArray(step)||!step.length||!step.every(v=>typeof v==='string')||!/^[a-zA-Z0-9_-]+$/.test(step[0]))throw new Error('构建命令必须是包内 node_modules/.bin 名称及字符串参数');
    const [bin,...args]=step;
    const exit=await new Promise((resolve,reject)=>{
      const child=spawn(path.join(dir,'node_modules','.bin',bin),args,{cwd:dir,stdio:'inherit'});
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    if(exit.code!==0||exit.signal)throw new Error(`编译失败，不生成构建清单：${bin} exit=${exit.code}, signal=${exit.signal}`);
  }
  const stamp=await snapshotBuild(dir,declaration);
  const after={inputs:stamp.inputs,repositoryInputs:stamp.repositoryInputs??{}};
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('构建期间输入内容变化，不生成构建清单；请完成修改后重新构建');
  const manifest=path.resolve(dir,declaration.manifest);
  const temporary=manifest+`.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(manifest),{recursive:true});
  let created=false;
  try {
    const handle=await fs.open(temporary,'wx');
    created=true;
    try {await handle.writeFile(JSON.stringify(stamp,null,2)+'\n');}finally {await handle.close();}
    await fs.rename(temporary,manifest);
  }finally {
    if(created)await fs.rm(temporary,{force:true});
  }
  console.log(`构建清单已生成：${declaration.manifest}（SHA256，${Object.keys(stamp.inputs).length}项包内输入，${Object.keys(stamp.repositoryInputs??{}).length}项仓库输入）`);
  return stamp;
}
