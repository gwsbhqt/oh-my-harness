# 共用远程边界

本页保留跨技能远程传输、部署、产物和回执限制。Python 日常调用先读 [Python 主说明](../PYSKILL.md) 和 [共用操作规则](common.md) 和 [Python 接口](python.md)，CLI 语法在 [命令参考](cli.md)。


`remote-host`、`computer-use`、`dsh-use` 使用同一套真实 SSH 与脚本暂存。每个工具只读写自己的默认目标，不会改其他工具的 pin。

```bash
computer-use -H alpha snap Finder --json
dsh-use -H alpha sessions --json
computer-use use alpha                 # pin 与 use 同义
computer-use hosts
computer-use use local                  # 恢复本机
computer-use use --clear                # 清除 computer-use 自己的 pin，恢复本机
remote-host use --clear                # 清除 remote-host 的 pin；之后仍须指定远端 host
```

- `computer-use` 和 `dsh-use` 无显式机器且无各自 pin 时默认 `local`。`-H` / `--host` 仅覆盖本次目标，`--local` 明确本机。机器选项放命令前，非文本位置出现错位参数会报错。明确的消息或输入文本保留原样，`--` 后不消费路由参数。
- `remote-host` 无 pin 必须指定 host。机器参数放在业务载荷之前：`remote-host -H laptop run curl -H "Accept: application/json" URL` 不会把 curl 的请求头误当机器。`run` / `send` 仍支持在载荷之前写上下文参数；载荷开始后所有词原样保留。后台任务的机器参数放 `job` 前。`remote-host use local` 只清除默认 host，不授权本机执行。`remote-host --local run` 和 `remote-host -H local run` 均失败。
- `computer-use` 和 `dsh-use` 的 `use` / `pin` / `hosts` 支持 `--json`，返回 `ok`、`tool`、`target`，`hosts` 另含可用目标列表。
- 不能同时传远端 `-H` 与 `--local`；冲突直接失败。默认目标文件损坏或无法读取也失败，不静默恢复本机。
- 未知 alias、缺 SSH 或缺远端工具、连接失败都返回非零，不会退回本机。目标信息只写 stderr；JSON 模式的 stdout 只含 JSON。
- 远程 `computer-use serve` 不支持双向标准输入流，明确报错退出；本机 `serve` 和远程单次命令不受影响。
- 远端调用显式使用 `~/.local/bin/computer-use` 或 `~/.local/bin/dsh-use`。先检查 `--capabilities --json` 的工具名、协议和必需能力，再加 `--local` 执行；旧入口或能力不足返回非零，未执行实际命令。不去掉安全参数重试，忽略远端 pin，避免递归和误跑系统同名工具。
- 远程 `computer-use snap` / `computer-use shot` 主动请求 JSON 并取回图片。`remotePath` 留原远端路径，`path` 改为本机可读路径；`snap` 的 `shot` 字段也改成本机路径。文本模式同样显示本机路径。不是 JSON 的输出不会猜成 JSON；差异快照没有截图时只渲染变化。
- 远端 `dsh-use restart` 保留 DSH 来源安全标记，但不携带本机会话 ID。每次排队或加入已有重启都有唯一请求编号，完成状态用 `restart-status --request-id UUID` 查询，不能拿下一次重启结果代替。DSH 会话发起的远程 `restart --detach`（`--force` 或 `--when-idle` 都算） 在本机启动有期限的结果观察，并以插件通知回到本机会话；`dsh-use restart-watch UUID --json` 查看本机记录。启动观察失败保留远端已排队回执并非零退出，不重复发送重启。观察超时为结果未知，不等于远端重启失败；本机操作系统重启不会自动续上观察。

remote-host、computer-use、dsh-use 共用同一份选机和 SSH 代码，放在 `skills/_shared/agentkit/remote/`，不属于本技能。这三个入口都按自己文件的真实位置找到它，缺了就报错退出，不会改成本机执行。调用方式见 [维护说明](maintaining.md#共用远程控制代码)。

默认机器的写入带跨进程锁、整体替换；一次调用固定自己读到的机器和每机设置，不随另一个终端的 `use` 在半途中变化。remote-host 的默认机器存在 `~/.local/state/remote-host/pin.json`，computer-use 和 dsh-use 各存在自己名字的目录里；都遵守 `XDG_STATE_HOME`。

### 选择浏览器实例

browser-use 用 `--browser cra` 或 `--browser chrome` 选择浏览器。Chrome 的 `--endpoint` 使用带端口的本机回环地址，指向已开启调试的实例。如果已有获准使用的转发连接，就传该连接在本机的地址。Cra 网页控制使用 Cra 官方 MCP，调试 Cra 时再指定该实例的调试地址。需要接手原生对话框时，为 computer-use 单独选定实际机器和窗口。[浏览器技能](../../browser-use/README.md)

