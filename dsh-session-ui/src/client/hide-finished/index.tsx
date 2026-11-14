/**
 * dsh-hide-finished client 半：替换会话头栏的「后台任务」「子代理」按钮和子代理切换框。
 *
 * 宿主两个按钮注册在 `conversation.session.header.actions` 列表插槽（id 分别是
 * `job-list` 和 `subagent-catalog`），切换框注册在 `conversation.session.header.lineage`
 * 单占位插槽。插槽同一格只渲染优先级数字最小的那条，所以这里用更小的优先级各注册一条，
 * 顶替宿主那条。顶替后照样渲染宿主原来的组件和注入，只在中间把「已结束」的条目拿掉：
 *
 * - 后台任务：只把还在跑的任务交给宿主组件。没有在跑的，宿主组件自己就不显示。
 * - 子代理按钮：只把在跑的子代理交给宿主组件，数字和展开的列表都只剩在跑的；
 *   一个都没在跑、团队任务板也没内容，就不渲染宿主的数量按钮（按钮同时是任务板入口）。
 * - 切换框：同样只列在跑的，但当前看的子代理和它的各级上级始终保留，
 *   否则宿主找不到父会话，标题会跟着消失。它总要渲染：标题本身就是它画的。
 *
 * 宿主组件每次渲染时从插槽登记里现找，宿主重载或换了实现也能跟上；
 * 找不到时什么都不显示，和宿主删掉这个按钮时的样子一致。
 *
 * @module dsh-hide-finished/client
 */
import type { ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// 以下类型导入会被擦除，只为拿到 Context 的类型扩充。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  ancestorsOf,
  hasRunningChild,
  hasTeamBoard,
  liveOnlyJobs,
  liveOnlySubagents,
  shouldShowCatalog,
  type AgentTeamLike,
  type JobsStateLike,
  type SessionStatusLike,
  type SessionsStateLike,
} from './filter.ts'
import { JOB_LIST_ID, LINEAGE_SLOT, SLOT, SUBAGENT_CATALOG_ID } from './ids.ts'

/** 比宿主的默认优先级 0 小，就排在它前面、顶替它。 */
const SHADOW_PRIORITY = -10

/** 宿主没注册时用的位置；正常情况按宿主那条的 order 走。 */
const FALLBACK_ORDER: Record<string, number> = {
  [JOB_LIST_ID]: 20,
  [SUBAGENT_CATALOG_ID]: -30,
}

/** 宿主插槽条目的组件和注入，类型被宿主擦成 unknown，这里按用法收窄。 */
type AnyProps = Record<string, unknown>
type AnyInject = (...args: unknown[]) => Record<string, unknown>

