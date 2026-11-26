# 参数与回执

## 运行条件

技能使用 Python 3.11 或更新版本和 Google 官方 `agy`。按 `PATH` 定位 CLI，未找到时尝试 macOS 和 Linux 的官方默认位置 `~/.local/bin/agy`。安装 CLI 和首次交互登录由使用者完成。技能调用沿用 AGY 的登录和权限。专用目录适合放入虚构样例或经授权的材料。[官方安装说明](https://antigravity.google/docs/getting-started?tab=cli)

## 函数与命令

所有 Python 函数都使用 `await skills.agy_use.<函数>(...)`。本表中的 `timeout` 以秒计，须为正的有限数值。路径支持字符串和 Python `Path`，在调用时解析为本机绝对路径。`--help` 显示命令参数。

| Python 函数 | 命令参数 | 官方操作 |
| --- | --- | --- |
| `status(*, timeout=10)` | `status [--timeout 秒]` | `agy --version` |
| `plugins(*, timeout=30)` | `plugins [--timeout 秒]` | `agy plugin list --json` |
| `validate_plugin(path, *, strict=False, timeout=30)` | `validate-plugin 路径 [--strict] [--timeout 秒]` | `agy plugin validate 路径 --json`，可加 `--strict` |
| `install_plugin(path, *, timeout=60)` | `install-plugin 插件目录 [--timeout 秒]` | `agy plugin install 插件目录` |
| `run(prompt, workspace, *, conversation_id=None, model=None, allow_repl=False, timeout=120)` | `run --workspace 目录 [--conversation-id 编号] [--model 模型] [--allow-repl] [--timeout 秒] -- 提示` | `agy --print`，使用 `--output-format=stream-json` 和 `--print-timeout`；按需加 `--conversation`、`--model` |

`validate_plugin` 只读，可验证本地 ZIP。`install_plugin` 调用一次官方安装命令。安装本地插件前应核实其来源，插件可包含启动钩子和工具程序。若宿主要求配置变量或交互确认，通过宿主完成。[官方插件管理](https://antigravity.google/docs/plugins) · [官方验证说明](https://antigravity.google/docs/build-plugins)

`run` 要求已有工作目录和非空提示。默认开启新会话，只有显式指定 `conversation_id` 才续接。`model` 只影响本次调用。命令行会话可在原工作目录使用 `/resume` 查找。桌面会话在桌面端续接。用桌面会话编号续接时，实测 CLI 1.5.18 返回 `trajectory not found`。官方编辑器协议的会话清单在 AGY 1.5.18 可能返回其他目录的记录，本技能读取本次运行的会话状态。[会话范围](https://antigravity.google/docs/cli/conversations) · [按编号续接](https://antigravity.google/docs/cli/commands/resume) · [编辑器协议](https://antigravity.google/docs/cli/acp)

`allow_repl=True` 或 `--allow-repl` 只为此次 AGY 进程传入本轮设置 `{"permissions":{"allow":["mcp(agy-python-repl_agy-python-repl/run_code)"]}}`。默认省略 `--settings`。此许可针对工作台的 Python 执行工具，具体 Python 代码使用该工具已有的本机访问权限。登录、工具可用性和宿主其他审批规则照常生效。[官方权限语法](https://antigravity.google/docs/permissions)

## 结果、超时和取消

Python 返回字典，命令将同一回执作为 JSON 写到标准输出。`executable` 是选中的 AGY 入口，`exit_code` 保留子进程的实际退出码，`stdout` 和 `stderr` 分别保留宿主输出。`error` 给出本地启动或等待失败的说明，也会保留 AGY 返回的错误原文，例如额度用尽。被拒绝的操作和缺少答复也会注明原因。JSON 缺失、损坏或缺少结束事件时，`output_error` 给出解析原因，原文可供核对。参数或本地路径错误发生在发起请求之前，Python 抛 `ValueError` 或 `OSError`，命令退出 2。

`plugins` 和 `validate_plugin` 把原生 JSON 放在 `data`，校验失败的报告也保留。`install_plugin` 的 `ok` 表示安装命令成功退出；确认插件可用还需核对清单并检查新会话里的实际操作。`run` 的 `events` 保留按顺序读到的事件，完整的结束事件存为 `result`。成功需要进程正常退出、本轮得到 `SUCCESS` 和非空答复，且宿主没有报告被拒绝的动作。续接时还核对结果中的会话编号。工具失败的详情见对应步骤的 `state` 和 `tool_info.error`。[官方非交互模式与事件字段](https://antigravity.google/docs/cli/headless)

`timeout` 限制本地等待时间。`run` 先将期限交给 AGY，再给它最多两秒写回结果；若本地等待也到期，技能终止自己启动的进程，在 POSIX 系统上终止该进程组，返回当时已收到的输出并标记 `timed_out=true`。宿主先返回的错误或中断会保留其原生状态。Python 任务被取消时，技能回收本次进程并传播 `asyncio.CancelledError`。已取得的取消回执位于异常的 `receipt` 属性。取消、超时和断连后，远端请求可能已经执行，检查原会话或安装状态后再决定下一步。

命令保留宿主的非零退出码；信号按 `128 + 信号编号` 返回，本地超时退出 124，键盘中断退出 130。AGY 未能启动，或宿主退出 0 但回执未达到成功条件时，命令退出 1。原生退出码和错误始终保留在回执中。
