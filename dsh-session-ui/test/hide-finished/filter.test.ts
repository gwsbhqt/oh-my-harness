import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ancestorsOf, hasRunningChild, hasTeamBoard, isLiveJob, liveOnlyJobs, liveOnlySubagents, shouldShowCatalog, type JobLike } from '../../src/client/hide-finished/filter.ts'

const job = (status: JobLike['status']): JobLike => ({ status })

describe('liveOnlyJobs', () => {
  it('只留下在跑和正在停止的任务', () => {
    const state = { rows: { a: [job('running'), job('completed'), job('stopping'), job('failed'), job('killed')] }, observed: {} }
    assert.deepEqual(liveOnlyJobs(state).rows.a?.map((j) => j.status), ['running', 'stopping'])
    assert.equal(isLiveJob(job('completed')), false)
  })

  it('全部结束时给空列表，宿主组件据此整个不显示', () => {
    assert.deepEqual(liveOnlyJobs({ rows: { a: [job('completed')] } }).rows.a, [])
  })

  it('保留状态里的其他字段（展开面板要用的 observed）', () => {
    const observed = { x: 1 }
    assert.equal(liveOnlyJobs({ rows: {}, observed }).observed, observed)
  })

  it('同一份状态返回同一个对象，宿主的 useMemo 不会白算', () => {
    const state = { rows: { a: [job('running')] } }
    assert.equal(liveOnlyJobs(state), liveOnlyJobs(state))
    assert.notEqual(liveOnlyJobs(state), liveOnlyJobs({ rows: { a: [job('running')] } }))
  })
})

describe('liveOnlySubagents', () => {
  const state = {
    byId: { c1: { running: false }, c2: { running: true }, c3: {} },
    projectionsBySession: {
      p: { state: 'ready', values: { subagentCatalog: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], other: 1 } },
      q: { state: 'idle', values: {} },
    },
  }

  it('目录只留在跑的：实时状态优先，缺了看会话摘要', () => {
    const statuses = new Map([['c1', { running: true }], ['c2', { running: false }]])
    const out = liveOnlySubagents(state, statuses)
    assert.deepEqual(out.projectionsBySession.p?.values.subagentCatalog?.map((e) => e.id), ['c1'])
    assert.deepEqual(liveOnlySubagents(state, new Map()).projectionsBySession.p?.values.subagentCatalog?.map((e) => e.id), ['c2'])
  })

  it('不动没有目录的会话和其他字段', () => {
    const out = liveOnlySubagents(state, new Map())
    assert.equal(out.projectionsBySession.q, state.projectionsBySession.q)
    assert.equal((out.projectionsBySession.p as { state: string }).state, 'ready')
    assert.equal(out.byId, state.byId)
  })

  it('同一份输入返回同一个对象', () => {
    const statuses = new Map()
    assert.equal(liveOnlySubagents(state, statuses), liveOnlySubagents(state, statuses))
    assert.equal(liveOnlySubagents(state, statuses, new Set(['c3', 'c1'])), liveOnlySubagents(state, statuses, new Set(['c1', 'c3'])))
  })

  it('keep 里的会话跑完也留着（切换框要靠它找到当前子代理的父会话）', () => {
    const out = liveOnlySubagents(state, new Map(), new Set(['c3']))
    assert.deepEqual(out.projectionsBySession.p?.values.subagentCatalog?.map((e) => e.id), ['c2', 'c3'])
  })
})

describe('ancestorsOf', () => {
  const tree = {
    byId: {},
    projectionsBySession: {
      root: { values: { subagentCatalog: [{ id: 'a' }] } },
      a: { values: { subagentCatalog: [{ id: 'b' }] } },
      b: { values: {} },
    },
  }

  it('沿目录逐级往上找，近的在前', () => {
    assert.deepEqual(ancestorsOf(tree, 'b'), ['a', 'root'])
    assert.deepEqual(ancestorsOf(tree, 'root'), [])
  })

  it('目录成环也会停下', () => {
    const loop = { byId: {}, projectionsBySession: { x: { values: { subagentCatalog: [{ id: 'y' }] } }, y: { values: { subagentCatalog: [{ id: 'x' }] } } } }
    assert.deepEqual(ancestorsOf(loop, 'x'), ['y'])
  })
})

describe('hasRunningChild', () => {
  const entries = [{ id: 'c1' }, { id: 'c2' }]

  it('没有目录或全部结束：不显示', () => {
    assert.equal(hasRunningChild(undefined, () => undefined, () => undefined), false)
    assert.equal(hasRunningChild(entries, () => false, () => true), false)
  })

  it('实时状态优先，缺了再看会话摘要', () => {
    assert.equal(hasRunningChild(entries, (id) => (id === 'c2' ? true : undefined), () => false), true)
    assert.equal(hasRunningChild(entries, () => undefined, (id) => id === 'c1'), true)
  })
})

describe('团队任务板（DSH 0.2.2-rc.2 起子代理按钮兼做它的入口）', () => {
  it('开着团队、有没删的任务或有失败说明，才算任务板有内容（和宿主同一口径）', () => {
    assert.equal(hasTeamBoard({ enabled: true, tasks: [{ status: 'completed' }] }), true)
    assert.equal(hasTeamBoard({ enabled: true, tasks: [{ status: 'deleted' }], failure: { message: 'x' } }), true)
    assert.equal(hasTeamBoard({ enabled: true, tasks: [{ status: 'deleted' }] }), false)
    assert.equal(hasTeamBoard({ enabled: false, tasks: [{ status: 'pending' }] }), false)
    assert.equal(hasTeamBoard(undefined), false)
  })

  it('子代理都跑完、任务板还有内容：按钮留着，否则任务板就没有入口了', () => {
    assert.equal(shouldShowCatalog('ready', false, true), true)
  })

  it('没有任务板时照旧：只在有在跑的子代理或目录出错时显示', () => {
    assert.equal(shouldShowCatalog('ready', false, false), false)
    assert.equal(shouldShowCatalog('ready', true, false), true)
    assert.equal(shouldShowCatalog('error', false, false), true)
    assert.equal(shouldShowCatalog(undefined, false, false), false)
  })
})
