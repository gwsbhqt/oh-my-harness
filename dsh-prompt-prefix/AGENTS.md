# dsh-prompt-prefix

把每个会话都不变的三样注入挪到系统提示词末尾：工作规范（AGENTS.md 基线）、技能目录、OpenViking 记忆画像。原来它们接在用户第一句话后面，第一句每次不同，新会话首次请求就得把它们全部重算。

## 怎么做的

- 第一步：在 `agent/pre-step`（`prepend`，排在官方插件外层）里截下官方插件这一步生成的三条消息，原文固定到本会话，同一步追加进 `system-prompt/assemble` 刚产出的段落数组（宿主把同一个数组交给渲染，见 dsh-agent-loop `preStep`/`step`）。
- 之后每步：`system-prompt/assemble` 里追加固定内容；`agent/pre-step` 里去重：与固定原文相同的工作规范基线换成一句指针，相同的技能目录丢掉，记忆画像丢掉，借别的路径重复注入全局 AGENTS.md 的消息丢掉。工作规范变化照常放行；技能目录变化时，同步替换系统提示词里的旧目录并持久化，让宿主更新消息照常进入会话历史。目录变化会使系统提示词缓存重新计算。
- 记忆画像里的 `<available-memories>` 路径清单不固定：它随记忆增长频繁变化，会让这段跨会话缓存失效，模型要找记忆用 OpenViking 搜索工具。
- 记忆插件排在外层时，画像由本插件用 `openvikingMemory.profileMessage(agent, {consume: true})` 取，它就不再自己发。子代理不取（与 `skipSubagentSessions` 一致）。
- 固定内容按会话存 `$DSH_HOME/plugins/prompt-prefix/sessions/<会话编号哈希>.json`。恢复会话时用宿主的会话观察接口核对可见历史中的最新技能目录；查询失败时暂不注入旧目录并在下步重试。每次读取都刷新文件修改时间，启动时只清 30 天没被任何会话读过的。
- 分叉会话：宿主不给分叉会话重发工作规范，它继承的历史里只有那句指针。指针里带着上级固定内容的文件名，分叉会话第一步在继承段里找到它，就整份沿用上级的固定内容，系统提示词和上级一致，也能接上上级的缓存。

## 改动时注意

- 依赖宿主内部细节：工作规范消息 `source.baseline`、技能目录 `source.kind === 'skill-catalog'`、记忆画像 `source.kind` 为 `plugin:openviking-memory` 且 `form === 'instructions'`、会话的 `snapshotEvents` 与 `inheritedEventCount`（读分叉继承段）、`profileMessage` 的 `consume` 参数（所用记忆插件必须支持该参数）。主动取画像最多等 2 秒，记忆服务连不上时不再叠加一次健康检查超时。DSH 或记忆插件升级后先核对这几处；认不出就原样放行，不会丢内容。
- 工作规范基线换成指针时，原消息记在 `globalThis[Symbol.for('dsh-prompt-prefix.originals')]` 这张以指针消息为键的 WeakMap 里，dsh-message-tidy 靠它和指针里的 `pin=` 标记接上「指令只发差异」；改指针格式或这张表要同步改那边。不能把原消息挂在指针消息上：宿主记录消息时只收纯 JSON，多一个符号键或不可枚举键整轮报 `non-JSON-serializable`。
- 固定段放在系统提示词最后，按稳定程度排：工作规范 → 技能目录 → 记忆画像。不要往这里放时间、目录、召回这类每步会变的东西：系统提示词中途变化可能使依赖稳定前缀的缓存失效，具体行为由模型服务决定。
- 跨会话命中的前提：同一模型（系统提示词开头有模型名）、同一工作区、三样内容没变。
- `pnpm run check` = 类型检查 + 构建 + 测试（真实 cordis 瀑布事件）。
