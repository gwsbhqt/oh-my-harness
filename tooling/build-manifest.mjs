import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ignored=new Set(['node_modules','.git','.cache','__pycache__']);
const ignoredFile=name=>/\.py[co]$/.test(name);
function relative(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||path.posix.isAbsolute(value))throw new Error('构建路径必须为包内相对路径');
  const parts=value.replace(/^\.\//,'').split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||ignored.has(p)||ignoredFile(p)))throw new Error('构建路径不能越界或指向依赖/缓存: '+value);
  return parts.join('/');
}
function repositoryFile(value) {
  const name=relative(value);
  if(/[?*\[\]]/.test(name))throw new Error('repositoryInputs 不允许通配符: '+value);
  if(name!==value||!(name.startsWith('tooling/')||name.startsWith('shared/')))throw new Error('repositoryInputs only accepts tooling files or shared files: '+value);
  return name;
}
function declarationOf(value) {
  if(!value||typeof value!=='object')throw new Error('缺少 dsh.build 声明');
  const manifest=relative(value.manifest),roots={};
  for(const kind of ['inputs','outputs']) {
    if(!Array.isArray(value[kind])||!value[kind].length)throw new Error('dsh.build.'+kind+' 必须非空');
    roots[kind]=[...new Set(value[kind].map(relative))].sort();
  }
  for(const a of roots.inputs)for(const b of roots.outputs)if(a===b||a.startsWith(b+'/')||b.startsWith(a+'/'))throw new Error('构建输入与输出不能重叠');
  if(!roots.outputs.some(r=>manifest.startsWith(r+'/')))throw new Error('manifest 必须在输出目录中');
  if(!roots.inputs.includes('package.json'))throw new Error('inputs 必须包含 package.json');
  if(value.repositoryInputs!==undefined&&!Array.isArray(value.repositoryInputs))throw new Error('dsh.build.repositoryInputs 必须是文件数组');
  const repositoryInputs=[...new Set((value.repositoryInputs??[]).map(repositoryFile))].sort();
  return {manifest,...roots,repositoryInputs};
}
async function safeStat(dir,name) {
  let current=dir,stat;
  for(const part of name.split('/')) {
    current=path.join(current,part);stat=await fs.lstat(current);
    if(stat.isSymbolicLink())throw new Error('构建清单不跟随符号链接: '+name);
  }
  return stat;
}
async function repositoryInput(repository,name) {
  if(!name.startsWith('tooling/'))return {file:path.join(repository,name),stat:await safeStat(repository,name)};
  const linked=path.join(repository,'tooling'),entry=await fs.lstat(linked);
  if(!entry.isSymbolicLink())return {file:path.join(repository,name),stat:await safeStat(repository,name)};
  if(path.isAbsolute(await fs.readlink(linked)))throw new Error('符号链接: The tooling link must be relative');
  const target=await fs.realpath(linked),own=await fs.realpath(path.dirname(fileURLToPath(import.meta.url)));
  if(target!==own)throw new Error('符号链接: The tooling link must target the executing shared tooling');
  const marker=await safeStat(path.dirname(target),'.git');
  if(!marker.isFile()&&!marker.isDirectory())throw new Error('Shared tooling must belong to a source repository');
  const suffix=name.slice('tooling/'.length);
  return {file:path.join(target,suffix),stat:await safeStat(target,suffix)};
}
async function snapshot(dir,value,kinds=['inputs','outputs']) {
  dir=await fs.realpath(dir);
  const declaration=declarationOf(value);
  // Python is loaded directly from disk; a TS-only stamp cannot prove one coherent runtime.
  for(const root of ['src','python','vendor']) {
    const present=await fs.lstat(path.join(dir,root)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
    if(present&&!declaration.inputs.includes(root))throw new Error('inputs 必须覆盖运行时目录: '+root);
  }
  const result={schemaVersion:1,algorithm:'sha256',inputs:{},outputs:{}};
  if(declaration.repositoryInputs.length)result.repositoryInputs={};
  let files=0,bytes=0;
  const walk=async(name,kind)=>{
    if(name===declaration.manifest)return;
    const stat=await safeStat(dir,name);
    if(stat.isDirectory()) {
      for(const child of (await fs.readdir(path.join(dir,name))).sort())if(!ignored.has(child)&&!ignoredFile(child))await walk(name+'/'+child,kind);
    }else if(stat.isFile()) {
      if(Object.hasOwn(result[kind],name))return;
      files++;bytes+=stat.size;
      if(files>20000||bytes>128*1024*1024)throw new Error('构建内容检查超出文件或字节预算');
      result[kind][name]=createHash('sha256').update(await fs.readFile(path.join(dir,name))).digest('hex');
    }else throw new Error('构建清单只支持普通文件: '+name);
  };
  for(const kind of kinds) {
    for(const root of declaration[kind])await walk(root,kind);
    if(!Object.keys(result[kind]).length)throw new Error(kind+' 未包含任何文件');
  }
  if(declaration.repositoryInputs.length) {
    // Only the direct repository parent is trusted; installed packages cannot invent a root.
    const repository=path.dirname(dir),marker=await safeStat(repository,'.git');
    if(!marker.isFile()&&!marker.isDirectory())throw new Error('repositoryInputs 无法确认源码仓库 root');
    for(const name of declaration.repositoryInputs) {
      const {file,stat}=await repositoryInput(repository,name);
      if(!stat.isFile())throw new Error('repositoryInputs 只支持普通文件: '+name);
      files++;bytes+=stat.size;
      if(files>20000||bytes>128*1024*1024)throw new Error('构建内容检查超出文件或字节预算');
      result.repositoryInputs[name]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  return result;
}
export async function snapshotInputs(dir,declaration) {
  return (await snapshot(dir,declaration,['inputs'])).inputs;
}
export async function snapshotInputState(dir,declaration) {
  const stamp=await snapshot(dir,declaration,['inputs']);
  return {inputs:stamp.inputs,repositoryInputs:stamp.repositoryInputs??{}};
}
export async function snapshotBuild(dir,declaration) {
  return snapshot(dir,declaration);
}
function validateStamp(stamp,declaration) {
  if(stamp?.schemaVersion!==1||stamp.algorithm!=='sha256')throw new Error('不支持的构建清单版本或算法');
  for(const kind of ['inputs','outputs',...(declaration.repositoryInputs.length||stamp.repositoryInputs!==undefined?['repositoryInputs']:[])]) {
    const values=stamp[kind];
    if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length)throw new Error('清单 '+kind+' 必须非空');
    for(const [name,hash] of Object.entries(values))if((kind==='repositoryInputs'?repositoryFile(name):relative(name))!==name||!/^[a-f0-9]{64}$/.test(hash))throw new Error('非法构建清单项: '+name);
  }
}
export async function inspectBuild(dir,value,requiredOutputs=[]) {
  if(!value)return {ok:false,status:'unverified',message:'未声明 dsh.build；无法证明源码与产物一致'};
  let declaration,stamp;
  try {
    declaration=declarationOf(value);
    const stat=await safeStat(await fs.realpath(dir),declaration.manifest);
    if(!stat.isFile()||stat.size>8*1024*1024)throw new Error('构建清单不是普通小文件');
    stamp=JSON.parse(await fs.readFile(path.join(dir,declaration.manifest),'utf8'));validateStamp(stamp,declaration);
  }catch(e) {return {ok:false,status:'unverified',message:'无法证明构建一致: '+e.message};}
  try {
    const current=await snapshot(dir,declaration),differences=[];
    for(const kind of ['inputs','outputs','repositoryInputs'])for(const name of new Set([...Object.keys(stamp[kind]??{}),...Object.keys(current[kind]??{})]))if(stamp[kind]?.[name]!==current[kind]?.[name])differences.push(kind+': '+name);
    for(const output of requiredOutputs.filter(Boolean))if(!Object.hasOwn(current.outputs,relative(output)))throw new Error('outputs 未覆盖运行时入口: '+output);
    return differences.length?{ok:false,status:'stale',message:'构建内容已变化: '+differences.slice(0,20).join('; '),differenceCount:differences.length}:{ok:true,status:'verified',message:'源码、动态运行时和产物内容哈希与构建清单一致'};
  }catch(e) {return {ok:false,status:'unverified',message:'无法证明构建一致: '+e.message};}
}
