/**
 * The settings card's field list. Kept in a JSX-free module so tests can
 * assert that every Config field is exposed on the card.
 */

export const SETTINGS_FIELD_DEFS = [
  ['python', 'text'],
  ['maxFrameBytes', 'number'],
  ['startupTimeoutMs', 'number'],
  ['teardownGraceMs', 'number'],
  ['interruptGraceMs', 'number'],
  ['toolCallTimeoutMs', 'number'],
  ['maxCellOutputTokens', 'number'],
  ['maxCellTimeoutMs', 'number'],
  ['archiveAfterCells', 'number'],
  ['deleteAfterCells', 'number'],
  ['cellWaitMs', 'number'],
  ['idleKernelMinutes', 'number'],
  ['residentTools', 'list'],
  ['skillRoots', 'list'],
  ['projectSkillRoots', 'list'],
] as const

export type SettingsFieldName = (typeof SETTINGS_FIELD_DEFS)[number][0]
export type SettingsFieldKind = (typeof SETTINGS_FIELD_DEFS)[number][1]

export const SETTINGS_FIELD_NAMES: readonly SettingsFieldName[] = SETTINGS_FIELD_DEFS.map(([field]) => field)
