/**
 * 设置侧栏「远程机器」一页：每台别的机器一张卡片，卡片里每个服务一行（DSH、Hermes……，由插件设置里的清单决定），
 * 很少远程的机器排在主机器后面，不另起分组。打开页面不自动查，先点「检查」看连不连得上、各服务在不在，
 * 连得上之后「打开」和清单里写的按钮才可点；隧道开着时「关隧道」才可点。
 * 每台下面还有一行「临时端口」：只有「扫描」一个入口，列出对面在听的端口，选中就直接拉起隧道并在浏览器打开。
 * 本机端口就用对面同一个号，占了自动往上 +1。开着的隧道列在下面，点一开、叉一关；哪些开着由宿主从本机 ssh 反推。
 * 数据全部走宿主半的 `/api/dsh-use.*`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Menu, Tag, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Listening, MachineEntry, MachineStatus, ServiceEntry, ServiceStatus, TempPlan, TempTunnel } from '../machines.ts'

export interface MachinesSectionInjected {
  rpc: ConnectionHandle['rpc']
}

export type MachinesSectionProps = Partial<MachinesSectionInjected>

interface ListResult { self?: string; viewedRemotely?: true; machines: MachineEntry[] }

// 扫描结果可能几十条。宿主菜单按整个视口算高度，放在设置弹窗里会顶出屏幕、也滚不动，
// 所以给它一个不超过弹窗的高度，超出的在菜单内部滚动。宿主的滚动规则靠 `.xxx .viewport` 这种嵌套，
// 菜单卡片又被 portal 到 body 下，拿不到稳定的 class，只能按这个插件自己的标记名注入样式。
const SCAN_MENU_CLASS = 'dsh-use-scan-menu'
const SCAN_MENU_CSS = `
.dsh-use-scan-menu { max-height: min(360px, calc(100vh - 160px)) !important; overflow: hidden; }
.dsh-use-scan-menu > div[role="presentation"] { overflow-y: auto !important; min-height: 0; }
`

function ensureScanMenuStyle(): void {
  if (typeof document === 'undefined') return
  let tag = document.querySelector<HTMLStyleElement>('style[data-plugin="dsh-use"]')
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-use'
    document.head.appendChild(tag)
  }
  if (tag.textContent !== SCAN_MENU_CSS) tag.textContent = SCAN_MENU_CSS
}

async function call<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  const result: RpcResult<unknown> = await rpc.call('/api', `dsh-use.${endpoint}`, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
  hint: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  // 卡片、机器名一行、各服务行共用同一组列（名字｜内容｜按钮），头部标签和下面每行的标签才能落在同一条竖线上。
  card: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr) max-content', alignItems: 'center', columnGap: 8, padding: '14px 18px', borderRadius: 'var(--dsw-radius-xl)', background: 'var(--dsw-alias-settings-card-fill)', border: '1px solid var(--dsw-alias-settings-card-stroke)' },
  head: { display: 'contents' },
  headTags: { gridColumn: '2', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  headCheck: { gridColumn: '3', justifySelf: 'end' },
  wide: { gridColumn: '1 / -1' },
  name: { gridColumn: '1', margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '24px' },
  time: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  reason: { gridColumn: '1 / -1', margin: '6px 0 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  error: { color: 'var(--dsw-alias-state-error-primary)' },
  divider: { width: 1, height: 20, background: 'var(--dsw-alias-border-l2)', margin: '0 4px' },
  // 一行不换：按钮文字、标签宽度都固定，状态变化只换颜色或在左侧多一个标签，不把按钮挤到下一行。
  anchor: { display: 'inline-flex' },
  // 一台机器的服务共用同一组列：名字按最长的定宽，标签上下对齐；进行中的提示单独一格，放不下就省略，不压按钮。
  services: { display: 'contents' },
  // 标签一格必须能压缩：窗口窄时先省略标签，不能让它压到右边按钮上。
  serviceTags: { gridColumn: '2', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' },
  serviceRule: { gridColumn: '1 / -1', borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '12px 0' },
  serviceName: { gridColumn: '1', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' },
  serviceBusy: { marginLeft: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  serviceActions: { display: 'flex', alignItems: 'center', gap: 6, justifySelf: 'end' },
  // 按钮都放这一格：整格宽由最长的服务行定，不会把两个字挤成竖排。
  actionsCell: { gridColumn: '3', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  // 检查中整张卡片暂时只读：按下去也没反应，也不要把颜色调得像坏了，只是淡淡地压住。
  cardBusy: { opacity: 0.6, transition: 'opacity 120ms ease' },
  // 提示固定占一行：没有提示时也留着这块高度，出现和消失都不会把下面的内容顶来顶去。
  tempHintSlot: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', height: 18, marginTop: 6, minWidth: 0 },
  tempHint: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  // 开着的隧道固定占一行：没开任何隧道时也显示「开着：无」，高度不变。
  tempList: { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minHeight: 19, marginTop: 8 },
  tempListLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  tempListEmpty: { fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' },
  // 一条开着的隧道：整块是一颗蓝色小胶囊，左边点开、右边的叉关掉。
  tempPill: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)', color: 'var(--dsw-alias-state-business-primary)', fontSize: 11, lineHeight: '17px', fontWeight: 500 },
  tempPillOpen: { padding: '1px 4px 1px 8px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' },
  tempPillClose: { padding: '1px 6px 1px 2px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'inherit', opacity: 0.7 },
}

// 关掉设置窗口时卡片会被卸载；检查结果记在模块里，重新打开设置接着显示，刷新网页才清空。
const remembered = new Map<string, { status: MachineStatus; checkedAt: number }>()

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 上次在线可能是前几天，不能只显示时分。 */
function dayClock(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? clock(at) : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(at)}`
}

/** 把「距最后一次输入」说清楚。 */
function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} 秒`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} 分钟`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} 小时`
  return `${String(Math.floor(seconds / 86_400))} 天`
}

