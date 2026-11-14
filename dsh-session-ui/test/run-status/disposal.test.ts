import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { applyRunStatus } from '../../src/host/run-status/index.ts'

test('会话离开宿主后清除其运行状态，其他会话不受影响', () => {
  const handlers = new Map<string, (...args: any[]) => void>()
  let route: ((req: unknown, res: unknown) => void) | undefined
  const projections: Array<{ key: string }> = []
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    on: (name: string, fn: (...args: any[]) => void) => { handlers.set(name, fn) },
    effect: (effect: () => unknown) => effect(),
    inject: (_services: string[], callback: (scope: unknown) => void) => callback({
      effect: (effect: () => unknown) => effect(),
      webServer: { register: (entry: { handler: typeof route }) => { route = entry.handler; return () => {} } },
      sessionProjections: { register: async (definition: { key: string }) => { projections.push(definition) } },
    }),
  }
  applyRunStatus(ctx as unknown as Context, { magpieBaseUrl: () => '', magpieKeyRef: () => '' })
  assert.deepEqual(projections.map((p) => p.key), ['runStatusTotals'])
  const status = (id: string) => {
    let body = ''
    assert.ok(route)
    route({ method: 'GET', headers: {}, url: `/?session=${id}` }, { writeHead() {}, end(text: string) { body = text } })
    return JSON.parse(body) as { running: boolean }
  }
  handlers.get('agent/status')?.({ agent: { session: { id: 'old' } }, status: 'running' })
  handlers.get('agent/status')?.({ agent: { session: { id: 'other' } }, status: 'running' })
  assert.equal(status('old').running, true)
  handlers.get('session/disposed')?.({ id: 'old' })
  assert.equal(status('old').running, false)
  assert.equal(status('other').running, true)
})
