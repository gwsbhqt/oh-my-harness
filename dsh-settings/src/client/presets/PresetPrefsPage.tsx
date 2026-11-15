/**
 * 设置侧栏「模式偏好」一页，样子照「模型偏好」页：上面是新会话默认模式，下面每个工作区一行下拉框。
 * 改动先进草稿，页头「撤销 / 保存」统一管；保存走宿主半 `/api/settings.presetsSave`，写完整页重读。
 * 说明收进标题旁 ⓘ 的提示里，页面上只留名字、下拉框和按钮。只用宿主公开组件和 `--dsw-*` 变量。
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconInfoOutlineRegular, IconWarningOutlineRegular, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PresetsKey } from './locales.ts'
import { call } from '../rpc.ts'
import { PageHeader } from '../shared/PageHeader.tsx'

export type Translate = (key: PresetsKey, params?: Record<string, unknown>) => string

export interface PageInjected {
  rpc: ConnectionHandle['rpc']
  t: Translate
}
export type PageProps = Partial<PageInjected>

interface PresetRow { id: string; name?: string; broken?: string }
interface ProjectRow { root: string; title: string; configured: boolean; preset: string | null }
interface Overview {
  path: string
  exists: boolean
  fileError?: string
  hook: { ok: boolean; message?: string }
  globalDefault: string | null
  presets: PresetRow[]
  projects: ProjectRow[]
}

/** 下拉里「跟随默认」那一项的值。 */
const FOLLOW = ''

/** 与「模型偏好」页同一套版式（dsh-models 的 layout.ts）；跨插件不能导入，抄一份。 */
const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 24, color: 'var(--dsw-alias-label-primary)' },
  header: {
    position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    minHeight: 28, padding: '8px 0', marginBottom: -8, background: 'var(--dsw-alias-bg-layer-2)',
  },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  block: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
  blockTitle: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)', display: 'flex', alignItems: 'center', gap: 6 },
  card: {
    display: 'flex', flexDirection: 'column', padding: '4px 14px',
    border: '.5px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)',
    borderRadius: 'var(--dsw-radius-xl)',
  },
  select: {
    boxSizing: 'border-box', width: '100%', height: 32, padding: '0 32px 0 10px',
    border: '.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', fontSize: 14, lineHeight: '22px', cursor: 'pointer',
  },
  divider: { borderTop: '.5px solid var(--dsw-alias-border-l2)' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  warn: { margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label)' },
  row: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(200px, 320px)', alignItems: 'center', columnGap: 12, padding: '8px 0' },
  name: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 14, lineHeight: '22px' },
  nameText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default' },
  icon: { display: 'inline-flex', alignItems: 'center', flexShrink: 0, cursor: 'default' },
}

function TipIcon({ label, color, children }: { label: string; color?: string; children: ReactNode }) {
  return (
    <Tooltip label={label} side="top" portal maxWidth={320}>
      <span tabIndex={0} aria-label={label} style={{ ...styles.icon, color: color ?? 'var(--dsw-alias-label-tertiary)' }}>{children}</span>
    </Tooltip>
  )
}

function BlockTitle({ title, tip }: { title: string; tip: string }) {
  return (
    <h3 style={styles.blockTitle}>
      {title}
      <TipIcon label={tip}><IconInfoOutlineRegular size={14} /></TipIcon>
    </h3>
  )
}

function DirtyDot({ label }: { label: string }) {
  return (
    <TipIcon label={label}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-warn-label)' }} />
    </TipIcon>
  )
}

/** 模式给人看的名字：模式自己声明了名字就用它，DSH 自带、没声明名字的按 id 翻译。 */
export function presetLabel(preset: PresetRow | undefined, id: string, t: Translate): string {
  if (preset?.name !== undefined) return preset.name
  switch (id) {
    case 'ptc': return t('preset_ptc')
    case 'cordis': return t('preset_cordis')
    case 'standard': return t('preset_standard')
    case 'minimal': return t('preset_minimal')
    default: return preset === undefined ? t('unknownPreset', { id }) : id
  }
}

/** 草稿：全局默认改成哪个，各项目根改成哪个（null = 跟随默认）。 */
interface Draft { default?: string; projects: Record<string, string | null> }

export function draftChanges(data: Overview | undefined, draft: Draft): { default?: string; projects: Record<string, string | null> } {
  if (data === undefined) return { projects: {} }
  const projects: Record<string, string | null> = {}
  for (const p of data.projects) {
    if (!(p.root in draft.projects)) continue
    const next = draft.projects[p.root] ?? null
    if (next !== p.preset) projects[p.root] = next
  }
  return {
    ...(draft.default !== undefined && draft.default !== data.globalDefault ? { default: draft.default } : {}),
    projects,
  }
}

function PresetSelect(props: { value: string; presets: PresetRow[]; follow?: string; ariaLabel: string; disabled: boolean; t: Translate; onChange: (value: string) => void }) {
  const { value, presets, follow, ariaLabel, disabled, t, onChange } = props
  const listed = presets.some((p) => p.id === value)
  return (
    <select aria-label={ariaLabel} style={styles.select} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {follow === undefined ? null : <option value={FOLLOW}>{follow}</option>}
      {presets.map((p) => <option key={p.id} value={p.id}>{presetLabel(p, p.id, t)}</option>)}
      {value === FOLLOW || listed ? null : <option value={value}>{presetLabel(undefined, value, t)}</option>}
    </select>
  )
}

