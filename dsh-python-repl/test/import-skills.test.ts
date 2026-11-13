/**
 * `import skills` in a cell. The kernel's `skills` is a namespace object the
 * bootstrap binds; `sys.modules["skills"]` is python/skills.py, the loader
 * that builds it. A plain import used to rebind the cell's `skills` to that
 * loader module, after which every `skills.<name>` failed. The import now
 * hands back the preloaded namespace.
 */
import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
after(() => session.dispose())
const run = async (code: string) => {
  const cell = await session.runCell(code, new Map())
  return { text: cell.logs.join('\n'), error: cell.error?.message ?? '' }
}

it('import skills keeps the preloaded namespace, also inside a function and under an alias', async () => {
  const plain = await run('import skills\n(skills is __import__("dsh_kernel").skills, type(skills).__name__)')
  assert.equal(plain.error, '')
  assert.match(plain.text, /\(True, '_SkillsNamespace'\)/)
  const later = await run('def f():\n    import skills as s\n    return s\n(f() is __import__("dsh_kernel").skills, await skills.list())')
  assert.equal(later.error, '')
  assert.match(later.text, /\(True, /)
})

it('from skills import a missing name still says to use the namespace directly', async () => {
  const cell = await run('from skills import no_such_skill')
  assert.match(cell.error, /^ImportError: cannot import name 'no_such_skill' from 'skills'/)
  assert.match(cell.error, /use `skills\.no_such_skill` directly/)
  // The failed import changed nothing.
  assert.match((await run('type(skills).__name__')).text, /'_SkillsNamespace'/)
})

it('library code importing a module named skills is untouched', async () => {
  const cell = await run('import importlib\nimportlib.import_module("skills").__name__')
  assert.equal(cell.error, '')
  assert.match(cell.text, /'skills'/)
})
