import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { it, type TestContext } from 'node:test'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { driveBenchmarkDialog } from '../scripts/benchmark-dialog.ts'
import { parseRunEvents } from '../scripts/benchmark.ts'

const route = { cwd: '/benchmark-fixture', provider: 'example-provider', model: 'example-model', sessionId: 'benchmark-session' }
const identity = { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
const completed = { kind: 'completed' }
const text = (value: string) => ({ type: 'text', text: value })
const message = (id: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [text(id)] })
const chunk = (usage: object) => ({ type: 'chunk', time: 1, chunk: { type: 'usage', usage } })
const jsonl = (raw: string) => raw.trimEnd().split('\n').map(line => JSON.parse(line))

function sdk(t: TestContext) {
  const input = new PassThrough()
  const output = new PassThrough()
  const remote = new JsonRpcLineTransport(output, input)
  const requests: string[] = []
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => identity,
    shutdown: () => ({}),
  }
  remote.onRequest(async (method, params) => {
    requests.push(method)
    const handler = handlers[method]
    if (!handler) throw new Error(`Unexpected request ${method}`)
    return handler(params)
  })
  remote.start()
  t.after(() => { remote.close(); input.destroy(); output.destroy() })
  let seq = 0
  function event(type: string, data: object, envelope: object = {}, sessionId = route.sessionId) {
    const record = { type, data, seq: seq++, time: 1, ...envelope }
    remote.notify('session.event', { sessionId, event: record })
    return record.seq
  }
  function admit(turn: number, id: string) {
    event('turn/start', { turn })
    event('step/start', { turn, step: 1 })
    event('user/message', message(id), { surfaceOp: 'append' })
  }
  function assistant(turn: number, step: number, content: object[], details: object = {}) {
    event('assistant/message', { turn, step, message: { id: `reply-${turn}-${step}`, role: 'assistant',
      source: { kind: 'model', provider: route.provider, model: route.model }, content }, stream: [], ...details }, { surfaceOp: 'append' })
  }
  function finish(turn: number, step = 1) {
    event('step/end', { turn, step })
    event('turn/end', { turn, reason: completed })
  }
  return { input, output, handlers, requests, event, admit, assistant, finish }
}

