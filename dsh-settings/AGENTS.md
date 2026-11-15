# dsh-settings（设置包：模式偏好 + 技能 + 快捷回复）

一个公开插件、一条 loader 条目 `settings-prefs`、一个设置命名空间 `settings-prefs`，在设置侧栏承载三页：

- **模式偏好**（`src/presets/`）：按工作区给新会话选默认模式。新会话走会话控制器内部的
  `agents.createSession(request)`，没指定模式时按 `request.cwd` 所在项目补上偏好。设置侧栏 section `preset-prefs`（order 11.5）。
- **技能**（`src/skills/`）：按全局和每个项目调整每个技能给模型看多少（开 / 只给名字 / 只许手动调 / 关），
  普通技能和 Python 技能分开管。设置侧栏 section `skill-exposure`（order 12）。另给 python-repl 提供
  `skillExposure.disabledPySkills` 只读服务。
- **快捷回复**（`src/quick-reply/`）：输入框工具行的「快捷回复」按钮（`conversation.input.right`，order 5）
  和设置侧栏一页（section `quick-reply`，order 12）。预设和点击动作存在共用偏好文件里。

三页放在同一个设置条目下；客户端插件不能跨插件共用代码，同一个包里才能共享页头等公用件。

## 共用页头

`src/client/shared/PageHeader.tsx` 是三页共用的「草稿 / 撤销 / 保存」页头，三页的页面组件都直接使用它。
各页只把已翻译好的文案传进来，页面之间不互相依赖。

三页走同一套编辑流程：改动先进草稿（页头显示「N 项未保存」）、「撤销」回到上次保存的状态、
「保存」一次写回文件；保存出错保留草稿并按错误原因禁用保存，保存成功后按接口返回内容刷新一致。
技能页与另外两页一致，也是一次完整提交（见「宿主半」的 `saveSkills`）。

## 宿主半

一个 loader 条目 `settings-prefs`，挂载三块：

| 模块 | 文件 | 接口（都在共享 `/api` 通道，`/api/settings.<endpoint>`） |
|---|---|---|
| 模式偏好 | `src/presets/` | `presetsOverview`、`presetsSave` |
| 技能 | `src/skills/` | `skillsOverview`、`skillsSave` |
| 快捷回复 | `src/quick-reply/` | `quickRepliesOverview`、`quickRepliesSave` |

端点名带模块前缀避免同名冲突；信封统一走 `src/routes.ts` 的 `route()`（和宿主 `/api` client-request 一致，
错误码统一加前缀 `settings/`），不保留任何旧路由别名。

技能保存是**一次完整提交**：`saveSkills` 把这一批 skills / pySkills 改动交给 `DocumentStore.update`，
在同一个串行读改写里逐条 `setLevel` 后一次性落盘；中途任一条非法就整批不写，其他项目的规则原样保留。

`Config` 只有快捷回复一个开关：

```yaml
- id: settings-prefs
  config:
    quickReply: false
```

| 键 | 默认 | 说明 |
|---|---|---|
| `quickReply` | `true` | 快捷回复开关；关掉时输入框按钮和设置侧栏「快捷回复」页都不出现，改回来即时出现，不用重启 |

字段标了 `volatile()`：设置页改完由 loader 原地写回，不能为某个模块重新解析一次，否则改设置不生效。

## 浏览器半

一个产物 `lib/client.js`（`dsh.client` 声明 `platform: web`）。`inject` 是
`['slots', 'locale', 'configForms', 'sessions', 'connection']`，三块各自注册字典和设置侧栏 section，
快捷回复另注册输入框工具行按钮。需求是 `configForms`（开关在 `settings-prefs` 命名空间里读）、`sessions`
（发消息、会话作用域）、`connection`（拉接口）。

- 三页 section：`preset-prefs`(11.5)、`skill-exposure`(12)、`quick-reply`(12)；文案命名空间分别
  `presets`、`skill-exposure`、`quick-reply`，各自独立、互不干扰。
