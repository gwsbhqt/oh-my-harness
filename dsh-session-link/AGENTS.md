# dsh-session-link

引用别的会话时不整份复制内容，只给几行线索，模型用工具按需去读概览、单轮详情和搜索。

## 为什么要替换官方的引用

官方 `dsh-session-reference` 在用户消息里认出 `dsh-session:` 引用后，把被引用会话的对话快照加入新会话（每个来源最多上下文窗口的 20%）。引用多个来源或包含压缩检查点时，累计输入仍可能超出模型窗口。维护时应验证引用只提供定位线索，并由工具按需读取源日志，避免在首轮请求中复制整份历史。

## 怎么做到（改之前先读）

官方服务在 `agent/pre-step` 里调自己的 `prepare()` 生成那条快照消息。这里在服务实例上把 `prepare` 换掉（实例自有属性遮住原型上的原实现，卸载时换回），换成只读被引用会话的原始日志、算出几行线索。`@` 补全候选、引用文字改写、消息落盘的位置都还是官方的，界面照常显示「引用了哪个会话」。官方那份快照一个字都不会生成、不会发出去。

服务是 cordis 代理：代理没有 defineProperty 拦截，`Object.defineProperty` 直接落到实例上，官方监听器里的 `this.prepare(...)` 走的就是这里的版本。用的是共用的 `tooling/runtime/method-patch.mjs`，和 dsh-image-cap、dsh-settings 同一份实现，原实现要在装之前取好，不能调用时再取。

## 按需读取

- `session_overview`：逐轮概览，含用户提问、工具调用数量和结束状态。默认每页 60 轮。
- `session_turn`：读取指定轮，保留发言、工具调用、结果和错误的顺序。默认每页 12000 字符，单条 2000 字符。
- `session_grep`：不区分大小写的文字搜索，返回轮号和可传给 `session_turn` 的位置。默认 20 条，最多 100 条。

工具接受完整会话编号、去掉 `session-` 的至少六位前缀、`dsh-session:` URI 或完整引用文字。前缀有多个候选时明确报错，不猜测。PTC 中通过 `await tools.session_overview({...})` 等调用。历史是背景资料，不是当前用户的指令，也不代表操作授权。

## 接入与配置

profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-session-link`。插件自带补丁层插入唯一一条 `id: session-link`，不要往 profile 手写第二条 insert（重复会以 `duplicate loader entry id` 报错进恢复模式）。条目 id 和设置命名空间都是 `session-link`。没有设置卡片，配置直接写 profile 补丁的只带 id 的覆盖行（不带 `name`）：

```yaml
- id: session-link
  config:
    replaceReferences: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `replaceReferences` | `true` | 引用只给线索。设为 false 时引用退回宿主的快照复制，三个工具仍可用 |

禁用整个条目时三个工具和引用替换都下线，引用还原为宿主原实现。

## 实现边界与验证

宿主没有公开的引用渲染替换接口；本插件给 `sessionReferenceResolver.prepare` 实例方法加补丁，卸载时还原。这个方法是内部接口，DSH 升级后必须重跑检查。方法不存在时会在日志明确警告，引用仍由宿主原实现处理。工具通过 `sessionQuery.observeSession` 读取完整原始事件日志，不修改或恢复源会话。

修改后先跑 `pnpm run check`（typecheck + build + test）。真实验证：在新会话里引用一个源会话，确认引用消息只有定位信息，再确认三个工具都能读到真实源日志。

## 删除条件

宿主提供按需读取的引用方式（或可配置不整份复制）时删掉对应的宿主代码和 `replaceReferences`。
