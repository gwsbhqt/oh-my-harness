---
name: dsh-control
description: 控制正在运行的 DSH：查询会话与回复，派任务并按回执等待，发送桌面通知，管理授权会话、模型、插件和配置，执行检查及重启。
version: 0.1.0
author: dsh-control
license: MIT
metadata:
  hermes:
    tags: [dsh, deepseek-harness, dsh-control, coding-agent]
    related_skills: []
---

# dsh-control

有 Python 技能内核的 agent 读取 [PYSKILL.md](PYSKILL.md)，直接调用 `skills.dsh_control` 完整下划线入口；无内核的 agent 读取 [SKILL.md](SKILL.md)，使用正式命令行入口。只有未提供 PYSKILL.md 时才读取 SKILL.md；读取、格式、导入或调用错误必须先报告并处理，不得换说明、shell、subprocess 或临时脚本绕过接口。两份说明属于同一正式技能，只在示例调用方式上不同。

Raycast 里的 Gemini 要用 stdio MCP 把任务派给 DSH 快档模型时，接入方式、自定义指令、数据与授权边界见 [references/raycast.md](references/raycast.md)。

只读查询不需要额外资料；发消息、改动会话或配置、重启前，先读 [共用规则](references/common.md) 里对应的段落，下文各处已链到具体段落。完整命令与选项见 [命令参数参考](references/cli.md)，函数签名和参数编码见 [函数参数参考](src/dsh_control/__init__.py)。

控制用户电脑上已经运行的 DSH，消息与界面发送走同一条路，用户能看到经过。简单本地文件修改直接完成，不必另派任务。授权、任务归属、取消、防重发及重启只在共用规则维护。

## 主动通知用户

需要提醒用户时，可用 `notify` 以 DSH 身份发送 macOS 通知。默认标题是「DSH」、正文是「有一条新通知」，并播放提示音；三项可分别替换或关闭，至少保留一项。正文可作为第一个参数直接写，也可以用正文选项，但不能同时使用。没有设置其他默认机器时发到本机；指定机器时发到对应机器。`notice` 是发给会话的消息，不是桌面通知。

```python
await skills.dsh_control.notify("任务完成")  # 正文、默认标题和声音
await skills.dsh_control.notify("可以查看结果了", title="任务完成", sound=False)
await skills.dsh_control.notify(title=False, body=False)  # 只有声音
```

声音走普通音频，受电脑音量控制，可能不受专注模式和 DSH 通知声音开关控制；系统通知是否显示由 macOS 的通知设置决定。通知停留时间不能按秒指定；在 macOS 系统设置中将 DeepSeek Harness 的通知样式设为「提醒」，通知会一直显示到手动隐藏，该设置影响 DSH 的所有系统通知。返回未确认时通知可能已发出，不要自动重发。

## 在线检查与定位

先检查在线状态，核对退出码、`ok`、`status`、`error` 和目标机器。

```python
state = await skills.dsh_control.health()
state
```

通信口不可用退出 69；按共用规则核对授权后保证 DSH 运行，仍失败再做检查。不要绕过桌面环境保护直接打开远端 App。

```python
await skills.dsh_control.start()
# 仍失败时：
await skills.dsh_control.doctor()
```

再查工作区、运行会话、目标状态和回复：

```python
await skills.dsh_control.sessions(running=True)
await skills.dsh_control.workspaces()
await skills.dsh_control.sessions(query="标题关键词", limit=0)
await skills.dsh_control.status("会话编号")
await skills.dsh_control.last("会话编号", chars=6000)
await skills.dsh_control.read("会话编号", turn=-1, tools=True)  # 这一轮正文在 data["text"]
```

会话可用完整编号、首尾至少 4 位或标题词，歧义时核对候选，不猜。列表默认不含存档、空白会话和子代理；全量读取需显式指定不限制数量，空白与存档分别显式包含。工作区筛选接受编号、名字或路径；未分组只按工作区登记集合判断普通会话，不按目录猜，也不能与工作区筛选同时使用。

## 核对目标机器

