import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { hostConfig, clientConfig, packageId, PLATFORM_MODULES } from '../tsdown.mjs'

for (const dependencyMode of ['deps', 'legacy']) {
  test(`宿主保持服务身份、窄清理和覆盖项：${dependencyMode}`, () => {
    const config = hostConfig({dependencyMode})
    const external = config.deps?.neverBundle ?? config.external
    assert.ok(external[0].test('@deepseek-ai/dsh-agent'))
    assert.ok(!external[0].test('other'))
    assert.deepEqual(config.clean, ['lib/*.js*'])
    assert.equal(config.format, 'esm')
    assert.equal(config.platform, 'node')
    assert.equal(hostConfig({target:'es2022',sourcemap:false,clean:undefined}).clean, undefined)
    assert.equal(hostConfig({deps:undefined}).deps, undefined)
  })
  for (const modules of ['minimal', 'web']) {
    test(`浏览器模块表、纯度和闭包外壳：${dependencyMode}/${modules}`, () => {
      const config = clientConfig({id:'dsh-fixture',dependencyMode,modules})
      const external = config.deps?.neverBundle ?? config.external
      const inline = config.deps?.alwaysBundle ?? config.noExternal
      assert.deepEqual(external, PLATFORM_MODULES[modules])
      for(const id of external)assert.equal(inline(id),undefined)
      assert.equal(inline('ordinary-library'),true)
      const gate=config.plugins[0]
      for(const id of external)assert.equal(gate.resolveId(id),null)
      assert.equal(gate.resolveId('ordinary-library'),null)
      assert.throws(()=>gate.resolveId('@deepseek-ai/dsh-agent'),/跨插件/)
      assert.equal(config.clean,false)
      assert.equal(config.fixedExtension,false)
      let loaded
      const {banner,intro,footer}=config.outputOptions
      vm.runInNewContext(banner+'\n'+intro+'\nexports.apply = function () {}; exports.platform = require("react");\n'+footer,{
        window:{__ModuleLoader__:{load:module=>{loaded=module}}},
      })
      assert.equal(loaded.id,'dsh-fixture')
      const marker={}
      const plugin=loaded.factory(id=>{assert.equal(id,'react');return marker})
      assert.equal(typeof plugin.apply,'function')
      assert.equal(plugin.platform,marker)
    })
  }
}

test('自定义纯度规则只放行声明的无身份贡献',()=>{
  const config=clientConfig({id:'fixture',purity:{name:'custom',allow:[/^@deepseek-ai\/dsh-tools\/remote$/],message:'forbidden'}})
  assert.equal(config.plugins[0].name,'custom')
  assert.equal(config.plugins[0].resolveId('@deepseek-ai/dsh-tools/remote'),null)
  assert.throws(()=>config.plugins[0].resolveId('@deepseek-ai/dsh-tools'),/forbidden/)
})
test('没有纯度闸门的旧插件保持原行为，额外插件不丢失',()=>{
  const plugin={name:'css'}
  const config=clientConfig({id:'fixture',purity:false,plugins:[plugin],target:undefined,fixedExtension:undefined,define:undefined})
  assert.deepEqual(config.plugins,[plugin])
  assert.equal(config.target,undefined)
  assert.equal(config.fixedExtension,undefined)
  assert.equal(config.define,undefined)
})
test('模块表不共享可变数组，包名由配置所在目录读取',()=>{
  const first=clientConfig({id:'fixture'})
  first.deps.neverBundle.push('injected')
  assert.ok(!clientConfig({id:'other'}).deps.neverBundle.includes('injected'))
  assert.ok(Object.isFrozen(PLATFORM_MODULES.minimal))
  assert.equal(packageId(new URL('../../dsh-image-cap/tsdown.config.ts',import.meta.url)),'dsh-image-cap')
  assert.throws(()=>clientConfig({id:''}),/包名/)
  assert.throws(()=>clientConfig({id:'fixture',modules:'unknown'}),/模块表/)
  assert.throws(()=>clientConfig({id:'fixture',dependencyMode:'typo'}),/打包模式/)
  assert.throws(()=>hostConfig({dependencyMode:'typo'}),/打包模式/)
})
