export declare const PREFERENCES_VERSION: 1
/** 偏好文件位置：`$DSH_HOME/preferences.json`，可用 `DSH_PREFERENCES_FILE` 覆盖。 */
export declare function preferencesPath(): string
export interface PreferencesRead {
  exists: boolean
  raw: Record<string, unknown>
  path: string
  error?: string
}
export declare function readPreferences(path?: string): PreferencesRead
export declare function readSection(section: string, path?: string): PreferencesRead & { value: unknown }
export declare function writeSection(section: string, value: unknown, path?: string): Promise<void>
export declare function formatPreferences(raw: Record<string, unknown>): string
