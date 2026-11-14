/** Public JSON contract shared by the host and the kernel panel. */
export const PANEL_STATE_PATH = '/dsh-python-repl/state'
export const PANEL_PREVIEW_PATH = '/dsh-python-repl/preview'
export const PANEL_CONTROL_PATH = '/dsh-python-repl/control'
export const PANEL_NAME_PATH = '/dsh-python-repl/names'

/** Per-name lifecycle actions from the kernel tab; the same operations as repl.keep/unkeep/unarchive. */
export const PANEL_NAME_ACTIONS = ['keep', 'unkeep', 'unarchive', 'archive'] as const
export type PanelNameAction = (typeof PANEL_NAME_ACTIONS)[number]
export interface PanelNameResult { action: PanelNameAction; name: string; ok: boolean; reason?: string }

/** lifecycle.json as written by python/lifecycle.py at the end of every user cell; cells count user cells only. */
export interface PanelLifecycle {
  cell: number
  /** 0 turns that step off. */
  archiveAfter: number
  deleteAfter: number
  pins: string[]
  /** Live names: last cell that used them (t), first seen (b), kind (k); `stuck` says why it could not be archived. */
  names: Record<string, { t: number; b: number; k?: string; stuck?: string }>
  archived: Array<{ name: string; at: number; t: number; b: number; k: string; bytes: number }>
  /** Newest first, bounded. */
  deleted: Array<{ name: string; at: number; t: number; b: number; k: string }>
  deletedTotal: number
}

/** Explicit user actions from the kernel tab; nothing else starts or stops a kernel from the page. */
export const PANEL_CONTROL_ACTIONS = ['start', 'stop', 'restart', 'reset'] as const
export type PanelControlAction = (typeof PANEL_CONTROL_ACTIONS)[number]
export interface PanelControlResult {
  action: PanelControlAction
  ok: boolean
  /** Kernel generation after the action; 0 when none has started. */
  epoch: number
  /** Why it was refused or did nothing; absent on a plain success. */
  reason?: string
}

export interface PanelPreviewRequest { session: string; name: string; epoch: number }
export type PanelJson = null | boolean | number | string | PanelJson[] | { [key: string]: PanelJson }

/** A click-only bounded observation; never evaluates an expression. */
export interface PanelPreview {
  session: string
  name: string
  epoch: number
  status: 'ok' | 'missing' | 'busy' | 'timeout' | 'not-started' | 'kernel-exit' | 'stale' | 'error'
  kind?: 'json' | 'source' | 'metadata'
  type?: string
  value?: PanelJson
  source?: string
  language?: 'python'
  filename?: string
  line?: number
  /** Raw code line range used only by the host for bounded source reads. */
  sourceEndLine?: number
  truncated?: boolean
  reason?: string
}


export interface PanelName {
  name: string
  kind: 'system' | 'module' | 'function' | 'class' | 'data'
  origin: 'system' | 'preloaded' | 'import' | 'internal' | 'user'
  /** Type and, for exact builtin containers, size only; never a scalar value. */
  summary: string
}

export interface PanelSkillReport {
  loaded: string[]
  skills: Array<{ skill: string; status: string; reason?: string; import_name?: string | null; description?: string }>
  failed: Array<{ skill: string; reason: string }>
}

export interface PanelSnapshot {
  status: 'available' | 'missing' | 'error' | 'disabled'
  /** ISO timestamp, exactly as persisted by the kernel manifest. */
  savedAt: string | null
  bytes: number | null
  saved: string[]
  skipped: Array<{ name: string; reason: string }>
  trimmed: string[]
  /** Serialized bytes per name at the last snapshot, from record headers only; absent for a legacy or unreadable file. */
  sizes?: Record<string, number>
  /** False when the size scan stopped early (time budget, damage); the sizes shown are a prefix. */
  sizesComplete?: boolean
  error?: string
}

/** One `run_code` call as the host saw it; kept in host memory only, so it starts empty after DSH restarts. */
export interface PanelCell {
  /** Run id once the cell reached a kernel (`cell-<epoch>-<n>`), else `queued-<seq>`. */
  id: string
  seq: number
  epoch: number | null
  queuedAt: number
  /** When user code was handed to the kernel; waiting and kernel start come before it. */
  startedAt: number | null
  endedAt: number | null
  status: 'queued' | 'running' | 'ok' | 'error' | 'aborted' | 'kernel-exit'
  /** First non-blank code line, clipped; the code is the model's own cell text. */
  firstLine: string
  lines: number
  /** The cell's own source, clipped to a per-cell cap so one record stays bounded; absent on records written before this field existed. */
  code?: string
  /** True when `code` is only the leading part of the source because it exceeded the cap. */
  codeClipped?: boolean
  /** The cell's visible output (stdout, displayed value, notes), clipped to a per-cell cap; absent on records written before this field existed. */
  output?: string
  /** True when `output` is only the leading part because it exceeded the cap. */
  outputClipped?: boolean
  /** Host tool calls this cell made through the bridge, in first-call order. */
  tools: Array<{ name: string; calls: number; errors: number }>
  outputChars: number | null
  error: string | null
  /** The DSH process that ran it (its start time); a change between cells marks a DSH restart. Absent on records from before 2026-11-03. */
  host?: number
}

export interface PanelGeneration {
  epoch: number
  startedAt: number
  endedAt: number | null
  /** Why the host retired it; null while alive or for a plain restart/close. */
  reason: string | null
  host?: number
}

export interface PanelState {
  session: string
  /** Host observation time in Unix milliseconds. */
  now: number
  /** Since when `cells` and `generations` are recorded (this session object's creation in this DSH process). */
  recordedSince: number | null
  /** Newest last; bounded, `cellsDropped` counts the oldest ones no longer kept. */
  cells: PanelCell[]
  cellsDropped: number
  generations: PanelGeneration[]
  alive: boolean
  started: boolean
  busy: boolean
  epoch: number
  python: string | null
  executable: string | null
  cwd: string | null
  skillReport: PanelSkillReport | null
  /** Last successful protocol observation; null means none has succeeded yet. */
  observedAt: number | null
  namespaceStatus: 'live' | 'cached' | 'unavailable'
  namespaceReason: 'busy' | 'timeout' | 'not-started' | 'kernel-exit' | 'error' | null
  /** Complete within the explicitly stated namespace scope at observedAt. */
  complete: boolean
  scope: 'top-level-excluding-dunder'
  total: number | null
  names: PanelName[]
  snapshot: PanelSnapshot
  /** Absent when the lifecycle is off or has not written its file yet. */
  lifecycle: PanelLifecycle | null
  error?: string
}