function stateHint(status: MachineStatus): string {
  if (status.state === 'active') return status.idleSeconds === undefined ? '屏幕没锁' : `屏幕没锁，最后一次操作在 ${duration(status.idleSeconds)}前`
  if (status.state === 'locked') return status.idleSeconds === undefined ? '屏幕锁着' : `屏幕锁着，最后一次操作在 ${duration(status.idleSeconds)}前`
  if (status.state === 'online') return 'SSH 能连上，但读不到锁屏状态'
  return '完全没响应；睡眠、关机、断网都会这样'
}

// 操作结果用浮动提示，不在卡片里插行：插一行再消失会让整页高度跳一下。
type Note = { seq: number; text: string; bad: boolean }
let noteSeq = 0

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function ServiceRow({ rpc, machine, entry, state, reachable, remote, cardBusy, onTunnel }: {
  rpc: ConnectionHandle['rpc']
  machine: MachineEntry
  entry: ServiceEntry
  state: ServiceStatus | undefined
  reachable: boolean
  remote: boolean
  /** 这张卡片正在检查：整张卡片的按钮都停用，免得同时改两处状态。 */
  cardBusy: boolean
  onTunnel: (open: boolean) => void
}) {
  const [busy, setBusy] = useState<string | undefined>()
  const [note, setNote] = useState<Note | undefined>()
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const run = async (key: string, work: () => Promise<string | undefined>) => {
    setBusy(key)
    setNote(undefined)
    try {
      const text = await work()
      if (alive.current && text !== undefined) setNote({ seq: ++noteSeq, text, bad: false })
    } catch (error) {
      if (alive.current) setNote({ seq: ++noteSeq, text: `${machine.label} ${entry.label}：${error instanceof Error ? error.message : String(error)}`, bad: true })
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }
  const target = { id: machine.id, service: entry.id }
  const open = () => run('open', async () => {
    await call(rpc, 'open', target)
    onTunnel(true)
    return undefined
  })
  const close = () => run('close', async () => {
    await call(rpc, 'close', target)
    onTunnel(false)
    return undefined
  })
  const action = (index: number) => {
    const a = entry.actions[index]!
    if (a.confirm && !window.confirm(`在 ${machine.label} 上「${a.label}」${entry.label}？`)) return
    void run(`action-${String(index)}`, async () => `${machine.label} ${a.label}：${(await call<{ line: string }>(rpc, 'action', { ...target, action: index })).line}`)
  }

  const locked = busy !== undefined || !reachable || cardBusy
  const busyText = busy === undefined ? undefined : busy === 'open' ? '打开中…' : busy === 'close' ? '关闭中…' : `${entry.actions[Number(busy.slice('action-'.length))]?.label ?? ''}…`
  const line = state === undefined ? '' : state.line
  return (
    <>
      <div style={styles.serviceRule} />
      <span style={styles.serviceName}>{entry.label}</span>
      <div style={styles.serviceTags}>
        {state !== undefined && reachable ? (
          <Tooltip label={line !== '' ? line : (state.running ? '在跑' : '没在跑')} side="top" portal maxWidth={420}>
            <span tabIndex={0} style={styles.anchor}><Tag tone={state.running ? 'success' : 'danger'}>{state.running ? '在跑' : '没在跑'}</Tag></span>
          </Tooltip>
        ) : null}
        <Tooltip label={state?.tunnel === true ? `隧道已开：http://127.0.0.1:${String(entry.localPort)}` : `隧道未开，打开后用本机端口 ${String(entry.localPort)}`} side="top" portal>
          <span tabIndex={0} style={styles.anchor}><Tag tone={state?.tunnel === true ? 'info' : 'outline'}>{state?.tunnel === true ? '已开 ' : '端口 '}{String(entry.localPort)}</Tag></span>
        </Tooltip>
        <span style={styles.serviceBusy}>{busyText ?? ''}</span>
      </div>
      <div style={styles.actionsCell}>
        <div style={styles.serviceActions}>
          <Button variant="outline" size="sm" disabled={locked || remote} onClick={() => void open()}>打开</Button>
          <Button variant="outline" size="sm" disabled={busy !== undefined || cardBusy || remote || state?.tunnel !== true} onClick={() => void close()}>关隧道</Button>
          {entry.actions.length > 0 ? <span style={styles.divider} /> : null}
          {entry.actions.map((a, i) => (
            <Button key={a.label} variant="outline" size="sm" disabled={locked} onClick={() => action(i)}>{a.label}</Button>
          ))}
        </div>
      </div>
      {note !== undefined ? <Toast key={note.seq} text={note.text} {...(note.bad ? { holdMs: 6000 } : { tone: 'success' as const, holdMs: 3000 })} onDone={() => setNote(undefined)} /> : null}
    </>
  )
}

function TempRow({ rpc, machine, temps, reach, remote, cardBusy, onTemps }: {
  rpc: ConnectionHandle['rpc']
  machine: MachineEntry
  temps: TempTunnel[]
  reach: boolean | undefined
  remote: boolean
  /** 这张卡片正在检查：扫描和关闭都停用。 */
  cardBusy: boolean
  onTemps: () => void
}) {
  const [busy, setBusy] = useState<'scan' | 'browse' | 'close' | undefined>()
  const [found, setFound] = useState<Listening[] | undefined>()
  const [menu, setMenu] = useState(false)
  const [note, setNote] = useState<Note | undefined>()
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const run = async (key: 'scan' | 'browse' | 'close', work: () => Promise<string | undefined>) => {
    setBusy(key)
    setNote(undefined)
    try {
      const done = await work()
      if (alive.current && done !== undefined) setNote({ seq: ++noteSeq, text: done, bad: false })
    } catch (error) {
      if (alive.current) setNote({ seq: ++noteSeq, text: `${machine.label} 临时端口：${message(error)}`, bad: true })
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }
  // 只留一条路：扫对面在听的端口，选中哪个就直接在本机浏览器打开。
  const browse = (target: number) => run('browse', async () => {
    const r = await call<TempPlan & { already: boolean; url: string }>(rpc, 'tempBrowse', { id: machine.id, port: target })
    onTemps()
    if (r.already) return `${String(r.port)} 早就拉起了，已打开：${r.url}`
    return r.taken === undefined ? `已打开：${r.url}` : `本机 ${String(r.preferred)} 被占，用了 ${String(r.localPort)}：${r.url}`
  })
  const scan = () => run('scan', async () => {
    const { ports } = await call<{ ports: Listening[] }>(rpc, 'scan', { id: machine.id })
    if (!alive.current) return undefined
    setFound(ports)
    if (ports.length === 0) throw new Error('对面没有在听的 TCP 端口')
    setMenu(true)
    return undefined
  })
  const drop = (target: number) => run('close', async () => {
    const r = await call<{ closed: boolean; port: number; localPort?: number }>(rpc, 'tempClose', { id: machine.id, port: target })
    onTemps()
    return r.closed ? `已关掉 ${String(r.port)}（本机 ${String(r.localPort)}）` : `${String(r.port)} 本来就没开`
  })

  // 扫描和拉起都要连对面；经隧道查看时打开的浏览器在对面屏幕上，所以也停用。
  const reachable = reach === true
  let hint = ''
  let bad = false
  if (busy === 'scan') hint = '扫描中…'
  else if (busy === 'browse') hint = '打开中…'
  else if (busy === 'close') hint = '关闭中…'
  else if (remote) hint = '经隧道查看时不能在这里开临时端口'
  else if (!reachable) hint = '先点上面的「检查」'
  const items: MenuEntry[] = (found ?? []).map((p) => ({
    id: String(p.port),
    label: `${String(p.port)}  ${p.processes.join('、')}${p.note === undefined ? '' : `（${p.note}）`}`,
    disabled: p.note !== undefined,
  }))
  return (
    <>
      <div style={styles.serviceRule} />
      <span style={styles.serviceName}>临时端口</span>
      <div style={styles.serviceTags} />
      <div style={styles.actionsCell}>
        <Menu
          open={menu}
          portal
          dense
          align="end"
          items={items}
          onSelect={(id: string) => { setMenu(false); if (!remote) void browse(Number(id)) }}
          onClose={() => setMenu(false)}
          listClassName={SCAN_MENU_CLASS}
          anchor={<Button variant="outline" size="sm" disabled={busy !== undefined || cardBusy || !reachable || remote} onClick={() => { if (menu) setMenu(false); else void scan() }}>扫描</Button>}
        />
      </div>
      <div style={styles.tempHintSlot}>{hint === '' ? null : <span style={{ ...styles.tempHint, ...(bad ? styles.error : {}) }}>{hint}</span>}</div>
      <div style={styles.tempList}>
        <span style={styles.tempListLabel}>开着：</span>
        {temps.length === 0 ? <span style={styles.tempListEmpty}>无</span> : null}
        {temps.map((t) => (
          <span key={t.port} style={styles.tempPill}>
            <Tooltip label={`在浏览器打开 http://127.0.0.1:${String(t.localPort)}`} side="top" portal>
              <button type="button" style={styles.tempPillOpen} disabled={cardBusy} onClick={() => { if (!remote) void browse(t.port) }}>{t.localPort === t.port ? String(t.port) : `${String(t.port)} → ${String(t.localPort)}`}</button>
            </Tooltip>
            <Tooltip label={`关掉这条隧道（本机 ${String(t.localPort)}）`} side="top" portal>
              <button type="button" style={styles.tempPillClose} aria-label={`关掉 ${String(t.port)}`} disabled={busy !== undefined || cardBusy} onClick={() => void drop(t.port)}>×</button>
            </Tooltip>
          </span>
        ))}
      </div>
      {note !== undefined ? <Toast key={note.seq} text={note.text} {...(note.bad ? { holdMs: 6000 } : { tone: 'success' as const, holdMs: 3000 })} onDone={() => setNote(undefined)} /> : null}
    </>
  )
}


function MachineCard({ rpc, entry, remote, temps, onTemps }: { rpc: ConnectionHandle['rpc']; entry: MachineEntry; remote: boolean; temps: TempTunnel[]; onTemps: () => void }) {
  const [status, setStatus] = useState<MachineStatus | undefined>(() => remembered.get(entry.id)?.status)
  const [checkedAt, setCheckedAt] = useState<number | undefined>(() => remembered.get(entry.id)?.checkedAt)
  const [statusError, setStatusError] = useState<string | undefined>()
  const [checking, setChecking] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (status !== undefined && checkedAt !== undefined) remembered.set(entry.id, { status, checkedAt })
    else remembered.delete(entry.id)
  }, [entry.id, status, checkedAt])

  const check = async () => {
    setChecking(true)
    setStatusError(undefined)
    try {
      const next = await call<MachineStatus>(rpc, 'status', { id: entry.id })
      if (alive.current) { setStatus(next); setCheckedAt(Date.now()) }
    } catch (error) {
      if (alive.current) { setStatus(undefined); setCheckedAt(undefined); setStatusError(error instanceof Error ? error.message : String(error)) }
    } finally {
      if (alive.current) setChecking(false)
    }
  }
  const setTunnel = (service: string, open: boolean) => setStatus((s) => s === undefined ? s : { ...s, services: s.services.map((x) => x.id === service ? { ...x, tunnel: open } : x) })

  const reach = status?.reachable
  const machineState = status?.state
  const stateText = checking ? '检查中…' : status === undefined ? (statusError !== undefined ? '查不到' : '未检查') : machineState === 'active' ? '活动' : machineState === 'locked' ? '锁屏' : machineState === 'online' ? '在线' : '睡眠/离线'
  const stateTone = checking || status === undefined ? (statusError !== undefined && !checking ? 'danger' : 'outline') : machineState === 'active' ? 'success' : machineState === 'locked' ? 'warning' : machineState === 'online' ? (reach === true ? 'info' : 'warning') : 'danger'
  return (
    <section style={styles.card} aria-busy={checking}>
      <div style={styles.head}>
        <h3 style={styles.name}>{entry.label}</h3>
        <div style={styles.headTags}>
          <Tooltip label={status === undefined ? '先点「检查」' : stateHint(status)} side="top" portal maxWidth={360}>
            <span tabIndex={0} style={styles.anchor}><Tag tone={stateTone}>{stateText}</Tag></span>
          </Tooltip>
          {reach === true ? <Tag tone="neutral">{status?.relayed === true ? '经中转' : '直连'}</Tag> : null}
          {status?.state === 'offline' && status.lastSeen !== undefined && !checking ? <span style={styles.time}>上次在线 {dayClock(status.lastSeen.at)}</span> : null}
          {checkedAt !== undefined && status !== undefined && !checking ? <span style={styles.time}>{clock(checkedAt)}</span> : null}
        </div>
        <div style={styles.headCheck}>
          <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>{checking ? '检查中…' : '检查'}</Button>
        </div>
      </div>
      {statusError !== undefined && status === undefined ? <p style={styles.reason}>{statusError}</p> : null}
      {reach === false && status?.reason !== undefined && status.reason !== '' ? <p style={styles.reason}>{status.state === 'offline' ? `完全没响应：${status.reason}` : status.reason}</p> : null}
      <div style={{ ...styles.services, ...(checking ? styles.cardBusy : {}) }}>{entry.services.map((s) => (
        <ServiceRow key={s.id} rpc={rpc} machine={entry} entry={s} state={status?.services.find((x) => x.id === s.id)} reachable={reach === true} remote={remote} cardBusy={checking} onTunnel={(open) => setTunnel(s.id, open)} />
      ))}<TempRow rpc={rpc} machine={entry} temps={temps} reach={reach} remote={remote} cardBusy={checking} onTemps={onTemps} /></div>
    </section>
  )
}