type Selector<S, R> = (state: S) => R
type UseStore<S> = <R>(selector: Selector<S, R>) => R
type UseProjection = <R>(key: string, selector: (value: AgentTeamLike | undefined) => R) => R

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const ours = new Set<unknown>()

  /** 宿主那条：同插槽、同 id（单占位插槽没有 id）、不是本插件注册的。 */
  const hostEntry = (slot: string, id?: string): StoredEntry | undefined =>
    ctx.slots.entries(slot as typeof SLOT).find((entry) => entry.options.id === id && !ours.has(entry.component))

  const hostComponent = (slot: string, id?: string): ComponentType<AnyProps> | undefined =>
    hostEntry(slot, id)?.component as ComponentType<AnyProps> | undefined

  /** 原样转交宿主的注入，宿主组件拿到的参数和平时一模一样。 */
  const delegateInject = (slot: string, id?: string): AnyInject => (...args) => {
    const hostInject = hostEntry(slot, id)?.inject as AnyInject | undefined
    return hostInject === undefined ? {} : hostInject(...args)
  }

  // 宿主组件里每次渲染都调同样次数的 useJobs，这里包一层不改变调用次数。
  const liveJobsHooks = new WeakMap<UseStore<JobsStateLike>, UseStore<JobsStateLike>>()
  const liveJobsHook = (useJobs: UseStore<JobsStateLike>): UseStore<JobsStateLike> => {
    let wrapped = liveJobsHooks.get(useJobs)
    if (wrapped === undefined) {
      wrapped = (selector) => selector(liveOnlyJobs(useJobs((state) => state)))
      liveJobsHooks.set(useJobs, wrapped)
    }
    return wrapped
  }

  function LiveJobList(props: AnyProps): JSX.Element | null {
    const Host = hostComponent(SLOT, JOB_LIST_ID)
    if (Host === undefined) return null
    return <Host {...props} useJobs={liveJobsHook(props.useJobs as UseStore<JobsStateLike>)} />
  }

  function RunningSubagentCatalog(props: AnyProps): JSX.Element | null {
    const sessionId = String(props.sessionId)
    const useSessions = props.useSessions as UseStore<SessionsStateLike>
    const useSessionStatus = props.useSessionStatus as UseStore<SessionStatusLike>
    const sessions = useSessions((state) => state)
    const statuses = useSessionStatus((value) => value)
    // 这两个注入 0.2.2-rc.2 才有。有没有取决于宿主版本，同一页面里不会变，所以条件调用不会打乱 hook 顺序。
    const useProjection = props.useProjection as UseProjection | undefined
    const useFooterAvailable = props.useFooterAvailable as UseStore<boolean> | undefined
    const teamBoard = useProjection?.('agentTeam', hasTeamBoard) ?? false
    const footerAvailable = useFooterAvailable?.((value) => value) ?? false
    const Host = hostComponent(SLOT, SUBAGENT_CATALOG_ID)
    if (Host === undefined) return null
    const snapshot = sessions.projectionsBySession[sessionId]
    const running = hasRunningChild(snapshot?.values.subagentCatalog, (id) => statuses.get(id)?.running, (id) => sessions.byId[id]?.running)
    if (!shouldShowCatalog(snapshot?.state, running, footerAvailable && teamBoard)) return null
    // 宿主组件每次渲染调同样次数的 useSessions，这里换成读同一份过滤结果，调用次数不变。
    const live = liveOnlySubagents(sessions, statuses)
    const liveUseSessions: UseStore<SessionsStateLike> = (selector) => selector(live)
    return <Host {...props} useSessions={liveUseSessions} />
  }

  function RunningSubagentLineage(props: AnyProps): JSX.Element | null {
    const useSessions = props.useSessions as UseStore<SessionsStateLike>
    const useSessionStatus = props.useSessionStatus as UseStore<SessionStatusLike>
    const sessions = useSessions((state) => state)
    const statuses = useSessionStatus((value) => value)
    const Host = hostComponent(LINEAGE_SLOT)
    if (Host === undefined) return null
    const keep = new Set<string>()
    for (const id of [props.lineageSessionId, props.sessionId]) {
      if (typeof id !== 'string') continue
      keep.add(id)
      for (const ancestor of ancestorsOf(sessions, id)) keep.add(ancestor)
    }
    const live = liveOnlySubagents(sessions, statuses, keep)
    const liveUseSessions: UseStore<SessionsStateLike> = (selector) => selector(live)
    return <Host {...props} useSessions={liveUseSessions} />
  }

  const shadow = (slot: string, id: string | undefined, component: ComponentType<AnyProps>, locale: string) => {
    ours.add(component)
    ctx.slots.inject(slot as typeof SLOT, () => ctx.slots.register({
      name: slot,
      ...id === undefined ? {} : { id, order: hostEntry(slot, id)?.options.order ?? FALLBACK_ORDER[id] ?? 0 },
      priority: SHADOW_PRIORITY,
      locale,
      inject: delegateInject(slot, id),
    } as never, component as never))
  }

  shadow(SLOT, JOB_LIST_ID, LiveJobList, 'job')
  shadow(SLOT, SUBAGENT_CATALOG_ID, RunningSubagentCatalog, 'subagent')
  shadow(LINEAGE_SLOT, undefined, RunningSubagentLineage, 'subagent')
}
