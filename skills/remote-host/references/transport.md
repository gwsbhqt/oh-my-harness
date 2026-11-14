# 共用远程边界

本页保留跨技能远程传输、部署、产物和回执限制。Python 日常调用先读 [Python 主说明](../PYSKILL.md) 和 [共用操作规则](common.md) 和 [Python 接口](python.md)，CLI 语法在 [命令参考](cli.md)。


`remote-host`、`computer-use`、`dsh-use`、`browser-use` 使用同一套真实 SSH 与脚本暂存。每个工具只读写自己的默认目标，不会改其他工具的 pin。

```bash
computer-use -H alpha snap Finder --json
dsh-use -H alpha sessions --json
browser-use -H alpha --scope task-a tab list --json
browser-use use alpha --json          # browser-use：只修改自己的机器 pin
browser-use hosts --json
computer-use use alpha                 # pin 与 use 同义
computer-use hosts
computer-use use local                  # 恢复本机
computer-use use --clear                # 清除 computer-use 自己的 pin，恢复本机
remote-host use --clear                # 清除 remote-host 的 pin；之后仍须指定远端 host
```

- `computer-use` / `dsh-use` / `browser-use` 无显式机器且无各自 pin 默认 `local`。`-H` / `--host` 仅覆盖本次目标，`--local` 明确本机。browser-use 的机器选项可放子命令前后；computer-use / dsh-use 的机器选项放命令前，非文本位置出现错位参数会报错。明确的消息或输入文本保留原样；`--` 后不消费路由参数。
- `remote-host` 无 pin 必须指定 host。机器参数放在业务载荷之前：`remote-host -H laptop run curl -H "Accept: application/json" URL` 不会把 curl 的请求头误当机器。`run` / `send` 仍支持在载荷之前写上下文参数；载荷开始后所有词原样保留。后台任务的机器参数放 `job` 前。`remote-host use local` 只清除默认 host，不授权本机执行。`remote-host --local run` 和 `remote-host -H local run` 均失败。
- `computer-use` / `dsh-use` / `browser-use` 的 `use` / `pin` / `hosts` 支持 `--json`，返回 `ok`、`tool`、`target`，`hosts` 另含可用目标列表。
- 不能同时传远端 `-H` 与 `--local`；冲突直接失败。默认目标文件损坏或无法读取也失败，不静默恢复本机。
- 未知 alias、缺 SSH 或缺远端工具、连接失败都返回非零，不会退回本机。目标信息只写 stderr；JSON 模式的 stdout 只含 JSON。
- 远程 `computer-use serve` 不支持双向标准输入流，明确报错退出；本机 `serve` 和远程单次命令不受影响。
- 远端调用显式使用 `~/.local/bin/computer-use` 或 `~/.local/bin/dsh-use`。先检查 `--capabilities --json` 的工具名、协议和必需能力，再加 `--local` 执行；旧入口或能力不足返回非零，未执行实际命令。不去掉安全参数重试，忽略远端 pin，避免递归和误跑系统同名工具。
- 远程 `computer-use snap` / `computer-use shot` 主动请求 JSON 并取回图片。`remotePath` 留原远端路径，`path` 改为本机可读路径；`snap` 的 `shot` 字段也改成本机路径。文本模式同样显示本机路径。不是 JSON 的输出不会猜成 JSON；差异快照没有截图时只渲染变化。
- 远端 `dsh-use restart` 保留 DSH 来源安全标记，但不携带本机会话 ID。每次排队或加入已有重启都有唯一请求编号，完成状态用 `restart-status --request-id UUID` 查询，不能拿下一次重启结果代替。DSH 会话发起的远程 `restart --detach`（`--force` 或 `--when-idle` 都算） 在本机启动有期限的结果观察，并以插件通知回到本机会话；`dsh-use restart-watch UUID --json` 查看本机记录。启动观察失败保留远端已排队回执并非零退出，不重复发送重启。观察超时为结果未知，不等于远端重启失败；本机操作系统重启不会自动续上观察。

remote-host、computer-use、dsh-use、browser-use 共用同一份选机和 SSH 代码，放在 `skills/_shared/agentkit/remote/`，不属于本技能。四个入口都按自己文件的真实位置找到它，缺了就报错退出，不会改成本机执行。调用方式见 [维护说明](maintaining.md#共用远程控制代码)。

默认机器的写入带跨进程锁、整体替换；一次调用固定自己读到的机器和每机设置，不随另一个终端的 `use` 在半途中变化。remote-host 的默认机器存在 `~/.local/state/remote-host/pin.json`，computer-use、dsh-use、browser-use 各存在自己名字的目录里；都遵守 `XDG_STATE_HOME`。

### browser-use 的远程浏览器入口

browser-use 不把浏览器 CDP 端口开放给调用端。它经真实 SSH 传 JSON RPC 到目标机本地 daemon；生产入口固定 `~/.local/bin/browser-use`，先核对工具名、协议与 local-routing/remote-rpc 能力，再发送明确 `host="local"`、session 的请求，忽略远端机器 pin。调用端与目标机须已显式安装 browser-use、`skills/_shared` 共用代码及声明依赖，不会自动安装。`BROWSER_USE_REMOTE_LAUNCHER` 仅用于显式测试部署，必须是目标机绝对路径，不猜 PATH 或备用入口。

browser-use 机器 pin 与任务 scope 独立。scope 按显式 `--scope`、`BROWSER_USE_CONTEXT_ID`、`DSH_SESSION_ID` 选择；自动 session 对当前任务稳定，不是全电脑共同默认。`browser-use session use NAME/current/use --clear` 只选择或查询资源归属，不 release、不关页。普通 CLI 浏览器任务无 scope/session 会明确拒绝，不从 label 或页面目标推导；Python 无任务环境时仅使用进程独立默认。Python Page 固定 host/session/browser/targetId，改机器 pin 不改变已有对象。

自动取回限明确截图与 debug 产物白名单，SHA-256 与字节数核对后发布本机私有新文件，返回本机路径并保留 remotePath、hostContext；远程截图 out 是本机 700 私有目录内的新文件，overwrite 暂不支持。upload 与 network override 的本机文件先显式 stage 并校验；upload 保留到对应 tab close/release，disconnect 保留，override 注册文件快照后可清理。清理失败报告，不重发动作。download directory 与 route fulfill file 仍是目标机路径，不自动取回任意下载。

登录浮层转 computer-use 时必须显式选同一 host，并核对对应浏览器窗口和 browser-use 页面；不能因为 computer-use 无 pin 就操作本机。远程 OOPIF 本阶段未现场验收，不把接口声明当成 live 通过。完整接口见 [browser-use Python 主说明](../../browser-use/PYSKILL.md)，授权规则见 [browser-use 共用规则](../../browser-use/references/common.md)。

