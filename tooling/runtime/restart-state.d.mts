export interface PendingRestart {
  phase: string
  pid: number
  requestId?: string
}
export function pendingRestart(home: string): PendingRestart | undefined
