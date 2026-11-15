/**
 * 快捷回复设置页：预设（增删改、拖拽排序）和点预设时的动作。
 *
 * 改动先进草稿，页头「撤销 / 保存」统一管（和「模型偏好」「模式偏好」两页一致）；
 * 保存走宿主半 `/api/settings.quickRepliesSave`，写 `$DSH_HOME/preferences.json` 的 `quickReplies` 段，写完按接口回来的内容刷新。
 * 输入框按钮菜单里的「编辑快捷回复…」也是打开这一页。
 */
import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import {
  Button,
  IconTrashOutlineRegular,
  Input,
  SegmentedControl,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { addPreset, editPreset, movePresetTo, removePreset, type PresetIssue } from '../../quick-reply/presets.ts'
import type { QuickReplyKey } from './locales.ts'
import type { QuickReplyStore, QuickReplyValue } from './store.ts'
import { PageHeader } from '../shared/PageHeader.tsx'

export type Translate = (key: QuickReplyKey, params?: Record<string, unknown>) => string

/** 设置页的注入面。 */
export interface QuickReplyFace {
  readonly store: QuickReplyStore
  readonly t: Translate
}

export type QuickReplySectionProps = Partial<QuickReplyFace>

const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
  intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },
  subTitle: { margin: '12px 0 0', fontSize: 14, fontWeight: 500, lineHeight: '22px' },
  card: {
    display: 'flex', flexDirection: 'column', padding: '4px 14px',
    border: '.5px solid var(--dsw-alias-settings-card-stroke)', background: 'var(--dsw-alias-settings-card-fill)',
    borderRadius: 'var(--dsw-radius-xl)',
  },
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' },
  // 每行共用一套列宽：把手、文字伸缩、按钮列按内容不换行
  row: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr) max-content', alignItems: 'center', columnGap: 8, padding: '8px 0' },
  rowDragging: { opacity: 0.45, background: 'var(--dsw-alias-interactive-bg-hover)' },
  divider: { borderTop: '.5px solid var(--dsw-alias-border-l2)' },
  handle: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 28,
    color: 'var(--dsw-alias-label-tertiary)', cursor: 'grab', borderRadius: 'var(--dsw-radius-sm, 8px)',
    userSelect: 'none',
  },
  rowActions: { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' },
  rowIdentity: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  editInput: { width: '100%' },
  addRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', alignItems: 'center', columnGap: 12, padding: '10px 0' },
  iconButton: { width: 28, padding: 0, justifyContent: 'center' },
  hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  empty: { margin: 0, padding: '10px 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  actionRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0' },
  actionLabel: { fontSize: 14, lineHeight: '22px' },
}

function issueText(issue: PresetIssue, t: Translate): string {
  return issue === 'empty' ? t('issueEmpty') : t('issueDuplicate')
}

/** 拖拽把手：六个点。宿主没有现成的把手图标，这是纯装饰。 */
function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
      <circle cx="3" cy="3" r="1.1" /><circle cx="7" cy="3" r="1.1" />
      <circle cx="3" cy="8" r="1.1" /><circle cx="7" cy="8" r="1.1" />
      <circle cx="3" cy="13" r="1.1" /><circle cx="7" cy="13" r="1.1" />
    </svg>
  )
}

/** 一条预设：左侧把手拖动排序，点文字原地改，Enter 或失焦保存，Esc 放弃；右侧删除。 */
function PresetRow(props: {
  text: string
  index: number
  total: number
  disabled: boolean
  dragging: boolean
  dragFrom: number | undefined
  t: Translate
  onSave: (index: number, text: string) => PresetIssue | undefined
  onMoveTo: (from: number, to: number) => void
  onDragStart: (index: number) => void
  onDragEnd: () => void
  onRemove: (index: number) => void
}) {
  const { text, index, total, disabled, dragging, dragFrom, t, onSave, onMoveTo, onDragStart, onDragEnd, onRemove } = props
  const [draft, setDraft] = useState(text)
  const [issue, setIssue] = useState<PresetIssue | undefined>(undefined)
  // 外面改了（撤销、保存后重新读、别的标签页）：丢掉基于旧值的草稿
  const [seen, setSeen] = useState(text)
  if (seen !== text) {
    setSeen(text)
    setDraft(text)
    setIssue(undefined)
  }
  const commit = () => {
    if (draft === text) return
    const problem = onSave(index, draft)
    setIssue(problem)
    if (problem === 'empty') setDraft(text)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDraft(text)
      setIssue(undefined)
    }
  }
  // 指针拖拽：按住把手拖动时，看指针落在哪一行就把当前这条挪过去。
  // 用 pointer 事件而不是 HTML5 drag：跟手，Mac 触控板/鼠标都走同一条路。
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (disabled || dragFrom === undefined) return
    const under = document.elementFromPoint(event.clientX, event.clientY)
    const row = under?.closest?.('li[data-row-index]') as HTMLElement | null
    if (row === null) return
    const target = Number(row.dataset['rowIndex'])
    if (Number.isInteger(target) && target !== dragFrom) onMoveTo(dragFrom, target)
  }
  const endDrag = () => {
    if (dragFrom !== undefined) onDragEnd()
  }
  return (
    <li
      data-row-index={index}
      style={{ ...styles.row, ...(index === 0 ? {} : styles.divider), ...(dragging ? styles.rowDragging : {}) }}
    >
      <span
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('dragHandle', { text })}
        onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          onDragStart(index)
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId)
          endDrag()
        }}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onMoveTo(index, Math.max(0, index - 1))
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            onMoveTo(index, Math.min(total - 1, index + 1))
          }
        }}
        style={styles.handle}
      >
        <GripIcon />
      </span>
      <div style={styles.rowIdentity}>
        <Input
          style={styles.editInput}
          value={draft}
          aria-label={t('editAria', { text })}
          disabled={disabled}
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {issue === undefined ? null : <p style={styles.error}>{issueText(issue, t)}</p>}
      </div>
      <div style={styles.rowActions}>
        <Button variant="ghost" size="sm" style={styles.iconButton} title={t('remove')} aria-label={t('removeAria', { text })} disabled={disabled} onClick={() => onRemove(index)} icon={<IconTrashOutlineRegular size={16} />} />
      </div>
    </li>
  )
}