- 快捷回复按钮只在「宿主半已服务」（`configForms` 的 `settings-prefs` 命名空间被服务）且 `quickReply !== false` 时显示；
  「编辑快捷回复…」跳到本包 `quick-reply` 页（`open-settings.ts` 借用设置外壳的共享状态句柄，测试守着它的形状）；按钮几何对照宿主工具行触发按钮。

## 存储位置与格式

- 模式偏好：`preferences.json` 的 `presetPreferences` 段；全局默认仍是宿主的 `agent-preset-registry.selectedDefault`。
- 快捷回复：`preferences.json` 的 `quickReplies` 段（`{ presets: string[], action: 'send' | 'insert' }`）。
  文件缺失时默认 `{ presets: ['继续'], action: 'send' }`；不改动已有用户的已存预设。
- 技能：`~/.agents/skill-exposure.json`（dotfiles 跟踪）。

三块各自的 store 都沿用统一读写规则：按修改时间缓存、原子写、顺着符号链接写真实文件、保留未知顶层段、
只改自己那一段。`src/presets/store.ts` 与 `src/skills/store.ts` 是同一套规则，`src/quick-reply/quick-replies-file.ts`
复用 `tooling/runtime/preferences.mjs` 的偏好文件读写。

## 客户端半边必须满足的形状（别改坏）

前端启动给每个声明 `dsh.client` 的包建一条 loader 条目，全部加载完后 `assertEntriesActive()` 发现一条没激活就
抛 `web boot: N entries did not activate`，整页停在 "Failed to load plugins"。所以：

- 客户端产物必须导出 cordis 插件形状（`apply`，和可选 `name` / `inject`）。只做副作用、`return {}` 会让整个 GUI 起不来。
- 监听器和注册都在 `apply(ctx)` 里装、用 `ctx.effect` 卸。
- 产物只许 require 平台模块表里的包；`tsdown.config.mjs` 的 purityGate 在构建时拦下跨插件值导入。
  本包不依赖任何私人服务、目录或插件，purityGate 不得绕过。
- `package.json` 三处要和客户端半边同在：`dsh.client`、`exports["./client"]`、`files`。
  `test/settings-shape.test.ts` 补这个洞（宿主没有启动前检查这道门）。

## 依赖的宿主易变方法（升级要核对）

- DSH 内部的 `createSession(request)`（模式偏好补偏好）和技能注册表的 `list` / `snapshot` / `get` 都可能随升级变更。
  保留可卸载的方法包装，装卸两轮测试在 `test/presets.test.ts`、`test/exposure.test.ts`；升级后先跑 `pnpm run check`。
- `open-settings.ts` 借用了宿主设置外壳「共享状态句柄 + `openSection(id)`」这个没公开的形状，
  `test/open-settings.test.ts` 对着开发依赖和本机 App 自带的设置外壳各核对一次，宿主改了会先在这里报。

## 测试

全部在 Node 里跑真实源码，不靠浏览器、不出网：

- `test/presets.test.ts`：模式偏好的规则、选模式、按宿主方式装卸两轮、接口信封。
- `test/exposure.test.ts`：技能分档改写、过滤、规则文件、装卸两轮、接口信封。
- `test/skills-save-batch.test.ts`：技能批量保存边界（全批有效、中途无效不写盘、保留其他项目、并发不丢）。
- `test/quick-replies-file.test.ts`：快捷回复文件默认值与校验、原子写、顺链接写。
- `test/quick-reply-presets.test.ts`：预设增删改、判重。
- `test/open-settings.test.ts`：打开设置页的取舍；开发依赖和 App 的设置外壳形状。
- `test/settings-shape.test.ts`：宿主/客户端形状 + `package.json` 三处声明。

```bash
pnpm install
pnpm run check   # typecheck + build（宿主 + 客户端两个产物，生成构建清单）+ test
```

改动后先跑它，再走受控重启；宿主半（loader 条目）和客户端半都要重启才生效。

## 安装

profile 的 `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-settings`。本包自带的补丁层插入唯一一条
`id: settings-prefs`（`cordis.patch.yml`），不要在 profile 手写第二条 insert；要改配置写只带 id 的覆盖行（不带 `name`）。
