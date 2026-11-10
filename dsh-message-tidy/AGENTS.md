# dsh-message-tidy

DSH 往对话里塞的消息，进模型之前整理一遍。四项整理各有开关，都挂在 `agent/pre-step`
的最外层（`prepend: true`，才能看到内层宿主插件塞进这一步的消息）。`source` 一律原样保留：
宿主和其他插件靠它认出自己发的消息。按 agent（会话）分开记状态，`WeakMap` 随会话释放。

同一条完成通知可能同时被「任务改名」和「通知加框」处理：先改名再加框，改名的匹配不锚定行首，
顺序反过来也对（有测试）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `noticeLabel` | `true` | 通知加框开关 |
| `noticeSources` | `['*']` | 要加框的通知来源（`source.kind`）；`*` 表示所有插件通知 |
| `noticeDedupe` | `true` | 同一步里一模一样的通知只留第一条 |
| `jobLabel` | `true` | 任务改名开关 |
| `jobLabelMaxChars` | 120 | 任务名超长截断，末尾加 `…` |
| `instructionsDiff` | `true` | 指令只发差异开关（关掉时清空缓存，重新打开后先发一次全文） |
| `maxDiffRatio` | 0.5 | diff 超过全文这个比例就发全文 |
| `contextLines` | 2 | 每处改动前后带几行原文 |

四项都被上游解决时，删掉本插件。

## 通知加框（`noticeLabel`，`src/notice.ts`）

插件发给模型的通知，加上「这是系统提醒、不是用户说的」外框。

### 现象

`repeat-tool-reminder`（「You are repeating the exact same tool call…」）、`tool-jobs`
（「background job bash-4 … finished」）的通知都以 **user 角色**进入对话，正文没有任何
来源标记，模型难以区分用户消息与插件通知。

### 做法

`agent/pre-step` 最外层（`prepend: true`，才能看到内层宿主插件塞进这一步的消息）：
通知消息（0.1.7 的形状是 `source: { kind: <插件名>, form: 'notice' }`）里 `source.kind` 在 `sources`
名单里的，第一个文本块包进
`<system-reminder>`，首行用统一英文格式写明来源插件和「不是用户说的话」。外框文字由 `tooling/runtime/notice.mjs` 生成，返回新对象、不就地修改。

- `source` 原样保留：宿主和其他插件靠它认出自己发的消息。
- 默认 `noticeSources: ['*']`，所有插件的 `form: 'notice'` 消息都会加框；普通 `send` 的真人来源和角色不改。外框只说明来源，不增加或删减授权。显式配置名单时尊重该名单，不强行追加。
- 本插件自己的提醒也按同一格式写（`src/notice.ts` 调用 `tooling/runtime/notice.mjs` 的 `reminderText` / `reminderSummary`）。
- 第一个文本块已经以 `<system-reminder>` 开头的不重复包；后续文本块和非文本块不动，多次处理仍幂等。
- 输入可能是冻结对象，一律返回新对象。



### 重复读取误报的边界

宿主已有公开 `repeat-tool-reminder` 配置 `exclude`，应在既有全局条目 `repeat-tool-reminder`
的 profile 覆盖层合并排除 `read`、`glob`、`grep`，保留其他既有排除项和 `job_output` 计数，
不提高全局阈值。只有在所有会话空闲后由统一配置负责人实施；本插件不代改宿主配置。
App rc.2 的通知来源仅含 `kind`、`form`、`summary`，没有结构化 `toolName`；不从正文或
摘要猜工具，不按内容过滤提醒，更不把删正文当作撤回模型唤醒。唯一例外是「同一步里完全相同的通知只留第一条」（见「同步骤重复通知去重」节）：不猜工具、不看语义，第二份起零信息量。`test/host-repeat.test.ts` 用 App
未改写的公开 `Config/apply` 和工具执行后钩子验证源头排除及轮询保留，不代表运行会话已部署。

### 删除条件

上游让这些通知以系统消息（或自带明确来源标记）进入对话时删掉这一项（本文件、`index.ts` 里对应的一行和开关）。

## 同步骤重复通知去重（`noticeDedupe`，`src/dedupe.ts`）

同一步里一模一样的插件通知只留第一条。

### 现象

宿主 `repeat-tool-reminder` 对每一次重复调用各发一份提醒；模型一步发一批相同的并发调用时，
这一步会被塞进一堆一模一样的提醒。第二份起信息量为零，白白占位。

### 做法

`agent/pre-step` 整理时，通知消息（`source.form` 为 `notice`）按「角色 + 完整来源 + 全部内容」与已保留的通知比对，
完全相同的不再留。只动通知消息；用户、助手消息一模一样也不动。先经「通知加框」再进这里，
加框不改变相同性。`source` 原样保留。