it('keeps one SDK session, waits for each prompt receipt and emits committed, paired headless events', async t => {
  const s = sdk(t)
  let turn = 0
  s.handlers.initialize = params => {
    assert.deepEqual(params, { cwd: route.cwd, model: route.model, provider: route.provider })
    return identity
  }
  s.handlers['session/prompt'] = params => {
    turn++
    assert.deepEqual(params, { sessionId: route.sessionId, contentBlocks: [text(`question ${turn}`)] })
    const id = `prompt-${turn}`
    // Even the entire preceding turn can be in the same read as the enqueue receipt.
    s.admit(0, 'another-message')
    s.assistant(0, 1, [text('old answer')])
    s.finish(0)
    s.admit(turn, id)
    return { messageId: id }
  }
  const answer = '答案'.repeat(5000)
  s.handlers['session/wait'] = params => {
    assert.deepEqual(params, { sessionId: route.sessionId })
    const step = 1
    if (turn === 1) {
      s.event('assistant/attempt', { turn, step, stream: [
        { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['discarded attempt'] },
        chunk({ inputTokens: 99, outputTokens: 1 }),
        chunk({ inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 }),
      ] })
      s.assistant(turn, step, [{ type: 'reasoning', text: 'thinking' }, text('checking'),
        { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"x":1}' },
        { type: 'tool-call', id: 'call-b', name: 'other', arguments: '1e400' }], {
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 0 },
        stream: [chunk({ inputTokens: 12, outputTokens: 4 })],
      })
      const a = s.event('tool/call', { turn, step, callId: 'call-a', name: 'read', arguments: '{"x":1}' })
      const b = s.event('tool/call', { turn, step, callId: 'call-b', name: 'other', arguments: '1e400' })
      const result = (callId: string, value: string) => ({ role: 'tool', id: `result-${callId}`, toolCallId: callId,
        source: { kind: 'tool', callId }, content: [text(value), text('!')] })
      s.event('tool/result', { turn, step, message: result('call-a', 'historical') },
        { surfaceOp: { op: 'replace', startSeq: a, endSeq: a }, sourceEventSeqs: [a] })
      s.event('tool/result', { turn, step, message: result('call-a', 'wrong call') }, { surfaceOp: 'append', sourceEventSeqs: [b] })
      s.event('tool/result', { turn, step, message: { ...result('call-b', 'failed'), isError: true },
        error: { name: 'ExampleError', code: 'BAD_INPUT' } }, { surfaceOp: 'append', sourceEventSeqs: [b] })
      s.event('tool/result', { turn, step, message: result('call-a', 'ok') }, { surfaceOp: 'append', sourceEventSeqs: [a] })
      s.event('step/end', { turn, step })
      s.event('step/start', { turn, step: 2 })
      s.assistant(turn, 2, [text('part '), text('one')], { stream: [chunk({ inputTokens: 8, outputTokens: 1 })] })
      s.finish(turn, 2)
    } else {
      s.event('assistant/message', { turn, step, message: { content: [text('child answer')] }, stream: [] }, { surfaceOp: 'append' }, 'other-session')
      s.assistant(turn, step, [text(answer)])
      s.finish(turn)
    }
    return {}
  }
  const callbacks: number[] = []
  await driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['question 1', 'question 2', 'must never run'],
    onTurn: async (index, raw, elapsed) => {
      assert.ok(elapsed >= 0)
      assert.equal(s.requests.at(-1), 'session/wait')
      assert.equal(raw.endsWith('\n'), true)
      const rows = jsonl(raw)
      assert.deepEqual(rows[0], { type: 'session', sessionId: route.sessionId, cwd: route.cwd })
      assert.deepEqual(rows.at(-1), { type: 'final', sessionId: route.sessionId, reason: completed, text: index ? answer : 'part one' })
      assert.deepEqual(rows.filter(r => r.phase === 'turn_end'), [{ type: 'status', phase: 'turn_end', turn: index + 1, reason: completed }])
      assert.doesNotMatch(raw, /old answer|child answer|discarded attempt|historical|wrong call/)
      const steps = rows.filter(r => r.phase === 'step_end')
      if (index === 0) {
        assert.deepEqual(steps.map(r => r.usage), [
          { inputTokens: 15, outputTokens: 6, totalTokens: 21, cacheReadTokens: 2, cacheWriteTokens: null, reasoningTokens: null },
          { inputTokens: 8, outputTokens: 1, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
        ])
        assert.deepEqual(rows.filter(r => r.type === 'tool_call'), [
          { type: 'tool_call', callId: 'call-a', tool: 'read', input: { x: 1 } },
          { type: 'tool_call', callId: 'call-b', tool: 'other', input: '1e400' },
        ])
        assert.deepEqual(rows.filter(r => r.type === 'tool_result'), [
          { type: 'tool_result', callId: 'call-b', status: 'error', result: 'failed!', error: { name: 'ExampleError', code: 'BAD_INPUT' } },
          { type: 'tool_result', callId: 'call-a', status: 'completed', result: 'ok!' },
        ])
        const metrics = parseRunEvents(raw)
        assert.equal(metrics.complete, true)
        assert.equal(metrics.modelToolCalls, 2)
        assert.equal(metrics.toolErrors, 1)
        assert.deepEqual(rows.filter(r => r.type === 'thinking' || r.type === 'text').map(r => r.text), ['thinking', 'checking', 'part ', 'one'])
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(s.requests, ['initialize', 'session/prompt', 'session/wait'])
      } else {
        assert.equal(steps[0].usage, null)
      }
      assert.ok(!rows.some(r => r.type === 'error'))
      callbacks.push(index)
      return index === 0
    } })
  assert.deepEqual(callbacks, [0, 1])
  assert.deepEqual(s.requests, ['initialize', 'session/prompt', 'session/wait', 'session/prompt', 'session/wait', 'shutdown'])
  assert.ok(!s.input.destroyed && !s.output.destroyed)
})

