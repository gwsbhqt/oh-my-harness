import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseCommand, createCli, type AppControl } from '../src/cli/core.ts'

function fixture(origin: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync('/tmp/dsh-front-')
  const touched: string[] = []
  const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = []
  let out = '', err = ''
  const app: AppControl = {
    running: () => { touched.push('running'); return false },
    backendRunning: () => { touched.push('backendRunning'); return false },
    quit: () => { touched.push('quit'); throw new Error('禁止访问真实 App') },
    open: () => { touched.push('open'); throw new Error('禁止访问真实 App') },
    kill: () => { touched.push('kill'); throw new Error('禁止访问真实 App') },
    confirmScheduledQuit: () => { touched.push('confirm'); throw new Error('禁止访问真实 App') },
  screenLocked: () => { touched.push('locked'); throw new Error('禁止访问真实 App') },
  }
  const env = { HOME: home, DSH_HOME: home, DSH_APP: join(home, 'absent.app'), ...origin }
  const cli = createCli(env, (t) => { out += t }, (t) => { err += t },
    (args, childEnv) => { spawned.push({ args, env: childEnv }); return 4242 }, app)
  return { home, touched, spawned, cli, out: () => out, err: () => err,
    close: () => rmSync(home, { recursive: true, force: true }) }
}

// 会话里的前台命令随 DSH 退出而消失：一律转后台；有会话编号就默认通知它。
for (const origin of [{ DSH_SESSION_ID: 'session-self' }, { DSH_SHELL: '1' }, { DSH_SESSION_ID: 'session-self', DSH_CONTROL_DETACHED: '1' }]) {
  for (const flags of [[], ['--kill'], ['--detach'], ['--detach', '--kill']] as const) {
    test(`会话来源 ${JSON.stringify(origin)} restart ${flags.join(' ')}：自动转后台，去掉来源环境`, async () => {
      const f = fixture(origin)
      try {
        assert.equal(await f.cli(['restart', ...flags]), 0, f.err())
        const expected = ['restart', ...flags.filter((flag) => flag !== '--detach')]
        if ('DSH_SESSION_ID' in origin) expected.push('--notify=session-self')
        assert.deepEqual(f.spawned[0]?.args, expected)
        assert.equal(f.spawned[0]?.env['DSH_SESSION_ID'], undefined)
        assert.equal(f.spawned[0]?.env['DSH_SHELL'], undefined)
        assert.deepEqual(f.touched, [], '前台只转后台，不碰 App')
      } finally { f.close() }
    })
  }
}

for (const flags of [['--when-idle'], ['--if-idle'], ['--force'], ['--timeout', '90'], ['--background']]) {
  test(`restart 已删除或未知参数 ${flags.join(' ')} 最早拒绝`, async () => {
    const f = fixture({ DSH_SESSION_ID: 'session-self' })
    try {
      assert.equal(await f.cli(['restart', ...flags]), 2, f.err())
      assert.deepEqual(f.touched, [])
      assert.deepEqual(f.spawned, [])
      assert.equal(existsSync(join(f.home, 'dsh-control')), false, '拒绝前不得写锁或日志')
    } finally { f.close() }
  })
}

test('真实终端显式转后台时保留有效参数', async () => {
  const f = fixture()
  try {
    assert.equal(await f.cli(['restart', '--detach', '--kill']), 0, f.err())
    assert.deepEqual(f.spawned[0]?.args, ['restart', '--kill'])
  } finally { f.close() }
})

for (const flags of [['--force=true'], ['--kill=1'], ['--detach=false'], ['--force', '--force'], ['--background'], ['--unexpected'], ['--quit-via', 'unknown'], ['--quit-via'], ['--quit-via', 'menu', '--quit-via', 'apple-event'], ['--quit-via', 'menu', '--kill']]) {
  test(`restart 错误请求 ${flags.join(' ')} 不静默放行`, async () => {
    const f = fixture()
    try {
      assert.equal(await f.cli(['restart', ...flags]), 2, f.err())
      assert.deepEqual(f.touched, [])
      assert.deepEqual(f.spawned, [])
      assert.equal(existsSync(join(f.home, 'dsh-control')), false)
    } finally { f.close() }
  })
}

test('parser 保留其他命令的 force 布尔参数，-- 后不是开关', () => {
  assert.deepEqual(parseCommand(['model', '--force', 'abcd']), {
    command: 'model', positional: ['abcd'], options: { force: true }, asJson: false,
  })
  assert.deepEqual(parseCommand(['restart', '--detach', '--force', '--kill']), {
    command: 'restart', positional: [], options: { detach: true, force: true, kill: true }, asJson: false,
  })
  assert.deepEqual(parseCommand(['restart', '--force', '--force']).options['force'], [true, true])
  assert.equal(parseCommand(['restart', '--force=true']).options['force'], 'true')
  assert.deepEqual(parseCommand(['restart', '--', '--force']).positional, ['--force'])
})
