/**
 * 网页上把 DSH 自带「创造模式」的文案换成「PTC 创造模式」，跟随配置项
 * `ptcCreativeMode` 开关：false 时一个字都不改，true 时才换。
 *
 * 后台不给 `cordis` 起名字，它在模式名单里仍是内置模式（网页认内置模式的规则：没有名字、id 是自带的四个之一）。
 * 名字、介绍、「Agent 预设」页的说明都是网页按 `settings.agentPreset` 文案现查的，所以在查文案这一步换。
 * 照继承的思路：拿官方当时的原文做替换，官方改了措辞就用新措辞，替换不上的句子保留原文；
 * 只有介绍整句换掉，因为官方那句讲的是创造模式本身，换词说不通。
 *
 * 开关由宿主端 `python-repl` 命名空间的配置快照驱动（`ctx.configForms.get(...)`）：配置一改，
 * 这里重算启用状态并触发一次文案重查，无需重启。
 */
import { createMethodPatcher } from '../../../tooling/runtime/method-patch.mjs'

export const AGENT_PRESET_NS = 'settings.agentPreset'
export const PLUGIN_NS = 'python-repl'

const DESCRIPTION = {
  zh: 'PTC 模式加上创造模式的加成：插件编排工具、写插件和模式的内置技能、插件管理工具。',
  en: 'PTC mode plus the Creator extras: runtime inspection tools, built-in skills for writing plugins and presets, and plugin management.',
}

const CJK = /[\u4e00-\u9fff]/

/** 讲工具的那半句：创造模式写的是「标准任务工具」，PTC 创造模式的工具都在 Python 代码格里调用。 */
const TOOLS: Array<[RegExp, string]> = [
  [/具备标准任务工具/g, '具备 PTC 模式的全部工具（模型在 Python 代码格里调用）'],
  [/includes the standard task tools/g, 'includes every PTC mode tool, called from Python code cells,'],
]

/** 一条 `settings.agentPreset` 文案换成 PTC 创造模式的说法；与创造模式无关的原样返回。 */
export function renameCreator(key: string, text: string): string {
  if (key === 'presetCordisDescription') return CJK.test(text) ? DESCRIPTION.zh : DESCRIPTION.en
  let out = text
  for (const [pattern, replacement] of TOOLS) out = out.replace(pattern, replacement)
  return out.replace(/(?<!PTC )创造模式/g, 'PTC 创造模式').replace(/([一-鿿])PTC 创造模式/g, '$1 PTC 创造模式').replace(/(?<!PTC )Creator mode/g, 'PTC Creator mode')
}

const installLocalePatch = createMethodPatcher('dsh-python-repl')

/** 读 `python-repl` 配置里 `ptcCreativeMode` 的那一小块快照。 */
export interface PtcConfigScope {
  getSnapshot(): { status: string; value?: { ptcCreativeMode?: boolean } }
  subscribe(listener: () => void): () => void
}

/** 客户端上下文里本功能用到的两处：取 locale 服务、注册内部文案命名空间。 */
export interface PtcLocaleContext {
  get(name: string): unknown
  locale: { register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void }
}

type Translate = (ns: string, key: string, params?: Record<string, unknown>) => string

function enabledIn(scope: PtcConfigScope): boolean {
  const snap = scope.getSnapshot()
  return snap.status === 'ready' && snap.value?.ptcCreativeMode === true
}

/**
 * 把 `settings.agentPreset` 的翻译包一层：开关打开时改成 PTC 创造模式，关闭或卸载时还原。
 * 每次开关变化注册一份空文案再撤掉，借 locale 的变更事件让已画好的界面重查一次。
 * @returns 卸载函数：撤掉监听、去掉包装，并再触发一次重查。
 */
export function syncPtcCreativeLocale(ctx: PtcLocaleContext, scope: PtcConfigScope): () => void {
  let enabled = enabledIn(scope)
  const locale = ctx.get('locale') as object

  const dispose = installLocalePatch(locale, 'translate', (original: Translate) =>
    function (this: unknown, ns: string, key: string, params?: Record<string, unknown>) {
      const text = original.call(this, ns, key, params)
      if (!enabled || ns !== AGENT_PRESET_NS || typeof text !== 'string') return text
      return renameCreator(key, text)
    })

  let seq = 0
  const refresh = (): void => {
    seq += 1
    const undo = ctx.locale.register(`${PLUGIN_NS}.ptc-refresh.${seq}`, { zh: {}, en: {} })
    undo()
  }

  const unsubscribe = scope.subscribe(() => {
    const next = enabledIn(scope)
    if (next === enabled) return
    enabled = next
    refresh()
  })

  return () => {
    unsubscribe()
    dispose?.()
    refresh()
  }
}
