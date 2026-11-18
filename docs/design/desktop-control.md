中文 | [English](desktop-control.en.md)

# 共享一台 Mac，点击会落在哪个窗口？

假设便笺应用开了两个都叫「草稿」的窗口。你在一个窗口里打字，助手要按另一个窗口里的「预览」。即使助手截对了图，照着图点一下，也可能点在你正在写的草稿上。本项目的 `computer-use` 让调用方把动作绑定到一个窗口，再按应用提供的控件操作。需要动用桌面上的鼠标或键盘时，它还要检查谁会收到输入。

## 同样叫 computer use，桌面由谁提供？

Computer use 泛指软件观察界面、执行动作、再根据结果决定下一步。Claude 的 computer use 工具、Codex 的桌面功能和本项目的 macOS 工具，分别由不同的产品或程序提供。

Anthropic 的开源 Computer Use Demo 把整个过程摆在一个可以重置的 Linux 桌面上。Claude 提出动作，容器里的程序在 X11 显示器上移动鼠标、点击或输入，再把截图等结果送回模型。人可以通过 VNC 看到同一个桌面。要研究模型怎样从画面选点、或在专用环境里复现实验，这个示例连执行和观察两端都准备好了。Claude 定义了它可以请求的动作，实际在哪台电脑上执行，由接入它的应用决定。

开源工具 Peekaboo 直接面向 Mac。它的 `see` 能给出截图和辅助功能元素的标识，后续命令可以指定确切的窗口号。它支持对能定向投递的动作使用后台模式，也允许明确选择前台操作。需要菜单栏里的权限引导、可独立使用的命令行，或想把同一套动作接给支持 MCP 的助手时，它已经提供了这些入口。

## 为什么保留自己的窗口接口

早期公开的维护说明写明了一项动机。它参考了 OpenAI Codex Computer Use 先观察、再按引用操作的做法，让模型少做反复估算坐标的工作。今天的接口默认读取控件，需要看外观时可以让同一次观察附上窗口截图。

![同一个文本编辑窗口里，三行清单的前两行依次被标为完成](<../assets/computer-use.gif>)

*这段已有演示截自一个真实的「文本编辑」窗口。工具读出三项虚构清单，把前两行的 `[ ]` 改成 `[x]`，最后读回正文。图中保留了工具的旧名。*

定向鼠标和模拟焦点这部分有明确的上游。项目改写了 `iFurySt/open-codex-computer-use` 的两份 Swift 源码，上游又注明其做法来自 Cua Driver 和 yabai。改写记录提到了「文本编辑」里的一个例子。向它发送后台右键事件时，菜单没有弹出。因此，默认的右键优先调用控件提供的「显示菜单」动作，找不到可靠的菜单动作就返回失败。部分定向鼠标操作依赖 macOS 的 SkyLight 私有接口，系统升级可能让这条路径失效。

从今天的代码看，单独维护这一层的价值在于，已有任务可以带着选好的窗口继续工作。Python 程序持有绑定窗口的对象，命令行程序传回同一窗口的引用。两种入口都能据返回结果决定该重新选窗，还是先读一遍草稿，以免重复输入。

- **窗口。** 绑定时读取辅助功能窗口对应的系统窗口号，同时记录应用标识、进程号和进程启动时间。应用重启，或原窗口消失、窗口号匹配到多个窗口时，绑定就失效。再打开一份同名草稿也需要重新选窗。
- **控件。** 应用通过 macOS 辅助功能报告按钮的角色、标签、标识和可执行的动作。按编号找到的按钮须来自完整快照。若原位置换了控件，而快照里有原按钮的标识，工具会在窗口内找同一角色和标识。新控件也叫「预览」，不足以接替它。原按钮支持「按下」时，可以直接让按钮执行动作，不必移动鼠标。
- **屏幕坐标。** 按窗口号截图可以看到被别的窗口盖住的内容。绑定窗口截不到就报错，只有未绑定的截图才可能退回按屏幕区域截取，把遮挡物一并拍下来。控件测量给出的是快照当时的屏幕坐标，遮挡状态为未知。只有调用方明确选择全局鼠标模式，才会移动真实指针。投递前要检查该点实际命中的应用、绑定的窗口，以及盖在该点最上方的窗口属于哪个应用。其他应用遮住了按钮，这次全局点击就会被拒绝。

## 用户切到另一份草稿时

辅助功能权限用于读取和操作控件，屏幕录制权限用于截图，合成键鼠事件另有投递权限检查。这些权限授给实际执行动作的宿主进程。具体允许改哪一份草稿，仍由用户决定。非浏览器应用按任务登记归属，共用浏览器则按窗口给每条命令加短锁。发送键鼠事件还要取得共用的输入锁。人随时可以在两次检查之间切窗。

向绑定窗口输入文字时，程序复查前台应用和焦点窗口，并检查当前接收输入的控件是否仍在该窗内。同一窗内有两个输入框时，这项检查只核对窗口归属。用户先一步切走，结果是 `not_sent`，也就是尚未发送。若已经发出一部分按键，结果是 `unknown`。此时应重新读目标窗口的内容，整段重打可能让第一个字出现两次。只在画布上画出按钮的应用也会遇到限制。即使看得到按钮，助手也可能找不到可在后台按下的控件。

在已有组件测试环境的 Mac 上，从仓库根目录运行下面的命令即可复核。

```sh
uv run --no-sync --project skills/computer-use python -B -m unittest discover \
  -s skills/computer-use/tests -p test_native.py -k text_focus_change
```

测试给实际的 Swift 文字发送函数传入 `A中😀`，用记录按键的替身接收事件。模拟在输入前失焦时，记录为空。模拟在第一个字符之后失焦时，只留下这个字符的一次按下和一次抬起。它验证停止的位置，实际应用是否把字写进草稿，仍要从窗口里读回来。

## 代码、测试与官方资料

- 设计原意、改写范围和许可署名。[维护说明](../../skills/computer-use/references/maintenance.md#设计来源) · [改写记录](../../skills/computer-use/VENDORED.md) · [第三方声明](../../skills/computer-use/THIRD_PARTY_NOTICES.md)
- 窗口身份、输入投递和遮挡字段。[Swift 执行器](../../skills/computer-use/bin/computer-use.swift) · [Python 元素对象](../../skills/computer-use/src/computer_use/elements.py)
- 可复核的窗口替换、失焦和快照用例，以及任务之间如何交接。[原生边界测试](../../skills/computer-use/tests/test_native.py) · [Python 接口测试](../../skills/computer-use/tests/test_contract.py) · [任务隔离设计](task-isolation.md)
- Peekaboo 的本机入口、快照和前后台模式。[项目说明](https://github.com/openclaw/Peekaboo/blob/v4.9.9/README.md) · [自动化指南](https://github.com/openclaw/Peekaboo/blob/v4.9.9/docs/automation.md)
- Anthropic 的专用桌面、操作循环和坐标执行。[Claude 工具接口](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) · [示例说明](https://github.com/anthropics/anthropic-quickstarts/blob/5264b729deda905dba3e5402d717bebed000325c/computer-use-demo/README.md) · [桌面工具源码](https://github.com/anthropics/anthropic-quickstarts/blob/5264b729deda905dba3e5402d717bebed000325c/computer-use-demo/computer_use_demo/tools/computer.py)
- 定向事件所改写的上游文件。[SkyLight 接口](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyLightSPI.swift) · [点击与模拟焦点](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyClickSimulation.swift)
