/**
 * 右键菜单「打开方式」的应用清单，宿主半（按 id 找 `.app` 再打开）和浏览器半（只显示能打开的）共用这一份。
 * 不碰 Node 模块，浏览器半也能直接打包进去。来历和核对方法见 `src/apps.ts`。
 *
 * @module dsh-path-mention/shared/apps
 */

export interface CatalogApp {
  /** 宿主清单里的 id（`zed`、`vscode`…），也是 `/open-in-app/icon/<id>` 的那一段。 */
  id: string
  /** macOS 上可能的 `.app` 名字，按顺序找第一个装了的。 */
  bundles: readonly string[]
  /** 终端：打开的是目录，不是文件本身。 */
  terminal?: boolean
  /** 固定位置的系统应用（访达、终端），不用去 /Applications 里找。 */
  system?: string
}

/** 和宿主清单的 macOS 部分逐项对应，顺序也一样（宿主菜单就按这个顺序列）。 */
export const MAC_CATALOG: readonly CatalogApp[] = [
  { id: 'finder', bundles: [], system: '/System/Library/CoreServices/Finder.app' },
  { id: 'cursor', bundles: ['Cursor.app'] },
  { id: 'vscode', bundles: ['Visual Studio Code.app'] },
  { id: 'vscodeinsiders', bundles: ['Visual Studio Code - Insiders.app'] },
  { id: 'windsurf', bundles: ['Windsurf.app'] },
  { id: 'zed', bundles: ['Zed.app', 'Zed Preview.app'] },
  { id: 'sublimetext', bundles: ['Sublime Text.app'] },
  { id: 'xcode', bundles: ['Xcode.app', 'Xcode-beta.app'] },
  { id: 'androidstudio', bundles: ['Android Studio.app'] },
  { id: 'fork', bundles: ['Fork.app'] },
  { id: 'sourcetree', bundles: ['Sourcetree.app'] },
  { id: 'github', bundles: ['GitHub Desktop.app'] },
  { id: 'tower', bundles: ['Tower.app'] },
  { id: 'gitkraken', bundles: ['GitKraken.app'] },
  { id: 'smartgit', bundles: ['SmartGit.app'] },
  { id: 'sublimemerge', bundles: ['Sublime Merge.app'] },
  { id: 'ghostty', bundles: ['Ghostty.app'], terminal: true },
  { id: 'warp', bundles: ['Warp.app'], terminal: true },
  { id: 'iterm', bundles: ['iTerm.app'], terminal: true },
  { id: 'kitty', bundles: ['kitty.app'], terminal: true },
  { id: 'terminal', bundles: [], system: '/System/Applications/Utilities/Terminal.app', terminal: true },
]

const OPENABLE = new Set(MAC_CATALOG.map((app) => app.id))

/**
 * 宿主 `open-in-app/apps` 回来的已装应用里，只留本插件能打开的；宿主有、清单里没有的不显示，免得点了打不开。
 * @param apps - 接口返回的 `apps` 字段，形状不对就当空列表。
 */
export function openableApps(apps: unknown): string[] {
  return Array.isArray(apps) ? apps.filter((id): id is string => typeof id === 'string' && OPENABLE.has(id)) : []
}
