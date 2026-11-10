import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverPlugins, repositoryRoot } from '../cli.mjs'

function parseJsonConfig(source) {
  let text = ''
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (char === '\n') { lineComment = false; text += char }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1 }
      else if (char === '\n') text += char
      continue
    }
    if (quote) {
      text += char
      if (char === '\\') { text += source[++i] ?? ''; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"') { quote = char; text += char; continue }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue }
    text += char
  }
  return JSON.parse(text)
}

async function referencedInputs(pluginDir) {
  const pending = ['scripts/build.mjs', 'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts', 'tsdown.config.mjs']
    .map(name => path.join(pluginDir,name))
  const visitSource=async dir=>{
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      if(entry.isDirectory())await visitSource(path.join(dir,entry.name))
      else if(/\.(?:ts|tsx|js|mjs)$/.test(entry.name))pending.push(path.join(dir,entry.name))
    }
  }
  await visitSource(path.join(pluginDir,'src'))
  const seen=new Set(), inputs=new Set()
  while(pending.length){
    const file=pending.pop()
    if(seen.has(file))continue
    seen.add(file)
    let source
    try{source=await fs.readFile(file,'utf8')}catch(e){if(e.code==='ENOENT')continue;throw e}
    const relative=path.relative(repositoryRoot,file).split(path.sep).join('/')
    if(relative.startsWith('tooling/')){
      inputs.add(relative)
      if(file.endsWith('.mjs'))pending.push(file.slice(0,-4)+'.d.mts')
    }
    if(file.endsWith('.json')){
      const extendsPath=parseJsonConfig(source).extends
      if(typeof extendsPath==='string' && extendsPath.startsWith('.'))pending.push(path.resolve(path.dirname(file),extendsPath))
    }else{
      for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){
        const target=path.resolve(path.dirname(file),match[1])
        if(target.startsWith(path.join(repositoryRoot,'tooling')+path.sep))pending.push(target)
      }
    }
  }
  return inputs
}

test('全仓共用源码和编译配置的递归依赖都纳入构建内容清单',async()=>{
  const plugins=discoverPlugins(repositoryRoot)
  assert.ok(plugins.length>0)
  for(const plugin of plugins){
    assert.equal(plugin.error,undefined,plugin.directory)
    const declaration=plugin.pkg.dsh?.build
    assert.ok(declaration,`${plugin.directory} 缺构建声明`)
    const inputs=await referencedInputs(path.join(repositoryRoot,plugin.directory))
    for(const input of inputs)assert.ok(declaration.repositoryInputs?.includes(input),`${plugin.directory} 缺共用输入 ${input}`)
  }
})

async function sourceFiles(dir) {
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(file))
    else if (/\.tsx?$/.test(entry.name)) files.push(file)
  }
  return files
}

function applyReturnTypes(source) {
  const found = []
  for (const match of source.matchAll(/export\s+(async\s+)?function\s+apply\s*(?:<[^>]*>)?\(/g)) {
    let depth = 1, i = match.index + match[0].length
    while (depth > 0 && i < source.length) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
      i++
    }
    const annotation = /^\s*:\s*([^{\n]+?)\s*(?:\{|$)/m.exec(source.slice(i))
    found.push({ async: match[1] !== undefined, returns: annotation?.[1], line: source.slice(0, match.index).split('\n').length })
  }
  return found
}

test('叫 apply 的函数一律声明为不返回值', async () => {
  // cordis 把普通 function 当构造函数 new，返回的撤销函数直接丢掉，补丁卸不掉；撤销要挂在 ctx.effect 上。
  for (const plugin of discoverPlugins(repositoryRoot)) {
    const src = path.join(repositoryRoot, plugin.directory, 'src')
    for (const file of await sourceFiles(src).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      for (const found of applyReturnTypes(await fs.readFile(file, 'utf8'))) {
        const where = `${path.relative(repositoryRoot, file)}:${found.line}`
        assert.equal(found.returns, found.async ? 'Promise<void>' : 'void', `${where} 的 apply 必须声明返回 ${found.async ? 'Promise<void>' : 'void'}；要撤销的东西用 ctx.effect 挂上，不靠返回值`)
      }
    }
  }
})

