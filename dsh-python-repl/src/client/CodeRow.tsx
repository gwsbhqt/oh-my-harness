/**
 * The `run_code` row, with its code shown — and highlighted — as Python.
 *
 * Why this exists: the host's generic tool card hard-codes
 * `<CodeBlock lang="typescript">` for every `run_code` call
 * (`dsh-client-ui-tool`, ToolRow), whatever language the code runtime runs.
 * With this plugin the runtime is Python, so every cell was labelled
 * "typescript" and coloured as TS — which read as "the session switched to
 * TS" (2026-09-23), though every cell ran in the Python kernel.
 *
 * A keyed `tool.call.toolview` entry replaces the generic card for one tool
 * name; the fallback is not handed to the entry, so the card is rebuilt here
 * from the same public primitives (`DisclosureRow`, `CodeBlock`, `StateDot`)
 * and the host's own ToolRow class names, read at runtime (classes.ts), so it
 * looks and behaves like the native one. Only `lang` differs. Sub-calls are
 * drawn by the host outside the slot, untouched.
 *
 * Delete this view when the host picks the code block's language from the
 * code runtime (`ctx.ptcRuntime.language`) instead of hard-coding it.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { codeRowModel, type CallBlock, type RowState } from './model.ts'
import { hostToolRowClasses, TOOL_ROW_CLASS_KEYS, type ToolRowClasses } from './classes.ts'
import {
  CodeBlock,
  DisclosureRow,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconCodeOutlineRegular as IconCode,
  IconInspectOutlineRegular as IconInspect,
} from '@deepseek-ai/dsh-client-ui-primitives'

const NO_CLASSES = Object.fromEntries(TOOL_ROW_CLASS_KEYS.map((k) => [k, ''])) as unknown as ToolRowClasses

/** Screen-reader-only even when the host stylesheet could not be read. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, border: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
}

type UseDisclosure = () => { expanded: boolean; toggle: () => void }

export interface CodeRowProps {
  callId: string
  toolName: string
  block: CallBlock
  inspect?: (() => void) | undefined
  /** Host-owned open state (resets with the enclosing turn); absent on older hosts. */
  useDisclosure?: UseDisclosure | undefined
  /** The conversation locale seat (the entry registers with `locale: "conversation"`). */
  // 方法写法让参数按双向检查：DSH 0.2.1 的 t 只收 conversation 表里的键，仍要能传进来。
  t(key: string): string
}

function useLocalDisclosure(): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState(false)
  return { expanded, toggle: () => setExpanded((v) => !v) }
}

function leading(state: RowState): ReactNode {
  if (state === 'error') return <StateDot state="error" />
  if (state === 'stopped') return <StateDot state="warning" />
  return <IconCode size={14} />
}

function stateLabel(state: RowState, t: CodeRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

function summaryClass(C: ToolRowClasses, state: RowState): string {
  if (state === 'error') return `${C.summary} ${C.errorSummary}`
  if (state === 'stopped') return `${C.summary} ${C.stoppedSummary}`
  return C.summary
}

export function CodeRow({ toolName, block, inspect, useDisclosure, t }: CodeRowProps) {
  const { expanded, toggle } = (useDisclosure ?? useLocalDisclosure)()
  const C = hostToolRowClasses() ?? NO_CLASSES
  const model = useMemo(() => codeRowModel(block), [block])
  const expandable = model.code !== null || model.output !== null
  const open = expanded && expandable
  const status = stateLabel(model.state, t)
  const failureLine = model.state === 'error' ? model.errorSummary : null
  const summaryText = failureLine ?? model.summary
  const toolbarLabels = useMemo(
    () => ({ codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') }),
    [t],
  )
  return (
    <div className={C.root} data-variant="code" data-tool={toolName} data-state={model.state} data-lang="python">
      {status !== null && <span className={C.visuallyHidden} style={VISUALLY_HIDDEN}>{status}</span>}
      <DisclosureRow
        rowClassName={C.row}
        leadingClassName={C.leading}
        titleClassName={C.title}
        chevronClassName={C.chevron}
        icon={leading(model.state)}
        title={t('tool.title.code')}
        running={model.state === 'running'}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={
          summaryText !== '' && (
            <>
              <span className={C.sep} data-shimmer-decoration aria-hidden />
              <span className={summaryClass(C, model.state)}>{summaryText}</span>
            </>
          )
        }
      >
        <div className={C.bodyWrap}>
          {model.code !== null && (
            <div className={C.bodyScroll}>
              <CodeBlock
                code={model.code}
                lang="python"
                streaming={model.state === 'running'}
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
                toolbarLabels={toolbarLabels}
                className={C.codeBody}
              />
            </div>
          )}
          {model.output !== null && (
            <div className={C.ioCard}>
              <div className={C.ioSection}>
                <span className={C.ioLabel}>{t('row.output')}</span>
                <span className={C.ioText} data-error={model.state === 'error' || undefined}>{model.output}</span>
              </div>
            </div>
          )}
          {inspect !== undefined && (
            <button type="button" className={C.inspectButton} onClick={inspect}>
              <IconInspect size={12} />
              {t('row.inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
