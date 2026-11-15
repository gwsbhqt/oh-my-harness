/**
 * 设置侧栏「技能」一页：顶上选「全局」或某个项目，下面普通技能、Python 技能两块，每个技能一行，右边菜单选档位。
 *
 * 改动先进草稿，页头「撤销 / 保存」统一管（和另外两页同一套骨架，共用 `../shared/PageHeader.tsx`）。
 * 保存走宿主半 `/api/settings.skillsSave`，把这一批改动一次提交、串行写进规则文件，写完按接口回来的内容刷新；
 * 保存失败保留草稿。切项目或刷新时有未保存的改动会拦下并提示，不会静默丢掉。
 *
 * 只用宿主公开组件和 `--dsw-*` 变量，不写宿主打包出来的样式名。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Menu, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillExposureKey } from './locales.ts'
import { call } from '../rpc.ts'
import { PageHeader } from '../shared/PageHeader.tsx'

export type Translate = (key: SkillExposureKey, params?: Record<string, unknown>) => string

export interface PageInjected {
  rpc: ConnectionHandle['rpc']
  t: Translate
}
export type PageProps = Partial<PageInjected>

type Level = 'on' | 'name-only' | 'user-only' | 'off'
type PyLevel = 'on' | 'off'
type From = 'default' | 'global' | 'project'
type Scope = 'project' | 'global' | 'builtin'

interface SkillRow {
  name: string
  description: string
  path?: string
  scope: Scope
  declared: { modelInvocable: boolean; userInvocable: boolean }
  level: Level
  from: From
  global: Level | null
  project: Level | null
}

interface PyRow {
  name: string
  description: string
  importName: string | null
  dir: string
  level: PyLevel
  from: From
  global: PyLevel | null
  project: PyLevel | null
}

interface Overview {
  home?: string
  path: string
  exists: boolean
  fileError?: string
  project: string | null
  projects: { root: string; title: string; configured: boolean }[]
  skills: SkillRow[]
  skillsError?: string
  pySkills: PyRow[]
}

/** 草稿：技能名 → 要写的档位；null 表示删掉这一层的那条（回到跟随 / 默认）。 */
interface Draft {
  skills: Record<string, Level | null>
  pySkills: Record<string, PyLevel | null>
}
const EMPTY_DRAFT: Draft = { skills: {}, pySkills: {} }

const LEVELS: Level[] = ['on', 'name-only', 'user-only', 'off']
const PY_LEVELS: PyLevel[] = ['on', 'off']
const SCOPES: Scope[] = ['project', 'global', 'builtin']
const INHERIT = '__inherit__'

const levelKey = (l: Level): SkillExposureKey => `level_${l.replace('-', '_')}` as SkillExposureKey
const levelHintKey = (l: Level): SkillExposureKey => `levelHint_${l.replace('-', '_')}` as SkillExposureKey
const tone = (l: Level) => (l === 'on' ? 'success' : l === 'off' ? 'danger' : l === 'user-only' ? 'warning' : 'info') as 'success' | 'danger' | 'warning' | 'info'
const has = (record: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key)

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 20, color: 'var(--dsw-alias-label-primary)' },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
  intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  block: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  blockTitle: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px' },
  groupTitle: { margin: '6px 0 0', fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
  card: {
    display: 'flex', flexDirection: 'column', padding: '2px 14px',
    border: '.5px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)',
    borderRadius: 'var(--dsw-radius-xl)',
  },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', minWidth: 0 },
  divider: { borderTop: '.5px solid var(--dsw-alias-border-l2)' },
  body: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  name: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: '22px', minWidth: 0 },
  desc: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  legend: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
  legendName: { color: 'var(--dsw-alias-label-secondary)' },
}