it('does not substitute a billed partial sum, an intermediate answer or a different receipt', async t => {
  const s = sdk(t)
  let turn = 0
  s.handlers['session/prompt'] = () => ({ messageId: `m${++turn}` })
  s.handlers['session/wait'] = () => {
    s.admit(turn, turn === 1 ? 'm1' : 'different-receipt')
    s.event('assistant/attempt', { turn, step: 1, stream: [] })
    s.assistant(turn, 1, [text('progress')], { usage: { inputTokens: 9, outputTokens: 2 } })
    s.event('step/end', { turn, step: 1 })
    s.event('step/start', { turn, step: 2 })
    s.assistant(turn, 2, [], { interrupted: true })
    s.finish(turn, 2)
    return {}
  }
  await driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['one', 'two'], onTurn: async (i, raw) => {
    const rows = jsonl(raw)
    assert.equal(rows.at(-1).text, '')
    assert.ok(rows.some(r => r.type === 'error'))
    if (i === 0) {
      assert.deepEqual(rows.filter(r => r.phase === 'step_end').map(r => r.usage), [null, null])
    } else {
      assert.equal(rows.at(-1).reason, null)
      assert.ok(!rows.some(r => r.phase === 'turn_end'))
    }
    return true
  } })
})

it('keeps a tool-concluded turn completed while leaving its preamble out of the final answer', async t => {
  const s = sdk(t)
  s.handlers['session/prompt'] = () => ({ messageId: 'm' })
  s.handlers['session/wait'] = () => {
    s.admit(1, 'm')
    const block = { type: 'tool-call', id: 'submit', name: 'submit_fixture', arguments: '' }
    s.assistant(1, 1, [text('submitting'), block])
    const cause = s.event('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: '' })
    s.event('tool/result', { turn: 1, step: 1, message: { role: 'tool', id: 'submission', source: { kind: 'tool', callId: block.id },
      toolCallId: block.id, content: [text('received')] } }, { surfaceOp: 'append', sourceEventSeqs: [cause] })
    s.finish(1)
    return {}
  }
  await driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['one'], onTurn: async (_index, raw) => {
    const metrics = parseRunEvents(raw)
    assert.equal(metrics.complete, true)
    assert.equal(metrics.final, '')
    assert.deepEqual(jsonl(raw).find(row => row.type === 'tool_call').input, {})
    return false
  } })
})

it('accounts for follow-up root turns through wait and never finishes on an intermediate terminal', async t => {
  const s = sdk(t)
  let trial = 0
  s.handlers['session/prompt'] = () => ({ messageId: `m${++trial}` })
  s.handlers['session/wait'] = () => {
    const turn = trial * 3
    s.admit(turn, `m${trial}`)
    s.assistant(turn, 1, [text('intermediate')], { usage: { inputTokens: 2, outputTokens: 3 } })
    s.finish(turn)
    s.event('turn/start', { turn: turn + 1 })
    s.event('step/start', { turn: turn + 1, step: 1 })
    s.assistant(turn + 1, 1, [text('follow-up')], { usage: { inputTokens: 5, outputTokens: 7 } })
    s.event('step/end', { turn: turn + 1, step: 1 })
    if (trial === 1) {
      s.event('turn/end', { turn: turn + 1, reason: completed })
      s.admit(turn + 2, 'another-human-input')
      s.assistant(turn + 2, 1, [text('unrelated')])
      s.finish(turn + 2)
    }
    return {}
  }
  await driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['one', 'two'], onTurn: async (i, raw) => {
    const metrics = parseRunEvents(raw)
    assert.equal(metrics.steps, 2)
    assert.equal(metrics.usage.inputTokens, 7)
    assert.equal(metrics.usage.outputTokens, 10)
    assert.equal(metrics.complete, i === 0)
    assert.equal(metrics.final, i === 0 ? 'follow-up' : '')
    assert.deepEqual(jsonl(raw).at(-1).reason, i === 0 ? completed : null)
    assert.doesNotMatch(raw, /unrelated/)
    return true
  } })
})

