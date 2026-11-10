import { readFileSync } from 'node:fs'

export const PLATFORM_MODULES = Object.freeze({
  minimal: Object.freeze([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]),
  web: Object.freeze([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-web-react', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-schema-form',
  ]),
})

export function packageId(url) {
  const id = JSON.parse(readFileSync(new URL('./package.json', url), 'utf8')).name
  if (typeof id !== 'string' || !id) throw new Error('插件包必须声明 name')
  return id
}

export function hostConfig(options = {}) {
  const { dependencyMode = 'deps', ...overrides } = options
  if (!['deps', 'legacy'].includes(dependencyMode)) throw new Error('未知的依赖打包模式')
  return {
    entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node',
    target: 'es2024', dts: false, sourcemap: true, fixedExtension: false,
    // 只清产物文件，不能递归清理可能带有外部软链的整个目录。
    clean: ['lib/*.js*'],
    ...(dependencyMode === 'legacy'
      ? { external: [/^@deepseek-ai\//] }
      : { deps: { neverBundle: [/^@deepseek-ai\//] } }),
    ...overrides,
  }
}

export function clientConfig(options) {
  const { id, modules = 'minimal', dependencyMode = 'deps', purity = {}, ...overrides } = options
  if (typeof id !== 'string' || !id) throw new Error('客户端必须声明插件包名')
  if (!['deps', 'legacy'].includes(dependencyMode)) throw new Error('未知的依赖打包模式')
  const platform = typeof modules === 'string' ? PLATFORM_MODULES[modules] : modules
  if (!Array.isArray(platform)) throw new Error('未知的平台模块表')
  const external = [...platform]
  const inline = id => external.includes(id) ? undefined : true
  const gate = {
    name: purity.name ?? 'purity-gate',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (external.includes(source) || (purity.allow ?? []).some(rule => rule.test(source))) return null
      throw new Error(`client bundle purity: "${source}" ${purity.message ?? '不在平台模块表——跨插件值导入禁止；协作走 cordis 服务'}`)
    },
  }
  return {
    name: `${id}/client`, entry: { client: 'src/client/index.tsx' },
    outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2024',
    dts: false, sourcemap: true, clean: false, fixedExtension: false,
    ...(dependencyMode === 'legacy'
      ? { external, noExternal: inline }
      : { deps: { neverBundle: external, alwaysBundle: inline } }),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: purity === false ? [] : [gate],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
    ...overrides,
  }
}
