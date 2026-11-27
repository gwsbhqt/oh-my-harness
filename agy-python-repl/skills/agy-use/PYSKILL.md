---
name: agy-use
description: 通过官方 Sidecar 桥接控制正在运行的 Antigravity App（列出、定位、新建、向指定已有桌面会话发消息、等待并读取转录回复，以及重命名、归档和删除），并把 agy CLI 命令明确区分为 cli-* 独立入口。
---

# agy-use

有 Python 技能内核时读取 [Python 使用说明](PYSKILL.md)，直接调用 `skills.agy_use` 完整下划线入口；无内核的传统代理读取 [标准使用说明](SKILL.md)，使用 `agy-use`。读取、导入或调用失败时先报告并定位，不得换方式绕过接口。完整参数、套接字约定、退出码和异常边界见 [参数与回执](references/commands.md)。

本技能默认面向 **正在运行的 Antigravity App 桌面会话**，通过随插件提供的官方 Sidecar（`agy-python-repl/app-bridge`）连接本机当前账户可访问的 Unix 套接字。`agy` CLI 的独立命令与桌面会话不共享编号，全部归在 `cli-*`（Python 为 `cli_*`）子命令下。

## 检查桌面 Sidecar 与定位会话

先确认桌面 App 正在运行且 `agy-python-repl/app-bridge` Sidecar 已启用，再列出或按关键词筛选桌面会话。`sessions` 默认隐藏已归档会话；全量扫描传 `limit=0`（命令行 `--limit 0`）。目标可传完整编号或至少 4 位的唯一前缀，歧义或不存在时直接报错，不猜替代会话。

```python
state = await skills.agy_use.health()
listed = await skills.agy_use.sessions(query="demo", limit=20)
detail = await skills.agy_use.get("11112222")
```

## 新建与向指定已有会话发消息

`send` 先核对当前桌面会话并保存发送前的步号。启用等待后，它按收件正文找到这一条消息，再读取同一轮的最终答复。若先发送、稍后再等，请保留回执中的会话编号、`since_step` 和 `prompt`。

```python
created = await skills.agy_use.new("请只回复 READY。", title="smoke-check", wait=True, timeout=60)
sent = await skills.agy_use.send("11112222", "请继续核对上一轮结果。", wait=True, timeout=120)
receipt = sent["receipt"]
waited = await skills.agy_use.wait(receipt["conversation_id"], since_step=receipt["since_step"],
                                   expected_prompt=receipt["prompt"], timeout=120)
```

发送或等待超时、断开或取消时，保留已有回执。用回执中的 `since_step` 和原正文继续等，或用 `read` 检查同一会话里的后续事件。

## 读取回复与管理桌面会话

`read` 读取同一 `conversation_id` 对应的本地 `transcript.jsonl`（或完整转录）及实时 `run_state`，`last` 返回最近一条助手回复并标明是否截断。`rename`、`archive`、`update` 和 `delete` 只在用户明确授权时对指定会话执行；`delete` 不可撤销。

```python
steps = await skills.agy_use.read("11112222", from_step=0, limit=20)
reply = await skills.agy_use.last("11112222", chars=4000)
renamed = await skills.agy_use.rename("11112222", "新的会话标题")
archived = await skills.agy_use.archive("11112222")
```

## 独立 `agy` CLI 入口

下列入口只操作独立安装的 `agy` 命令行工具，**不能**用于读取或续接 Antigravity App 桌面会话（CLI 传入桌面会话编号会报 `trajectory not found`）。仅在明确需要查询 CLI 版本、CLI 模型目录、插件列表、校验/安装本地插件或跑一轮非交互 CLI 会话时使用。

```python
version = await skills.agy_use.cli_status()
models = await skills.agy_use.cli_models()
plugins = await skills.agy_use.cli_plugins()
checked = await skills.agy_use.cli_validate_plugin("./demo-plugin", strict=True)
ran = await skills.agy_use.cli_run("只回复 READY。", workspace="./demo-workspace", timeout=60)
```
