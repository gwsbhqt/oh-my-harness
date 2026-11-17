import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { publicFiles, documentLinks, documentAnchors, documentationIssues, privacyIssues, licenseIssues } from '../public-repository.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const files = await publicFiles(root)
const report = issues => issues.map(issue => typeof issue === 'string' ? issue : `${issue.file}:${issue.line}: ${issue.reason}${issue.target ? ` (${issue.target})` : ''}`).join('\n')

test('公开文档的本地链接、图片和标题存在于发布内容中', () => {
  const issues = documentationIssues(files)
  assert.equal(issues.length, 0, report(issues))
})

test('独立插件和 Python 包保留 MIT 许可证及发布声明', () => {
  const issues = licenseIssues(files)
  assert.equal(issues.length, 0, report(issues))
})

test('公开文本不包含私钥、常见凭据或私有网段字面值', () => {
  const issues = privacyIssues(files)
  assert.equal(issues.length, 0, report(issues))
})

test('链接检查覆盖 Markdown 图片、HTML 属性和引用式链接，跳过代码示例', () => {
  const source = [
    '[guide](guide.md#start)',
    '![flow](<assets/flow chart.svg>)',
    '<img src="assets/missing.svg"><a href=missing.md>missing</a>',
    '[![linked image](assets/flow%20chart.svg)](guide.md#start)',
    '[reference][details]',
    '[details]: guide.md#missing "title"',
    '`[example](not-a-link.md)`',
    '```md', '[sample](not-a-link.md)', '```',
    '    [indented sample](not-a-link.md)',
    '<!-- [draft](not-a-link.md) -->',
  ].join('\n')
  const fixture = new Map([
    ['README.md', source], ['guide.md', '# Start'], ['assets/flow chart.svg', '<svg/>'],
  ])
  assert.equal(documentLinks(source).length, 7)
  assert.deepEqual(documentationIssues(fixture).map(({ target }) => target).sort(), ['assets/missing.svg', 'guide.md#missing', 'missing.md'])
  assert.deepEqual(documentationIssues(fixture).map(({ line }) => line).sort(), [3, 3, 6])
})

test('当前标题生成锚点，支持中文、行内代码、重复标题及显式锚点', () => {
  const source = '# Hello, `world`!\n## 中文标题\n## Hello, world!\nSetext\n------\n<a id="named"></a>\n`<a id="sample"></a>`\n```md\n# hidden\n```'
  assert.deepEqual([...documentAnchors(source)], ['hello-world', '中文标题', 'hello-world-1', 'setext', 'named'])
  const fixture = new Map([
    ['README.md', '[one](guide.md#hello-world-1) [two](guide.md#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98) [three](guide.md#named)'],
    ['guide.md', source],
  ])
  assert.deepEqual(documentationIssues(fixture), [])
  fixture.set('guide.md', '# Renamed')
  assert.equal(documentationIssues(fixture).length, 3)
})

test('文件名支持括号和编码，外部链接无需联网，本地越界和未发布内容报错', () => {
  const fixture = new Map([
    ['docs/guide.md', [
      '[balanced](../assets/flow(v2).svg)',
      '<img src="../assets/flow%20chart.svg">',
      '[root](/README.md)',
      '[directory](../assets/)',
      '[external](https://example.com/missing#heading)',
      '[outside](../../missing.md)',
      '[local](file:///tmp/example.md)',
      '[ignored](../node_modules/example/README.md)',
      '[bad](bad%encoding.md)',
    ].join('\n')],
    ['README.md', '# Readme'], ['assets/flow(v2).svg', '<svg/>'], ['assets/flow chart.svg', '<svg/>'],
    ['tests/fixtures/app.html', '<a href="/dynamic-route">fixture</a>'],
  ])
  assert.deepEqual(documentationIssues(fixture).map(({ line }) => line), [6, 7, 8, 9])
})

