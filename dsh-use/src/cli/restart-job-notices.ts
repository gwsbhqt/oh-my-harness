import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedDetail } from '../quit-blockers.ts'

export interface StoppedJobNotice {
  sessionId: string
  messageId: string
  insertionSeq: number
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function stoppedJobNotice(sessionId: string, data: unknown): StoppedJobNotice | undefined {
  const receipt = data as Record<string, unknown> | null | undefined
  if (receipt?.sessionId === sessionId && receipt.accepted === true && receipt.delivery === 'inject' &&
    receipt.scheduled === false && receipt.agentStatus === 'idle' && isUuid(receipt.messageId) && validSeq(receipt.insertionSeq)) {
    return { sessionId, messageId: receipt.messageId, insertionSeq: receipt.insertionSeq }
  }
  return undefined
}

/** 只信执行者按请求原子写入的终态档案。通知正文和普通 notice 的返回值都不能登记回执。 */
export function readStoppedJobNotices(directory: string): Map<string, StoppedJobNotice> {
  const owners = new Map<string, StoppedJobNotice>()
  let files
  try { files = readdirSync(directory, { withFileTypes: true }) } catch { return owners }
  for (const file of files) {
    const id = file.name.slice(0, -5)
    if (!file.isFile() || !file.name.endsWith('.json') || !isUuid(id)) continue
    try {
      const record = JSON.parse(readFileSync(join(directory, file.name), 'utf8'))
      if (record?.schemaVersion !== 2 || record.requestId !== id || record.executionRequestId !== undefined ||
        (record.phase !== 'completed' && record.phase !== 'failed') || !Array.isArray(record.stoppedJobNotices)) continue
      for (const notice of record.stoppedJobNotices) {
        if (typeof notice?.sessionId === 'string' && isUuid(notice.messageId) && validSeq(notice.insertionSeq)) owners.set(notice.messageId, notice)
      }
    } catch { /* 缺失或损坏的档案不能证明任何消息的来历。 */ }
  }
  return owners
}

export function allowsQueuedNotices(queued: readonly string[], details: QueuedDetail[] | undefined, loadReceipts: () => ReadonlyMap<string, StoppedJobNotice>): boolean {
  if (queued.length === 0 || !Array.isArray(details)) return false
  const pending: { sessionId: string; source: QueuedDetail['nextStepSources'][number] }[] = []
  for (const id of queued) {
    const detail = details.find((item) => item?.id === id)
    if (detail?.nextTurnCount !== 0 || !Array.isArray(detail.nextStepSources) || detail.nextStepCount !== detail.nextStepSources.length || detail.nextStepCount === 0) return false
    for (const source of detail.nextStepSources) pending.push({ sessionId: id, source })
  }
  if (pending.every(({ source }) => source?.form === 'notice' && (source.kind === 'dsh-monitor' || source.kind === 'python-repl-jobs'))) return true
  return pending.every(({ source, sessionId }) => {
    if (source?.kind !== 'dsh-use' || source.form !== 'notice' || !isUuid(source.messageId) || !validSeq(source.insertionSeq)) return false
    const receipt = loadReceipts().get(source.messageId)
    return receipt?.sessionId === sessionId && receipt.insertionSeq === source.insertionSeq
  })
}
