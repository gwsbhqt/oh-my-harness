中文 | [English](browser-use.en.md)

# 使用 browser-use

Cra 和 Chrome 可以使用相同的网页操作。`tab_open` 打开标签，`page_snapshot` 读取页面，`page_click` 操作快照里的控件。调试另用一套 `debug_*` 调用，例如 `debug_network` 读取所选标签的网络请求。

| 目标 | 网页操作由谁执行 | 调试由谁执行 |
| --- | --- | --- |
| Cra | Cra 官方 MCP，首次连接由用户在 Cra 中授权 | Google 的 Chrome DevTools MCP，需要这个 Cra 实例的调试地址 |
| Chrome | Google 的 Chrome DevTools MCP，需要已开启调试的 Chrome 地址 | 同一个 Google 工具，连接同一个 Chrome 实例 |

先准备要使用的浏览器。Chrome 的 `endpoint` 接受带端口的本机回环地址，指向已运行且已开启远程调试的实例。登录状态取决于这个实例使用的资料。安装与连接条件见[技能说明](../skills/browser-use/README.md)。[Cra 官方 MCP](https://github.com/VictorKildahl/cra/blob/v0.1.53/docs/mcp.md) · [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)

## 打开标签并读取页面

在装有技能的 DSH Python 会话中，下面的例子用 Cra 在后台打开示例网页，读取快照，再关闭本次打开的标签。打开标签的回执给出 `tabId`。如果任务要求操作已有标签，用 `tabs_list()` 列出它们，再从选定项的 `id` 取得编号。

```python
async with skills.browser_use.Browser("cra") as browser:
    opened = await browser.tab_open(url="https://example.com/")
    tab_id = opened["tabId"]
    try:
        snapshot = await browser.page_snapshot(tabId=tab_id)
        print(snapshot)
    finally:
        await browser.tab_close(tabId=tab_id)
```

在同一个连接中沿用这个 `tabId`。两端的导航参数与 Cra 相同。访问新地址用 `page_navigate(tabId=tab_id, url=...)`，重新加载用 `page_history(tabId=tab_id, action="reload")`。点击时使用该页最新快照中的 `ref`。导航或控件变化后重新读取页面。例如，提交表单后要看原标签里是否出现了预期的保存结果。超时发生在点击之后时，也先读回原页，再判断是否还需要操作。浏览器菜单和系统对话框使用[桌面工具](computer-use.md)。

## 在同一标签查看网络请求

以下地址代表你已准备好的 Chrome 实例。网页和调试调用都传入同一个 `tabId`。若要调试 Cra，先在 Cra 中允许页面 JavaScript 工具，以便核对调试的确实是同一页。把浏览器名改为 `"cra"`，传入那个 Cra 实例的调试地址。只操作 Cra 网页时可以省略 `endpoint`。

```python
async with skills.browser_use.Browser("chrome", endpoint="http://127.0.0.1:9222") as browser:
    opened = await browser.tab_open(url="https://example.com/")
    tab_id = opened["tabId"]
    try:
        snapshot = await browser.page_snapshot(tabId=tab_id)
        requests = await browser.debug_network(tabId=tab_id)
    finally:
        await browser.tab_close(tabId=tab_id)
```

终端里用第一条命令列出 Cra 标签。需要在多次调用间保留连接时，把第二条命令配置为 MCP 客户端的启动命令。它连接已运行的 Chrome。

```sh
browser-use --browser cra tabs_list
browser-use --browser chrome --endpoint http://127.0.0.1:9222 mcp
```

<a id="two-tabs"></a>

## 归档实拍：标题和网址都相同的两个标签

旧版 browser-use 把[虚构清单](examples/browser-task.html)打开两遍，只在先打开的标签勾一项。分别读回的计数为 `[1, 0]`，截图中的第一页显示 1/3，第二页显示 0/3。原版 Python 步骤、截图和录屏保留在下列链接。[归档版复现步骤](https://github.com/gwsbhqt/oh-my-harness/blob/archive/browser-use-before-mcp/docs/browser-use.md#two-tabs) · [两页截图](assets/two-tabs.png) · [旧版操作录屏](assets/browser-use.gif)

网页内容和网络请求可能包含账号数据。按任务需要读取和展示，使用页面结果核对操作。Python 技能以当前进程的权限运行。[Python 运行环境](../dsh-python-repl/README.md) · [浏览器设计](design/browser-control.md)
