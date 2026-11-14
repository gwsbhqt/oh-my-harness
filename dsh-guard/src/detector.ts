export interface LoopRules {
  readonly repeatCount: number
  readonly minCycleChars: number
  readonly maxCycleChars: number
  readonly minRepeatedChars: number
  readonly windowChars: number
}

export interface LoopMatch {
  readonly cycleChars: number
  readonly repeats: number
}

export function normalizeForComparison(text: string): string {
  return text.replace(/[\s*_`]/g, '')
}

export function findRepeatedSuffix(text: string, rules: LoopRules): LoopMatch | undefined {
  const required = Math.max(rules.minRepeatedChars, rules.minCycleChars * rules.repeatCount)
  if (text.length < required) return undefined
  const maxCycle = Math.min(rules.maxCycleChars, Math.floor(text.length / rules.repeatCount))
  for (let cycleChars = rules.minCycleChars; cycleChars <= maxCycle; cycleChars++) {
    const unit = text.slice(-cycleChars)
    // 纯符号、纯数字的结构串（Markdown 表格分隔行、数值列表等）是正常排版，不算文字循环。
    if (!/\p{L}/u.test(unit)) continue
    // 短单元可以靠更多次数达标，只要实际重复覆盖的字符数达到 minRepeatedChars。
    const needed = Math.max(rules.repeatCount, Math.ceil(rules.minRepeatedChars / cycleChars))
    if (needed * cycleChars > text.length) continue
    let matches = true
    for (let repeat = 1; repeat < needed; repeat++) {
      if (!text.startsWith(unit, text.length - cycleChars * (repeat + 1))) {
        matches = false
        break
      }
    }
    if (matches) return { cycleChars, repeats: needed }
  }
  return undefined
}

export class BlankRunDetector {
  private run = 0
  private pendingEscape = false
  private readonly limit: number
  private readonly jsonEscapes: boolean

  constructor(limit: number, jsonEscapes = false) {
    this.limit = limit
    this.jsonEscapes = jsonEscapes
  }

  push(delta: string): number | undefined {
    for (const char of delta) {
      if (this.pendingEscape) {
        this.pendingEscape = false
        if (char === 'n' || char === 't' || char === 'r') this.run += 2
        else this.run = 0
      } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') this.run += 1
      else if (this.jsonEscapes && char === '\\') this.pendingEscape = true
      else this.run = 0
      if (this.run >= this.limit) return this.run
    }
    return undefined
  }
}

export class RepetitionDetector {
  private text = ''
  private readonly rules: LoopRules

  constructor(rules: LoopRules) {
    this.rules = rules
  }

  push(delta: string): LoopMatch | undefined {
    const normalized = normalizeForComparison(delta)
    if (normalized.length === 0) return undefined
    this.text = (this.text + normalized).slice(-this.rules.windowChars)
    return findRepeatedSuffix(this.text, this.rules)
  }
}
