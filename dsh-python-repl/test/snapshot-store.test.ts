import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readPanelSnapshot, snapshotFiles, snapshotPresence } from '../src/snapshot.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'

const run = promisify(execFile)
const host = fileURLToPath(new URL('./fixtures/snapshot-store-host.ts', import.meta.url))
const digest = (name: string) => createHash('sha256').update(name).digest('hex')

for (const [scenario, name] of [
  ['changed-names', 'the reader, restore notice and panel keep the old pair after publication fails'],
  ['same-size', 'a failed same-name same-size change leaves both committed files untouched'],
  ['first', 'a failed first publication cannot be discovered as a legacy partial write'],
  ['legacy', 'an old unframed payload without a manifest restores without migrating on read'],
  ['broken', 'a damaged generation stays protected until reset, which preserves explicit copies'],
  ['restore-switch', 'the restore notice describes the data Python actually restored even after another host publishes'],
  ['replaced', 'flat files or a foreign link left by another writer protect both its replacement and the committed generation'],
] as const) {
  it(name, { timeout: 120_000 }, async t => {
    const python = await testKernelPython()
    const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-store-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const env = { ...process.env, HOME: join(root, 'home'), DSH_HOME: join(root, 'host'), PYTHONDONTWRITEBYTECODE: '1' }
    await mkdir(env.HOME)
    const invoke = (mode: string) => run(process.execPath, [host, mode, scenario, root, python], { env })
    const state = join(env.DSH_HOME, 'plugins', 'python-repl', 'state', digest('snapshot-store-test').slice(0, 32))
    const pair = snapshotFiles(state)
    const store = join(state, `.snapshot-${digest(basename(pair.path))}`)
    const bytes = () => Promise.all([readFile(pair.path), readFile(pair.manifestPath)])
    if (scenario === 'legacy') {
      await mkdir(state, { recursive: true })
      await run(python, ['-I', '-c', "import dill, sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(dill.dumps({'counter': dill.dumps(31), 'dsh_user_legacy': dill.dumps(13)}))", pair.path], { env })
    } else if (scenario === 'first') {
      await invoke('fail')
      assert.ok(!existsSync(pair.path) && !existsSync(pair.manifestPath))
    } else {
      await invoke('seed')
      const generation = await readlink(join(store, 'current'))
      if (scenario === 'restore-switch') {
        await invoke('restore-switch')
        return
      }
      if (scenario === 'replaced') {
        const original = await bytes()
        const fromPreviousClient = join(root, 'unpublished.dill')
        await run(python, ['-I', '-c', "import dill, sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(dill.dumps({'counter': dill.dumps(9)}))", fromPreviousClient], { env })
        const replacement = await readFile(fromPreviousClient)
        await rename(fromPreviousClient, pair.path)
        const oldManifest = join(root, 'unpublished.json')
        await writeFile(oldManifest, original[1]!)
        await rename(oldManifest, pair.manifestPath)
        await invoke('conflict')
        assert.deepEqual(await bytes(), [replacement, original[1]])
        assert.deepEqual(await readFile(join(store, generation, basename(pair.path))), original[0])
        // A foreign symlink also conflicts, even when it points to an ordinary file containing valid data.
        await rename(pair.path, fromPreviousClient)
        await symlink(fromPreviousClient, pair.path)
        await invoke('conflict')
        assert.equal(await readlink(pair.path), fromPreviousClient)
        assert.deepEqual(await readFile(fromPreviousClient), replacement)
        assert.equal(await readlink(join(store, 'current')), generation)
        return
      }
      if (scenario === 'broken') {
        await unlink(join(store, generation, basename(pair.path)))
        await invoke('broken')
        return
      }
      const original = await bytes()
      await invoke('fail')
      assert.equal(await readlink(join(store, 'current')), generation)
      assert.deepEqual(await bytes(), original)
    }
    await invoke('observe')
  })
}

it('a regular name during migration must still be the exact legacy inode, even with identical bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pair = snapshotFiles(root)
  const store = join(root, `.snapshot-${digest(basename(pair.path))}`)
  const dir = join(store, 'legacy')
  await mkdir(dir, { recursive: true })
  const old = join(dir, basename(pair.path))
  await writeFile(pair.path, 'legacy fixture')
  await link(pair.path, old)
  await symlink('legacy', join(store, 'current'))
  assert.equal(await snapshotPresence(pair), 'available')
  const first = await readPanelSnapshot(root)
  assert.equal(first.bytes, (await readFile(old)).length)
  assert.match(first.error ?? '', /manifest/)
  const replacement = join(root, 'other-writer')
  await copyFile(old, replacement)
  await rename(replacement, pair.path)
  assert.equal(await snapshotPresence(pair), 'error')
  assert.match((await readPanelSnapshot(root)).error ?? '', /conflicts with the migrating snapshot/)
  assert.deepEqual(await readFile(pair.path), await readFile(old))
})

it('a panel reading during current switches gets counts, bytes and names from one generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-generation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pair = snapshotFiles(root)
  const store = join(root, `.snapshot-${digest(basename(pair.path))}`)
  const current = join(store, 'current')
  const next = join(store, 'switch')
  const labels = ['earlier', 'later'] as const
  const generations = ['1'.repeat(32), '2'.repeat(32)]
  const expected = new Map<string, number>()
  for (const [i, label] of labels.entries()) {
    const dir = join(store, generations[i]!)
    await mkdir(dir, { recursive: true })
    const bytes = 11 + 500 * i
    const head = Buffer.alloc(12 + label.length)
    head.writeUInt32LE(label.length)
    head.write(label, 4)
    head.writeBigUInt64LE(BigInt(bytes), 4 + label.length)
    const payload = Buffer.concat([Buffer.from('PRIME-AGENT-KERNEL-SNAPSHOT-V2\n'), head, Buffer.alloc(bytes)])
    await writeFile(join(dir, basename(pair.path)), payload)
    await writeFile(join(dir, basename(pair.manifestPath)), JSON.stringify({ version: 1, bytes: payload.length, timestamp: new Date().toISOString(), savedNames: [label], pruned: [], skipped: [] }))
    expected.set(label, payload.length)
  }
  await symlink(generations[0]!, current)
  await symlink(join(basename(store), 'current', basename(pair.path)), pair.path)
  await symlink(join(basename(store), 'current', basename(pair.manifestPath)), pair.manifestPath)
  const checks = async () => {
    const snapshot = await readPanelSnapshot(root)
    assert.equal(snapshot.status, 'available', snapshot.error)
    const [name] = snapshot.saved
    assert.ok(name && expected.has(name))
    assert.equal(snapshot.bytes, expected.get(name))
    assert.deepEqual(Object.keys(snapshot.sizes ?? {}), [name])
    assert.equal(snapshot.sizes?.[name], name === labels[0] ? 11 : 511)
    return name
  }
  assert.equal(await checks(), labels[0])
  const switching = async () => {
    for (let turn = 0; turn < 31; turn++) {
      await symlink(generations[(turn + 1) % 2]!, next)
      await rename(next, current)
    }
  }
  await Promise.all([switching(), (async () => { for (let turn = 0; turn < 40; turn++) await checks() })()])
  assert.equal(await checks(), labels[1])
})
