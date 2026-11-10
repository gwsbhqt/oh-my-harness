import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { loadPreview } from '../src/client/preview-request.ts'

const request = { session: 'session-a', name: 'target', epoch: 3 }

it('preview client decodes split UTF-8 and forwards cancellation to fetch', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  const payload = { ...request, status: 'ok', kind: 'json', value: ['中文🐈'] }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.signal, controller.signal)
    assert.equal(init?.cache, 'no-store')
    assert.match(String(input), /session=session-a&name=target&epoch=3/)
    return new Response(new ReadableStream({
      start(stream) {
        for (let i = 0; i < bytes.length; i++) stream.enqueue(bytes.slice(i, i + 1))
        stream.close()
      },
    }))
  }
  try { assert.deepEqual(await loadPreview(request, controller.signal), payload) }
  finally { globalThis.fetch = original }
})

it('preview client cancels oversized UTF-8 response before parsing it', async () => {
  const original = globalThis.fetch
  let cancelled = false
  let chunks = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(stream) {
      chunks++
      stream.enqueue(new Uint8Array(16 * 1024).fill(65))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }))
  try {
    await assert.rejects(loadPreview(request, new AbortController().signal), /超过大小限制/)
    assert.equal(cancelled, true)
    assert.equal(chunks, 7)
  } finally { globalThis.fetch = original }
})

it('preview client rejects results from another session, name or kernel generation', async () => {
  const original = globalThis.fetch
  try {
    for (const mismatch of [{ session: 'session-b' }, { name: 'other' }, { epoch: 4 }]) {
      globalThis.fetch = async () => Response.json({ ...request, ...mismatch, status: 'ok', kind: 'json', value: 1 })
      await assert.rejects(loadPreview(request, new AbortController().signal), /内核状态已改变/)
    }
  } finally { globalThis.fetch = original }
})
