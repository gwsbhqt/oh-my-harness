/**
 * DSH 插件的共用偏好文件：`$DSH_HOME/preferences.json`。
 *
 * 多个插件各读写自己的顶层段，
 * 保存时先读整份、只换自己那一段，其他段和未知字段原样保留。
 * 所有段写入同一偏好文件；写入时必须保留其他段。
 * 写入要用 realpath 顺着符号链接写真实文件，不能把链接换成普通文件。
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PREFERENCES_VERSION = 1

/** 已知段按这个顺序输出；未知字段排在后面，保证 git diff 稳定。 */
const KNOWN_SECTIONS = ['modelTiers', 'presetPreferences', 'quickReplies']

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 偏好文件位置：`$DSH_HOME/preferences.json`，测试用 `DSH_PREFERENCES_FILE` 改。 */
export function preferencesPath() {
  const override = process.env['DSH_PREFERENCES_FILE']
  if (override !== undefined && override !== '') return override
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'preferences.json')
}

/** 按固定顺序格式化整份偏好文件。 */
export function formatPreferences(raw) {
  if (!isObject(raw)) throw new Error('preferences.json 顶层必须是对象')
  const doc = { version: PREFERENCES_VERSION }
  for (const key of KNOWN_SECTIONS) if (raw[key] !== undefined) doc[key] = raw[key]
  for (const key of Object.keys(raw).sort()) {
    if (key !== 'version' && !KNOWN_SECTIONS.includes(key)) doc[key] = raw[key]
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * 读取整份偏好文件。文件不存在不算错，返回 exists: false 和空对象。
 * 读不到、不是合法 JSON、版本不认识都返回 error 字符串，交给各插件决定显示还是当默认值。
 */
export function readPreferences(path = preferencesPath()) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, raw: {}, path }
    return { exists: true, raw: {}, path, error: `preferences.json 读不到（${error.message}）` }
  }
  let raw
  try {
    raw = JSON.parse(text)
    if (!isObject(raw)) throw new Error('顶层必须是对象')
    if (raw['version'] !== undefined && raw['version'] !== PREFERENCES_VERSION) {
      throw new Error(`不认识的版本 ${JSON.stringify(raw['version'])}（只支持 ${PREFERENCES_VERSION}）`)
    }
  } catch (error) {
    return { exists: true, raw: {}, path, error: `preferences.json 不是合法内容：${error.message}` }
  }
  return { exists: true, raw, path }
}

/** 读取某个顶层段；文件整体有问题时 value 为 undefined，error 说明原因。 */
export function readSection(section, path = preferencesPath()) {
  const read = readPreferences(path)
  if (read.error !== undefined) return { ...read, value: undefined }
  return { ...read, value: read.raw[section] }
}

/**
 * 只更新自己那一段：先读最新内容，再写回，其他段和未知字段不动。
 * 文件不存在时创建；目录不存在时自己建；路径是符号链接时写链接指向的真实文件。
 *
 * 读到改名全程同步：几个插件各自内联了本模块，进程内没有共用的锁；
 * 中间一旦 await，同时进来的另一次保存会读到旧内容，把这次写的段冲掉。
 */
export async function writeSection(section, value, path = preferencesPath()) {
  const read = readPreferences(path)
  if (read.error !== undefined) throw new Error(read.error)
  const text = formatPreferences({ ...read.raw, version: PREFERENCES_VERSION, [section]: value })
  let target = path
  try {
    target = realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
