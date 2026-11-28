# dsh-use 命令行参考

日常流程见 [CLI 主说明](../SKILL.md)，Python 调用见 [Python 主说明](../PYSKILL.md)。授权、回执、取消、模型与重启规则统一见 [共用规则](common.md)；安装见 [插件说明](../../../README.md)。

## 在线检查与选机器

```bash
dsh-use health
dsh-use start
dsh-use doctor
dsh-use -H alpha health
dsh-use -H alpha start
```

退出 69 表示通信口不可用；start 先检查桌面启动环境，不直接用 open 或其他工具绕过。远端必须已部署命令和插件，连不上不退回本机。

## 选择机器

```bash
dsh-use -H alpha sessions   # 只这次使用指定机器
dsh-use use alpha           # 记住 dsh-use 自己的默认机器
dsh-use pin alpha           # 与 use 相同
dsh-use use                 # 查看默认机器，不连接
dsh-use hosts               # 列 SSH 昵称
dsh-use use local           # 恢复本机
dsh-use use --clear         # 清除默认机器，恢复本机
```

没有设置时默认本机。remote-host、computer-use、dsh-use 的默认机器各自独立；`-H` 不改默认设置。查询与写操作都使用同一个目标，操作前核对 stderr 显示的目标。`--local` 明确执行本机，也用于远端转发时防止二次转发。远程重启带 `--detach` 时，共享目标入口在发起机器观察结果，再以本机通知送回原会话；本机会话编号不传给远端；子代理的编号不是会话编号，从子代理发起时照常排队并退出 0，回执写 `watchSkipped`，不会收到完成通知，要自己查。回执里的监听编号用 `dsh-use restart-watch WATCHID --json` 在本机查，不连接默认机器。远端执行结果可用同一个 `-H` 和 `restart-status --request-id UUID --json` 查，UUID 来自排队回执；读取退出 0 只表示查到记录，必须看 `data.phase` 是否为 `completed`。通知未送达也必须照实报告。

## 命令速查

会话可以写完整 id、id 开头或末尾至少 4 位、或标题里的词。对上多个会列候选，照候选再问，不要猜。

