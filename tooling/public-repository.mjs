import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export async function publicFiles(root) {
  const names = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean))]
  const published = new Set(names)
  const files = new Map()
  for (const name of names) {
    const file = path.join(root, name)
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat) continue
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file)
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
      if (path.isAbsolute(target) || !published.has(relative)) throw new Error(`${name}: symlink target is outside the published files`)
      const actual = path.relative(await fs.realpath(root), await fs.realpath(file))
      if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw new Error(`${name}: symlink leaves the repository`)
    }
    if (stat.isDirectory()) throw new Error(`${name}: nested repositories are not part of this checkout`)
    const content = await fs.readFile(file)
    files.set(name, content.includes(0) ? null : content.toString('utf8'))
  }
  return files
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length
const blank = text => text.replace(/[^\n]/g, ' ')
const entities = text => text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
  const value = entity.slice(1, -1).toLowerCase()
  if (value[0] === '#') {
    const point = value[1] === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1))
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[value]
})

function prose(source) {
  let fence
  return source.replace(/<!--[^]*?-->/g, blank).split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined
      return blank(line)
    }
    if (marker) { fence = marker; return blank(line) }
    if (/^(?: {4}|\t)/.test(line)) return blank(line)
    return line
  }).join('\n')
}

function sourceSetTargets(source) {
  const targets = []
  while (source) {
    const match = /^[\s,]*(\S+)/.exec(source)
    if (!match) break
    source = source.slice(match[0].length)
    targets.push(match[1].replace(/,+$/, ''))
    if (!match[1].endsWith(',')) {
      const separator = source.indexOf(',')
      source = separator < 0 ? '' : source.slice(separator + 1)
    }
  }
  return targets
}

export function documentLinks(source, { markdown = true } = {}) {
  const text = markdown ? prose(source).replace(/(`+)([^]*?)\1/g, blank) : source.replace(/<!--[^]*?-->/g, blank)
  const links = []
  const add = (match, target) => links.push({ target: entities(target.replace(/^<|>$/g, '').replace(/\\([\\()[\]<> ])/g, '$1')), line: lineAt(text, match.index) })
  for (const match of text.matchAll(/\]\(\s*(<[^>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) add(match, match[1])
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)) add(match, match[1])
  for (const tag of text.matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const attr of tag[0].matchAll(/\b(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value = attr[2] ?? attr[3] ?? attr[4]
      const targets = attr[1].toLowerCase() === 'srcset' ? sourceSetTargets(value) : [value]
      for (const target of targets) add({ index: tag.index + attr.index }, target)
    }
  }
  return links
}

export function documentAnchors(source) {
  const text = prose(source)
  const anchors = new Set()
  const generated = new Set()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i])
    const heading = atx?.[1] ?? (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) ? lines[i].trim() : '')
    if (!heading) continue
    const base = entities(heading.replace(/<[^>]*>/g, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1'))
      .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/ /g, '-')
    let anchor = base
    for (let suffix = 1; generated.has(anchor); suffix++) anchor = `${base}-${suffix}`
    generated.add(anchor)
    anchors.add(anchor)
  }
  for (const tag of text.replace(/(`+)([^]*?)\1/g, blank).matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const match of tag[0].matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) anchors.add(entities(match[1]))
  }
  return anchors
}

export function documentationIssues(files) {
  const issues = []
  const anchors = new Map()
  const directories = new Set(['.'])
  for (const file of files.keys()) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir)
  }
  for (const [file, source] of files) {
    if (source === null || !/\.(?:md|html?)$|^llms\.txt$/i.test(file) || /(?:^|\/)(?:tests?|fixtures)\//.test(file)) continue
    for (const { target, line } of documentLinks(source, { markdown: !/\.html?$/i.test(file) })) {
      const report = reason => issues.push({ file, line, reason, target })
      if (/^file:/i.test(target)) { report('local file URL is outside the published repository'); continue }
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue
      let destination, fragment
      try {
        const hash = target.indexOf('#')
        destination = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split('?')[0])
        fragment = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1))
      } catch { report('invalid URL encoding'); continue }
      let resolved = destination ? path.posix.normalize(path.posix.join(destination.startsWith('/') ? '.' : path.posix.dirname(file), destination)) : file
      resolved = resolved.replace(/\/$/, '') || '.'
      if (resolved === '..' || resolved.startsWith('../')) { report('link leaves the published repository'); continue }
      if (!files.has(resolved) && !directories.has(resolved)) { report('target is not a published file or directory'); continue }
      if (directories.has(resolved)) resolved = ['README.md', 'README.en.md'].map(name => path.posix.join(resolved, name)).find(name => files.has(name)) ?? resolved
      if (!fragment || !resolved.endsWith('.md')) continue
      if (!anchors.has(resolved)) anchors.set(resolved, documentAnchors(files.get(resolved) ?? ''))
      if (!anchors.get(resolved).has(fragment)) report('heading or explicit anchor does not exist')
    }
  }
  return issues
}

export function privacyIssues(files) {
  const issues = []
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
    ['credential-shaped value', /\b(?:gh[pousr]_[A-Za-z\d]{30,}|github_pat_[A-Za-z\d_]{40,}|AKIA[A-Z\d]{16})\b/g],
    ['private network address', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/g],
  ]
  for (const [file, text] of files) {
    if (text === null) continue
    for (const [reason, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (reason === 'private network address' && match[0].split('.').some(part => Number(part) > 255)) continue
        issues.push({ file, line: lineAt(text, match.index), reason })
      }
    }
  }
  return issues
}

export function licenseIssues(files) {
  const issues = []
  const license = files.get('LICENSE')
  if (!license?.startsWith('MIT License\n') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) issues.push('LICENSE: missing MIT license text')
  for (const [file, source] of files) {
    const plugin = /^dsh-[^/]+\/package\.json$/.test(file)
    const python = /^skills\/[^/]+\/pyproject\.toml$/.test(file)
    if (!plugin && !python) continue
    const directory = path.posix.dirname(file)
    if (files.get(`${directory}/LICENSE`)?.trim() !== license?.trim()) issues.push(`${directory}/LICENSE: must preserve the repository license`)
    if (plugin) {
      const pkg = JSON.parse(source)
      if (pkg.license !== 'MIT') issues.push(`${file}: missing MIT license declaration`)
    } else {
      if (!/^license\s*=\s*["']MIT["']\s*$/m.test(source)) issues.push(`${file}: missing MIT license declaration`)
    }
  }
  return issues
}
