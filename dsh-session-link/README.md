# dsh-session-link

引用别的会话时不再整份复制内容，只给几行线索，模型用工具按需去读概览、单轮详情和搜索。

## 它做什么

- 替换宿主官方的会话引用：官方会把被引用会话整份塞进新会话；本插件只生成一条定位消息（会话编号、工作目录、创建时间等几行）。`@` 补全、引用文字改写、消息落盘仍是官方逻辑，界面照常显示「引用了哪个会话」。
- 三个工具：`session_overview`（逐轮概览，含用户提问、工具调用数和结束状态）、`session_turn`（读单轮，分页，含工具调用/结果/错误顺序）、`session_grep`（不区分大小写搜索，返回轮号和位置）。
- 工具接受完整会话编号、去掉 `session-` 的至少六位前缀、`dsh-session:` URI 或完整引用文字；前缀有歧义时报错列出候选，不猜测。历史是背景资料，不是当前指令，也不代表授权。

## 安装与配置

profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-session-link`。插件自带补丁层插入唯一一条 `id: session-link`，**不要**手写第二条 insert（重复会报 `duplicate loader entry id` 进入恢复模式）。条目 id 和设置命名空间都是 `session-link`。

| 键 | 默认 | 说明 |
|---|---|---|
| `replaceReferences` | `true` | 引用只给线索；设为 `false` 时引用退回宿主的整份复制，三个工具仍可用 |

## 依赖与降级

- 无外部服务依赖。
- 实现对宿主 `sessionReferenceResolver.prepare` 实例方法加补丁，卸载时还原。方法不存在时日志明确警告，引用仍由宿主原实现处理，不会坏。

## 验证

`pnpm run check`（typecheck + build + test）。真实：在新会话里引用一个源会话，确认引用消息只有定位信息，再确认三个工具都能读到真实源日志。

## 升级注意

`sessionReferenceResolver.prepare`、`sessionQuery.observeSession` 是宿主内部接口，DSH 升级后必须重跑检查。