function LevelMenu(props: {
  t: Translate
  label: string
  current: string
  options: { id: string; label: string }[]
  disabled: boolean
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = props.options.map((o) => ({ id: o.id, label: o.id === props.current ? `✓ ${o.label}` : o.label }))
  return (
    <Menu
      open={open}
      portal
      dense
      items={items}
      onSelect={(id: string) => { setOpen(false); if (id !== props.current) props.onSelect(id) }}
      onClose={() => setOpen(false)}
      anchor={<Button variant="ghost" size="sm" disabled={props.disabled} onClick={() => setOpen((v) => !v)}>{props.label} ▾</Button>}
    />
  )
}

function tildePath(path: string, home: string | undefined): string {
  return home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function ProjectMenu(props: { t: Translate; data: Overview; onPick: (root: string | null) => void; disabled: boolean }) {
  const { t, data } = props
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [
    { id: INHERIT, label: data.project === null ? `✓ ${t('global')}` : t('global') },
    ...(data.projects.length > 0 ? [{ type: 'separator' as const, id: 'sep' }] : []),
    ...data.projects.map((p) => {
      const text = `${data.project === p.root ? '✓ ' : ''}${p.title}${p.configured ? ' ·' : ''}  ${tildePath(p.root, data.home)}`
      return { id: p.root, label: <span title={`${p.title}\n${p.root}`}>{text}</span> }
    }),
  ]
  const current = data.project === null ? t('global') : `${t('projectPrefix')}${data.projects.find((p) => p.root === data.project)?.title ?? data.project}`
  return (
    <Menu
      open={open}
      portal
      dense
      items={items}
      onSelect={(id: string) => { setOpen(false); props.onPick(id === INHERIT ? null : id) }}
      onClose={() => setOpen(false)}
      anchor={<Button variant="outline" size="sm" disabled={props.disabled} onClick={() => setOpen((v) => !v)}>{current} ▾</Button>}
    />
  )
}

function fromText(t: Translate, from: From): string {
  return from === 'project' ? t('fromProject') : from === 'global' ? t('fromGlobal') : t('fromDefault')
}

/** 草稿里相对当前视角真正变了的那些条目。 */
function changesOf(data: Overview, draft: Draft, inProject: boolean): { skills: Record<string, Level | null>; pySkills: Record<string, PyLevel | null> } {
  const skills: Record<string, Level | null> = {}
  const pySkills: Record<string, PyLevel | null> = {}
  for (const row of data.skills) {
    if (!has(draft.skills, row.name)) continue
    const own = inProject ? row.project : row.global
    const next = draft.skills[row.name]
    if (next !== own) skills[row.name] = next ?? null
  }
  for (const row of data.pySkills) {
    if (!has(draft.pySkills, row.name)) continue
    const own = inProject ? row.project : row.global
    const next = draft.pySkills[row.name]
    if (next !== own) pySkills[row.name] = next ?? null
  }
  return { skills, pySkills }
}

export function SkillExposurePage(props: PageProps) {
  const { rpc, t } = props
  const [data, setData] = useState<Overview | undefined>()
  const [project, setProject] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [saveError, setSaveError] = useState<string | undefined>()
  const [busy, setBusy] = useState(true)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async (root: string | null) => {
    if (rpc === undefined) return
    setBusy(true)
    setLoadError(undefined)
    try {
      const next = await call<Overview>(rpc, 'skillsOverview', { project: root ?? '' })
      setData(next)
      setDraft(EMPTY_DRAFT)
      setSaved(false)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [rpc])

  useEffect(() => { void load(project) }, [load, project])

  const groups = useMemo(() => {
    const out = new Map<Scope, SkillRow[]>()
    for (const s of data?.skills ?? []) out.set(s.scope, [...(out.get(s.scope) ?? []), s])
    return out
  }, [data])

  if (rpc === undefined || t === undefined) return null

  if (data === undefined) {
    return (
      <div style={styles.page}>
        <h2 style={styles.title}>{t('title')}</h2>
        <p style={styles.intro}>{t('intro')}</p>
        {loadError === undefined ? <p style={styles.hint}>{t('loading')}</p> : <p style={styles.error}>{t('error', { message: loadError })}</p>}
      </div>
    )
  }

  const inProject = data.project !== null
  const changes = changesOf(data, draft, inProject)
  const count = Object.keys(changes.skills).length + Object.keys(changes.pySkills).length
  const own = <L,>(row: { global: L | null; project: L | null }): L | null => (inProject ? row.project : row.global)

  const editSkill = (name: string, value: Level | null): void => {
    setSaved(false)
    setDraft((d) => ({ ...d, skills: { ...d.skills, [name]: value } }))
  }
  const editPy = (name: string, value: PyLevel | null): void => {
    setSaved(false)
    setDraft((d) => ({ ...d, pySkills: { ...d.pySkills, [name]: value } }))
  }
  const revert = (): void => {
    setDraft(EMPTY_DRAFT)
    setSaveError(undefined)
    setSaved(false)
  }
  const save = async (): Promise<void> => {
    if (rpc === undefined) return
    setBusy(true)
    setSaveError(undefined)
    try {
      const next = await call<Overview>(rpc, 'skillsSave', { project: project ?? '', skills: changes.skills, pySkills: changes.pySkills })
      setData(next)
      setDraft(EMPTY_DRAFT)
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const guardSwitch = (): boolean => {
    if (count === 0) return false
    setSaveError(t('switchBlocked'))
    return true
  }
  const pickProject = (root: string | null): void => {
    if (guardSwitch()) return
    setSaveError(undefined)
    setProject(root)
  }
  const refresh = (): void => {
    if (guardSwitch()) return
    setSaveError(undefined)
    void load(project)
  }

  const skillOptions = (row: SkillRow) => [
    ...(inProject ? [{ id: INHERIT, label: `${t('inherit')}（${t(levelKey(row.global ?? 'on'))}）` }] : []),
    ...LEVELS.map((l) => ({ id: l, label: t(levelKey(l)) })),
  ]
  const pyOptions = (row: PyRow) => [
    ...(inProject ? [{ id: INHERIT, label: `${t('inherit')}（${t(levelKey(row.global ?? 'on'))}）` }] : []),
    ...PY_LEVELS.map((l) => ({ id: l, label: t(levelKey(l)) })),
  ]

  return (
    <div style={styles.page}>
      <PageHeader
        title={t('title')}
        dirtyCount={count}
        justSaved={saved}
        busy={busy}
        saveDisabled={data.fileError !== undefined}
        labels={{ unsaved: t('unsaved', { count }), saved: t('saved'), revert: t('revert'), save: t('save'), saving: t('saving') }}
        onRevert={revert}
        onSave={() => void save()}
      />
      <p style={styles.intro}>{t('intro')}</p>
      <div style={styles.bar}>
        <span style={styles.meta}>{t('viewing')}</span>
        <ProjectMenu t={t} data={data} disabled={busy} onPick={pickProject} />
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>{t('refresh')}</Button>
      </div>
      {inProject && <p style={styles.hint}>{t('projectHint')}</p>}
      <p style={styles.hint}>{data.exists ? t('file', { path: data.path }) : t('fileMissing', { path: data.path })}</p>
      {data.fileError !== undefined && <p style={styles.error}>{t('fileError', { message: data.fileError })}</p>}
      {saveError !== undefined && <p style={styles.error}>{t('saveError', { message: saveError })}</p>}

      <section style={styles.block}>
        <h3 style={styles.blockTitle}>{t('normalTitle')}</h3>
        <p style={styles.hint}>{t('normalHint')}</p>
        <ul style={styles.legend}>
          {LEVELS.map((l) => <li key={l}><span style={styles.legendName}>{t(levelKey(l))}</span>：{t(levelHintKey(l))}</li>)}
        </ul>
        {data.skillsError !== undefined && <p style={styles.error}>{data.skillsError}</p>}
        {data.skills.length === 0 && data.skillsError === undefined && <p style={styles.hint}>{t('empty')}</p>}
        {SCOPES.map((scope) => {
          const rows = groups.get(scope) ?? []
          if (rows.length === 0) return null
          return (
            <div key={scope} style={styles.block}>
              <h4 style={styles.groupTitle}>{t(`scope_${scope}` as SkillExposureKey)}（{rows.length}）</h4>
              <div style={styles.card}>
                {rows.map((row, i) => {
                  const editing = has(draft.skills, row.name) ? draft.skills[row.name]! : own(row)
                  return (
                    <div key={row.name} style={{ ...styles.row, ...(i === 0 ? {} : styles.divider) }}>
                      <div style={styles.body}>
                        <div style={styles.name}>
                          <span title={row.path}>{row.name}</span>
                          <Tag tone={tone(row.level)}>{t(levelKey(row.level))}</Tag>
                          {!row.declared.modelInvocable && <Tag tone="outline">{t('declaredUserOnly')}</Tag>}
                          {!row.declared.userInvocable && <Tag tone="outline">{t('declaredModelOnly')}</Tag>}
                        </div>
                        <span style={styles.desc} title={row.description}>{row.description}</span>
                        <span style={styles.meta}>{fromText(t, row.from)}</span>
                      </div>
                      <div style={styles.actions}>
                        <LevelMenu
                          t={t}
                          label={editing === null ? (inProject ? t('inherit') : t('inheritDefault')) : t(levelKey(editing))}
                          current={editing === null ? (inProject ? INHERIT : 'on') : editing}
                          options={skillOptions(row)}
                          disabled={busy}
                          onSelect={(id) => editSkill(row.name, id === INHERIT ? null : (!inProject && id === 'on' ? null : (id as Level)))}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </section>

      <section style={styles.block}>
        <h3 style={styles.blockTitle}>{t('pyTitle')}</h3>
        <p style={styles.hint}>{t('pyHint')}</p>
        {data.pySkills.length === 0 && <p style={styles.hint}>{t('empty')}</p>}
        {data.pySkills.length > 0 && (
          <div style={styles.card}>
            {data.pySkills.map((row, i) => {
              const editing = has(draft.pySkills, row.name) ? draft.pySkills[row.name]! : own(row)
              return (
                <div key={row.name} style={{ ...styles.row, ...(i === 0 ? {} : styles.divider) }}>
                  <div style={styles.body}>
                    <div style={styles.name}>
                      <span title={row.dir}>{row.name}</span>
                      <span style={styles.meta}>skills.{row.importName}</span>
                      <Tag tone={row.level === 'on' ? 'success' : 'danger'}>{t(levelKey(row.level))}</Tag>
                    </div>
                    <span style={styles.desc} title={row.description}>{row.description}</span>
                    <span style={styles.meta}>{fromText(t, row.from)}</span>
                  </div>
                  <div style={styles.actions}>
                    <LevelMenu
                      t={t}
                      label={editing === null ? (inProject ? t('inherit') : t('inheritDefault')) : t(levelKey(editing))}
                      current={editing === null ? (inProject ? INHERIT : 'on') : editing}
                      options={pyOptions(row)}
                      disabled={busy}
                      onSelect={(id) => editPy(row.name, id === INHERIT ? null : (!inProject && id === 'on' ? null : (id as PyLevel)))}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
