// One JSON line per DSH tool call: {session, seq, name, args, isError}.
// DSH stores sessions as concatenated zstd frames; node's zlib decodes them
// without a zstd binary. A frame magic can also occur inside a payload, so a
// failed decode just extends the range to the next magic.
import { globSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(path) {
  const buf = readFileSync(path)
  const starts = []
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
  let out = ''
  let from = 0
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : buf.length
    try {
      out += zstdDecompressSync(buf.subarray(starts[from], end)).toString()
      from = k
    } catch {
      // magic inside a payload: keep extending
    }
  }
  return out
}

const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')
for (const file of globSync(join(root, '*', '*', 'session.v3.jsonl.zstd'))) {
  const session = file.split('/').at(-2)
  const calls = new Map()
  const errors = new Map()
  for (const line of decode(file).split('\n')) {
    if (!line.startsWith('{"type":"tool/')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'tool/call') calls.set(d.data.callId, { session, seq: d.seq, name: d.data.name, args: d.data.arguments })
    else if (d.type === 'tool/result') for (const c of d.data?.message?.content ?? []) if (c.toolCallId) errors.set(c.toolCallId, c.isError === true)
  }
  for (const [id, c] of calls) process.stdout.write(JSON.stringify({ ...c, isError: errors.get(id) ?? null }) + '\n')
}
