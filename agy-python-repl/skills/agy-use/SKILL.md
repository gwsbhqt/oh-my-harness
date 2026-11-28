---
name: agy-use
description: 通过 Antigravity App 的官方 Sidecar 列出和管理桌面会话，向指定会话发送消息，并核对同一会话的收件和回复。
---

# agy-use

有 Python 技能内核时读取 [Python 使用说明](PYSKILL.md)，直接调用 `skills.agy_use` 完整下划线入口；无内核的传统代理读取 [标准使用说明](SKILL.md)，使用 `agy-use`。读取、导入或调用失败时先报告并定位，不得换方式绕过接口。完整参数、套接字约定、退出码和异常边界见 [参数与回执](references/commands.md)。

`agy-use` 通过随插件提供的官方 Sidecar（`agy-python-repl/app-bridge`）连接正在运行的 Antigravity 桌面 App。

## 检查桌面 Sidecar 与定位会话

先确认桌面 App 正在运行且 `agy-python-repl/app-bridge` Sidecar 已启用，再列出或按关键词筛选桌面会话。`sessions` 默认隐藏已归档会话；全量扫描传 `limit=0`（命令行 `--limit 0`）。目标可传完整编号或至少 4 位的唯一前缀，歧义或不存在时直接报错，不猜替代会话。

```sh
agy-use health
agy-use sessions --query "demo" --limit 20
agy-use get 11112222
```

## 新建与向指定已有会话发消息

把首条任务传给 `new`，可以当场等待，也可以先保存创建回执。稍后核对首轮回复时，用回执中的会话编号、`since_step` 和 `prompt`，并启用首条用户输入匹配。只传标题会创建空会话。

```sh
agy-use new "请只回复 READY。" --title "smoke-check"
agy-use wait 11112222 --since-step -1 --expected-prompt "请只回复 READY。" --allow-user-input --timeout 120
```

`send` 先核对当前桌面会话并保存发送前的步号。启用等待后，它按收件正文找到这一条消息，再读取同一轮的最终答复；若只需严格确认对方已收件、不等本轮结束，使用只等收件确认选项（只返回确认标志、步骤索引和必要错误/状态字段，不输出事件或对话资料）。若先发送、稍后再等，请保留回执中的会话编号、`since_step` 和 `prompt`。

```sh
agy-use send 11112222 "请继续核对上一轮结果。" --wait --timeout 120
agy-use send 11112222 "请收件。" --wait-receipt --timeout 20
agy-use wait 11112222 --since-step 4 --expected-prompt "请继续核对上一轮结果。" --timeout 120
agy-use wait 11112222 --since-step 4 --expected-prompt "请收件。" --receipt-only --timeout 20
```

`status=unanswered` 且 `receipt_confirmed=true` 表示 App 已收件，但未观察到本轮最终文字回复。请结合返回里的非内容字段 `diagnosis`（或用 `read` 查看 `diagnosis`）区分 `still_running`、`transport_error` / `step_error`、`cancelling` / `user_cancelled` 或 `unknown_idle`，并按 `next_action` 与 `unsettled_tool_calls` 决策：任何已发送请求均不提供自动重发推荐；`completed` 严禁重发，`cancelling`/`user_cancelled` 严禁自动续接，存在 `unsettled_tool_calls` 或已触发工具调用时先核清目标产物后再在原会话发一条不重复副作用的显式续接消息。发送或等待超时、断开或本地中断时也保留回执，需要复核时用原来的 `since_step` 和正文再次调用 `wait`。

## 读取回复与管理桌面会话

`read` 读取同一 `conversation_id` 对应的本地 `transcript.jsonl`（或完整转录）及实时 `run_state`，`last` 返回最近一条助手回复并标明是否截断。`rename`、`archive`、`update` 和 `delete` 只在用户明确授权时对指定会话执行；`delete` 不可撤销。

```sh
agy-use read 11112222 --from-step 0 --limit 20
agy-use last 11112222 --chars 4000
agy-use rename 11112222 "新的会话标题"
agy-use archive 11112222
```

## 与 DSH 跨宿主派单与做完通知协作

从 Antigravity 桌面会话向本机 DSH 派单并要求真做完后只回传当前 AGY 会话一次时，使用 `dsh-use` 的 `--notify`（底层由 DSH 按 `wait --settled` 终态判定后，调用本机 `agy-use send --wait-receipt` 经 `bridge.sock` 严格确认收件一次并仅传任务编号、明确状态和 watch ID，不读密钥且未确认收件不重发）：终端工具中环境带 `ANTIGRAVITY_CONVERSATION_ID` 时可直接传 `self`，Python REPL 内核不继承该环境变量，须显式传 `agy:<当前AGY会话UUID>`。

```sh
# 在 Antigravity 终端工具（含 ANTIGRAVITY_CONVERSATION_ID）中：
dsh-use send <DSH会话> "任务目标与验收标准" --notify self --json
# 或显式指定目标 AGY 会话：
dsh-use send <DSH会话> "任务目标与验收标准" --notify agy:11112222-bbbb-0000-0000-000000000002 --json
```