| 要做的事 | 命令 |
|---|---|
| 在跑什么 | `dsh-use sessions --running` |
| 最近的会话 | `dsh-use sessions [--workspace 工作区名] [--cwd 目录] [--query 标题词] [--limit N] [--all] [--include-blank]`（默认不列已归档和空白会话，`--limit 0` 列全部，`--all` 包含已存档，`--include-blank` 包含空白；末尾写着省略了几个；`health` 的会话数用同一口径） |
| 工作区 | `dsh-use workspaces [--json]`（含工作区 id、路径和登记的会话 id） |
| 每个工作区下的会话 | `dsh-use sessions --workspace <工作区 id、名字或路径> --limit 0`；要连已存档和空白一起看，加 `--all --include-blank` |
| 未分组会话 | `dsh-use sessions --ungrouped --limit 0 [--include-blank] [--all]`（不在任何工作区登记的普通会话，不按目录判断，不含子代理；不能同时加 `--workspace`） |
| 存档 / 取消存档 | `dsh-use archive <会话>` / `dsh-use unarchive <会话>`（可撤销；有活动任务时拒绝，不会中止它） |
| 重命名 | `dsh-use rename <会话> "新标题"` |
| 分叉 | `dsh-use fork <会话> [--at-seq N]`（默认复制到最近完成的一轮；指定序号则复制到该事件，含该事件；输出新会话 id，不会自动发消息，继续用 `send`） |
| 一个会话的状态 | `dsh-use status <会话>`（在不在跑、模型、待办进度、排队消息、是否在等回答；在等回答时退出码 10） |
| 一次请求的收件元数据 | `dsh-use receipt <完整 sessionId> <完整 requestId> [--json]`（只查这个目标，不含正文、标题、路径或继承事件；`state=enqueued` 是曾记录入队，`state=user-message` 是已成为用户消息，都不表示仍在队列、已回复或已完成） |
| 工作目录 | `dsh-use cwd <会话>` 看现在的目录（中途换过会同时列起始目录）；`dsh-use cwd <会话> /绝对路径` 换过去，模型下一步就在新目录干活，已经开着的终端和后台命令还在原目录 |
| 持续目标 | `dsh-use goal <会话>` 看；`goal <会话> pause|resume|clear` 暂停、恢复、清掉，等同用户在界面目标面板上点。模型自己恢复不了被暂停的目标，要靠这里或界面。会话正在跑时 `pause` 会中止这一轮；只想让它这轮做完后别再自动开下一轮，用 `goal <会话> hold`，恢复同样用 `resume` |
| 定时提醒 | `dsh-use schedule [会话]` 列出（界面「自动化任务」那一页）；`schedule history <提醒>` 看发过几次；`schedule delete <提醒>` 删。提醒用列表每行开头的 8 位编号指。外部不能新建，要建就 `send` 让会话里的模型建 |
| 桌面通知 | `dsh-use notify [正文] [--title 标题|--no-title] [--body 正文|--no-body] [--sound|--no-sound]`；正文可直接写或用 `--body`，不能同时写。默认标题「DSH」、正文「有一条新通知」、开启声音。各项可单独关闭，只有声音时不弹通知；声音受电脑音量控制 |
| 最后一段回复 | `dsh-use last <会话>`（长回复会截断，按提示加 `--chars`） |
| 逐轮概览 / 看某一轮 | `dsh-use read <会话>` / `dsh-use read <会话> --turn -1 [--tools] [--chars 每条字数] [--max 这一轮总字数]`（加 `--json` 时这一轮正文在 `data.text`） |
| 发消息 | `dsh-use send <会话> "消息" [--now|--interrupt] [--notify <会话>|self]`（默认排到下一轮；怎么选见下面「发消息：排队、插话还是打断」；`--notify` 见下面「做完通知」） |
| 排队消息 | `dsh-use queue <会话>` 列出（每条带编号）；`queue <会话> steer 编号…` 只把点名的几条插进当前这一轮，其余照常排队；`remove 编号…` 删掉；`edit 编号 "新内容"` 改写 |
| 等跑完 | `dsh-use wait <会话> --since <send 或 new 给的起点 seq> [--settled] [--timeout 秒，默认 1800]`（不带 `--settled` 一轮结束就返回；带上等到真做完，见下面「做完通知」） |
| 发消息并等 | `dsh-use chat <会话> "消息" [--settled] [--notify <会话>|self] [--timeout 秒]`（退出码同 `wait`） |
| 开新会话 | `dsh-use new <工作区名字或绝对路径> "第一条消息" [--tier fast] [--if-idle] [--notify <会话>|self]`（输出里有起点 seq，直接用于 `wait`；绝对路径只在那个目录开会话，不会加进工作区列表；档位没有可用模型就不建会话，退出码 2） |
| 回答会话的提问 | `dsh-use answer <会话> --select "选项"` 或 `dsh-use answer <会话> "自由回答"`（`--select` 可只写选项开头或其中几个字，例如选项「蓝色」写 `蓝`；对上多个会报歧义并列候选） |
| 启动持久服务 | `dsh-use monitor <会话> --command <完整命令> --cwd <绝对目录> [--label <名称>] [--restart never|on-failure] [--quiet]`：直接挂到指定会话（`--quiet` 时输出不推进会话）（`--restart` 缺省 on-failure，失败退出自动重拉），重启前暂停、重启后接回原会话，不发消息或启动模型回合。只启动，不替换已有任务；先核对旧服务是否已停，再启动并验端口。需要 dsh-monitor 插件，缺失时报错 |
| 中止 | `dsh-use cancel <会话>` |
| 额度 / 模型 | `dsh-use quota`、`dsh-use models`、`dsh-use pick [normal|fast]`（某家查不到会附一句去哪修；`pick` 整档没有可用模型退出码 2） |
| 会话改名 | `dsh-use rename <会话> "新标题"` |
| 换模型或推理档位 | `dsh-use model <会话> [--tier normal|fast | --model provider/model] [--effort 档位]`；只写 `--effort` 保持当前模型。已开始的会话受缓存保护，用户已明确要求更改时先等会话停下，再加 `--force` |
| 插件 | `dsh-use plugins`（描述以 … 结尾是被截断了，`--json` 看全文）、`dsh-use plugin install|remove|enable|disable <包名>` |
| 配置 | `dsh-use config`、`dsh-use config <命名空间>`、`dsh-use config <命名空间> --set '{"字段":值}'` |
| 启动检查 | `dsh-use doctor`（离线检查并隔离试启动；运行时还会调用在线 doctor 工具；全部通过才退出 0） |
| 重启 | 先 `dsh-use doctor`，全部通过再 `dsh-use restart`：一律中止在跑的会话后直接重启，没有等空闲模式；会话里自动转后台并通知你。重启后被中止的会话（包括你自己）自动收到「继续」，本次停下的显式后台 bash 有原目录才在原会话重新拉起；前台和意图不明的任务只报告中断，闲着的主人不被叫醒 |
| 升级 App | `dsh-use upgrade [--check] [--before <命令>]`：按更新源取包，校验大小、sha512、签名、公证和开发者，用新版 App 对实际配置跑启动检查，全过才重启；旧 App 退出后才替换，新版拉不起来自动换回旧版，新版就绪后删掉旧版。`--check` 只备好并检查不替换，已是最新直接退出 0 |
| 网页登录网址 | `dsh-use web-url [--base 网址]`：带这次启动的一次性口令，等同登录凭据，别外传；DSH 重启后失效。从别的机器打开 DSH 网页一般直接用下一行的 `open` |
| 打开别的机器上的服务 | `dsh-use open <机器> <服务>`：拉起隧道并在本机浏览器打开，例如 `dsh-use open beta dsh`、`dsh-use open beta hermes`；`dsh-use tunnel close <机器> <服务>` 关掉。机器和服务由 profile 的 `dsh-use` 配置提供，插件默认清单为空 |
| 退出检查 | `dsh-use quit-check`：现在退出 DSH 会不会弹「任务将中断」确认框、卡在哪 |
| 重启进度 | `dsh-use restart-status [--json]`：最近一次重启阶段、真实阻碍和结果；进程消失而无终态不是成功 |
| 等会话停下 | `dsh-use wait-idle [会话] [--timeout 秒] [--slice 毫秒]`：指定会话或全部会话停下时返回；指定会话等回答退出 10，超时退出 124。没写 `--timeout` 时只等一段（默认 30 秒）；空闲是当下状态，不检查后台任务，也不代表任务成功 |
| 兜底 | `dsh-use api list [ns]`、`dsh-use api describe ns/method`、`dsh-use api call ns/method '{"参数":值}'` |