test('HTML 文档中缩进和跨行的图片与链接也检查发布目标', () => {
  const fixture = new Map([
    ['docs/page.html', '<main>\n    <img\n      src="missing.svg">\n    <a href="../README.md">readme</a>\n</main>'],
    ['README.md', '# Readme'],
  ])
  assert.deepEqual(documentationIssues(fixture).map(({ target, line }) => ({ target, line })), [{ target: 'missing.svg', line: 3 }])
})

test('响应式图片逐一检查 source 与 img 的 srcset，不漏手机图或高分辨率候选', () => {
  const fixture = new Map([
    ['README.md', [
      '<picture>',
      '  <source media="(max-width: 600px)" srcset="assets/mobile.svg">',
      '  <img src="assets/desktop.svg" srcset="assets/desktop.svg 1x, assets/retina.svg 2x">',
      '</picture>',
      '<img srcset="data:image/svg+xml,%3Csvg/%3E 1x, assets/desktop.svg 2x">',
    ].join('\n')],
    ['assets/desktop.svg', '<svg/>'],
  ])
  assert.deepEqual(documentationIssues(fixture).map(({ target, line }) => ({ target, line })), [
    { target: 'assets/mobile.svg', line: 2 }, { target: 'assets/retina.svg', line: 3 },
  ])
  fixture.set('assets/mobile.svg', '<svg/>')
  fixture.set('assets/retina.svg', '<svg/>')
  assert.deepEqual(documentationIssues(fixture), [])
})

test('通用隐私检查拒绝危险形状，保留公共测试地址且诊断不回显值', () => {
  const secrets = ['-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'ghp_' + 'A'.repeat(36), ['10', '12', '34', '56'].join('.'), ['100', '64', '0', '1'].join('.')]
  const fixture = new Map([
    ['fixture.txt', secrets.join('\n')],
    ['reserved.txt', '127.0.0.1 192.0.2.1 198.51.100.1 203.0.113.1 example.com host.invalid'],
    ['binary.png', null],
  ])
  const issues = privacyIssues(fixture)
  assert.equal(issues.length, secrets.length)
  assert.deepEqual(issues.map(({ line }) => line), [1, 2, 3, 4])
  for (const secret of secrets) assert.ok(!report(issues).includes(secret))
})

test('删除许可证或漏掉发布声明时失败', () => {
  const license = files.get('LICENSE')
  const fixture = new Map([
    ['LICENSE', license],
    ['dsh-fixture/package.json', JSON.stringify({ license: 'MIT' })],
    ['dsh-fixture/LICENSE', license + '\n'],
    ['skills/fixture/pyproject.toml', 'license = "MIT"\nlicense-files = ["LICENSE"]'],
    ['skills/fixture/LICENSE', license],
  ])
  assert.deepEqual(licenseIssues(fixture), [])
  fixture.delete('dsh-fixture/LICENSE')
  fixture.set('skills/fixture/pyproject.toml', 'name = "fixture"')
  assert.equal(licenseIssues(fixture).length, 2)
})

test('干净目录无依赖可检查，包含隐藏文件，忽略未发布产物并拒绝外部软链', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'public-check-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', directory])
  await fs.writeFile(path.join(directory, '.gitignore'), 'ignored/\n')
  await fs.writeFile(path.join(directory, 'README.md'), '![missing](ignored/asset.svg)')
  await fs.writeFile(path.join(directory, '.fixture'), 'hidden')
  await fs.mkdir(path.join(directory, 'ignored'))
  await fs.writeFile(path.join(directory, 'ignored/asset.svg'), '<svg/>')
  const found = await publicFiles(directory)
  assert.ok(found.has('.fixture'))
  assert.ok(!found.has('ignored/asset.svg'))
  assert.equal(documentationIssues(found).length, 1)
  await fs.symlink('../outside', path.join(directory, 'escape'))
  await assert.rejects(publicFiles(directory), /symlink target is outside the published files/)
})
