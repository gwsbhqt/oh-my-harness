/**
 * The run_code card borrows the host ToolRow's hashed class names; they are
 * read from the host stylesheet at runtime (src/client/classes.ts). These
 * tests parse the stylesheet of two hosts, so a host that renames or drops a
 * class fails here rather than in the GUI:
 *
 * - the dev dependency, what the build and the other tests run against;
 * - the host inside the installed DeepSeek Harness App, what the GUI actually
 *   runs. The two differ even at the same version number: 0.2.0-rc.1 from npm
 *   prefixes `o3BgMG_`, the App build `qefBqa_` (2026-09-29), so checking only
 *   the dev dependency misses exactly the breakage this card suffered.
 *
 * The App is looked up at DSH_APP_ASAR, else the default macOS install path;
 * without one that App test is skipped and says so.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { TOOL_ROW_CLASS_KEYS, TOOL_ROW_STYLE_ID, toolRowClassesFromCss } from '../src/client/classes.ts'

const require = createRequire(import.meta.url)
const devHostJs = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-tool/client'), 'utf8')

const APP_ASAR = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const APP_TOOL_DIR = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-tool']

interface AsarEntry { files?: Record<string, AsarEntry>; size?: number; offset?: string; unpacked?: boolean }

/**
 * One file out of an Electron asar archive: a 16-byte pickle prefix, the JSON
 * directory header, then file bodies at `8 + headerPickleSize + offset`.
 * Unpacked entries live beside it in `app.asar.unpacked`.
 */
function readAsarFile(archive: string, path: readonly string[]): string {
  const buf = readFileSync(archive)
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  let node: AsarEntry = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8')) as AsarEntry
  for (const part of path) {
    const next = node.files?.[part]
    assert.ok(next !== undefined, `${path.join('/')} not in ${archive}`)
    node = next
  }
  if (node.unpacked === true) return readFileSync(join(`${archive}.unpacked`, ...path), 'utf8')
  assert.ok(node.size !== undefined && node.offset !== undefined, `${path.join('/')} is not a file`)
  const start = 8 + headerPickleSize + Number(node.offset)
  return buf.subarray(start, start + node.size).toString('utf8')
}

/** The ToolRow stylesheet text a host bundle injects under TOOL_ROW_STYLE_ID. */
function toolRowCss(hostJs: string): string {
  const idAt = hostJs.indexOf(JSON.stringify(TOOL_ROW_STYLE_ID))
  assert.ok(idAt > 0, 'host still tags the ToolRow stylesheet with the same id')
  const decl = hostJs.lastIndexOf('const css', idAt)
  const literal = /const css\$?\d* = ("(?:[^"\\]|\\.)*");/.exec(hostJs.slice(decl, idAt))
  assert.ok(literal !== null, 'ToolRow stylesheet literal found')
  return JSON.parse(literal[1]!) as string
}

/** Every class the card uses resolves in this host bundle, and matches the names the host renders with. */
function assertHostHasClasses(hostJs: string, label: string): void {
  const { classes, missing } = toolRowClassesFromCss(toolRowCss(hostJs))
  assert.deepEqual(missing, [], `${label}: host ToolRow stylesheet lacks these classes`)
  assert.ok(classes !== null)
  for (const key of TOOL_ROW_CLASS_KEYS) {
    assert.match(classes[key], new RegExp(`^[\\w-]+_${key}$`))
    assert.ok(hostJs.includes(`"${key}": "${classes[key]}"`), `${label}: host renders ${key} under another name`)
  }
}

describe('host ToolRow class names', () => {
  it('the dev-dependency host has every class the card uses', () => {
    assertHostHasClasses(devHostJs, 'dev dependency')
  })

  it('the installed DeepSeek Harness App has every class the card uses', (t) => {
    if (!existsSync(APP_ASAR)) {
      t.skip(`no App at ${APP_ASAR} (set DSH_APP_ASAR to check another install)`)
      return
    }
    const version = (JSON.parse(readAsarFile(APP_ASAR, [...APP_TOOL_DIR, 'package.json'])) as { version: string }).version
    t.diagnostic(`App dsh-client-ui-tool ${version}`)
    assertHostHasClasses(readAsarFile(APP_ASAR, [...APP_TOOL_DIR, 'lib', 'client.js']), `App ${version}`)
  })

  it('a stylesheet missing a class yields null, not a half-styled card', () => {
    const { classes, missing } = toolRowClassesFromCss('.ab12Cd_root{display:flex}.ab12Cd_row{gap:0}')
    assert.equal(classes, null)
    assert.ok(missing.includes('visuallyHidden'))
  })

  it('a host without the optional chevron class still styles the card', () => {
    const css = TOOL_ROW_CLASS_KEYS.map((k) => `.ab12Cd_${k}{color:red}`).join('')
    const { classes, missing } = toolRowClassesFromCss(css)
    assert.deepEqual(missing, [])
    assert.ok(classes !== null)
    assert.equal(classes.chevron, undefined)
    assert.equal(toolRowClassesFromCss(`${css}.ab12Cd_chevron{color:inherit}`).classes?.chevron, 'ab12Cd_chevron')
  })

  it('no stylesheet at all yields null', () => {
    assert.equal(toolRowClassesFromCss('').classes, null)
  })
})