`receipt` 的 `requestId` 只接受完整小写 UUID；`sessionId` 只按精确键接受现有 `session-` 短编号和数字编号（包括 `session-1`），不能用前缀或标题找会话，也不会退回 `readSession`、会话列表或全量 `status/read`。入队证据只认 `agent/inbox/spliced` 的 `data.inserted[].source.rpcId`，且来源只接受 `user` 或旧 `remote-control`；`injected` 不算收件。`turn` 优先取 `user/message` 自身的 `data.turn`，没有时只按包住该消息的 `turn/start` / `turn/end` 边界归属，没有可靠边界就省略。

`request-not-found` 表示已完整读取该会话自有日志但无记录；`session-not-found` 表示目标会话缺失，沿既有调用错误返回 HTTP 400 / CLI 退出 2；`exact-receipt-unavailable` 表示旧宿主没有无枚举精确观察能力；`receipt-read-failed` 表示读取、观察 getter 或释放失败。这些结果都不推断 ACL、从未送达或模型已回复，更不会自动重发；错误文本不回显上游内容或不可信任的长会话编号。

`new`、`send`、`chat` 也支持 `--effort`，可与 `--model` 或 `--tier` 一起使用；可选值由所选模型目录决定，非法值会列出可选项。例：`dsh-use new example-workspace --model provider/model --effort high`。

