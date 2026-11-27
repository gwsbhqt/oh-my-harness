# 命令行

`browser-use --help` 列出连接选项。`browser-use --browser cra tools` 输出工具名、说明和完整输入结构。`browser-use --browser chrome capabilities` 输出这个后端实现的工具名和显式不支持的工具。

## 单次命令

```sh
browser-use --browser cra tabs_list
browser-use --browser cra page_read '{"tabId":"实际标签编号"}'
```

末尾的 `-` 表示从标准输入读一个 JSON 参数对象。多个动作需复用页面或控件引用时，使用持续会话。Chrome 的临时标签编号和控件引用属于同一 browser-use 连接。

## 持续会话

```sh
browser-use --browser chrome --endpoint http://127.0.0.1:9222 session
```

每行输入一个对象，形如 `{"name":"tabs_list","arguments":{}}`。读取一行返回的 `result` 或 `error`，原样使用本次连接返回的标签编号与控件引用。关闭输入流结束会话。

## MCP 客户端

将 `browser-use` 注册为所需 MCP 客户端的 stdio 可执行文件。参数示例为 `["--browser","chrome","--endpoint","http://127.0.0.1:9222","mcp"]`。通过 `initialize`、`tools/list` 和 `tools/call` 使用同一会话。每个进程绑定一个目标浏览器，无须另起 browser-use 后台服务。

本机已保存的图片可用一次命令比较，不需要调试连接，例如 `browser-use compare_screenshots '{"baseline":"before.png","current":"after.png","output":"changes.png"}'`。`debug_viewport` 也使用持续会话。在 `tab_open` 返回的测试标签上设置手机视口，省略 `viewport` 可撤销。模拟接口需要持续会话，按 `tab_open`、`debug_mock_json`、点击、`debug_mock_status` 和 `debug_mock_clear` 的顺序调用。会话退出会回收临时响应。
