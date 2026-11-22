中文 | [English](browser-control.en.md)

# 同一个网址开了两次，助手该改哪一页？

判断点到了哪一页，要看打开标签时返回的编号。旧版 browser-use 做过一次对照：在独立的 Chrome 里把同一份虚构的笔记本校对清单打开两遍，只在先开的标签里勾选一项。两页的标题和网址相同，分别读回的计数却是 1/3 和 0/3。下图记录的是归档版本的结果。[归档步骤与实拍](../browser-use.md#two-tabs)

![同一份本地清单开了两页，先开的页勾了一项，显示 1/3，后开的页仍是 0/3](../assets/two-tabs.png)

## 为什么把网页操作和调试分开

已有助手知道要读哪一页、点击哪个控件。browser-use 让它对 Cra 和 Chrome 写相同的网页调用，例如 `page_snapshot(tabId=...)`。Cra 把调用交给自己的官方 MCP。Chrome 把相同的参数转换成 Google 的 Chrome DevTools MCP 操作。需要检查网络时，两端都调用 `debug_network(tabId=...)`，都由 Google 的工具读取。调试需要属于所选浏览器的调试地址。[Python 与命令行示例](../browser-use.md)

这种分工也保留了浏览器各自的能力。Cra 的侧栏、空间和置顶标签属于 Cra。需要某项浏览器专有操作时，可以先用 `capabilities` 核对当前目标的支持范围。Chrome 连接调用方明确选定、已开启调试的实例，使用那份资料中的登录状态。

## 在一个连接里保留标签编号

用 Python 时，在同一个 `Browser` 对象里打开标签、保存回执中的 `tabId`，后续网页操作和调试都传这个编号。用命令行接入 MCP 客户端时，`mcp` 子命令可以维持同一条连接。把同一网址打开两次时，分别保存两个编号，清理时只关闭本任务创建的标签。

假设助手点了“添加清单项”，网站已加上一行，回复却丢了。再点一次可能多添一行。先回原标签重新读取清单，如果不能确认原标签，就停下核对目标。旧版的后台服务、远程 SSH 路由和页面恢复机制记录在[归档设计](https://github.com/gwsbhqt/oh-my-harness/blob/archive/browser-use-before-mcp/docs/design/browser-control.md)。

## 读者该选哪种工具

**要把整件事交给模型规划，选开源项目 Browser Use 的 Agent。** `browser-use/browser-use` 是另一个项目。它的 1.0 `Agent` 接收任务，让模型在能保留变量的 Python 环境里写代码，调用 `browser-harness` 提供的函数或直接使用 Chrome 调试协议（CDP），读取结果后决定下一步。同一团队也把底层的 Browser Harness 提供给已有的编码助手。只需直接操作已登录的 Chrome 时，上游推荐的 Browser Use CLI 就能完成这件事。它可以连接已开放调试的本机 Chrome，也能连接指定的 CDP 地址。希望让服务商运行浏览器、自己控制每一步时，Browser Use Cloud 能提供可供 Playwright 等客户端直接连接的浏览器。

**已有一套固定流程，可以从现成的命令行或测试库入手。** Vercel 的 `agent-browser` 能按确切的标签页标识选页，多条命令也能复用后台进程。如果目标是让每次代码改动都跑同一组验收，Playwright 可按角色或标签找到元素，自动等待可操作状态，并让新的测试环境复用先前保存的登录状态。它也能通过 CDP 连接已运行的 Chromium 系浏览器。Playwright 官方文档说明，这样连接时，部分高级能力不及它自己的连接协议。

**需要一段脚本同时适配 Cra 和 Chrome 时，本仓库提供相同的网页操作和调试接口。** 脚本选择浏览器连接，保留该连接返回的标签编号，就能把动作和结果对应到同一页。共享浏览器资料也会共享登录，退出账号可能影响使用其他标签的人。

## 源码与官方资料

- 查看浏览器选择、网页调用和调试调用如何分发。[Python 入口](../../skills/browser-use/src/browser_use/browser.py) · [网页与调试示例](../browser-use.md) · [桌面与任务隔离的边界](task-isolation.md)
- 两个上游接口分别列出了其支持的操作。[Cra 官方 MCP](https://github.com/VictorKildahl/cra/blob/v0.1.53/docs/mcp.md) · [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- Browser Use 对任务规划、浏览器选择、命令行直控和托管浏览器分别有说明。[Agent](https://docs.browser-use.com/open-source/agent) · [底层 Browser Harness](https://github.com/browser-use/browser-harness) · [浏览器与已有登录](https://docs.browser-use.com/open-source/browsers) · [Browser Use CLI](https://docs.browser-use.com/open-source/browser-use-cli) · [直接连接云浏览器](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)
- 两个可直接用于脚本的选择。[Vercel agent-browser 定版说明](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/README.md) · [Playwright 元素定位](https://playwright.dev/python/docs/locators) · [复用登录状态](https://playwright.dev/python/docs/auth) · [通过 CDP 连接](https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect-over-cdp)