### 删除条件

宿主在同一步内对相同通知去重时删掉这一项（本文件、`index.ts` 里对应的一行和开关）。

## 任务改名（`jobLabel`，`src/job.ts`）

后台任务的完成通知用 `description` 当任务名，不再抄整条命令。

### 现象

`bash` 以 `run_in_background` 启动时，宿主（`dsh-tool-bash`：`label: args.command`）把
**整条命令**当任务名，`tool-jobs` 的完成通知照抄：

```
background job bash-4 (bash: ssh -o BatchMode=yes example-host 'printf ZXhhbXBsZQ== | base64 -d' 2>&1) finished [status: completed, exit code: 0]
```

多条这样的通知重复携带完整命令，模型给的 `description` 反而用不上。

### 做法

- `tools/result`：`bash` 显式后台调用成功返回 `{kind:'background', jobId}`，或超时自动晋级
  返回 `{kind:'promoted', jobId}`，且带非空 `description` 时，按 agent 记 `jobId → description`
  （`WeakMap`，不同会话的 `bash-4` 互不相干）。自动晋级不要求 `run_in_background`。
  PTC 代码格里的子调用同样经过这里。
- `agent/pre-step` 最外层：`tool-jobs` 的通知里把 `(bash: <命令>)` 换成
  `(bash: <description>)`，`source.summary` 同步换掉，其余原样。名字的结束边界取
  **最后一个** `) finished [status:`，命令里自带的括号不会截断；DSH 0.2.2-rc.1 起通知在 `. Output:` 后接命令输出，只在它之前找。
- 没记到 description 的任务（会话恢复前启动的、没写 description 的）不动。


### 删除条件

上游让任务名取 `description`（或允许调用方指定任务名）时删掉这一项（本文件、`index.ts` 里对应的一行和开关）。

## 指令只发差异（`instructionsDiff`，`src/instructions.ts`）

会话中途改了 AGENTS.md（或其他指令文件），只把改动的行以 diff 发给模型，不再重发全文。

### 现象

`dsh-agent-instructions` 发现指令文件变了，会把**新版全文**以
「Updated instructions from: X … Use the following content instead」重新发一遍。
即使只改一个词，整份规则也会重新进入上下文。

### 做法

`agent/pre-step` 最外层（`prepend: true`）看 `source.kind === 'agent-instructions'` 的消息：

1. 拆成段（`Instructions from` / `Additional instructions from` / `Updated instructions from`
   / `Instructions removed`），从按 agent 保存的「已提交到会话的那一版」正文复制临时记录。
2. 遇到 `Updated` 段且缓存里有上一版：做行级 unified diff（首尾相同行先剥掉，中间 LCS），
   diff 不超过全文 `maxDiffRatio` 就把这一段换成「只列改动」的说明加 diff 块；只更新临时记录。
3. `session/event` 收到匹配的 `user/message` 提交后才晋升基准；匹配消息内容和来源，不依赖
   对象身份（宿主提交时复制消息）。失败、取消的 `turn/end` 或下一次预处理会丢弃未提交记录。
   无法核对提交时清空基准，下一版发全文；不能把尚未提交的版本当作已送达。
   可选互操作：若另有插件把基线换成指针（原文进了系统提示词），它在里层时从
   `globalThis[Symbol.for('dsh-prompt-prefix.originals')]` 这张表按指针消息查到原消息，这里照原文记；它在外层时提交的是带
   `<!-- prompt-prefix pin=… -->` 的指针、`source` 与待提交那条相同，按已送达处理。两个插件谁在外层取决于加载先后，两种都有测试。
4. `source` 原样保留：宿主按 `source.changes` 里的摘要判断「送达过什么」，不看正文，
   改写正文不会引起重发。

以下情况**照旧发全文**，宁可多花 token 也不让模型拿到不完整的指令：

- 缓存里没有上一版（会话恢复、压缩后、插件晚加载）；
- 该文件出现在预算标记「Workspace instruction budget … omitted/truncated X」里；
- diff 太大（超过 `maxDiffRatio`），或文件大到行级 diff 算不动（中间差异 > 400 万格）。


### 依赖的宿主文字

段标题、`Updated` 的固定引导句、预算标记的格式都是照 `dsh-agent-instructions`
的原文写的。上游改了措辞，这里会
**解析不到、原样放行**（退化为发全文，不会出错）。
升级 DSH 后若发现又在重发全文，先对一下这几段文字。

### 删除条件

上游在指令更新时只发差异（或提供这样的选项）时删掉这一项（本文件、`index.ts` 里对应的一行和开关）。
