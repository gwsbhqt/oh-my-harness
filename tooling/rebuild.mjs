import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {inspectBuild,snapshotInputState} from './build-manifest.mjs';
import {run,failureText} from '../tooling/doctor.mjs';

const sections=['dependencies','optionalDependencies','devDependencies'];
function target(value) {
  if(typeof value==='string')return value;
  if(value&&typeof value==='object')return target(value.default??value.import??value.require);
}
async function regular(dir,name) {
  let current=dir;
  for(const part of name.split('/')) {
    current=path.join(current,part);
    const stat=await fs.lstat(current);
    if(stat.isSymbolicLink())throw new Error('不运行符号链接构建文件: '+current);
  }
  if(!(await fs.stat(current)).isFile())throw new Error('必须是普通文件: '+current);
}
async function packageState(dir,name) {
  await regular(dir,'package.json');
  const pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  if(pkg.name!==name)throw new Error(`登记名称与实际包名不一致: ${name} / ${pkg.name}`);
  const outputs=[target(pkg.exports?.['.'])??pkg.main,...(pkg.dsh?.client?[target(pkg.exports?.['./client'])]:[])].filter(Boolean);
  return {pkg,inspection:await inspectBuild(dir,pkg.dsh?.build,outputs)};
}

async function scanLinkedPlugins({repository,profile}) {
  if(!path.isAbsolute(repository??'')||!path.isAbsolute(profile??''))throw new Error('repository 和 profile 必须显式提供绝对目录');
  repository=await fs.realpath(repository);profile=await fs.realpath(profile);
  const marker=await fs.lstat(path.join(repository,'.git'));
  if(marker.isSymbolicLink()||(!marker.isFile()&&!marker.isDirectory()))throw new Error('repository 必须有真实 .git 标记');
  const manifestFile=path.join(profile,'package.json'),original=await fs.readFile(manifestFile,'utf8'),manifest=JSON.parse(original);
  const report={schemaVersion:1,ok:false,repository,profile,plugins:[],skipped:[],errors:[],summary:{}};
  const registered=new Map();
  for(const section of sections)for(const [name,specifier] of Object.entries(manifest[section]??{})) {
    if(registered.has(name)&&registered.get(name)!==specifier)throw new Error('依赖登记冲突: '+name);
    registered.set(name,specifier);
  }
  if(registered.size>512)throw new Error('profile 依赖超过 512 项扫描预算');
  // Only explicit profile links into the selected checkout authorize a builder.
  for(const [name,specifier] of registered) {
    if(typeof specifier!=='string'||!specifier.startsWith('link:')) {
      report.skipped.push({name,specifier,reason:'不是明确的本地 link 依赖'});continue;
    }
    const row={name,specifier,action:'failed',built:false};
    try {
      if(!specifier.slice(5))throw new Error('空 link 路径');
      const wanted=path.resolve(profile,specifier.slice(5));
      row.dir=await fs.realpath(wanted).catch(async e=>{
        if(e.code!=='ENOENT')throw e;
        // 新插件已登记但目录还没拉下来时，只有父目录是本仓库才算本仓库缺插件；别的仓库的断链由那个仓库报。
        if(await fs.realpath(path.dirname(wanted)).catch(()=>undefined)!==repository)return undefined;
        row.missing=true;row.dir=wanted;throw new Error('插件目录不存在: '+wanted);
      });
      if(!row.dir) {
        report.skipped.push({name,specifier,dir:wanted,reason:'链接目标不存在且不在指定仓库'});continue;
      }
      if(path.dirname(row.dir)!==repository) {
        report.skipped.push({name,specifier,dir:row.dir,reason:'真实路径不是指定仓库的直接插件目录'});continue;
      }
      const {pkg,inspection}=await packageState(row.dir,name);
      row.before=inspection;
      if(!pkg.dsh?.build)throw new Error('自有 link 插件未声明 dsh.build，不能自动构建');
      row.action=inspection.ok&&inspection.status==='verified'?'skip':'build';
    }catch(e){row.error=e.message;}
    report.plugins.push(row);
  }
  return {report,registered,manifestFile,original};
}

async function missingDependencies(profile,registered) {
  const missing=[];
  for(const name of registered.keys())if(!(await fs.stat(path.join(profile,'node_modules',name)).catch(()=>undefined)))missing.push(name);
  return missing;
}

export async function checkLinkedPlugins({repository,profile}={}) {
  const {report,registered}=await scanLinkedPlugins({repository,profile});
  report.mode='check';
  report.plugins=report.plugins.map(({name,specifier,dir,action,missing,before,error})=>({
    name,specifier,dir,action,
    status:missing?'missing':before?.status??'error',
    message:error??before?.message,
    ...(before?{before}:{}),
  }));
  report.missingDependencies=await missingDependencies(report.profile,registered);
  const count=status=>report.plugins.filter(p=>p.status===status).length;
  report.summary={scanned:report.plugins.length,verified:count('verified'),stale:count('stale'),unverified:count('unverified'),missing:count('missing'),error:count('error'),wouldBuild:report.plugins.filter(p=>p.action==='build').length,failed:report.plugins.filter(p=>p.action==='failed').length,skipped:report.skipped.length,missingDependencies:report.missingDependencies.length};
  report.ok=report.plugins.every(p=>p.action==='skip')&&report.missingDependencies.length===0;
  return report;
}

