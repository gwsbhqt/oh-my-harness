import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { PanelPreview } from './panel-types.ts'

type PreviewBody = Omit<PanelPreview, 'session' | 'name' | 'epoch'>
const MAX_SCAN_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 24 * 1024
const MAX_SOURCE_LINES = 200

/** This promise owns its fd until finally, including after the HTTP wait expires. */
export async function withFileSource(preview: PreviewBody, cwd?: string): Promise<PreviewBody> {
  const { filename, line, sourceEndLine } = preview
  if (preview.kind !== 'metadata' || filename === undefined || line === undefined || sourceEndLine === undefined) return preview
  const unavailable = (reason: string): PreviewBody => ({ ...preview, reason })
  if (!filename || filename.length > 1024 || filename.includes('\0') || filename.startsWith('<')
    || !Number.isSafeInteger(line) || !Number.isSafeInteger(sourceEndLine) || line < 1 || sourceEndLine < line) {
    return unavailable('没有可读取的 Python 源码位置')
  }
  if (!isAbsolute(filename) && cwd === undefined) return unavailable('源码路径不是绝对路径，无法安全定位')
  const path = isAbsolute(filename) ? filename : resolve(cwd!, filename)
  const deadline = performance.now() + 500
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile()) return unavailable('源码位置不是普通文件，未读取')
    const buffer = Buffer.alloc(8192)
    const pieces: Buffer[] = []
    let scanned = 0
    let currentLine = 1
    let sourceBytes = 0
    let ended = false
    let eof = false
    const lastLine = Math.min(sourceEndLine, line + MAX_SOURCE_LINES - 1)
    while (scanned < MAX_SCAN_BYTES && !ended && sourceBytes < MAX_SOURCE_BYTES) {
      if (performance.now() >= deadline) return unavailable('读取源码超过时间限制')
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MAX_SCAN_BYTES - scanned), scanned)
      if (bytesRead === 0) { eof = true; break }
      scanned += bytesRead
      let segment = -1
      for (let index = 0; index < bytesRead; index++) {
        if (currentLine >= line && segment < 0) segment = index
        if (buffer[index] === 10) currentLine++
        if (currentLine > lastLine || (segment >= 0 && sourceBytes + index - segment + 1 >= MAX_SOURCE_BYTES)) {
          if (segment >= 0) {
            const part = Buffer.from(buffer.subarray(segment, index + 1))
            pieces.push(part); sourceBytes += part.length
          }
          ended = true
          break
        }
      }
      if (!ended && segment >= 0) {
        const part = Buffer.from(buffer.subarray(segment, bytesRead))
        pieces.push(part); sourceBytes += part.length
      }
    }
    if (sourceBytes === 0) return unavailable(scanned >= MAX_SCAN_BYTES ? '源码位置超过 1 MiB 扫描限制' : '文件中没有对应源码行')
    // Cut an incomplete UTF-8 suffix without adding replacement bytes beyond the cap.
    const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces), { stream: true })
    const { value: _value, reason: _reason, ...metadata } = preview
    return { ...metadata, kind: 'source', source, language: 'python',
      truncated: preview.truncated === true || sourceBytes >= MAX_SOURCE_BYTES || lastLine < sourceEndLine
        || (scanned >= MAX_SCAN_BYTES && currentLine <= sourceEndLine) || (!eof && currentLine <= sourceEndLine),
    }
  } catch {
    return unavailable('源码文件不存在、无法访问或不是可读取的普通文件')
  } finally { await file?.close() }
}
