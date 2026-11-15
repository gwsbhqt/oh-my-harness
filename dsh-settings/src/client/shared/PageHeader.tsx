/**
 * 三页共用的「草稿 / 撤销 / 保存」页头骨架。
 *
 * 模式偏好、技能、快捷回复三页在同一个包里；客户端插件不能跨插件 import，同一个包内才能共用，
 * 所以三页共享这一份页头。各页只传入已翻译好的文案，页面之间不互相依赖。
 */
import type { CSSProperties } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

export interface PageHeaderLabels {
  /** 已带好数量，如「3 项未保存」。 */
  unsaved: string
  saved: string
  revert: string
  save: string
  saving: string
}

export interface PageHeaderProps {
  title: string
  dirtyCount: number
  justSaved: boolean
  busy: boolean
  /** 保存按钮的额外禁用条件（例如规则文件写错了）。 */
  saveDisabled?: boolean
  labels: PageHeaderLabels
  onRevert: () => void
  onSave: () => void
}

const styles: Record<string, CSSProperties> = {
  header: {
    position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    minHeight: 28, padding: '8px 0', marginBottom: -8, background: 'var(--dsw-alias-bg-layer-2)',
  },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
}

export function PageHeader(props: PageHeaderProps) {
  const { title, dirtyCount, justSaved, busy, saveDisabled, labels, onRevert, onSave } = props
  return (
    <div style={styles.header}>
      <h2 style={styles.title}>{title}</h2>
      <div style={styles.actions}>
        {dirtyCount > 0 ? <Tag tone="warning">{labels.unsaved}</Tag> : justSaved ? <Tag tone="success">{labels.saved}</Tag> : null}
        <Button variant="ghost" size="sm" disabled={dirtyCount === 0 || busy} onClick={onRevert}>{labels.revert}</Button>
        <Button variant="primary" size="sm" disabled={dirtyCount === 0 || busy || saveDisabled === true} onClick={onSave}>{busy ? labels.saving : labels.save}</Button>
      </div>
    </div>
  )
}