it('preserves the actual blocked turn when pre-step claimed the prompt before user/message', async t => {
  const s = sdk(t)
  const id = 'claimed'
  s.handlers['session/prompt'] = () => {
    s.event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message(id)] })
    return { messageId: id }
  }
  s.handlers['session/wait'] = () => {
    s.event('turn/start', { turn: 8 })
    s.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    s.event('turn/end', { turn: 8, reason: { kind: 'blocked' } })
    s.admit(9, 'other')
    s.assistant(9, 1, [text('unrelated success')])
    s.finish(9)
    return {}
  }
  await driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['one'], onTurn: async (_i, raw) => {
    const rows = jsonl(raw)
    assert.deepEqual(rows.at(-1), { type: 'final', sessionId: route.sessionId, reason: { kind: 'blocked' }, text: '' })
    assert.doesNotMatch(raw, /unrelated success|completed/)
    return false
  } })
})

it('shuts down after a handshake error, prompt or wait error, and grading exception without resubmitting', async t => {
  for (const failure of ['identity', 'receipt', 'prompt', 'wait', 'grading', 'shutdown'] as const) {
    const s = sdk(t)
    if (failure === 'identity') s.handlers.initialize = () => ({ serverInfo: { name: 'another-server', version: '1' } })
    s.handlers['session/prompt'] = () => {
      if (failure === 'prompt') throw new Error(failure)
      return failure === 'receipt' ? {} : { messageId: 'm' }
    }
    s.handlers['session/wait'] = () => {
      if (failure === 'wait') throw new Error(failure)
      s.admit(1, 'm')
      s.assistant(1, 1, [text('done')])
      s.finish(1)
      return {}
    }
    if (failure === 'shutdown') s.handlers.shutdown = () => { throw new Error(failure) }
    let graded = 0
    await assert.rejects(driveBenchmarkDialog(s.input, s.output, { ...route, prompts: ['one', 'two'], onTurn: async () => {
      graded++
      if (failure === 'grading') throw new Error(failure)
      return false
    } }), error => {
      if (failure === 'identity') return /握手/.test(String(error))
      if (failure === 'receipt') return /消息编号/.test(String(error))
      if (failure === 'grading') return error instanceof Error && error.message === failure
      return error instanceof JsonRpcResponseError && error.message === failure
    })
    const expected = ['initialize']
    if (failure !== 'identity') expected.push('session/prompt')
    if (['wait', 'grading', 'shutdown'].includes(failure)) expected.push('session/wait')
    assert.deepEqual(s.requests, [...expected, 'shutdown'])
    assert.equal(graded, ['grading', 'shutdown'].includes(failure) ? 1 : 0)
  }
})

it('releases pending RPCs and its stream listeners on EOF or a broken output pipe', async () => {
  for (const broken of ['input', 'output'] as const) {
    const input = new PassThrough()
    const output = new PassThrough()
    const methods: string[] = []
    output.on('data', bytes => {
      const frame = JSON.parse(bytes.toString())
      methods.push(frame.method)
      if (frame.method === 'initialize') input.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: identity })}\n`)
      if (frame.method === 'session/prompt') input.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { messageId: 'm' } })}\n`)
      if (frame.method === 'session/wait') {
        if (broken === 'input') input.end()
        else output.destroy(new Error('broken pipe'))
      }
    })
    const listeners = () => [input, output].flatMap(stream => ['data', 'end', 'close', 'finish', 'error'].map(name => stream.listenerCount(name)))
    const original = listeners()
    try {
      await assert.rejects(driveBenchmarkDialog(input, output, { ...route, prompts: ['one'], onTurn: async () => assert.fail('unexpected callback') }),
        broken === 'input' ? /closed|已结束/ : /broken pipe/)
      assert.deepEqual(methods, ['initialize', 'session/prompt', 'session/wait'])
      assert.deepEqual(listeners(), original)
    } finally { input.destroy(); output.destroy() }
  }
})
