import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { pickPreferred } from '../../src/client/path-mention/menu.ts'
import { absoluteTarget, composerMention, lineSuffix, mentionLabel, mentionModelText, pastedPathText, relativePath } from '../../src/client/path-mention/menu.ts'
import { openCommand } from '../../src/host/path-mention/index.ts'
import { appOpenCommand, locateApp, MAC_CATALOG } from '../../src/host/path-mention/apps.ts'
import { openableApps } from '../../src/shared/path-mention/apps.ts'

const cwd = '/Users/me/ws'

describe('右键菜单的路径', () => {
  it('相对路径：工作区内去掉前缀，工作区外保持绝对，工作区本身是 .', () => {
    assert.equal(relativePath('/Users/me/ws/src/a.ts', cwd), 'src/a.ts')
    assert.equal(relativePath('/Users/me/ws', cwd + '/'), '.')
    assert.equal(relativePath('/Users/me/wsx/a.ts', cwd), '/Users/me/wsx/a.ts')
    assert.equal(relativePath('/tmp/a', undefined), '/tmp/a')
  })

  it('不在工作区但在家目录里的写成 ~/…', () => {
    const home = '/Users/me'
    assert.equal(relativePath('/Users/me/.agents/skills/shot-sheet', cwd, home), '~/.agents/skills/shot-sheet')
    assert.equal(relativePath('/Users/me', cwd, home), '~')
    assert.equal(relativePath('/Users/me/ws/src/a.ts', cwd, home), 'src/a.ts')
    assert.equal(relativePath('/Users/meow/a.ts', cwd, home), '/Users/meow/a.ts')
    assert.equal(relativePath('/tmp/a', cwd, home), '/tmp/a')
    assert.equal(relativePath('/Users/me/x', undefined, home), '~/x')
  })

  it('Markdown 链接地址补成绝对路径', () => {
    assert.deepEqual(absoluteTarget('dsh-path-mention/AGENTS.md', cwd), { path: '/Users/me/ws/dsh-path-mention/AGENTS.md', kind: 'file' })
    assert.deepEqual(absoluteTarget('./session-analysis/', cwd), { path: '/Users/me/ws/session-analysis', kind: 'directory' })
    assert.deepEqual(absoluteTarget('/tmp/a.md', undefined), { path: '/tmp/a.md', kind: 'file' })
    assert.equal(absoluteTarget('a.md', undefined), undefined)
  })
})

describe('拖进输入框的提及块', () => {
  it('和宿主从访达拖文件进来的写法一致', () => {
    assert.equal(composerMention({ path: '/Users/me/ws/src/a.ts', kind: 'file' }, cwd), '@src/a.ts')
    assert.equal(composerMention({ path: '/Users/me/ws/out', kind: 'directory' }, cwd), '@out/')
    assert.equal(composerMention({ path: '/Users/me/A B/c.md', kind: 'file' }, cwd), '@"/Users/me/A B/c.md"')
    assert.equal(composerMention({ path: '/Users/me/a"b', kind: 'file' }, cwd), undefined)
    assert.equal(mentionLabel({ path: '/Users/me/ws/out', kind: 'directory' }), 'out/')
    assert.equal(mentionLabel({ path: '/Users/me/ws/src/a.ts', kind: 'file' }), 'a.ts')
  })
})

describe('带行号的提及块', () => {
  const file = { path: '/Users/me/ws/dsh-path-mention/src/client/index.tsx', kind: 'file' as const }
  it('显示名带行号，发给模型时行号单独写', () => {
    assert.equal(mentionLabel({ ...file, line: 24, endLine: 27 }), 'index.tsx:24-27')
    assert.equal(mentionLabel({ ...file, line: 24 }), 'index.tsx:24')
    assert.equal(lineSuffix({ ...file, line: 24, endLine: 24 }), ':24')
    assert.equal(mentionModelText({ ...file, line: 24, endLine: 27 }, cwd), '@dsh-path-mention/src/client/index.tsx（第 24–27 行）')
    assert.equal(mentionModelText({ ...file, line: 5 }, cwd), '@dsh-path-mention/src/client/index.tsx（第 5 行）')
    assert.equal(mentionModelText(file, cwd), '@dsh-path-mention/src/client/index.tsx')
  })
  it('粘贴的文字只有一个路径才算', () => {
    assert.equal(pastedPathText('  dsh-path-mention/src/client/index.tsx:24-27\n'), 'dsh-path-mention/src/client/index.tsx:24-27')
    assert.equal(pastedPathText('`src/a.ts:3`'), 'src/a.ts:3')
    assert.equal(pastedPathText('@src/a.ts'), 'src/a.ts')
    assert.equal(pastedPathText('a.ts\nb.ts'), undefined)
    assert.equal(pastedPathText('   '), undefined)
  })
})

