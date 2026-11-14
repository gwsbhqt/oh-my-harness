import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { markAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config, resolveConfig } from '../src/index.ts'
import { guardOutputStream, OUTPUT_LOOP_CODE, REASONING_ONLY_CODE, TOOL_ARGS_TOO_LONG_CODE, type OutputGuardOptions } from '../src/guard.ts'

const options: OutputGuardOptions = {
  rules: { repeatCount: 8, minCycleChars: 4, maxCycleChars: 160, minRepeatedChars: 64, windowChars: 1000 },
  maxBlankRun: 2000,
  maxToolArgsChars: 50000,
  reasoningOnlyGuard: true,
  provider: 'test',
  model: 'model',
}

async function* from(chunks: Iterable<StreamChunk>) {
  yield* chunks
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

function reasoning(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
  ]
}

test('重复输出变成失败并关闭上游，不转发触发片段', async () => {
  let closed = false
  async function* source() {
    try {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' } as StreamChunk
      for (let index = 0; index < 30; index++) yield { type: 'reasoning-delta', index: 0, text: '\n\n**测试。**\n\n**好。**\n\n好。' } as StreamChunk
    } finally {
      closed = true
    }
  }
  const result = await collect(guardOutputStream(source(), options))
  const last = result.at(-1)
  assert.equal(last?.type, 'finish')
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, OUTPUT_LOOP_CODE)
  assert.equal(closed, true)
  assert.ok(result.length < 25, '不能等全部失控内容输出完')
})

test('工具参数即使重复也不检查，工具调用算有效结果', async () => {
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    ...Array.from({ length: 30 }, () => ({ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '重复参数。' }) as StreamChunk),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

function blankFlood(): string[] {
  const pieces = ['  \t\t\t\t\t\t\t\t \t\t\t', '\n', '                                                    ', '\t\t\t\t\t\t\t\t\t\t', '\n  ']
  return Array.from({ length: 400 }, (_, index) => pieces[index % pieces.length]!)
}

test('虚构工具参数写到一半变成大段空白时中止，并关闭上游', async () => {
  let closed = false
  let sent = 0
  async function* source() {
    try {
      yield { type: 'block-start', index: 1, blockType: 'tool-call' } as StreamChunk
      yield { type: 'tool-call-delta', index: 1, id: 'call', name: 'run_code', argumentsDelta: String.raw`{"code":"print({'message': 'Example response {"` } as StreamChunk
      for (const piece of blankFlood()) {
        sent++
        yield { type: 'tool-call-delta', index: 1, id: 'call', argumentsDelta: piece } as StreamChunk
      }
    } finally {
      closed = true
    }
  }
  const result = await collect(guardOutputStream(source(), options))
  const last = result.at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, OUTPUT_LOOP_CODE)
  assert.equal(closed, true)
  assert.ok(sent < 200, '空白累计到上限就停，不等它写完')
})

test('JSON 转义的换行和制表符同样计入空白', async () => {
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    ...Array.from({ length: 300 }, () => ({ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: String.raw`\n\t\t\t  ` }) as StreamChunk),
  ]
  const last = (await collect(guardOutputStream(from(input), options))).at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, OUTPUT_LOOP_CODE)
})

test('文字中的反斜杠加字母不是空白', async () => {
  const text = String.raw`\n`.repeat(20)
  const input: StreamChunk[] = [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), { ...options, maxBlankRun: 16 })), input)
})

test('JSON 字符串中转义的反斜杠不是换行', async () => {
  const args = JSON.stringify({ text: String.raw`\n`.repeat(20) })
  const input: StreamChunk[] = [
    ...Array.from(args, char => ({ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: char }) as StreamChunk),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), { ...options, maxBlankRun: 16 })), input)
})

test('同一个片段中空白超过上限后出现文字仍要中止', async () => {
  const input: StreamChunk[] = [{ type: 'text-delta', index: 0, text: ' '.repeat(20) + '结束' }]
  const last = (await collect(guardOutputStream(from(input), { ...options, maxBlankRun: 16 }))).at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, OUTPUT_LOOP_CODE)
})

test('正文只输出空白也会中止', async () => {
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...blankFlood().map(text => ({ type: 'text-delta', index: 0, text }) as StreamChunk),
  ]
  const last = (await collect(guardOutputStream(from(input), options))).at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, OUTPUT_LOOP_CODE)
})