export async function rebuildLinkedPlugins({repository,profile,timeoutMs=120000}={}) {
  if(!path.isAbsolute(repository??'')||!path.isAbsolute(profile??''))throw new Error('repository 和 profile 必须显式提供绝对目录');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000)throw new Error('timeoutMs 必须为至少 1000 的整数');
  const {report,manifestFile,original}=await scanLinkedPlugins({repository,profile});
  profile=report.profile;
  for(const row of report.plugins.filter(p=>p.action==='build')) {
    try {
      if(await fs.realpath(path.resolve(profile,row.specifier.slice(5)))!==row.dir)throw new Error('构建前 link 目标变化');
      const {pkg}=await packageState(row.dir,row.name);
      if(pkg.scripts?.build!=='node scripts/build.mjs')throw new Error('自动构建只接受 build: node scripts/build.mjs');
      await regular(row.dir,'scripts/build.mjs');
      const covered=pkg.dsh.build.inputs?.some(root=>{root=root.replace(/^\.\//,'');return root==='scripts/build.mjs'||root==='scripts';});
      if(!covered)throw new Error('inputs 必须覆盖 scripts/build.mjs');
      const before=await snapshotInputState(row.dir,pkg.dsh.build);
      row.build=await run(process.execPath,['scripts/build.mjs'],{cwd:row.dir,timeoutMs});
      if(!row.build.ok)throw new Error(failureText(row.build,timeoutMs,'构建 '+row.name));
      const current=await packageState(row.dir,row.name);
      if(JSON.stringify(before)!==JSON.stringify(await snapshotInputState(row.dir,current.pkg.dsh?.build)))throw new Error('构建期间输入内容变化；不自动重试');
      row.after=current.inspection;
      if(!row.after.ok||row.after.status!=='verified')throw new Error('构建退出成功但复验失败: '+row.after.message);
      row.built=true;
    }catch(e){row.action='failed';row.error=e.message;}
  }
  // A later builder may change an earlier plugin's inputs. Rescan once, never loop.
  for(const row of report.plugins) {
    try {
      if(await fs.realpath(path.resolve(profile,row.specifier.slice(5)))!==row.dir)throw new Error('复验时 link 目标变化');
      row.after=(await packageState(row.dir,row.name)).inspection;
      if(!row.after.ok||row.after.status!=='verified')throw new Error('最终复验失败: '+row.after.message);
    }catch(e){row.action='failed';row.built=false;row.error??=e.message;}
  }
  if(await fs.readFile(manifestFile,'utf8')!==original)report.errors.push('构建期间 profile 依赖 manifest 变化；不自动重试');
  report.summary={scanned:report.plugins.length,built:report.plugins.filter(p=>p.built).length,skipped:report.skipped.length+report.plugins.filter(p=>p.action==='skip').length,failed:report.plugins.filter(p=>p.action==='failed').length};
  report.ok=report.summary.failed===0&&report.errors.length===0;
  return report;
}

const invoked=process.argv[1]?await fs.realpath(process.argv[1]).catch(()=>undefined):undefined;
if(invoked===await fs.realpath(fileURLToPath(import.meta.url))) {
  try {
    const {values}=parseArgs({options:{repository:{type:'string'},profile:{type:'string'},json:{type:'boolean'},check:{type:'boolean'},'timeout-ms':{type:'string'},help:{type:'boolean',short:'h'}}});
    if(values.help)console.log('node tooling/rebuild.mjs --repository <插件仓库绝对目录> --profile <实际 profile 绝对目录> [--json] [--check] [--timeout-ms 120000]\n只构建明确登记的自有 link 插件中未 verified 的项；最后全体复验。不执行 doctor 或重启。\n--check 只检查不构建：列出过期、缺失、缺依赖的插件和原因；全部一致退出 0，有要处理的退出 1。');
    else if(values.check) {
      const report=await checkLinkedPlugins({repository:values.repository,profile:values.profile});
      const pending=report.plugins.filter(p=>p.action!=='skip');
      console.log(values.json?JSON.stringify(report):[`${report.ok?'一致':'需要处理'}：检查 ${report.summary.scanned}，一致 ${report.summary.verified}，待构建 ${report.summary.wouldBuild}，不能自动构建 ${report.summary.failed}，缺依赖 ${report.summary.missingDependencies}`,...pending.map(p=>`${p.name}（${p.status}）: ${p.message}`),...report.missingDependencies.map(name=>`${name}: profile 里登记了但没装`)].join('\n'));
      process.exitCode=report.ok?0:1;
    }
    else {
      const report=await rebuildLinkedPlugins({repository:values.repository,profile:values.profile,timeoutMs:values['timeout-ms']===undefined?undefined:Number(values['timeout-ms'])});
      const failed=report.plugins.filter(p=>p.action==='failed');
      console.log(values.json?JSON.stringify(report):[`${report.ok?'通过':'失败'}：检查 ${report.summary.scanned}，构建 ${report.summary.built}，跳过 ${report.summary.skipped}，失败 ${report.summary.failed}`,...report.errors,...failed.map(p=>`${p.name}: ${p.error}`),...report.plugins.filter(p=>p.built).map(p=>`${p.name}: 构建成功，复验 verified`)].join('\n'));
      process.exitCode=report.ok?0:1;
    }
  }catch(e){console.error(e.message);process.exitCode=2;}
}