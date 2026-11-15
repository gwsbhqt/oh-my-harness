# dsh-session-tidy

给工作区加一个「整理本工作区」入口：工作区行「…」菜单里一项（排最后），点一下把**该工作区**里没用的一次性/测试会话批量归档。

## 行为

- 唯一入口：工作区「…」菜单，`ctx.contextMenus` 结构化菜单 `target: 'workspace'`，order 250，排在“删除工作区”上面。会话「…」菜单不再注册（用户要求只放工作区菜单；要恢复会话入口再加一条 `target: 'session'` 即可）。
- 点击 → 直接把 `dryRun:false` 发到 `/api/session-tidy.tidy`，**后台静默执行**（不弹全屏遮罩/确认框，不挡界面）→ 完成后用应用内置的**顶部横幅 Toast**（`@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`，body portal、顶部居中、与产品其它提示同款）报「已归档 N 个」（或“没有需要归档的”），失败也用同款 Toast（停留 5s）。归档可恢复。
- 判定在宿主半（`runTidy`），交给外部模型 **Jev**（`/systemone` 的“是非概率”调用，请求体 `{model,state,questions}` → `answers.<名>.noul`，与 dsh-composer 协议一致）：每条候选会话带上**标题、创建时间、多久没用、第一段用户消息（截 300 字）**，问“是不是一次性的测试/临时/调试会话”，概率 ≥ `JUNK_THRESHOLD=0.58` 就归档；另有两问做补强——明显是“一次性测试/验收”（`testlike≥0.9`）且不像仍在进行的工作（`ongoing<0.5`）时，junk 分数在 0.35 以上也收，用来兜住模型分数的波动。只处理非 live（不在内存、没打开着/没在跑，含当前会话）、非子代理、非置顶、非已归档的会话。
- 为什么必须带第一段消息：只给标题时“长工”“…合并验收（主控）”这类正在推进的会话会被误判；带上第一段用户消息后能干净分开。
- Jev 没配 key 时退回旧规则口径（标题模板 + 超过 `MAX_IDLE_DAYS=3` 天没有用户消息）；单条调用失败或超时则该条保留，不因失败归档。
- 归档走宿主 `workspaceRegistry.archiveSession`，可撤销；不删除、不中断任何运行中的会话。
- 同一操作也暴露成 agent 工具 `tidy_workspace_sessions`，参数 `session`（目标工作区里任一会话编号）。

## 配置

三项都 volatile，路由和工具每次现读（设置页改完不重启）。默认指向通用 Typesafe 网关；用别的网关时在 profile 只带 id 的覆盖行里改这三项。

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyRef` | `TYPESAFE_API_KEY` | 取 key 的凭据引用名，不能填钥匙本身；按引用交 credentials（取不到再退回环境变量） |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Jev 的**完整请求端点**（含 `/systemone`） |
| `model` | `jev-latest` | 模型名 |

阈值 `JUNK_THRESHOLD=0.58`、第一段消息截断 `MAX_FIRST_CHARS=300`、并发 `JEV_CONCURRENCY=6`、单条超时 15s 写在 `src/index.ts`。条目 id 与包名同名 `session-tidy` / `dsh-session-tidy`，补丁层只插一条 `id: session-tidy`。禁用：profile 补丁写 `- id: session-tidy` + `disabled: true`。

## 依赖与降级

- 只依赖宿主的 `workspaceRegistry`、`sessionQuery`、`ctx.contextMenus`、`credentials.resolve`，没有外部服务依赖就能加载。
- 取不到 key 或模型调用失败/超时：该条保留；全部取不到 key 时退回纯规则兜底，绝不因模型失败误归档。

## 验证

- `pnpm run check`（typecheck + build + test）。`test/rules.test.ts` 钉住兜底标题规则；`test/jev.test.ts` 钉住 Jev 响应解析与 gzip 解压；`test/config.test.ts` 钉住三项配置默认值与 volatile 现读、无 key 走纯规则；有 key 但连接失败时该条保留（判 Jev、请求失败、不归档）；并用回环 HTTP fixture 实发 HttpJev 请求，断言端点/Authorization/model/body，且同一 volatile 单元格先请求一次、按写机制热改后重放，覆盖注册的 route 与 tool 两条调用路径。
- 真实界面：工作区「…」菜单出现「整理本工作区」（会话菜单不出现）；点它后台静默执行、不出现全屏遮罩，完成后顶部居中横幅 Toast 报「已归档 N 个」；被归档的会话进存档、可在存档里恢复；运行中/置顶/当前/已归档会话不动。

## 升级注意

- 宿主 `workspaceRegistry.list()/archiveSession`、`sessionQuery.readTitleSnapshots/listSessions/readSession`、`ctx.contextMenus`、`credentials.resolve` 是内部接口；DSH 升级后重跑 check 并实际点一遍。
- Jev 的 `{model,state,questions}` → `answers.<名>.noul` 协议与 dsh-composer 一致；网关地址、模型、钥匙引用都在本包配置里，换网关改配置，不用改代码。
