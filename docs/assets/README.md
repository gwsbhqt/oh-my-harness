中文 | [English](README.en.md)

# 演示素材录制清单

这份清单说明每个演示该怎样录制和验证。各部件的说明链接到已经完成的录屏和截图。

| 文件 | 需要录制的真实操作和证据 | 用在哪里 |
| --- | --- | --- |
| `python-data-locality.gif` | 把真实终端输出节选与真实 DSH 会话回放放在一起。两边筛选同一份虚构日志，会话中复用内存变量。标明节选，并展示 [results.json](../../benchmarks/results.json) 中两项可重复的文本量估算。 | [dsh-python-repl 部件说明](../../dsh-python-repl/README.md)。 |
| `controller-worker.gif` | 使用两个已授权的测试会话。主控发送明确任务，记录回执后停止轮询。长工执行任务。展示通知送达、主控检查，以及实际的纠正或验收。不要编造用量或耗时计数。 | [dsh-control 部件说明](../../dsh-control/README.md)。 |
| `browser-control.gif` | 使用本地虚构页面或示例页面，不登录账号。绑定任务窗口和确切页面，做一个看得见的改动，再检查结果。 | [browser-control 部件说明](../../skills/browser-control/README.md)。 |
| `computer-control.gif` | 已录制并审查：绑定 macOS 文本编辑窗口，使用虚构清单，修改两项，并通过原生文字读回核对。16 秒动图展示八个标有节选说明的截图步骤。 | [computer-control 部件说明](../../skills/computer-control/README.md)。 |
| `monitor.gif` | 跟随一个本地事件来源，产生已知示例事件。结束 Agent 当前轮次，再发出事件，展示会话被唤醒并采取行动。说明使用哪种投递模式。不能让模型轮询、重复启动监控器或伪造事件到达。 | [dsh-monitor 部件说明](../../dsh-monitor/README.md)。 |
| `bounded-display.png` | 录下真实的大段虚构输出，包含实际显示的开头、结尾和完整文本保存位置。核对保存内容与保留的 Python 值。它演示交互执行环境 REPL 的输出预算，不是模型输出流防护。 | [dsh-python-repl 部件说明](../../dsh-python-repl/README.md)。 |
| `remote-host.png` | 使用明确授权的测试目标，进行只读检查或复制虚构样例。展示实际选中的机器和内容核对结果。隐藏账号与网络信息。 | [remote-host 部件说明](../../skills/remote-host/README.md)。 |

私人窗口、通知、账号数据、机器标识、用户名、私有路径、菜单栏身份信息和凭据都不能进入录制区域。优先只录相关窗口。发布前审查抽取的帧。不要为了让演示更逼真而登录账号。

素材应紧凑，适合放进部件说明。如果加速播放，要在画面中标明倍速。事件流中断或操作未确认时，必须保留不确定性，不能剪成虚假的成功。素材合入后检查所有写到的路径。某段录制通过审查后，删除相关文档中对应的待录说明。尚未完成的录制仍保留提示。

[首页](../../README.md)上的 CI 和发布徽章链接到 GitHub Actions 和版本发布页。
