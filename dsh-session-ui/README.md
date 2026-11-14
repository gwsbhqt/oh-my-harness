# dsh-session-ui

DSH 会话界面的四件小改动，合成一个插件、一个 loader 条目、一个设置命名空间 `session-ui`，四个子开关可单独关掉。

| 子开关 | 作用 |
| --- | --- |
| `hideFinished` | 会话头栏「后台任务」「子代理」只显示还在跑的；都跑完了按钮整个消失（团队任务板有内容时保留入口）。 |
| `pathMention` | 助手回复里用反引号写、且本机真实存在的路径渲染成可点的提及：左键文件在侧栏预览、目录在系统打开；右键用应用打开；可拖进输入框。 |
| `runStatus` | 输入框上方一行说清「深度求索中」这会儿卡在哪一步、这一段多久；输入框下方统计卡顶替宿主自带那张，给出更准的会话统计。走 magpie 的请求还能看分段用时。 |
| `copySessionId` | 会话头栏一个「复制会话编号」按钮，复制本会话裸编号；网页端加 `#机器名`。贴进输入框时由 dsh-composer 换成引用小块。 |

四块默认都开。关掉某一块时对应的槽位注册、宿主路由和事件监听都不挂。

## 安装

profile 的 `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-session-ui`。
不要往 profile 的 `cordis.patch.yml` 手写同 id 的 `insert`（插件自带补丁层已经插入 `id: session-ui`，重复会报 `duplicate loader entry id`）。
临时关某一块只写只带 id 的覆盖行（不带 `name`）：

```yaml
- id: session-ui
  config:
    runStatus: false
```

## 配置

条目 id 与设置命名空间都是 `session-ui`。六项都是 volatile，改后作用于后续操作，无需重挂：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hideFinished` | `true` | 页头只显示还在跑的后台任务和子代理 |
| `pathMention` | `true` | 回复里真实路径可点、可右键打开、可拖入 |
| `runStatus` | `true` | 输入框上方运行状态行与下方统计卡 |
| `copySessionId` | `true` | 头栏复制会话编号按钮 |
| `magpieBaseUrl` | `''` | 分段用时用的 magpie 网关地址。留空时本机装了 Magpie 自动用 `127.0.0.1:3425`，没装就不显示分段用时区 |
| `magpieKeyRef` | `''` | 网关钥匙的凭据引用名，不填钥匙本身 |

网关选择规则：本机装了 Magpie（PATH 上有 `magpie`）就用本机地址和本机钥匙；没装才用显式配置的远程地址和引用名；都没有就不读分段用时，其余状态和统计照常显示。公开代码里不写死任何网关地址或钥匙，都由配置注入。

## 工作原理

- `hideFinished`（纯浏览器半，`src/client/hide-finished/`）：用同 id、更小 priority 顶替宿主注册在 `conversation.session.header.actions` 的 `job-list`、`subagent-catalog`，以及 `conversation.session.header.lineage` 的子代理切换框，渲染时原样渲染宿主组件，只把「已结束」的条目滤掉。
- `pathMention`（宿主路由 + 浏览器半）：宿主半开 `/dsh-path-mention/resolve`、`/open`、`/open-with` 三条同源路由，只认真实存在的绝对路径和固定动作；浏览器半在助手回复组件外包一层，把宿主已经能转的路径之外、本机真实存在的补上。
- `runStatus`（宿主 + 浏览器半）：宿主半只听公开事件（`session/event`、`agent/status`、`session/disposed`、`agent/assistant-stream`）和插件钩子计时，记每个会话卡在哪一步，开只读路由 `/dsh-run-status/state`，并登记会话投影 `runStatusTotals`；浏览器半分「等模型/思考/输出」等状态和统计卡。
- `copySessionId`（从 dsh-session-link 拆出的按钮）：浏览器半在头栏 `conversation.session.header.utilities` 注册 id `copy-session-id` 的小方按钮；机器代号由本包自己的宿主路由 `/api/session-ui.machine` 给出（`scutil --get LocalHostName`，拿不到退回 `os.hostname()`），不依赖别的插件。

## 开发

```sh
pnpm install
pnpm run check   # typecheck + build（宿主和浏览器两个产物）+ test
```

测试夹具都是合成或虚构数据，不含真实会话编号、路径、日志正文或私人端点。

## 许可证

MIT