查询与写入必须保持同一目标，远端失败不退回本机。显式本机选项与指定机器互斥。默认机器只属于 dsh-control；先查询，只有任务需要时才修改，完成后按任务约定恢复。切换和恢复默认机器、跨机器重启通知的写法见 [选择机器](references/cli.md#选择机器)。

```python
await skills.dsh_control.health(host="alpha")
await skills.dsh_control.use()
```

## 派任务与保存回执

用户授权派单后，任务描述写清目标、限制和验收标准；目标会话看不到当前完整对话。派单时用 `notify` 登记做完通知，目标真做完后由 DSH 给派单会话送一条插件通知，派单方不用另起轮询，也不怕 DSH 重启；在 DSH 会话里写 `notify="self"` 就是通知自己。

```python
sent = await skills.dsh_control.send("会话编号", "任务目标、限制和验收标准", notify="self")
if sent["exit_code"] == 0 and sent.get("ok"):
    receipt = sent["data"]          # sessionId、since、requestId、notify.watchId
```

```python
await skills.dsh_control.new("工作区名或绝对路径", "任务与验收标准", tier="normal", notify="self")
```

「真做完」只看宿主的实时状态：这一轮结束、没在跑、没有排队消息，名下和子代理名下没有在跑的后台任务，子代理不在干活，持续目标不会自动续跑，且保持 3 秒。目标一轮结束后还挂着自己的后台任务时不算做完，任务跑完它被叫醒接着做，最后才通知。不要再看回复里的字（「在等」「跑完了」）判断做没做完。通知只送一次，同一个目标多次带 `--notify` 也只送一次；失败、中止、会话不见了也送并写明；中途停下等回答会先另送一条提醒。通知对象一般和目标在同一台 DSH 上；用 `-H` 派到别的机器时写 `self`，由本机后台观察进程盯远端，真做完后通知本机发起会话（`chat` 不支持跨机器 `self`）。

要在本轮里拿结果时，用同一口径等：`wait(..., settled=True)`，或 `chat(..., settled=True)` 一步发完等完。

```python
result = await skills.dsh_control.wait(receipt["sessionId"], since=receipt["since"], settled=True, timeout=1800)
```

回执中的 `sessionId`、`since` 和 `requestId` 必须保存，后续等待继续使用同一机器和起点。回执里 `notify.error` 表示消息已发出、通知没登记上：不要重发，改用 `wait(settled=True)`。绝对路径只开会话，不登记工作区。

合并发送和等待的操作也要先检查 `receipt`，任何等待失败都不能重新发送。独立任务默认排下一轮；纠正当前方向用插话，用户要求立即停止才按授权中断。已排修正先查队列，再按稳定消息编号处理。具体选择和防重发规则见 [发送回执与防重发](references/common.md#发送回执与防重发)。


## 等待结果与回答问题

只想知道某个会话何时停下时，用 `await skills.dsh_control.wait_idle("会话编号", timeout=3600)`；不指定会话则等待全部会话。空闲只代表当下没有运行或排队，不检查后台任务，也不代表任务成功；退出 10 是等回答，124 是超时。长时间等待可交给 `repl.background(...)`，完成后收取结果。

按 [结果和取消](references/common.md#结果和取消) 判断终态：退出 0 且最后一轮 `completed` 才完成；不带 `settled` 的 `wait` 只代表这一轮结束，目标可能还挂着后台任务，要判断任务做完必须带 `settled=True`。任务失败或中止退出 1；退出 10 原样转达问题与选项，用户回答后再从原起点等；退出 11 核对没有新内容；退出 124 先查状态并汇报真实进度，再继续等。不能把等待输入、空闲或超时当完成。

```python
# 仅在用户已回答该问题后执行，再从原 since 等待。
await skills.dsh_control.answer("会话编号", select=["选项"])
```

保存完整输出和退出码，核对 `data.turns` 的结束原因与回复。函数结果额外保留 `exit_code`、完整 `stdout`、`stderr`，非零退出仍返回字典，不自动抛业务异常；文本结果与协议错误解释见共用规则。普通后台等待记录任务编号并收取退出码；取消本地等待不等于取消目标会话，取消传播与消息不可撤销边界见共用规则。

## 模型、管理与批量操作

先看实际可用档位与理由，再只挑不改。开发默认主力档，轻量档只用于很简单的任务；模型保护与权限见 [模型与批量操作](references/common.md#模型与批量操作)。

```python
await skills.dsh_control.models()
await skills.dsh_control.pick("normal")
# 以下写操作须已有相应授权：
await skills.dsh_control.rename("会话编号", "新标题")
await skills.dsh_control.model("会话编号", model="provider/model", force=True)
```

`new`、`model`、`send` 和 `chat` 可传 `effort="high"` 指定推理档位；可选值以所选模型目录为准，不支持时会报错并列出可选值。`model("会话编号", effort="medium")` 只改档位并保留当前模型。已开始的会话修改档位同样受保护；用户已明确要求切换时，等会话停下后可使用 `force=True`，它也会跳过运行中保护。

```python
await skills.dsh_control.new("example-workspace", model="provider/model", effort="high")
```

批量存档先获得范围授权，再读取全部未分组候选，核对 `meta.shown == meta.matched`，使用授权范围内的完整会话编号逐项处理，再复查同一列表。活动任务被拒时按共用规则处理，不把部分完成报成全部完成。

```python
await skills.dsh_control.sessions(ungrouped=True, include_blank=True, limit=0)
```

取消存档、重命名、分叉、换目录、目标与提醒管理、装卸插件、改配置及通用接口写入前，必须遵守 [权限边界](references/common.md#权限边界)。不熟悉的接口先查描述并按真实 schema 调用；Hermes 等外部 agent 按本技能的命令行用法接入；安装见 [插件说明](../../README.md)。已授权把后台服务挂到原会话时，先按 [检查与重启](references/common.md#检查与重启) 核对原命令、工作目录并精确停止旧任务，再用 `monitor` 挂上并实测端口；它只确认进程已启动，不保证服务已就绪。

## 检查与重启

先逐条阅读 [检查与重启](references/common.md#检查与重启)。需要重启的授权任务，先完成插件规定检查，再通过离线和在线检查，全部通过就直接后台重启。

```python
checked = await skills.dsh_control.doctor()
if checked["exit_code"] == 0 and checked.get("ok"):
    queued = await skills.dsh_control.restart(detach=True)
```

回执只证明已转后台。保存请求编号，结束本轮等通知，再查同一请求的阶段与终态并验证实际改动。不要用后台任务或 Monitor 等这次重启。热加载前置更新、重复请求、跨机器通知、目标自动续轮、后台任务和退出路线的全部规则均以共用规则为准。

```python
await skills.dsh_control.restart_status(request_id="回执中的UUID")
await skills.dsh_control.quit_check()
```

查询退出 0 只证明读到记录，需看 `data.phase`；旧实例已退出、新实例身份不同且必要服务就绪才算完成。通知的已记录、已安排与实际回复必须区分；跨机器请求和监听编号的查法见 [检查与重启](references/common.md#检查与重启)。等待、通知或前置更新失败后，先查实际阶段与日志，再决定下一步，不能重放已执行更新。

## 参数与收尾

下列示例展示完整答案对象与通用命令入口，使用前核对真实问题或命令描述：

```python
# answer 的 json 选项可传完整答案对象；编号和选项取自实际问题。
await skills.dsh_control.answer("会话编号", json={"answers": [{"id": "问题编号", "selected": ["选项"]}]})
await skills.dsh_control.run("help", "sessions")
# 同名函数与 run 共用编码：选项用下划线，True 为开关，False/None 不传，
# 列表重复选项，字典编码 JSON；位置参数保留原文，不自行拼 shell。
```

所有公开控制函数均为异步函数，函数调用都要 `await`。通用入口与同名函数走相同校验与目标选择，不提供绕过权限或保护的路径。选项编码、完整答案、命令行 JSON 和函数结果的区别见两份参数参考。

只做本次授权操作，核对任务终态、实际产物和未验证项；其余管理参数见 [命令参数参考](references/cli.md)。重启、回执、取消和权限规则保留在 [共用规则](references/common.md) 单一维护，不能凭收到通知或进程退出就宣布任务完成。
