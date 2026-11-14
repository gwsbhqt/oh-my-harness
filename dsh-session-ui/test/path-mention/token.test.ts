import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { inlineCodeTokens, parsePathToken } from '../../src/shared/path-mention/token.ts'

describe('哪些反引号文字算路径', () => {
  it('路径、目录、带省略号和行号的都算', () => {
    assert.deepEqual(parsePathToken('dsh-use/src/cli/core.ts'), { path: 'dsh-use/src/cli/core.ts' })
    assert.deepEqual(parsePathToken('~/Library/Containers/com.tencent.xinWeChat/.../msg/file/2026-10/'), { path: '~/Library/Containers/com.tencent.xinWeChat/.../msg/file/2026-10/' })
    assert.deepEqual(parsePathToken('index.tsv'), { path: 'index.tsv' })
    assert.deepEqual(parsePathToken('.gitignore'), { path: '.gitignore' })
    assert.deepEqual(parsePathToken('.env.local'), { path: '.env.local' })
    assert.deepEqual(parsePathToken('src/a.ts:24'), { path: 'src/a.ts', line: 24, suffix: ':24' })
    assert.deepEqual(parsePathToken('src/a.ts#L3-L9'), { path: 'src/a.ts', line: 3, endLine: 9, suffix: '#L3-L9' })
    assert.deepEqual(parsePathToken('dsh-path-mention/src/client/index.tsx:24-27'), { path: 'dsh-path-mention/src/client/index.tsx', line: 24, endLine: 27, suffix: ':24-27' })
    assert.deepEqual(parsePathToken('src/a.ts:24:3'), { path: 'src/a.ts', line: 24, suffix: ':24:3' })
    assert.deepEqual(parsePathToken('/Applications/DeepSeek Harness.app'), { path: '/Applications/DeepSeek Harness.app' })
  })

  it('命令、占位写法、通配、网址、普通词都不算', () => {
    for (const text of ['jq', 'grep', 'git status', 'sessions/remote/<工作区>/<会话ID>.jsonl', '*.ts', 'https://a.com/b', '--force', 'a b', '~', '/', 'run code/now please', ' a.ts', '...', 'e.g.', 'v1.2']) {
      assert.equal(parsePathToken(text), undefined, text)
    }
  })

  it('从原文里取出像路径的行内代码', () => {
    const text = '放在 `a/b.ts` 里，用 `jq` 读，见 `` c/d.md ``。\n```\nx\n```'
    assert.deepEqual(inlineCodeTokens(text), ['a/b.ts', 'c/d.md'])
  })
})
