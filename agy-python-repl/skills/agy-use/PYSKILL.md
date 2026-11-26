---
name: agy-use
description: 通过本机 Antigravity CLI 查看版本、可用模型和插件，验证或安装已授权的本地插件，在专用工作目录新开或续接一轮会话并核对原始事件。
---

# agy-use

有 Python 技能内核时读取 [Python 使用说明](PYSKILL.md)，直接调用 `skills.agy_use`。传统命令行读取[标准使用说明](SKILL.md)，使用 `agy-use`。加载或调用失败时按原错误排查。函数、命令、超时和权限的完整约定见[参数与回执](references/commands.md)。

## 查看本机状态

`status` 返回实际使用的 AGY 路径和版本。`models` 的 `stdout` 列出可用模型的 ID 和显示名称，ID 可用于选择本轮模型。`plugins` 读取当前账号安装的插件及启用状态。插件列入清单后，还可用一次专用会话检查工具能否实际运行。

```python
state = await skills.agy_use.status()
models = await skills.agy_use.models()
installed = await skills.agy_use.plugins()
state["stdout"], models["stdout"], installed.get("data")
```

## 校验和安装本地插件

先检查目标目录、清单或 ZIP。查看回执的 `data.findings`，需要把警告也列为失败时使用 `strict`。

```python
check = await skills.agy_use.validate_plugin("./demo-plugin")
check["ok"], check.get("data")
```

获得安装这个本地插件的授权后，交给 AGY 的安装入口须是插件目录。安装会影响此账号的新会话。安装后按名称、启用状态、来源和版本核对清单。

```python
install = await skills.agy_use.install_plugin("./demo-plugin")
installed = await skills.agy_use.plugins()
install["ok"], installed.get("data")
```

## 在专用目录发起一轮会话

准备只含本次任务材料的工作目录，示例使用 `./demo-workspace`。提示将发送给当前 AGY 配置的模型，工具沿用宿主权限。目录用于划分会话上下文，文件访问范围由宿主的权限和沙箱设置决定。

```python
reply = await skills.agy_use.run("只回复 READY。", workspace="./demo-workspace", timeout=60)
reply["ok"], reply.get("result"), reply.get("error")
```

一轮默认限时 120 秒。长任务可把 `timeout` 设为 `0`，命令行使用 `--timeout 0`。这会等待当前这一轮自然结束。运行期间可取消 Python 任务或在终端按 `Ctrl-C`，取消回执保留已经收到的输出。

新会话的编号在 `result.conversation_id`。用户明确要求续接时，在原工作目录中传入这个编号。下面的示例需要先把示例编号换成实际值。

```python
reply = await skills.agy_use.run("用一句话总结上轮。", workspace="./demo-workspace",
                                 conversation_id="conversation-id")
reply["ok"], reply.get("result"), reply.get("error")
```

## 本轮允许工作台执行 Python

任务已授权在本机运行 Python，并且 `agy-python-repl` 已启用时，可显式开启 `allow_repl`。AGY 在本轮允许工作台的 `run_code` 执行模型写的 Python 代码，作用于整个工具。其他工具继续由 AGY 按当前设置审批。默认沿用宿主设置；遇到拒绝时保留原始回执。

```python
reply = await skills.agy_use.run("用 Python 计算 21 × 2 并给出结果。", workspace="./demo-workspace",
                                 allow_repl=True)
reply["ok"], reply.get("result"), reply.get("error")
```

## 核对结果和工具调用

先看技能回执的 `ok`、`exit_code`、`timed_out` 和宿主返回的 `result`。即使 AGY 退出码为 0，`result.denied_actions` 也可能有被拒绝的操作。`events` 保留每个原始事件，包括失败步骤和已有的部分输出。一轮取得答复后，仍需按任务要求核对实际产物。

核对工具调用时查看 `step_update` 的 `conversation_id`、`step_index`、`step_type`、`state` 和 `tool_info`。同一步可能先报告 `ACTIVE` 再报告 `DONE`。对于 `call_mcp_tool`，还要从 `tool_info.parameters` 核实被调用的具体工具，并检查输出或错误。`init.tools` 只描述可见的工具，模型自述只属于答复内容。

超时或取消后，已发生的安装和模型请求仍可能生效。保留原回执，用插件清单或原工作区的 `/resume` 核对。确认结果前停止重复发送。专用目录和会话由调用者管理。
