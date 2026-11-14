/** 从输出中选原因；完整输出由调用者单独存日志。 */
export class FailureReasonCollector {
  private pending = ''
  private checks: string[] = []
  private structured: string[] = []
  private errors: string[] = []
  private plain: string[] = []
  stage: string | undefined
  private failedStage: string | undefined
  private priority = 4
  push(chunk: string): void {
    for (const part of chunk.split(/(?<=\n)/)) {
      this.pending += part
      if (part.endsWith('\n')) {
        this.line(this.pending)
        this.pending = ''
      }
    }
  }
  private remember(target: string[], value: unknown): void {
    if (typeof value !== 'string' || value.trim() === '') return
    const raw = value.trim()
    const text = raw.length > 6000 ? `${raw.slice(0, 1500)} … ${raw.slice(-4497)}` : raw
    if (!target.includes(text)) {
      if (target.length >= 8) target.shift()
      target.push(text)
    }
  }
  private line(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (line === '') return
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      const inspect = (v: unknown, depth = 0): void => {
        if (depth > 6 || v === null || typeof v !== 'object') return
        const item = v as Record<string, unknown>
        if (Array.isArray(item.checks)) for (const check of item.checks) {
          if (check && typeof check === 'object' && (check as Record<string, unknown>).ok === false) {
            const c = check as Record<string, unknown>
            const failures = Array.isArray(c.details) ? c.details.filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok === false) : []
            if (failures.length > 0) for (const entry of failures) {
              const failed = entry as Record<string, unknown>
              this.remember(this.checks, `${String(c.id ?? 'check')}: ${String(failed.name ?? '')}: ${String(failed.message ?? failed.reason ?? failed.error ?? '检查失败')}`)
            }
            else this.remember(this.checks, `${typeof c.id === 'string' ? `${c.id}: ` : ''}${String(c.message ?? c.reason ?? c.error ?? '检查失败')}`)
          }
        }
        if (typeof item.stage === 'string') this.stage = item.stage
        if (item.error && typeof item.error === 'object') {
          const error = item.error as Record<string, unknown>
          this.remember(this.structured, error.message)
          if (typeof error.stage === 'string') this.failedStage = error.stage
        }
        if (item.ok === false || item.error !== undefined || item.reason !== undefined) {
          for (const key of ['reason', 'message', 'error']) this.remember(this.structured, item[key])
        }
        if (Array.isArray(item.plugins)) for (const entry of item.plugins) {
          if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).action === 'failed') {
            const failed = entry as Record<string, unknown>
            const error = failed.error
            this.remember(this.structured, `${String(failed.name ?? 'plugin')}: ${typeof error === 'object' && error !== null ? String((error as Record<string, unknown>).message ?? JSON.stringify(error)) : String(error ?? '构建失败')}`)
          }
        }
        if (Array.isArray(item.errors)) for (const error of item.errors) {
          this.remember(this.structured, typeof error === 'object' && error !== null ? (error as Record<string, unknown>).message : error)
        }
        for (const key of ['data', 'report', 'result']) inspect(item[key], depth + 1)
      }
      inspect(value)
      return
    } catch { /* 普通文本错误照样保留。 */ }
    if (/(?:^|[\s\[])WARN(?:ING)?(?:[\s\]:]|$)|^\(node:\d+\).*Warning:|^\s*DeprecationWarning:/i.test(line) && !/\b(?:error|failed|fatal|exception)\b|失败|错误/i.test(line)) return
    this.remember(this.plain, line)
    if (/error|failed|fatal|失败|错误|没通过|exception|denied/i.test(line)) this.remember(this.errors, line)
  }
  reason(): string {
    if (this.pending !== '') { this.line(this.pending); this.pending = '' }
    this.priority = this.checks.length ? 0 : this.structured.length ? 1 : this.errors.length ? 2 : this.plain.length ? 3 : 4
    return [this.checks, this.structured, this.errors, this.plain, []][this.priority]!.join('；').slice(0, 6000)
  }
  result(): { priority: number; reason: string; stage?: string } {
    const reason = this.reason()
    const stage = this.failedStage ?? this.stage
    return { priority: this.priority, reason, ...(stage === undefined ? {} : { stage }) }
  }
}
