# 使用条件

## Cra

在 Cra 设置的高级选项中打开本地代理控制。普通网页操作使用 Cra 原生连接。命令行默认查找安装的 Cra，使用当前本机用户的 Cra 套接字。另一个资料或测试实例可用 `--cra-executable` 和 `--cra-socket` 明确指定。Python 对应 `cra_executable` 和 `cra_socket`。

DSH 默认经已注册的 Cra 连接执行。没有该工具或权限时，调用会返回错误。日常控制不要求启用浏览器远程调试。调试同一张 Cra 标签还需允许 Cra 的页面 JavaScript 工具，并向 browser-use 提供该实例的本机调试地址。

## Chrome 与调试

准备官方 [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.13.0 及其支持的 Node.js。优先使用 PATH 中已安装的 `chrome-devtools-mcp`。也可以先显式运行 `npx --yes chrome-devtools-mcp@1.13.0 --version` 准备依赖。后续调用从 npx 离线缓存启动固定版本。`--google-executable` 或 Python 的 `google_executable` 可指定它。进程附着于明确提供的本地 HTTP 或浏览器 WebSocket 调试地址。一个浏览器实例对应一个地址。普通 Chrome、Chrome for Testing 和独立启动的 Cra 都需已开放相应调试接口。

使用 `BROWSER_USE_CRA_ENDPOINT`、`BROWSER_USE_CHROME_ENDPOINT` 为各自的任务配置地址。`--endpoint` 或 Python 的 `endpoint` 只对当前选定的浏览器生效。常规网页操作交给当前浏览器的官方工具，所有 `debug_*` 操作交给 Google 工具。

## 页面和文件的归属

Chrome 的每个 `Browser` 或持续运行的进程管理自己的页号映射。DSH 中的 Cra 控制复用当前会话已经授权的原生连接，标签归属由 Cra 管理。保留本次连接取得的 `tabId` 和 `ref`。退出前显式关闭自建标签。若调试地址指向另一份资料或不同实例，无法证明对应关系时调用会失败。多个标签可同时使用相同网址和标题。

Chrome 的文件输入由浏览器所在主机读取。仅在明确知道浏览器与 browser-use 共用同一文件系统时，用 `local_files=True` 或 `--local-files` 启用同机上传。转发到远端的端口也可能绑定在本地回环地址。调试文件由官方 Google 工具写入其允许的输出目录。使用明确的临时输出目录与文件名，避免覆盖现有工作。

## 恢复旧版本

公开 Git 标签 `archive/browser-use-before-mcp` 保存了整个上一版技能目录、测试和使用说明。可以在独立 Git 工作树中查看该版本。新版本使用原有的 `browser-use` 命令名和 `browser_use` 包名。
