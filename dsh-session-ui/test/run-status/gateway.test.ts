import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LOCAL_MAGPIE_BASE_URL, LOCAL_MAGPIE_KEY_REF, resolveMagpieGateway } from '../../src/host/run-status/magpie-gateway.ts'
import { RunTracker } from '../../src/host/run-status/tracker.ts'

const REMOTE = { baseUrl: 'https://gw.example.test/v1', keyRef: 'MY_GATEWAY_KEY' }

describe('magpie 网关三分支：本机优先、显式远端、都没有', () => {
  it('分支一：本机装了 Magpie 就用本机地址，显式配置的远端被忽略', () => {
    // 即使配置里写了远端地址和钥匙，本机有 Magpie 时也必须走本机，不能被远端顶掉。
    assert.deepEqual(resolveMagpieGateway(REMOTE, () => true), {
      magpieBaseUrl: LOCAL_MAGPIE_BASE_URL,
      magpieKeyRef: LOCAL_MAGPIE_KEY_REF,
    })
  })

  it('分支二：本机没 Magpie、显式配了远端，就用远端地址和钥匙引用', () => {
    assert.deepEqual(resolveMagpieGateway(REMOTE, () => false), {
      magpieBaseUrl: 'https://gw.example.test/v1',
      magpieKeyRef: 'MY_GATEWAY_KEY',
    })
    // 只配地址不配钥匙时，钥匙引用退回本机默认名（仍是引用名，不是钥匙本身）。
    assert.deepEqual(resolveMagpieGateway({ baseUrl: 'https://gw.example.test/v1', keyRef: '' }, () => false), {
      magpieBaseUrl: 'https://gw.example.test/v1',
      magpieKeyRef: LOCAL_MAGPIE_KEY_REF,
    })
  })

  it('分支三：本机没 Magpie、也没配远端，返回 undefined：不发查询、不出分段那一区', () => {
    assert.equal(resolveMagpieGateway({ baseUrl: '', keyRef: '' }, () => false), undefined)
    // 只有空白也算没配。
    assert.equal(resolveMagpieGateway({ baseUrl: '   ', keyRef: '' }, () => false), undefined)
  })

  it('分支三补充：没配网关时其他状态统计照常，只是不记请求分段', () => {
    // 网关判断为 undefined 时宿主不会记录请求分段；但运行状态本身照常跟踪。
    const enabled = () => resolveMagpieGateway({ baseUrl: '', keyRef: '' }, () => false) !== undefined
    assert.equal(enabled(), false)
    const tracker = new RunTracker({ trackRequests: () => enabled() })
    tracker.status('s', true, 0)
    tracker.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    tracker.event('s', { type: 'step/start', time: 0, data: { turn: 1, step: 1 } })
    const snap = tracker.snapshot('s', 5000)
    assert.equal(snap.running, true, '会话在跑这件事照常记着')
    assert.equal(snap.turn, 1, '轮次照常记着')
    assert.equal(snap.requests?.length ?? 0, 0, '没配网关就不记请求分段')
  })

  it('远端协议校验：不能是带账号/查询串/片段的地址，公网只能是 https', () => {
    assert.throws(() => resolveMagpieGateway({ baseUrl: 'http://gw.example.test/v1', keyRef: '' }, () => false), /只能是本机 HTTP/)
    assert.throws(() => resolveMagpieGateway({ baseUrl: 'https://user:' + 'pw' + '@gw.example.test/v1', keyRef: '' }, () => false), /不能带账号/)
    assert.throws(() => resolveMagpieGateway({ baseUrl: 'https://gw.example.test/v1?x=1', keyRef: '' }, () => false), /不能带账号/)
    assert.throws(() => resolveMagpieGateway({ baseUrl: 'https://gw.example.test/v1', keyRef: 'not a ref' }, () => false), /凭据引用名/)
    // 本机回环允许 http。
    assert.equal(resolveMagpieGateway({ baseUrl: 'http://127.0.0.1:3425/v1', keyRef: '' }, () => false)?.magpieBaseUrl, 'http://127.0.0.1:3425/v1')
  })
})