export function MachinesSection({ rpc }: MachinesSectionProps) {
  const [list, setList] = useState<ListResult | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [temps, setTemps] = useState<Record<string, TempTunnel[]>>({})
  const [tempsError, setTempsError] = useState<string | undefined>()
  useEffect(() => {
    if (rpc === undefined) return
    call<ListResult>(rpc, 'list', { viewPort: Number(window.location.port) }).then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [rpc])
  // 临时隧道只在本机查 ssh 监听，不连对面，所以打开页面就查。
  const loadTemps = useCallback(() => {
    if (rpc === undefined) return
    call<Record<string, TempTunnel[]>>(rpc, 'temps', {}).then((t) => { setTemps(t); setTempsError(undefined) }, (e: unknown) => setTempsError(message(e)))
  }, [rpc])
  useEffect(loadTemps, [loadTemps])
  useEffect(ensureScanMenuStyle, [])
  if (rpc === undefined) return null
  const remote = list?.viewedRemotely === true
  // 主机器的卡片在上，很少远程的机器排在后面；不另起分组，保持一条卡片列表。
  const ordered = list === undefined ? [] : [...list.machines.filter((m) => !m.secondary), ...list.machines.filter((m) => m.secondary)]
  return (
    <div style={styles.page}>
      <div style={styles.titleRow}>
        <h2 style={styles.title}>远程机器</h2>
        {list?.self !== undefined ? <Tag tone="quiet">本机 {list.self}</Tag> : null}
        {remote ? (
          <Tooltip label={`这是 ${list?.self ?? '对面'} 的 DSH，经隧道打开的。这里的按钮都在 ${list?.self ?? '对面'} 上执行，「打开」会在那台的屏幕上弹浏览器，所以停用了；要打开别的机器，回你自己电脑的 DSH。`} side="bottom" portal maxWidth={360}>
            <span tabIndex={0} style={styles.anchor}><Tag tone="warning">经隧道查看</Tag></span>
          </Tooltip>
        ) : null}
      </div>
      {error !== undefined ? <p style={{ ...styles.hint, ...styles.error }}>读不到机器列表：{error}</p> : null}
      {tempsError !== undefined ? <p style={{ ...styles.hint, ...styles.error }}>读不到本机开着的临时隧道：{tempsError}</p> : null}
      {ordered.map((entry) => <MachineCard key={entry.id} rpc={rpc} entry={entry} remote={remote} temps={temps[entry.id] ?? []} onTemps={loadTemps} />)}
    </div>
  )
}
