中文 | [English](components.en.md)

# 按问题找部件

[← 首页](../README.md) · [文档导航](README.md) · [开始安装](getting-started.md)

插件装进 DSH；技能提供 Agent 可调用的操作入口。每个部件的说明维护自己的安装方式、平台要求和限制。源码构建需要保留相邻的共享目录，见[仓库结构](architecture.md#目录为什么这样放)。

## 执行与协作

| 部件 | 解决什么问题 | 接着读 |
| --- | --- | --- |
| [dsh-python-repl](../dsh-python-repl/README.md) | 在同一 Python 进程里连续调工具，保留结果、函数和可恢复的状态。 | [教程](dsh-python-repl.md) · [设计](design/python-data-locality.md) |
| [dsh-use](../dsh-use/README.md) | 从 CLI、Python 或 MCP 接上正在运行的 DSH；派活、保留回执、等结果、发通知。 | [教程](dsh-use.md) · [协作技能](../dsh-use/skills/dsh-supervise/SKILL.md) |
| [dsh-monitor](../dsh-monitor/README.md) | 把后台程序的事件送进会话，变化发生时再唤醒 Agent。 | [教程](dsh-monitor.md) |
| [dsh-guard](../dsh-guard/README.md) | 发现复读、空输出等异常，限制重试，并帮助长期目标停止空转。 | [教程](dsh-output-guard.md) |

## 操作电脑

| 技能 | 目标与能力 | 接着读 |
| --- | --- | --- |
| [browser-use](../skills/browser-use/README.md) | 日常 Cra 网页走官方 MCP。Chrome 页面支持观察、点击、输入、截图及远端操作。 | [教程](browser-use.md) |
| [computer-use](../skills/computer-use/README.md) | macOS 原生应用和窗口：读界面、定向输入、截图与核对。 | [教程](computer-use.md) |
| [remote-host](../skills/remote-host/README.md) | 通过 SSH 在明确的目标主机执行、传输和核对结果。 | [教程](remote-host.md) |

它们共用 [`skills/_shared`](../skills/_shared/README.md) 的传输与选机代码。这里的 browser-use 是本仓库提供的技能，与同名的 [browser-use 项目](https://github.com/browser-use/browser-use)分别维护。

## 验证与演示

| 工具 | 能做什么 | 使用入口 |
| --- | --- | --- |
| [shot-sheet](../skills/shot-sheet/README.md) | 把多张截图拼成审查图，从 GIF 或视频抽帧，制作前后对比与标注。 | [Python 与命令行示例](../skills/shot-sheet/README.md#常用操作) |

## 上下文与检索

| 部件 | 什么时候用 |
| --- | --- |
| [dsh-compaction-bound](../dsh-compaction-bound/README.md) | 对话太长需要压缩，同时保留用户原话和有长度上限的清单。 |
| [dsh-message-tidy](../dsh-message-tidy/README.md) | 系统提示重复、来源不清；想减少自动注入的噪声。 |
| [dsh-image-cap](../dsh-image-cap/README.md) | 截图多，需要限制发给模型的图片大小和张数。 |
| [dsh-history-cap](../dsh-history-cap/README.md) | 长会话打开慢，需要界面分页加载。它不减少模型上下文。 |
| [dsh-session-link](../dsh-session-link/README.md) | 想按需读另一个会话的概览、单轮或搜索结果。 |
| [dsh-grep-scope](../dsh-grep-scope/README.md) | 需要连隐藏和被忽略的文件一起搜，并看清无法读取的范围。 |
| [dsh-prompt-prefix](../dsh-prompt-prefix/README.md) | 固定的工作规范、技能目录和记忆画像需要稳定排列，便于前缀缓存复用。 |

## 界面与运行维护

| 部件 | 什么时候用 |
| --- | --- |
| [dsh-runtime](../dsh-runtime/README.md) | 桌面启动找不到命令，或需要保留软链接的配置写入。 |
| [dsh-doctor](../dsh-doctor/README.md) | 重启前核对配置、依赖、构建产物和隔离试启动结果。 |
| [dsh-settings](../dsh-settings/README.md) | 统一编辑模式偏好、技能和快捷回复，使用一致的草稿与保存操作。 |
| [dsh-session-tidy](../dsh-session-tidy/README.md) | 批量归档工作区里已经结束的会话，并保留恢复入口。 |
| [dsh-session-ui](../dsh-session-ui/README.md) | 看清正在跑的任务、当前阻碍、会话统计，并打开回复中的真实文件路径。 |

## 学习与维护材料

[架构与源码地图](architecture.md) · [设计文章](README.md#按场景读) · [可复现测量](../benchmarks/README.md) · [与 dotfiles 配合](dotfiles.md) · [维护路线](maintenance.md)