test('正常缩进的长代码不误伤', async () => {
  const line = String.raw`\n                        if row[\"cpu\"] > threshold:\n                            hits.append(row)`
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    ...Array.from({ length: 450 }, () => ({ type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: line }) as StreamChunk),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

test('正常的 Markdown 表格分隔行不误伤', async () => {
  const text = '结论如下：\n\n| Index | Item | Category | Status | Owner | Group | Count | Flag | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 1 | DEMO-001 | Example | Ready | Test User | Sample | 1 | Yes | Synthetic row |'
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, char => ({ type: 'text-delta', index: 0, text: char }) as StreamChunk),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

test('单次工具调用超过 5 万字就中止，并关闭上游', async () => {
  let closed = false
  let sent = 0
  async function* source() {
    try {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as StreamChunk
      for (let index = 0; index < 2000; index++) {
        sent++
        yield { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '<div class="row">内容</div>'.repeat(4) } as StreamChunk
      }
    } finally {
      closed = true
    }
  }
  const result = await collect(guardOutputStream(source(), options))
  const last = result.at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, TOOL_ARGS_TOO_LONG_CODE)
  assert.equal(closed, true)
  assert.ok(sent < 600, '写到上限就停')
})

test('每个工具调用单独计长度，几个 3 万字的调用都放行', async () => {
  const input: StreamChunk[] = [0, 1, 2].flatMap(index => [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: `call-${index}`, argumentsDelta: 'x'.repeat(30000) },
    { type: 'block-end', index, block: { type: 'tool-call', id: `call-${index}`, name: 'run_code', arguments: '' } },
  ] as StreamChunk[])
  input.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

test('只有思考的正常结束被改成失败', async () => {
  const input: StreamChunk[] = [
    ...reasoning('先分析问题，再决定下一步。'),
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析问题，再决定下一步。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const result = await collect(guardOutputStream(from(input), options))
  const last = result.at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, REASONING_ONLY_CODE)
})

test('达到上限但没有正文时按空回复失败', async () => {
  const input: StreamChunk[] = [...reasoning('还在思考'), { type: 'finish', reason: { kind: 'max-tokens' } }]
  const last = (await collect(guardOutputStream(from(input), options))).at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, REASONING_ONLY_CODE)
})

test('达到上限时被宿主丢弃的工具调用不算有效回复', async () => {
  const input: StreamChunk[] = [
    { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '{"incomplete":' } as StreamChunk,
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const last = (await collect(guardOutputStream(from(input), options))).at(-1)
  assert.equal(last?.type === 'finish' && last.reason.kind === 'error' && last.reason.failure.code, REASONING_ONLY_CODE)
})

test('达到上限但已有正文时保留宿主的结束原因', async () => {
  const input: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: '已有内容' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

test('正常正文与结束原因原样透传', async () => {
  const input: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '已经核对，原因是配置未生效。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '已经核对，原因是配置未生效。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  assert.deepEqual(await collect(guardOutputStream(from(input), options)), input)
})

test('关闭假完成保护后原样透传', async () => {
  const input: StreamChunk[] = [...reasoning('只思考。'), { type: 'finish', reason: { kind: 'stop' } }]
  assert.deepEqual(await collect(guardOutputStream(from(input), { ...options, reasoningOnlyGuard: false })), input)
})

function fakeHost() {
  const listeners: Record<string, ((payload: never, next: () => unknown) => unknown)[]> = {}
  const appended: { type: string, data: { content: { text: string }[] } }[] = []
  const agent = {
    id: 'session-test',
    session: { append(type: string, data: never) { appended.push({ type, data }); return { seq: appended.length } } },
  } as unknown as Agent
  const ctx = {
    on(event: string, listener: never) {
      ;(listeners[event] ??= []).push(listener)
      return () => undefined
    },
  }
  apply(ctx as never, Config({}))
  return { listeners, appended, agent }
}

test('异常重试一次并写入纠正提示，第二次交回宿主', async () => {
  const host = fakeHost()
  const listener = host.listeners['agent/request-error']![0]!
  const payload = { agent: host.agent, turn: 3, step: 1, failure: { code: OUTPUT_LOOP_CODE, message: 'loop' } }
  assert.deepEqual(await listener(payload as never, async () => 'retry'), { kind: 'retry' })
  assert.equal(host.appended.length, 1)
  assert.equal(host.appended[0]!.type, 'user/message')
  assert.match(host.appended[0]!.data.content[0]!.text, /Do not continue or repeat/)
  assert.doesNotMatch(host.appended[0]!.data.content[0]!.text, /\*\*测试。\*\*/)
  assert.equal(await listener(payload as never, async () => 'terminal'), 'terminal')
  assert.equal(host.appended.length, 1)
})

test('工具调用太长时重试提示要求拆分', async () => {
  const host = fakeHost()
  const listener = host.listeners['agent/request-error']![0]!
  const payload = { agent: host.agent, turn: 4, step: 2, failure: { code: TOOL_ARGS_TOO_LONG_CODE, message: 'long' } }
  assert.deepEqual(await listener(payload as never, async () => 'retry'), { kind: 'retry' })
  assert.match(host.appended[0]!.data.content[0]!.text, /Split the work into steps/)
})

test('配置默认值与开关符合约定', () => {
  const config = resolveConfig(Config({}))
  assert.equal(config.enabled, true)
  assert.equal(config.autoRetry, true)
  assert.equal(config.reasoningOnlyGuard, true)
  assert.equal(config.repeatCount, 8)
  assert.equal(config.maxBlankRun, 2000)
  assert.equal(config.maxToolArgsChars, 50000)
})

test('llm/stream 只保护代理请求，其他模型调用不受影响', async () => {
  const host = fakeHost()
  const listener = host.listeners['llm/stream']![0]! as unknown as (options: never, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  const input = reasoning('只思考。')
  input.push({ type: 'finish', reason: { kind: 'stop' } })
  const plain = { provider: 'test', model: 'model', messages: [] }
  assert.deepEqual(await collect(listener(plain as never, () => from(input))), input)
  const marked = markAgentLoopRequest(Object.freeze(plain))
  const guarded = await collect(listener(marked as never, () => from(input)))
  const last = guarded.at(-1)
  assert.ok(last?.type === 'finish')
  assert.equal(last.reason.kind, 'error')
})
