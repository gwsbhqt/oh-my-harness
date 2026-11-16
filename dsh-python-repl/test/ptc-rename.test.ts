/**
 * `ptcCreativeMode` 的网页文案开关（src/client/rename.ts）。
 *
 * 两项都测真实接线，不测空壳：
 * 1. `renameCreator` 对官方原文的替换（介绍整句、工具半句、不重复加「PTC」、无关原样）；
 * 2. `syncPtcCreativeLocale` 真的包住 locale 服务的 `translate`，跟随配置快照 true/false
 *    改名与还原，卸载后方法回到原样。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  AGENT_PRESET_NS,
  PLUGIN_NS,
  SETTINGS_PRESETS_NS,
  renameCreator,
  syncPtcCreativeLocale,
  type PtcConfigScope,
  type PtcLocaleContext,
} from '../src/client/rename.ts'

describe('renameCreator', () => {
  it('replaces the whole Creator description with the PTC-Creator one', () => {
    assert.match(renameCreator('presetCordisDescription', '创造模式：具备标准任务工具'), /PTC 模式加上创造模式的加成/)
    assert.match(renameCreator('presetCordisDescription', 'Creator mode: includes the standard task tools'), /PTC mode plus the Creator extras/)
  })

  it('turns the tool half-sentence into the Python-cell wording', () => {
    assert.match(renameCreator('presetCordisDescription2', '具备标准任务工具，另加…'), /具备 PTC 模式的全部工具（模型在 Python 代码格里调用）/)
    assert.match(renameCreator('x', 'includes the standard task tools, plus'), /includes every PTC mode tool, called from Python code cells,/)
  })

  it('rewrites 创造模式 once and never doubles an existing PTC prefix', () => {
    assert.equal(renameCreator('presetCordis', '创造模式'), 'PTC 创造模式')
    assert.equal(renameCreator('presetCordis', 'PTC 创造模式'), 'PTC 创造模式')
    assert.equal(renameCreator('presetCordis', '内置创造模式'), '内置 PTC 创造模式')
    assert.equal(renameCreator('presetCordis', 'Creator mode'), 'PTC Creator mode')
    assert.equal(renameCreator('presetCordis', 'PTC Creator mode'), 'PTC Creator mode')
  })

  it('leaves unrelated strings untouched', () => {
    assert.equal(renameCreator('presetPtc', 'PTC 模式'), 'PTC 模式')
    assert.equal(renameCreator('title', 'Agent 预设'), 'Agent 预设')
  })
})

interface FakeLocale {
  service: { translate: (ns: string, key: string) => string; register: (ns: string, d: { zh: object; en: object }) => () => void }
  context: PtcLocaleContext
  registrations: string[]
}

function fakeLocale(): FakeLocale {
  const dict: Record<string, Record<string, string>> = {
    [AGENT_PRESET_NS]: {
      presetCordis: '创造模式',
      presetCordisDescription: '创造模式：具备标准任务工具',
      presetPtc: 'PTC 模式',
    },
    [SETTINGS_PRESETS_NS]: {
      preset_cordis: '创造模式',
      preset_ptc: 'PTC 模式',
    },
  }
  const registrations: string[] = []
  const service = {
    translate(ns: string, key: string): string {
      return dict[ns]?.[key] ?? `${ns}/${key}`
    },
    register(ns: string, _d: { zh: object; en: object }): () => void {
      registrations.push(ns)
      return () => registrations.push(`undo:${ns}`)
    },
  }
  const context: PtcLocaleContext = {
    get: (name: string) => (name === 'locale' ? service : undefined),
    locale: { register: service.register },
  }
  return { service, context, registrations }
}

function fakeScope(ptcCreativeMode: boolean, status: 'ready' | 'loading' = 'ready'): PtcConfigScope & { set: (on: boolean) => void } {
  let snapshot = { status, value: { ptcCreativeMode } }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(on: boolean) {
      snapshot = { status: 'ready', value: { ptcCreativeMode: on } }
      for (const listener of listeners) listener()
    },
  }
}

describe('syncPtcCreativeLocale', () => {
  it('makes no change while the option is off', () => {
    const { service, context } = fakeLocale()
    const original = service.translate
    const dispose = syncPtcCreativeLocale(context, fakeScope(false))
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')
    dispose()
    assert.equal(service.translate, original)
  })

  it('renames once the config turns on and restores when it turns off, without reload', () => {
    const { service, context, registrations } = fakeLocale()
    const scope = fakeScope(false)
    const dispose = syncPtcCreativeLocale(context, scope)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')

    scope.set(true)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), 'PTC 创造模式')
    assert.match(service.translate(AGENT_PRESET_NS, 'presetCordisDescription'), /PTC 模式加上创造模式的加成/)
    // 设置侧栏「模式偏好」页的下拉（dsh-settings 的 presets 命名空间）也要一致；别的模式名不动
    assert.equal(service.translate(SETTINGS_PRESETS_NS, 'preset_cordis'), 'PTC 创造模式')
    assert.equal(service.translate(SETTINGS_PRESETS_NS, 'preset_ptc'), 'PTC 模式')
    // 与创造模式无关的命名空间保持原样
    assert.equal(service.translate('settings.other', 'x'), 'settings.other/x')
    // 配置变化触发了文案重查（注册了内部空命名空间）
    assert.ok(registrations.length > 0)
    assert.ok(registrations[0]?.startsWith(PLUGIN_NS))

    scope.set(false)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')

    dispose()
  })

  it('removes the wrapper on dispose so renaming stops for good', () => {
    const { service, context } = fakeLocale()
    const original = service.translate
    const scope = fakeScope(true)
    const dispose = syncPtcCreativeLocale(context, scope)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), 'PTC 创造模式')
    dispose()
    assert.equal(service.translate, original)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')
    scope.set(false)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')
  })

  it('stays off while the config namespace is not served yet', () => {
    const { service, context } = fakeLocale()
    const scope = fakeScope(true, 'loading')
    const dispose = syncPtcCreativeLocale(context, scope)
    assert.equal(service.translate(AGENT_PRESET_NS, 'presetCordis'), '创造模式')
    dispose()
  })
})
