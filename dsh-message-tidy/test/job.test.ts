import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { backgroundJob, relabel, type MessageLike } from '../src/job.ts'

// Synthetic notice preserving command quoting, pipes, and the host message shape.
const COMMAND = "ssh -o BatchMode=yes example-host 'printf ZXhhbXBsZQ== | base64 -d' 2>&1"
const noticeText = (id: string, cmd: string) =>
  `background job ${id} (bash: ${cmd}) finished [status: completed, exit code: 0]. Read its output with job_output.`

function notice(id: string, cmd = COMMAND): MessageLike {
  return Object.freeze({
    role: 'user',
    id: `n-${id}`,
    content: Object.freeze([Object.freeze({ type: 'text', text: noticeText(id, cmd) })]),
    // 0.1.7 实测形状：{ kind: 'tool-jobs', form: 'notice', summary }
    source: Object.freeze({ kind: 'tool-jobs', form: 'notice', summary: `bash ${cmd.slice(0, 60)}… [status: completed, exit code: 0]` }),
  })
}

const names = new Map([['bash-4', 'Install base CLI on Example Host']])

test('the command is replaced by the description, status line kept', () => {
  const out = relabel(notice('bash-4'), names, 120)
  assert.equal(out.content[0]!.text,
    'background job bash-4 (bash: Install base CLI on Example Host) finished [status: completed, exit code: 0]. Read its output with job_output.')
  assert.equal(out.source!.summary, 'bash Install base CLI on Example Host [status: completed, exit code: 0]')
  assert.equal(out.source!.kind, 'tool-jobs')
  assert.equal(out.source!.form, 'notice')
})

