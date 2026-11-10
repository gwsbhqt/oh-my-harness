/**
 * `display()` is IPython's, and models reach for it. A real kernel must add one
 * line saying how this REPL shows values — without defining `display`, which
 * would hide real mistakes.
 */

import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const session = new ReplSession({
  python: process.env['DSH_PY'] ?? 'python3',
  vendorRoot: join(root, 'vendor', 'prime'),
  pythonRoot: join(root, 'python'),
})
after(() => session.dispose())

it('a display() NameError says this is not IPython', async () => {
  const cell = await session.runCell('x = 1\ndisplay(x)', new Map())
  assert.equal(cell.error?.kind, 'exception')
  assert.match(cell.error?.message ?? '', /NameError: name 'display' is not defined/)
  assert.match(cell.error?.message ?? '', /This is not IPython: use print\(\) or put the value last in the cell/)
})

it('a tool called without tools. says how to reach it; an unknown name gets no hint', async () => {
  const cell = await session.runCell('await read_image({"file_path": "x.png"})', new Map([['read_image', async () => 'ok']]))
  assert.match(cell.error?.message ?? '', /`read_image` is a DSH tool: call it as `await tools\.read_image\(\.\.\.\)`/)
  const plain = await session.runCell('no_such_name_here', new Map())
  assert.doesNotMatch(plain.error?.message ?? '', /DSH tool|Python skill/)
})

it('import skills.x says skills is a bound namespace, not a package to install', async () => {
  const cell = await session.runCell('import skills.demo', new Map())
  assert.match(cell.error?.message ?? '', /`skills` is already bound in every cell and is not a package/)
  assert.doesNotMatch(cell.error?.message ?? '', /repl\.install/)
})