/** 设置页本体。 */
export function QuickReplySection(props: QuickReplySectionProps) {
  const { store, t } = props
  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? emptySnapshot)
  const [draft, setDraft] = useState<QuickReplyValue | undefined>(undefined)
  const [addDraft, setAddDraft] = useState('')
  const [addIssue, setAddIssue] = useState<PresetIssue | undefined>(undefined)
  const [saveError, setSaveError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | undefined>(undefined)

  if (store === undefined || t === undefined) return null
  if (snapshot.status === 'loading') return null
  if (snapshot.status === 'unavailable') return <p style={styles.hint}>{t('unavailable')}</p>

  const base = snapshot.value
  const value = draft ?? base
  const presetsChanged = value.presets.length !== base.presets.length
    || value.presets.some((entry, at) => entry !== base.presets[at])
  const actionChanged = value.action !== base.action
  const count = (presetsChanged ? 1 : 0) + (actionChanged ? 1 : 0)
  const disabled = busy || !snapshot.writable

  const edit = (next: QuickReplyValue) => {
    setSaved(false)
    setDraft(next)
  }
  const revert = () => {
    setDraft(undefined)
    setSaveError(false)
    setAddDraft('')
    setAddIssue(undefined)
  }
  const save = async () => {
    setBusy(true)
    setSaveError(false)
    try {
      const ok = await store.save(value)
      setSaveError(!ok)
      if (ok) {
        setDraft(undefined)
        setSaved(true)
      }
    } catch {
      setSaveError(true)
    } finally {
      setBusy(false)
    }
  }

  const add = (text: string): void => {
    const change = addPreset(value.presets, text)
    if (!change.ok) {
      setAddIssue(change.issue)
      return
    }
    setAddIssue(undefined)
    setAddDraft('')
    edit({ ...value, presets: change.presets })
  }

  const saveRow = (index: number, text: string): PresetIssue | undefined => {
    const change = editPreset(value.presets, index, text)
    if (!change.ok) return change.issue
    edit({ ...value, presets: change.presets })
    return undefined
  }

  const moveTo = (from: number, to: number): void => {
    if (from < 0) return
    const next = movePresetTo(value.presets, from, to)
    if (next.join('\n') === value.presets.join('\n')) return
    setDragFrom(to)
    edit({ ...value, presets: next })
  }

  const onAddKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter') return
    event.preventDefault()
    add(addDraft)
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title={t('title')}
        dirtyCount={count}
        justSaved={saved}
        busy={busy}
        saveDisabled={!snapshot.writable}
        labels={{ unsaved: t('unsaved', { count }), saved: t('saved'), revert: t('revert'), save: t('save'), saving: t('saving') }}
        onRevert={revert}
        onSave={() => void save()}
      />
      <p style={styles.intro}>{t('intro')}</p>

      <h3 style={styles.subTitle}>{t('presetsTitle')}</h3>
      <div style={styles.card}>
        {value.presets.length === 0
          ? <p style={styles.empty}>{t('presetsEmpty')}</p>
          : (
              <ul style={styles.list}>
                {value.presets.map((text, index) => (
                  <PresetRow
                    // 用位置当 key：改字时不该重建这一行（会丢焦点）
                    key={index}
                    text={text}
                    index={index}
                    total={value.presets.length}
                    disabled={disabled}
                    dragging={dragFrom === index}
                    dragFrom={dragFrom}
                    t={t}
                    onSave={saveRow}
                    onMoveTo={moveTo}
                    onDragStart={setDragFrom}
                    onDragEnd={() => setDragFrom(undefined)}
                    onRemove={at => edit({ ...value, presets: removePreset(value.presets, at) })}
                  />
                ))}
              </ul>
            )}
        <div style={{ ...styles.addRow, ...styles.divider }}>
          <Input
            value={addDraft}
            placeholder={t('addPlaceholder')}
            aria-label={t('addPlaceholder')}
            disabled={disabled}
            onChange={(event) => {
              setAddDraft(event.target.value)
              setAddIssue(undefined)
            }}
            onKeyDown={onAddKey}
          />
          <Button variant="outline" size="sm" disabled={disabled || addDraft.trim() === ''} onClick={() => add(addDraft)}>{t('add')}</Button>
        </div>
        {addIssue === undefined ? null : <p style={{ ...styles.error, paddingBottom: 8 }}>{issueText(addIssue, t)}</p>}
        <div style={{ ...styles.actionRow, ...styles.divider }}>
          <span style={styles.actionLabel}>{t('actionTitle')}</span>
          <SegmentedControl
            id="quick-reply-action"
            label={t('actionTitle')}
            value={value.action}
            disabled={disabled}
            options={[{ value: 'send', label: t('actionSend') }, { value: 'insert', label: t('actionInsert') }]}
            onChange={next => edit({ ...value, action: next as QuickReplyValue['action'] })}
          />
        </div>
      </div>
      {saveError ? <p style={styles.error}>{t('saveFailed')}</p> : null}
      {snapshot.error === undefined ? null : <p style={styles.error}>{snapshot.error}</p>}
    </div>
  )
}

const noopSubscribe = () => () => {}
const EMPTY = { status: 'unavailable', writable: false, value: { presets: [], action: 'send' } } as const
const emptySnapshot = () => EMPTY
