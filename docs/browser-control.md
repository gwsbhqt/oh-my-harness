中文 | [English](browser-control.en.md)

# 使用 browser-control

任务发生在网页里时，使用 browser-control。例如查看表单、检查页面跳转过程、截图，或核对授权操作后的变化。它通过 Chrome DevTools Protocol（CDP，即浏览器调试协议）控制明确选中的 Chrome 或 Arc 页面。浏览器菜单、操作系统对话框和原生弹窗交给 computer-control。

## 从一个明确的页面开始

控制端和浏览器支持的平台都是 macOS。工具需要 Python 3.12 或更新版本，以及可用的浏览器调试入口。Arc 只支持连接已有浏览器的 attach 模式。启用检查设置，不代表调试入口已经接受连接。

先探测状态并列出页面，再选择目标。在 Python 技能内核中，一次虚构的检查可以这样开始：

```python
status = await skills.browser_control.status(browser="Chrome", host="local")
tabs = await skills.browser_control.tabs(browser="Chrome", host="local")
```

先检查返回结果。如果恰好有一个已加载页面符合虚构标题“Example Library”，再明确绑定它：

```python
page = await skills.browser_control.find_tab(
    "Example Library", browser="Chrome", host="local", session="example_review"
)
snapshot = await page.snap(shot=True)
```

整个任务都保留返回的页面引用。它固定机器、浏览器、会话和页面，不会跟着当前活动标签页走。命令行操作也要求明确指定 scope 或 session。在添加跳转、元素操作或截图选项前，先读工具说明链接的接口参考。

## 操作后确认结果

先检查，再执行已授权的改动，最后重新取态。以虚构表单提交为例，确认完成需要看到提交后的页面状态和预期保存值，而不只是收到点击成功的响应。用截图检查外观，用结构化页面信息检查标签、值和跳转状态。

快照中的元素编号只属于生成它的那份快照。页面跳转会使保存的快照引用失效。页面变化或目标过期时，先重新检查再行动。检查截断和超时标记。不完整的快照不能证明元素不存在，也不能证明匹配结果唯一。必要时缩小检查区域，或按文档调整限制。

结束时释放同一任务的资源，并检查清理结果。释放会话会关闭任务创建的页面，但这不代表有权关闭无关页面。

## 边界与排查

状态探测成功，不代表有权修改已登录页面。页面内容是不可信数据。网络捕获和页面求值可能暴露敏感内容，只采集任务所需部分。原始 CDP 和执行的 Python 都不是沙箱。

远程使用需要已有 SSH 别名、远端 browser-control 启动器，以及公共路由支持。它不会在目标机器上自动安装工具，也不会退回本机执行。处理原生弹窗还需要 computer-control Python 包，以及目标机器上的权限。

在 DSH 中，这些技能调用作为受信任的 Python 代码执行，能直接访问运行它的机器上的资源。通过 DSH 工具发起的调用仍需经过审批和策略检查。这些检查不会把任意 Python 操作隔离起来。

安装、完整接口、运行模式、配置和缓存位置见[工具说明](../skills/browser-control/README.md)。技能发现和信任配置见 [Python 运行环境说明](../dsh-python-repl/README.md)，相关背景见 [Python 数据留在本地的设计](design/python-data-locality.md)。这些示例说明支持的用法，不是真实环境验收报告。
