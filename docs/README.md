中文 | [English](README.en.md)

# 文档导航

[← 项目首页](../README.md)

先选要解决的问题。部件说明负责安装、参数与限制；教程负责一条完整操作；设计文章解释取舍。

| 你的目的 | 阅读入口 |
| --- | --- |
| 第一次用，想先装一个试试 | [从一个插件开始](getting-started.md) |
| 找能解决当前问题的部件 | [完整部件目录](components.md) |
| 研究 Agent 怎样持续工作 | [整体架构与源码地图](architecture.md) |
| 用自己的配置管理工具接入 | [与 dotfiles 配合](dotfiles.md) |
| 参与开发、修复或维护 | [贡献指引](../CONTRIBUTING.md) · [维护路线](maintenance.md) |

## 按场景读

| 场景 | 教程 | 深入设计 |
| --- | --- | --- |
| 大批结果留在 Python，反复分析 | [持久内核](dsh-python-repl.md) | [DSH 的程序化调用与 Prime 的持久内核](design/python-data-locality.md) |
| 一个会话派活，另一个会话执行 | [控制现有 DSH](dsh-use.md) | [回执、状态和验收](design/controller-worker.md) |
| 后台有变化，再唤醒 Agent | [事件监听](dsh-monitor.md) | [输出与事件边界](design/output-guard.md) |
| 长对话压缩后保留用户要求 | [有界压缩](dsh-compaction-bound.md) | [三代压缩方案](design/three-generations-of-compaction.md) |
| 给已有 Agent 操作网页或 Mac 窗口 | [浏览器](browser-use.md) · [桌面](computer-use.md) | [网页工具的选择](design/browser-control.md) · [桌面工具的选择](design/desktop-control.md) |
| 多个任务共用设备或操作远程机器 | [SSH](remote-host.md) | [任务与目标隔离](design/task-isolation.md) |

其他使用指南：[消息整理](dsh-message-tidy.md) · [图片预算](dsh-image-cap.md) · [历史分页](dsh-history-cap.md) · [输出防护](dsh-output-guard.md)。

## 看演示、查证据

[shot-sheet](../skills/shot-sheet/README.md) 可以把多张截图或视频帧拼成一页，便于集中审查和对比。

各部件的实拍包括 [Python](../dsh-python-repl/README.md#实际效果)、[会话协作](../dsh-use/README.md#实际效果)、[事件唤醒](../dsh-monitor/README.md#实际效果)、[桌面](../skills/computer-use/README.md#实际效果)和[远程主机](../skills/remote-host/README.md#实际效果)。[浏览器旧版实拍](browser-use.md#two-tabs)附原版复现步骤。

演示使用虚构输入；[素材说明](assets/README.md)区分录制结果和结构示意。[测量说明](../benchmarks/README.md)列出复现命令、估算方法与未计入项。单元测试、集成样例与真实外部操作分别报告，不互相代替。

给 AI 助手的导航见 [llms.txt](../llms.txt)。安全问题走[私密报告](../SECURITY.md)。
