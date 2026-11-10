/**
 * Packaging: what actually ships, and whether it runs without this checkout.
 *
 * The failure this guards against is specific: the plugin is TypeScript, but
 * its runtime is Python source under `python/` and `vendor/`. A bundler only
 * sees the TS, so a `files` list that forgets the Python ships a package that
 * builds, installs, and then cannot start a kernel.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function pkg(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('packaging', () => {
  it('ships the Python runtime, not just the compiled TypeScript', async () => {
    const files = (await pkg())['files'] as string[]
    assert.ok(files.some((f) => f.startsWith('python/')), 'python/ must ship')
    assert.ok(files.some((f) => f.startsWith('vendor/')), 'vendor/ must ship')
    assert.ok(files.some((f) => f.startsWith('lib/')), 'lib/ must ship')
  })

  it('ships the vendored licence and provenance', async () => {
    // Assert the FILES exist and the patterns cover them, rather than matching
    // literal entries: `vendor/**/*.md` covers PROVENANCE without naming it,
    // and a test that insists on the literal name would fail a correct config.
    assert.ok(await exists(join(root, 'vendor', 'prime', 'LICENSE')))
    assert.ok(await exists(join(root, 'vendor', 'PROVENANCE.md')))
    const files = (await pkg())['files'] as string[]
    assert.ok(files.some((f) => f.includes('LICENSE')), 'vendored MIT licence must ship')
    assert.ok(
      files.some((f) => f === 'vendor/**/*.md' || f.includes('PROVENANCE')),
      'the provenance record must be covered by a ships-it pattern',
    )
  })

  it('declares the patch the loader reads', async () => {
    const meta = await pkg()
    assert.equal((meta['dsh'] as { bundle: { patch: string } }).bundle.patch, './cordis.patch.yml')
    assert.ok(await exists(join(root, 'cordis.patch.yml')))
  })

  it('keeps @deepseek-ai packages external so the host instance is shared', async () => {
    const built = join(root, 'lib', 'index.js')
    if (!(await exists(built))) return // build not run in this environment
    const code = await readFile(built, 'utf8')
    assert.match(code, /from ["']@deepseek-ai\/dsh-ptc-runtime["']/,
      'PtcRuntime must be imported, never bundled: a bundled copy registers a service the host cannot see')
  })

  it('has no absolute developer paths baked into the shipped code', async () => {
    const built = join(root, 'lib', 'index.js')
    if (!(await exists(built))) return
    const code = await readFile(built, 'utf8')
    assert.ok(!code.includes('/Users/'), 'a local absolute path must never ship')
  })

  it('resolves the Python runtime relative to the package, not the cwd', async () => {
    const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
    assert.match(source, /fileURLToPath\(import\.meta\.url\)/,
      'paths must be derived from the module location so an installed copy works')

    // Our ASSETS (vendor/, python/) must come from the module location — an
    // installed copy lives somewhere else entirely. The kernel's WORKING
    // directory is the opposite concern: it should be the session workspace,
    // the same place `bash` and the file tools use. So the rule is about the
    // asset roots specifically, not a blanket ban on `process.cwd()`.
    assert.ok(
      !/(vendorRoot|pythonRoot):\s*[^\n]*process\.cwd\(\)/.test(source),
      'asset roots must never be derived from the cwd',
    )
    assert.match(
      source,
      /packageRoot/,
      'assets are addressed from the package root',
    )
  })

  it('ships our rlm compat shim, which the untouched upstream kernel imports', async () => {
    // repl.py is byte-for-byte upstream, so its `from .bash import ...` is
    // intact; the package must carry our half of the `rlm` namespace package
    // or an installed copy cannot start. Ownership and no-modification are
    // asserted in test/python/test_vendor_integration.py against real hashes.
    const shim = join(root, 'python', 'compat', 'rlm', 'bash.py')
    assert.ok(await exists(shim), 'the shim lives in python/, never in vendor/')
    const text = await readFile(shim, 'utf8')
    assert.match(text, /_kill_live_handles/)
    assert.ok(!/def bash\(/.test(text), 'the shim must not provide a native bash entry point')
    const files = (await pkg())['files'] as string[]
    assert.ok(
      files.some((f) => f.startsWith('python/')),
      'python/ must ship, including compat',
    )
  })

  it('keeps vendor/ free of anything we wrote', async () => {
    // Ownership is expressed by directory, not by a per-file note that would
    // go stale on the next version bump.
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(root, 'vendor', 'prime', 'rlm'))
    const files = entries.filter((e) => !e.startsWith('.') && e !== '__pycache__')
    assert.deepEqual(files.sort(), ['repl.md', 'repl.py'])
  })

  it('does not ship its own test files', async () => {
    // Tests live under test/, which is simply not in `files` — no negation
    // pattern needed, and nothing under python/ is a test any more.
    const files = (await pkg())['files'] as string[]
    assert.ok(!files.some((f) => f.startsWith('test')), 'test/ must not ship')
  })

  it('declares the same Python floor as the vendored runtime', async () => {
    const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
    assert.match(source, /MIN_PYTHON = \[3, 11\]/, 'prime-agent-runtime requires-python >= 3.11')
  })
})
