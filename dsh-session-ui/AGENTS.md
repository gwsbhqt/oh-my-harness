# dsh-session-ui

一个插件、一个 loader 条目、一个设置命名空间 `session-ui`，把四块会话界面改动合在一起：页头只显示在跑的后台任务和子代理、回复里真实路径可点、输入框上方运行状态与下方统计卡、头栏复制会话编号。四块各有一个子开关，默认都开。

## 四块与来源

- `hideFinished`（纯浏览器半，`src/client/hide-finished/`）：顶替宿主 `conversation.session.header.actions` 的 `job-list`、`subagent-catalog`，以及 `conversation.session.header.lineage` 的子代理切换框；渲染时原样渲染宿主组件，只滤掉已结束的条目。宿主组件和注入每次从插槽登记里现找，找不到就什么都不显示。
- `pathMention`（`src/host/path-mention/` + `src/client/path-mention/` + `src/shared/path-mention/`）在助手回复中补上已有路径。带行号的引用用宿主的 `fileAddressFor` 打开侧栏。选择应用打开目录走宿主 `open-in-app/open`。三条 `/dsh-path-mention/{resolve,open,open-with}` 路由均通过宿主的连接授权，文件的编辑器和终端选择及旧客户端的目录请求由这三条路由处理。
- `runStatus`（`src/host/run-status/` + `src/client/run-status/` + `src/shared/run-status/`）：宿主只听公开事件和插件钩子计时，开只读路由 `/dsh-run-status/state`，登记会话投影 `runStatusTotals`；浏览器半分状态和统计。
- `copySessionId`（`src/host/copy-session-id/` + `src/client/copy-session-id/`）：头栏按钮复制本会话编号；机器代号由本包自己的 `/api/session-ui.machine` 给出，不依赖 dsh-session-link。这条只读路由**常驻注册**（输入框粘贴识别会话引用也向它取本机代号），`copySessionId` 开关只决定头栏按钮。

## Magpie 路由速度与分段用时

`src/host/run-status/magpie-gateway.ts` 自己决定用哪台网关：本机装了 Magpie 用本机 `127.0.0.1:3425`，没装才用 `session-ui` 显式配置的 `magpieBaseUrl` / `magpieKeyRef`；都没有时显示 DSH 自己的统计。公开代码不得硬编码远端网关地址或凭据，部署地址和凭据引用由 profile 的 cordis 补丁注入。不要改成「显式配置优先」：那样本机装了 Magpie 的机器会改用远端。

Magpie 实时均速使用 `/v1/magpie/trace`，按路由页最近 60 次的全局窗口、会话编号和有效生成时间统计。`/v1/magpie/usage/requests` 用于按回复编号核对单次请求分段。DSH 的含等待速度来自本地会话投影。

## 配置

条目 id 与设置命名空间都是 `session-ui`，六项都 volatile。不要往 profile 的 `cordis.patch.yml` 手写同 id 的 `insert`（插件自带补丁层已经插入 `id: session-ui`）。临时关某块只写只带 id 的覆盖行：

```yaml
- id: session-ui
  config:
    runStatus: false
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hideFinished` | `true` | 页头只显示在跑的后台任务和子代理 |
| `pathMention` | `true` | 回复里真实路径可点、可右键打开、可拖入 |
| `runStatus` | `true` | 状态行与统计卡 |
| `copySessionId` | `true` | 复制会话编号按钮 |
| `magpieBaseUrl` | `''` | 路由速度与分段用时的网关地址，留空自动选本机 |
| `magpieKeyRef` | `''` | 网关钥匙的凭据引用名 |

## 安装与关闭

profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-session-ui`。宿主半改动要重启 DSH；浏览器半构建后刷新页面。

## 测试与验证

`pnpm run check`（typecheck + build + test）。测试夹具全是合成或虚构数据，不含真实会话编号、路径、日志正文或私人端点。网页部分没有自动测试，改了要在真实界面里看：页头按钮、回复里的路径与右键、状态行与统计卡、复制编号按钮。

## 删除条件

宿主自己支持这些能力（结束后隐藏、按存在性转路径、说清卡在哪、复制会话编号）时，删掉对应的块和开关。