所有命令都能加 `--json` 拿结构化结果：成功是 `{ok:true,status,data}`，没做成是 `{ok:false,error:{code,message}}`，`code` 是稳定的英文（如 `not-found`、`ambiguous`、`model-change-refused`、`no-model`、`answer-rejected`、`plugin-action-failed`）。
`dsh-use help` 列出全部命令（含 `chat`、`start`、`restart`、`doctor` 这些命令行自己做的）；DSH 没运行时也能列全。

## 发送与等待

```bash
dsh-use send <会话> "任务目标、限制和验收标准" --notify self --json
dsh-use wait <回执中的sessionId> --since <回执中的since> --settled --timeout 100 --json
dsh-use new /tmp/dsh-use-check "用户授权的任务" --tier fast --notify self --json
dsh-use answer <会话> --select "蓝色"
dsh-use send <会话> "纠正当前方向" --now
dsh-use send <会话> "用户要求立即停止并调整" --interrupt
dsh-use queue <会话>
dsh-use queue <会话> steer a1b2c3d4 e5f6a7b8
dsh-use queue <会话> remove <消息编号>
dsh-use queue <会话> edit <消息编号> "新内容"
```

回执字段、等待退出码、防重发、队列权限与取消边界见 [共用规则](common.md#发送回执与防重发)。后台等待记录任务编号并收取退出码；前台 timeout 短于宿主工具时限。

## 做完通知

`--notify <会话|agy:会话>` 可加在 `send`、`new`（要带第一条消息）、`chat` 上；在 DSH 会话（bash 工具、Python 内核）或 Antigravity 桌面终端（环境含 `ANTIGRAVITY_CONVERSATION_ID`）里写 `self`，由命令行换成发起的会话（Antigravity Python REPL 内核不继承 `ANTIGRAVITY_CONVERSATION_ID`，须显式写 `agy:<会话编号>`）。传 `agy:<会话编号或唯一前缀>` 时，DSH 发送前会先经本机 `agy-use get --active-only --no-metadata` 校验目标存在、未归档且已开始首轮对话（转录存在、步数大于零且末步有效），并规范化为完整 UUID；真做完或等回答时经本机 `agy-use send --wait-receipt`（仅连 `bridge.sock`，不读密钥也不传 `--title`）严格确认收件一次，正文仅含目标任务编号、明确状态与监听 watch ID，不透传标题、路径、回复正文、提问或命令提示；最终通知若无法确认收件，会保存为 `unconfirmed`，同一记录不重发。提问提醒在投递前保存题号，收件不明时保留题号并继续等待最终通知；确认未发出且可重试时才释放该题号；`agy:<会话编号>` 仅用于通知本机 Antigravity App 会话。插件发送后登记一条监听，记录在 `$DSH_HOME/dsh-use/done-watches/<watchId>.json`，插件每次启动读回来接着盯，DSH 重启不丢。DSH 本机目标真做完时用插件通知（来源 `dsh-use`）给指定会话送一次：目标编号和标题、结束原因、最后回复的开头、读全文的命令。最后一轮失败、中止、目标会话不见了也送并写明；目标中途停下等回答时另送一条提醒，同一个提问只送一次。最终通知送之前先标为 `delivering`，DSH 在这时退出则不再重送。同一个目标和通知对象仍在等待任务结束时，再带 `--notify` 会复用监听，回执 `data.notify.reused` 为 true。本机插件开始旧任务的最终投递后，新派单按自己的起点另建监听。通知对象必须和目标在同一台 DSH 上，不能是目标自己。例外是用 `-H` 派到别的机器时写 `self`：消息去掉 `--notify` 发到远端，本机起一个后台观察进程反复问远端 `wait --settled`，真做完后用 `--local notice` 通知本机发起会话，等回答时同样先送一次提醒；记录在 `~/.local/state/dsh-use/remote-done-watches/<watchId>.json`，回执 `data.notify.observer` 为 `local`。派单前核对远端入口支持 settled-wait；观察进程最长盯 24 小时、不跨本机重启；`chat` 不支持跨机器 `self`。写具体会话编号时仍由远端插件同机通知。回执 `data.notify` 有 `watchId` 和记录路径；有 `error` 表示消息已发出、监听没登记上，不要重发，改用 `wait --settled`。

「真做完」与 `wait --settled` 同一口径，只看宿主实时状态，不看回复内容：这一轮已结束、会话没在跑、没有排队消息或待领通知；会话及其子代理名下没有在跑的后台任务（bash 后台任务、Python 内核的 `repl.background`、监听等）；子代理不在跑或排队；持续目标不会自动开下一轮；没有重启正在进行；插件刚启动 2 分钟内，上次退出时被中止的那一轮不算终态。以上全部满足并连续保持 3 秒才算。持久服务（开发服务器这类一直不退出的监听）会让会话永远算没做完。

```bash
dsh-use send <会话> "任务与验收标准" --notify self --json
dsh-use chat <会话> "任务与验收标准" --settled --timeout 1800 --json
```

## 启动检查与重启

```bash
dsh-use doctor --json
dsh-use doctor --profile desktop --json
dsh-use doctor --full --json
dsh-use restart --detach --json
dsh-use restart-status --request-id <UUID> --json
dsh-use quit-check --json
dsh-use restart-watch <WATCHID> --json
dsh-use -H alpha restart-status --request-id <UUID> --json
```

检查、重启终态及通知规则见 [共用规则](common.md#检查与重启)。

中止所有会话后、退出前执行一次更新命令，失败不重启：

```bash
dsh-use restart --detach --before 'cp /tmp/x.yml <profile>/cordis.patch.yml && cd <profile> && CI=true pnpm install'
```

按实际 profile 替换占位符；更新的失败处理与不可重放要求见共用规则。

可选参数：`--notify 会话`、`--quit-via apple-event|menu`、`--kill`（不试正常退出、直接结束进程再拉起，不能配 `--before`）。默认 apple-event，明确选择 menu 才核对 computer-use 并点精确唯一普通退出项；正常退出没走成时结束进程再拉起。没有等空闲模式，`--timeout`、`--when-idle`、`--force`、`--background` 都会被直接拒绝（退出 2）；会话里自动转后台。

## 升级 App

```bash
dsh-use upgrade --check          # 只取包、校验、用新版对实际配置跑启动检查，不替换
dsh-use upgrade --detach         # 检查通过后重启：旧 App 退出后才换成新版
dsh-use -H beta upgrade --detach   # 给别的机器升级；远端在后台进程里做，SSH 断了也不影响
```

默认更新源是 `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml`，可以用 `--feed` 指定其他来源。缓存位于 `~/.local/state/dsh-use/app-upgrade`。`--check` 使用新版 App 验证实际配置，并返回已检查的 App 路径。升级成功后会清理本次备份与这份发布包的缓存。需要同时更新 profile 依赖时使用 `--before`，它在会话中止后、替换 App 前执行。预检或更新命令失败时会保留正在使用的版本。脚本通过 `--json` 读取回执，后台受理后的结果按请求编号查询。

## 通用接口

```bash
dsh-use api list
dsh-use api list schedule
dsh-use api describe schedule/list
dsh-use api call schedule/list '{"request":{}}'
dsh-use help
dsh-use help restart
```

先 describe 并按实际 schema 传参；权限和禁止的命名空间见 [共用规则](common.md#权限边界)。示例本身不授权真实消息或重启。