test('parentheses inside the command do not cut the label short', () => {
  const cmd = 'for i in $(seq 1 3); do (echo "x) finished"); done'
  const out = relabel(notice('bash-4', cmd), names, 120)
  assert.match(out.content[0]!.text!, /^background job bash-4 \(bash: Install base CLI on Example Host\) finished \[status:/)
})

test('0.2.2-rc.1 inline output that happens to contain the status marker is left alone', () => {
  const text = 'background job bash-4 (bash: grep finished) finished [status: completed, exit code: 0]. Output:\nlog line (x) finished [status: fake]\n'
  const message = Object.freeze({ role: 'user', id: 'n-out', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice', summary: 'bash grep finished [status: completed, exit code: 0]' } }) as MessageLike
  const out = relabel(message, names, 120)
  assert.equal(out.content[0]!.text,
    'background job bash-4 (bash: Install base CLI on Example Host) finished [status: completed, exit code: 0]. Output:\nlog line (x) finished [status: fake]\n')
})

test('unknown jobs and other messages are untouched', () => {
  const unknown = notice('bash-99')
  assert.equal(relabel(unknown, names, 120), unknown)
  const user: MessageLike = { role: 'user', content: [{ type: 'text', text: noticeText('bash-4', 'x') }], source: { kind: 'user' } }
  assert.equal(relabel(user, names, 120), user)
})

test('a long description is clipped', () => {
  const out = relabel(notice('bash-4'), new Map([['bash-4', 'x'.repeat(300)]]), 20)
  assert.match(out.content[0]!.text!, /\(bash: x{19}…\) finished/)
})

test('backgroundJob recognises only successful background bash calls with a description', () => {
  const bg = { kind: 'background', jobId: 'bash-7' }
  assert.deepEqual(backgroundJob({ name: 'bash', arguments: { command: 'x', description: ' Install  apps ', run_in_background: true } }, { isError: false, value: bg }), ['bash-7', 'Install apps'])
  assert.equal(backgroundJob({ name: 'bash', arguments: { command: 'x', run_in_background: true } }, { isError: false, value: bg }), undefined)
  assert.equal(backgroundJob({ name: 'bash', arguments: { command: 'x', description: 'd' } }, { isError: false, value: { kind: 'foreground' } }), undefined)
  assert.equal(backgroundJob({ name: 'read', arguments: {} }, { isError: false, value: bg }), undefined)
  assert.equal(backgroundJob({ name: 'bash', arguments: { description: 'd', run_in_background: true } }, { isError: true }), undefined)
})

test('a timeout-promoted bash receipt is remembered without run_in_background', () => {
  const exec = { name: 'bash', arguments: { command: 'node slow-task', description: ' Verify promoted  job ' } }
  const receipt = { kind: 'promoted', jobId: 'bash-promoted', timeoutMs: 1, output: '' }
  assert.deepEqual(backgroundJob(exec, { isError: false, value: receipt }), ['bash-promoted', 'Verify promoted job'])
  assert.equal(backgroundJob(exec, { isError: true, value: receipt }), undefined)
  for (const description of ['', '  ', undefined]) {
    assert.equal(backgroundJob({ ...exec, arguments: { description } }, { isError: false, value: receipt }), undefined)
  }
  assert.equal(backgroundJob(exec, { isError: false, value: { ...receipt, jobId: 3 } }), undefined)
  assert.equal(backgroundJob(exec, { isError: false, value: { kind: 'background', jobId: 'bash-7' } }), undefined)
})

type Waterfall = (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages: MessageLike[] }>

test('end to end: a tools/result is remembered per agent and used by the next step', async () => {
  const ctx = new Context()
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const agentA = {}
  const agentB = {}
  ;(ctx as unknown as { emit: (...a: unknown[]) => void }).emit('tools/result',
    { name: 'bash', agent: agentA, arguments: { command: COMMAND, description: 'Install base CLI on Example Host', run_in_background: true } },
    { isError: false, value: { kind: 'background', jobId: 'bash-4' }, content: [] })
  const waterfall = (ctx as unknown as { waterfall: Waterfall }).waterfall.bind(ctx)
  const a = await waterfall('agent/pre-step', { agent: agentA, messages: [] }, async () => ({ kind: 'enter', messages: [notice('bash-4')] }))
  assert.match(a.messages[0]!.content[0]!.text!, /\(bash: Install base CLI on Example Host\)/)
  // Another session's bash-4 is a different job: left alone.
  const b = await waterfall('agent/pre-step', { agent: agentB, messages: [] }, async () => ({ kind: 'enter', messages: [notice('bash-4')] }))
  assert.match(b.messages[0]!.content[0]!.text!, /\(bash: ssh -o BatchMode/)
})

test('promoted tools/result flows through the public hook into a labeled completion', async () => {
  const ctx = new Context()
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const agent = {}
  ;(ctx as unknown as { emit: (...a: unknown[]) => void }).emit('tools/result',
    { name: 'bash', agent, arguments: { command: COMMAND, description: 'Verify promoted task' } },
    { isError: false, value: { kind: 'promoted', jobId: 'bash-4', timeoutMs: 1, output: '' }, content: [] })
  const input = notice('bash-4')
  const decision = await (ctx as unknown as { waterfall: Waterfall }).waterfall('agent/pre-step', { agent, messages: [] }, async () => ({ kind: 'enter', messages: [input] }))
  const out = decision.messages[0]!
  assert.match(out.content[0]!.text!, /\(bash: Verify promoted task\) finished/)
  assert.match(out.content[0]!.text!, /^<system-reminder>/)
  assert.equal(out.id, input.id)
  assert.equal(out.source!.kind, input.source!.kind)
  assert.equal(out.source!.form, input.source!.form)
  assert.equal(out.role, input.role)
})

test('works on a notice already framed by dsh-notice-label', () => {
  const framed: MessageLike = {
    ...notice('bash-4'),
    content: [{ type: 'text', text: `<system-reminder>\n[tool-jobs] Automatic system notice (the user did not write this)\n\n${noticeText('bash-4', COMMAND)}\n</system-reminder>` }],
  }
  const text = relabel(framed, names, 120).content[0]!.text!
  assert.match(text, /^<system-reminder>\n\[tool-jobs\] Automatic system notice/)
  assert.match(text, /background job bash-4 \(bash: Install base CLI on Example Host\) finished \[status: completed, exit code: 0\]\. Read its output with job_output\.\n<\/system-reminder>$/)
})

test('merged plugin: relabel then frame, both on one notice, and switches turn items off', async () => {
  const run = async (config: Record<string, unknown>) => {
    const ctx = new Context()
    await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, config)
    const agent = {}
    ;(ctx as unknown as { emit: (...a: unknown[]) => void }).emit('tools/result',
      { name: 'bash', agent, arguments: { command: COMMAND, description: 'Install base CLI on Example Host', run_in_background: true } },
      { isError: false, value: { kind: 'background', jobId: 'bash-4' }, content: [] })
    const d = await (ctx as unknown as { waterfall: Waterfall }).waterfall('agent/pre-step', { agent, messages: [] }, async () => ({ kind: 'enter', messages: [notice('bash-4')] }))
    return d.messages[0]!.content[0]!.text!
  }
  const both = await run({})
  assert.match(both, /^<system-reminder>\n\[tool-jobs\] Automatic system notice/)
  assert.match(both, /\(bash: Install base CLI on Example Host\) finished/)
  const noFrame = await run({ noticeLabel: false })
  assert.match(noFrame, /^background job bash-4 \(bash: Install base CLI on Example Host\)/)
  const noRename = await run({ jobLabel: false })
  assert.match(noRename, /^<system-reminder>[\s\S]*\(bash: ssh -o BatchMode/)
})