describe('菜单最上面的默认打开方式', () => {
  const apps = ['finder', 'zed', 'terminal']
  it('上次用过的优先，其次头栏记住的，再其次第一个编辑器', () => {
    assert.equal(pickPreferred(apps, 'terminal', 'zed', 'file'), 'terminal')
    assert.equal(pickPreferred(apps, undefined, 'terminal', 'file'), 'terminal')
    assert.equal(pickPreferred(apps, undefined, undefined, 'file'), 'zed')
    assert.equal(pickPreferred(apps, 'vscode', undefined, 'file'), 'zed')
  })
  it('文件不选访达，目录可以', () => {
    assert.equal(pickPreferred(apps, 'finder', undefined, 'file'), 'zed')
    assert.equal(pickPreferred(apps, 'finder', undefined, 'directory'), 'finder')
    assert.equal(pickPreferred(['finder'], undefined, undefined, 'file'), undefined)
    assert.equal(pickPreferred(['finder', 'terminal'], undefined, undefined, 'directory'), 'finder')
  })
})

describe('按头栏清单里的应用打开', () => {
  const installed = (id: string) => (id === 'zed' ? '/Applications/Zed.app' : id === 'terminal' ? '/System/Applications/Utilities/Terminal.app' : undefined)
  it('编辑器打开文件本身，终端打开文件所在目录', () => {
    assert.deepEqual(appOpenCommand('zed', '/w/src/a.ts', false, 'darwin', installed), ['open', ['-a', '/Applications/Zed.app', '/w/src/a.ts']])
    assert.deepEqual(appOpenCommand('terminal', '/w/src/a.ts', false, 'darwin', installed), ['open', ['-a', '/System/Applications/Utilities/Terminal.app', '/w/src']])
    assert.deepEqual(appOpenCommand('terminal', '/w/src', true, 'darwin', installed), ['open', ['-a', '/System/Applications/Utilities/Terminal.app', '/w/src']])
  })
  it('访达：目录进到目录里，文件显示位置', () => {
    assert.deepEqual(appOpenCommand('finder', '/w/src', true, 'darwin', installed), ['open', ['/w/src']])
    assert.deepEqual(appOpenCommand('finder', '/w/a.ts', false, 'darwin', installed), ['open', ['-R', '/w/a.ts']])
  })
  it('不在清单里、没装、不是 macOS 都拒绝', () => {
    assert.equal(appOpenCommand('quicktime', '/w/a.ts', false, 'darwin', installed), undefined)
    assert.equal(appOpenCommand('vscode', '/w/a.ts', false, 'darwin', installed), undefined)
    assert.equal(appOpenCommand('zed', '/w/a.ts', false, 'linux', installed), undefined)
    assert.equal(locateApp('../../bin/sh'), undefined)
  })
  it('清单里每个应用都有找法', () => {
    for (const app of MAC_CATALOG) assert.ok(app.system !== undefined || app.bundles.length > 0, app.id)
  })
  it('浏览器半显示的应用就是清单里的全部，不另抄一份', () => {
    const all = MAC_CATALOG.map((app) => app.id)
    assert.deepEqual(openableApps([...all, 'quicktime', 3, null]), all)
    assert.deepEqual(openableApps(undefined), [])
    assert.deepEqual(openableApps('zed'), [])
  })
})

describe('宿主打开命令', () => {
  it('macOS：目录用默认程序打开、文件在访达中显示', () => {
    assert.deepEqual(openCommand('open', '/d', true, 'darwin'), ['open', ['/d']])
    assert.equal(openCommand('open', '/f', false, 'darwin'), undefined)
    assert.deepEqual(openCommand('reveal', '/f', false, 'darwin'), ['open', ['-R', '/f']])
  })
  it('其他系统只支持打开目录', () => {
    assert.deepEqual(openCommand('open', '/d', true, 'linux'), ['xdg-open', ['/d']])
    assert.equal(openCommand('reveal', '/d', true, 'linux'), undefined)
  })
})