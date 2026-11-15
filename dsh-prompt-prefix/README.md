# dsh-prompt-prefix

把每个会话都不变的三样注入（工作规范、技能目录、记忆画像）固定到系统提示词末尾，便于复用缓存；是否命中取决于模型服务与是否相同前缀。

## 它做什么

- 在 `agent/pre-step`（`prepend`，排在官方插件外层）截下官方这一步生成的三条消息，原文固定到本会话，同一步追加进 `system-prompt/assemble` 的段落数组；之后每步去重：与固定原文相同的工作规范基线换成一句指针，相同技能目录/记忆画像丢掉。
- 技能目录变化时同步替换系统提示词里的旧目录并持久化；工作规范变化照常放行。
- 记忆画像里的 `<available-memories>` 路径清单不固定，不放进缓存段（模型要找记忆用 OpenViking 搜索工具）。
- 固定内容按会话存 `$DSH_HOME/plugins/prompt-prefix/sessions/<会话编号哈希>.json`，启动时清理 30 天没被读过的。

## 安装

profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-prompt-prefix`。插件自带补丁层插入一条 `id: prompt-prefix`，**不要**手写第二条 insert。无配置项。

## 依赖与降级

- 无外部服务依赖就能工作，主要收益是把稳定内容固定到系统提示词末尾，便于跨会话复用缓存（能否命中取决于模型服务与相同前缀）。
- **画像增强依赖 OpenViking 记忆插件的本地 `profileMessage(... {consume:true})` 补丁。** 没装记忆插件、或该插件没有这个补丁时，画像部分原样放行（由记忆插件自己发或不发），本插件其余功能（工作规范、技能目录固定到末尾）不受影响，只少了「把画像挪到末尾」这一项。

## 验证

`pnpm run check`（typecheck + build + test，真实 cordis 瀑布事件）。

## 升级注意

依赖宿主 `agent/pre-step`、`system-prompt/assemble` 的细节（工作规范 `source.baseline`、技能目录 `source.kind`、记忆画像 `source.kind`、分叉继承段）。DSH 或记忆插件升级后先核对这几处；认不出就原样放行，不会丢内容。
