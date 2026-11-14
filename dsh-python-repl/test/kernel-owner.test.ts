/**
 * 内核看门狗的「主人」必须是本进程，不能从环境继承。
 *
 * 2026-09-27 真机：DSH 是从 Prime Agent 里启动的，继承了 pa 工作进程的
 * PRIME_AGENT_KERNEL_OWNER_PID。pa 重启后那个进程没了，之后每个新内核都在启动时
 * 自杀（kernel exited during startup, code=1），run_code 在所有新会话里全挂，
 * 而报错里没有任何原因——内核启动前的 stderr 没人读。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'
import { PythonKernel } from '../src/kernel.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'
const noTools = (): Map<string, BoundTool> => new Map()

/** 一个肯定不存在的进程号：比 macOS/Linux 的 pid 上限都大。 */
const DEAD_PID = '4194000'

const saved = { ...process.env }
const sessions: ReplSession[] = []
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

describe('kernel owner and inherited agent environment', () => {
  it('starts even when the host inherited a dead PRIME_AGENT_KERNEL_OWNER_PID, and sees no agent internals', async () => {
    process.env['PRIME_AGENT_KERNEL_OWNER_PID'] = DEAD_PID
    process.env['PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN'] = 'secret-token'
    process.env['RLM_SESSION_DIR'] = '/tmp/not-ours'
    const session = new ReplSession({
      python: PYTHON,
      vendorRoot: join(root, 'vendor', 'prime'),
      pythonRoot: join(root, 'python'),
    })
    sessions.push(session)
    const code = 'import os\n[os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID"), sorted(k for k in os.environ if k.startswith(("PRIME_AGENT_INTERNAL", "RLM_")))]'
    const result = await session.runCell(code, noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    const shown = result.logs.join('')
    assert.ok(shown.includes(`'${process.pid}'`), `owner must be this process, got ${shown}`)
    assert.ok(shown.includes('[]'), `agent internals must not reach the kernel, got ${shown}`)
  })

  it('keeps proxy settings but uses the bare IPv6 loopback form for HTTPX', async () => {
    // 2026-10-29: the host adds [::1] for undici; HTTPX rejects that token
    // while parsing NO_PROXY, before it sends the request. Only that exact
    // Python-facing token changes here; the host and other clients stay intact.
    Object.assign(process.env, {
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'https://proxy.example:8443',
      ALL_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost, 127.0.0.1,[::1],[::1]:8080,[2001:db8::1],foo[::1]bar,',
      no_proxy: '[::1],example.test',
    })
    // httpx is preinstalled in every real kernel venv, not in a bare python3: run where it exists.
    const session = new ReplSession({
      python: process.env['DSH_PY'] ?? await testKernelPython(),
      vendorRoot: join(root, 'vendor', 'prime'),
      pythonRoot: join(root, 'python'),
    })
    sessions.push(session)
    const result = await session.runCell('import os, json, httpx, importlib.util\nassert importlib.util.find_spec("httpx") is not None, "proxy regression requires httpx"\nwith httpx.Client(): pass\nasync def check_async():\n    async with httpx.AsyncClient(): pass\nawait check_async()\nprint(json.dumps({key: os.environ.get(key) for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy")}, sort_keys=True))', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    const actual = JSON.parse(result.logs.join('').trim())
    assert.deepEqual(actual, {
      ALL_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'https://proxy.example:8443',
      HTTP_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost, 127.0.0.1,::1,[::1]:8080,[2001:db8::1],foo[::1]bar,',
      no_proxy: '::1,example.test',
    })
  })

  it('passes the session id to the kernel as DSH_SESSION_ID (dsh-use 的会话标记)', async () => {
    const session = new ReplSession({
      python: PYTHON,
      vendorRoot: join(root, 'vendor', 'prime'),
      pythonRoot: join(root, 'python'),
      sessionId: 'session-test-123',
    })
    sessions.push(session)
    const result = await session.runCell('import os\nos.environ.get("DSH_SESSION_ID")', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(result.logs.join('').includes("'session-test-123'"), JSON.stringify(result.logs))
  })

  it('a kernel that dies before the handshake reports its stderr', async () => {
    const kernel = new PythonKernel({
      python: PYTHON,
      pythonPath: [join(root, 'python')],
      moduleArgs: ['-c', 'import sys; sys.stderr.write("boom: missing module\\n"); sys.exit(1)'],
      onHostRequest: () => {},
    }, 1)
    await assert.rejects(kernel.start(10_000), /exited during startup[\s\S]*boom: missing module/)
    await kernel.dispose()
  })
})