export function PresetPrefsPage(props: PageProps) {
  const { rpc, t } = props
  const [data, setData] = useState<Overview | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft>({ projects: {} })
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    if (rpc === undefined) return
    setLoadError(undefined)
    try {
      setData(await call<Overview>(rpc, 'presetsOverview', {}))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [rpc])

  useEffect(() => { void load() }, [load])

  if (rpc === undefined || t === undefined) return null

  const changes = draftChanges(data, draft)
  const count = Object.keys(changes.projects).length + (changes.default === undefined ? 0 : 1)
  const usable = (data?.presets ?? []).filter((p) => p.broken === undefined)
  const byId = new Map((data?.presets ?? []).map((p) => [p.id, p] as const))
  const globalNow = draft.default ?? data?.globalDefault ?? ''

  const edit = (next: (d: Draft) => Draft) => {
    setSaved(false)
    setDraft(next)
  }
  const revert = () => {
    setDraft({ projects: {} })
    setSaveError(undefined)
  }
  const save = async () => {
    setBusy(true)
    setSaveError(undefined)
    try {
      setData(await call<Overview>(rpc, 'presetsSave', changes))
      setDraft({ projects: {} })
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title={t('nav')}
        dirtyCount={count}
        justSaved={saved}
        busy={busy}
        saveDisabled={data?.fileError !== undefined}
        labels={{ unsaved: t('unsaved', { count }), saved: t('saved'), revert: t('revert'), save: t('save'), saving: t('saving') }}
        onRevert={revert}
        onSave={() => void save()}
      />
      {saveError === undefined ? null : <p style={styles.error}>{t('saveError', { message: saveError })}</p>}
      {data === undefined
        ? loadError === undefined
          ? <p style={styles.hint}>{t('loading')}</p>
          : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p style={styles.error}>{t('loadError', { message: loadError })}</p>
                <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
              </div>
            )
        : (
            <>
              {data.hook.ok ? null : <p style={styles.warn}><IconWarningOutlineRegular size={14} />{t('hookMissing', { message: data.hook.message ?? '' })}</p>}
              {data.fileError === undefined ? null : <p style={styles.error}>{t('fileError', { message: data.fileError })}</p>}
              <section style={styles.block}>
                <BlockTitle title={t('defaultTitle')} tip={t('defaultTip')} />
                <div style={styles.card}>
                  <div style={styles.row}>
                    <span style={styles.name}>
                      <span style={styles.nameText}>{presetLabel(byId.get(globalNow), globalNow, t)}</span>
                      {changes.default === undefined ? null : <DirtyDot label={t('dirty')} />}
                    </span>
                    <PresetSelect
                      value={globalNow}
                      presets={usable}
                      ariaLabel={t('defaultTitle')}
                      disabled={busy}
                      t={t}
                      onChange={(value) => edit((d) => ({ ...d, default: value }))}
                    />
                  </div>
                </div>
              </section>
              <section style={styles.block}>
                <BlockTitle title={t('projectsTitle')} tip={`${t('projectsTip')} ${t('fileTip', { path: data.path })}`} />
                <div style={styles.card}>
                  {data.projects.length === 0
                    ? <p style={{ ...styles.hint, padding: '10px 0' }}>{t('projectsEmpty')}</p>
                    : data.projects.map((p, index) => {
                        const value = p.root in draft.projects ? (draft.projects[p.root] ?? FOLLOW) : (p.preset ?? FOLLOW)
                        const dirty = p.root in changes.projects
                        const broken = value === FOLLOW ? undefined : byId.get(value)?.broken
                        return (
                          <div key={p.root} style={index === 0 ? styles.row : { ...styles.row, ...styles.divider }}>
                            <span style={styles.name}>
                              <Tooltip label={p.root} side="top" portal maxWidth={420}>
                                <span tabIndex={0} style={styles.nameText}>{p.title}</span>
                              </Tooltip>
                              {broken === undefined ? null : <TipIcon label={t('brokenPreset', { message: broken })} color="var(--dsw-alias-state-warn-label)"><IconWarningOutlineRegular size={14} /></TipIcon>}
                              {dirty ? <DirtyDot label={t('dirty')} /> : null}
                            </span>
                            <PresetSelect
                              value={value}
                              presets={usable}
                              follow={t('follow', { name: presetLabel(byId.get(globalNow), globalNow, t) })}
                              ariaLabel={t('selectAria', { name: p.title })}
                              disabled={busy || data.fileError !== undefined}
                              t={t}
                              onChange={(next) => edit((d) => ({ ...d, projects: { ...d.projects, [p.root]: next === FOLLOW ? null : next } }))}
                            />
                          </div>
                        )
                      })}
                </div>
              </section>
            </>
          )}
    </div>
  )
}
