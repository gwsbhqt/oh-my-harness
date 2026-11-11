中文 | [English](dsh-control.en.md)

# 派发任务并核对完成情况

`dsh-control` 让另一个本地 Agent 查看和操作已有的 DSH 实例。它提供命令行、异步 Python 接口和 MCP（一种通用的工具接入协议）入口。MCP 入口通过标准输入输出连接。常见用途包括查找会话、派发范围明确的任务、回答问题和收集结果。模型无需反复询问进度。

## 先检查，再发送

先做只读查询：

```sh
dsh-control health --json
dsh-control sessions --limit 3 --json
```

写入前先确认目标会话。给长工明确的目标、允许修改的文件或执行的动作、必需检查和停止条件。例如，虚构的文档任务可以要求只更新一篇教程，并返回位置和验证证据。创建会话、发送消息、取消任务和修改配置，都需要用户授权。

```sh
dsh-control send WORKER_SESSION 'Revise the example guide within the agreed scope and report the checks performed.' --notify LEAD_SESSION --json
```

保存返回的会话标识和起始序号。发送回执只证明请求被接受，不证明任务成功完成。响应丢失或含糊时，先查已有回执和会话历史，再决定是否重发。应重试等待，而不是重复派任务：

```sh
dsh-control wait WORKER_SESSION --since RECEIPT_SEQUENCE --settled --json
```

把大写占位符换成实际返回值。`--settled` 检查的不只是会话空闲：排队任务、后台任务、子 Agent 和自动继续的目标，都可能让任务尚未完成。检查退出状态和结构化结果。等输入、超时、失败和中止是不同结果。即使报告成功完成，也仍需对照要求检查交付物。

## 较长任务使用监督分工

内置的 `dsh-supervise` 流程把计划与验收交给主控，把执行交给长工。主控编写任务书，说明目标、边界、清单、预期证据和报告问题的条件。长工按任务书执行。好的任务书应规定长工自己能达到的终点，例如产出可审查的补丁，而不是把终点设成别人稍后的批准。

派发时登记完成通知，然后让主控暂停等待。附带的看守程序在完成通知之外，还会报告停滞、断连、恢复和检查器错误。它检查状态和进展，不把让人放心的回复当成证明。连接中断意味着长工状态未知。恢复后要检查中断期间发生的事。监督结束时，停止看守程序返回的监控器。

验收时，把实际产物和检查结果与任务书对照。长工汇报、发送回执、已登记的观察程序和已结束的会话，各自证明不同事实。任何一项都不能单独证明部署的功能或可见界面已经可用。

## 接口与限制

Python 中的 `await skills.dsh_control.health()` 使用同一套命令行。结果保留 JSON、`exit_code`、`stdout` 和 `stderr`，非零退出需要明确处理。技能是受信任的 Python 代码，插件命令则仍受 `readOnly` 和 `denyNamespaces` 限制。

服务端使用私有 Unix socket，信任同一操作系统账号下的程序。远程路由需要兼容的安装、SSH 和可选的公共远程支持。缺少远程支持时，会明确报错。MCP 提供更窄的任务接口，不提供全局重启或配置修改。支持的平台是 macOS。

完整配置、命令示例、内置监督说明和远程前提见[插件说明](../dsh-control/README.md)。[主控与长工](design/controller-worker.md)解释双方的职责。
