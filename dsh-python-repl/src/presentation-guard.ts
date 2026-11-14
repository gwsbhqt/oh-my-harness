import type { Context } from '@deepseek-ai/cordis'
/**
 * 组装钩子拿到的对象：不带工具数组，run_code 在不在看 PTC 执行器才会产出的 `tools:sdk` 段。
 */
export interface AssemblyLike {
  contexts: { name: string; text: string }[]
  sections?: readonly { name: string }[]
}

function hasRunCode(assembly: AssemblyLike): boolean | undefined {
  if (Array.isArray(assembly.sections)) return assembly.sections.some(section => section.name === 'tools:sdk')
  return undefined
}

export const PRESENTATION_ERROR_CONTEXT = 'python-repl:presentation-error'

type PublicAgent = {
  id?: unknown
  sessionId?: unknown
  ctx?: Context
  session?: { id?: unknown; header?: { agentPreset?: unknown } }
}
type PublicPresets = { composedPreset?: (ctx: Context) => unknown }
type PublicProjections = { stateOf?: (session: object, key: string) => unknown }

function stringId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Read only public composition and durable session facts; no tool-name inference. */
export function expectedPtc(ctx: Context, scope: unknown): boolean {
  if (!scope || typeof scope !== 'object') return false
  const agent = scope as PublicAgent
  const get = (name: string) => (ctx as unknown as { get(name: string): unknown }).get(name)
  const presets = get('agentPresets') as PublicPresets | undefined
  if (agent.ctx && typeof presets?.composedPreset === 'function') {
    const composed = presets.composedPreset(agent.ctx)
    if (typeof composed === 'string') return composed === 'ptc'
  }
  if (!agent.session || typeof agent.session !== 'object') return false
  const projections = get('sessionProjections') as PublicProjections | undefined
  if (typeof projections?.stateOf === 'function') {
    const selected = projections.stateOf(agent.session, 'agentPreset')
    // The immutable header is a creation fact; a later public selection overrides it.
    if (selected !== undefined) return selected === 'ptc'
  }
  return agent.session.header?.agentPreset === 'ptc'
}

/** One log per live session; the current fault stays in the dynamic snapshot until recovery. */
export function createPresentationGuard(ctx: Context): (assembly: AssemblyLike, scope: unknown) => void {
  const warned = new WeakSet<object>()
  return (assembly, scope) => {
    // A registry-less or incomplete assembly cannot prove the model's tool surface.
    const present = hasRunCode(assembly)
    if (!ctx.get('tools') || present === undefined) return
    assembly.contexts = assembly.contexts.filter(c => c.name !== PRESENTATION_ERROR_CONTEXT)
    if (present || !expectedPtc(ctx, scope)) return
    const agent = scope as PublicAgent
    const sid = stringId(agent.session?.id) ?? stringId(agent.sessionId) ?? stringId(agent.id)
    if (sid === undefined) return
    const text = `ERROR [dsh-python-repl] sid=${JSON.stringify(sid)}: 本会话公开模式记录为 ptc，但本次实际工具清单缺少 run_code。`
      + '工具呈现已损坏，不能执行 Python 工具编排。停止其他工具操作，用 bash 工具跑 `dsh-use doctor`，通过后跑 `dsh-use restart --detach` 直接重启（它中止在跑的会话，重启后让它们自动接着做），告诉用户已经在重启并结束这一轮；只有重启被拒或检查失败才把原因交给用户。'
      + '不要调用 monitor、原生工具或其他入口替代 run_code；不要自动重放此前可能已发生的外部动作。此检测不会自动修复或恢复内核数据。'
    assembly.contexts.push({ name: PRESENTATION_ERROR_CONTEXT, text })
    const identity = agent.session ?? scope as object
    if (!warned.has(identity)) {
      warned.add(identity)
      ctx.logger.error(text)
    }
  }
}
