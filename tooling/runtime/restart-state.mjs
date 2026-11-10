import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const terminal = new Set(['completed', 'failed', 'timed-out', 'interrupted'])
const active = new Set(['queued', 'checking', 'waiting', 'updating', 'quitting', 'starting'])

/** 只把尚未结束且执行进程真实存活的重启当作待处理；无法核实时拒绝自动维护。 */
export function pendingRestart(home) {
  const path = join(home, 'dsh-control', 'restart-state.json')
  try {
    let state
    try { state = JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.phase !== 'string') throw new Error('记录缺少 phase')
    if (terminal.has(state.phase) || state.phase === 'none') return undefined
    if (!active.has(state.phase)) throw new Error(`未知重启阶段 ${state.phase}`)
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error('记录缺少有效执行 PID')
    try { process.kill(state.pid, 0) }
    catch (error) { if (error?.code === 'ESRCH') return undefined; throw error }
    return { phase: state.phase, pid: state.pid, ...(typeof state.requestId === 'string' ? { requestId: state.requestId } : {}) }
  } catch (error) {
    const failure = new Error(`无法核实重启状态 ${path}：${error instanceof Error ? error.message : String(error)}`)
    failure.code = 'restart-state-unavailable'
    throw failure
  }
}
