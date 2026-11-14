/**
 * 右键菜单「打开方式」的应用清单：和宿主头栏「打开工作区」那个菜单同一份（`dsh-host-open-in-app` 的
 * OPEN_IN_APP_CATALOG），只取 macOS 部分。哪些装了、图标是什么，浏览器半直接问宿主那个菜单的接口
 * （`/open-in-app/apps`、`/open-in-app/icon/<id>`），所以显示的应用和头栏一模一样。
 *
 * 只有「打开」要本插件自己做：宿主那个打开接口只收目录，右键的却常常是文件。这里按同一份清单把
 * 应用 id 换成 macOS 上的 `.app`，在 /Applications、~/Applications 里找到装了的那个，再 `open -a`。
 * 不在清单里的 id 一律拒绝，不执行任意程序。终端类应用打开的是文件所在的目录。
 *
 * 清单本身在 `src/shared/apps.ts`（浏览器半也用它决定显示哪些）。宿主清单以后加了新应用，在那里补一行；`test/host-shape.test.ts` 会对着宿主核对，漏了就失败。
 *
 * @module dsh-path-mention/apps
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MAC_CATALOG } from '../../shared/path-mention/apps.ts'

export { MAC_CATALOG, type CatalogApp } from '../../shared/path-mention/apps.ts'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 按清单 id 找到本机装了的那个 `.app`。
 * @param id - 宿主清单里的应用 id。
 * @param roots - 找应用的目录，默认和宿主一样：/Applications、~/Applications。
 * @returns `.app` 的绝对路径；不在清单里或没装就是 undefined。
 */
export function locateApp(id: string, roots: readonly string[] = ['/Applications', join(homedir(), 'Applications')]): string | undefined {
  const app = MAC_CATALOG.find((entry) => entry.id === id)
  if (app === undefined) return undefined
  if (app.system !== undefined) return existsSync(app.system) ? app.system : undefined
  for (const root of roots) for (const bundle of app.bundles) {
    const candidate = join(root, bundle)
    if (isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * 用清单里的某个应用打开一个路径。
 * @param id - 宿主清单里的应用 id。
 * @param path - 已确认存在的绝对路径。
 * @param isDir - 这个路径是不是目录。
 * @param locate - 找 `.app` 的函数，测试时可注入。
 * @returns 要执行的命令；不在清单里、没装、或不是 macOS 时返回 undefined。
 */
export function appOpenCommand(id: string, path: string, isDir: boolean, platform: NodeJS.Platform = process.platform, locate: (id: string) => string | undefined = locateApp): [string, string[]] | undefined {
  if (platform !== 'darwin') return undefined
  const app = MAC_CATALOG.find((entry) => entry.id === id)
  if (app === undefined) return undefined
  // 访达打开文件就是「显示位置」，打开目录就是进到这个目录。
  if (app.id === 'finder') return isDir ? ['open', [path]] : ['open', ['-R', path]]
  const bundle = locate(id)
  if (bundle === undefined) return undefined
  const target = app.terminal === true && !isDir ? dirname(path) : path
  return ['open', ['-a', bundle, target]]
}
