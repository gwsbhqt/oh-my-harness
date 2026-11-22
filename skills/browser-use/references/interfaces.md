# 网页控制和调试 API

一次创建一个 `Browser("cra")` 或 `Browser("chrome", endpoint=...)`，在任务内复用。工具名、输入参数和调试返回值在两端共用同一份定义。`Browser.tools()`、CLI 的 `tools` 以及 MCP 的 `tools/list` 都提供实际参数、必填项、枚举和范围。`capabilities` 按所选浏览器报告具有实现的操作。某个工具的个别选项仍可能受浏览器限制。

## 网页控制

控制接口对应 [Cra 0.1.53 的 33 个工具](https://github.com/VictorKildahl/cra/blob/v0.1.53/docs/mcp.md)。Cra 直接返回原生结果。Python 和普通 CLI 会解开仅含一个 JSON 文本块的回执。截图等多块结果保留原始 MCP `content`。MCP 服务向客户端提供标准 `tools/call` 回执。

| 使用目的 | 工具 | 使用约定 |
|---|---|---|
| 选页、开页、显示和关闭 | `tabs_list`、`tab_open`、`tab_show`、`tab_close` | 用返回的编号指向同一页。`tab_open` 默认后台打开。Chrome 的已有页可从列表选用。关闭操作限于本会话新开的页。 |
| 定位、读取和等待 | `page_snapshot`、`page_read`、`page_wait` | 从快照选 `ref`。Google 控件标识在当前会话内转换为页面引用。分页使用返回的 `nextOffset`。等待的条件必须同时成立。 |
| 交互 | `page_click`、`page_fill`、`page_type`、`page_press`、`page_hover`、`page_select`、`page_drag`、`page_scroll` | Chrome 使用 Google 官方输入工具。原生鼠标滚轮和其他未提供的选项会明确拒绝。`page_fill` 表示替换，`page_type` 表示输入。 |
| 导航与弹框 | `page_navigate`、`page_history`、`page_dialog` | 正在等待用户答复的原生网页弹框使用 `page_dialog`。Chrome 导航遇到离页确认时尽量保留原页并报告。 |
| 页面证据 | `page_screenshot`、`page_console`、`page_network`、`page_evaluate` | 截图随图像块返回。摘要采用各端确实可观察的数据。详细请求和完整调试回执见下方 `debug_*`。 |
| 文件 | `page_upload`、`page_pdf`、`page_download`、`download_status`、`download_cancel` | Chrome 的同机上传有文件系统前提。Cra 的无窗口下载、导出 PDF 及下载管理仅在 Cra 侧可用。 |
| 侧栏和空间 | `tab_move`、`tab_update`、`folder_create`、`history_search`、`site_notes` | Cra 根据其设置、权限和用户的空间执行。Chrome 对这些浏览器专用语义返回 `unsupported`。 |
| 同一页的连续动作 | `page_batch` | 最多 50 个 `page_` 动作，所有步骤绑定外层 `tabId`，不允许嵌套批处理。一步失败后，保留已经完成的步骤并标记余项。 |

Chrome 控制使用官方 [Chrome DevTools MCP 1.13.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.13.0/docs/tool-reference.md)。Google 的页号和控件编号属于该连接。BU 保留会话内的对应关系，网页重绘或连接更换后无法确认原节点时会报错。Chrome 的普通标签页不具备 Cra 空间、独立无窗口标签或手动接管的原生语义。Google 读取正文和等待 DOM 时使用页面的执行环境，Cra 原生读取可以使用隔离的执行环境。

### Chrome 输入的具体范围

Chrome 支持能对应 Google 无障碍控件的 `ref` 或唯一 CSS，左键单击和双击，也支持用当前截图的坐标点击。元素悬停、填写普通输入框和可编辑区域、发送按键、按值或文字选择原生单选下拉框、在两个控件间拖放，均使用 Google 的输入工具。覆盖目标的浮层、焦点被别的输入框抢走或引用失效时，先核对状态再操作。

Chrome 的 `humanize`、带修饰键的点击、右击、中击、三击、坐标悬停、像素滚轮和自定义下拉组件无法兑现相同动作时会明确报错。上传针对能确切定位的文件控件，每次 1 到 8 个普通文件，每个不超过 16 MiB，合计不超过 64 MiB。动作回执中的写请求来自前后两次观察期间的同页请求，同时发生的独立请求也可能出现在其中。

成功的动作回执表示对应输入已执行。Chrome 对支持的动作在前后分别观察能取得的控件、网页和网络记录。两端可观察的请求及事件并不总是相同。读回业务结果再判断提交是否成功。遇到 `BrowserError`，Python 可查看 `code`、`outcome` 和 `data`。`not_sent` 表示该动作在发出前被拒绝。`unknown` 表示结果需要复核。MCP 错误通过 `isError` 报告。保留原始错误块才能看见批处理中的部分结果。

## 调试

每次调用都传入此前选定的 `tabId`，返回 Google 原始 MCP 回执。可读取 `content` 和工具实际提供的 `structuredContent`。两种浏览器的选项、结果和错误均走同一段实现。

| 动作 | 主要参数 | 结果 |
|---|---|---|
| `debug_console` | `tabId`，可选 `types`、`pageSize`、`pageIdx` | 当前页的控制台记录 |
| `debug_network` | `tabId`，可选 `resourceTypes`、`pageSize`、`pageIdx` | 当前页的请求与请求编号 |
| `debug_request` | `tabId`、`reqid` | 同一页里该请求的详情。可选保存请求、响应文件 |
| `debug_trace_start` | `tabId`，可选 `reload`、`autoStop` | 启动性能记录。自动停止时可同时传入 `filePath` |
| `debug_trace_stop` | `tabId`，可选 `filePath` | 停止记录，返回摘要，可写文件 |
| `debug_heap_snapshot` | `tabId`、`filePath` | 从目标页采集并保存内存快照 |

Cra 模式用两端都能观察的随机文档标记验证同一页。完成或出错时清理标记，页面关闭或导航期间无法确认时停止调用。Chrome 模式复用当前连接的确切页号。不要把另一个标签的请求编号交给 `debug_request`，两个标签的请求编号可以都是 1。性能录制按浏览器实例独占，记录范围可包含该实例中的其他页面。网络详情、快照和性能文件可能包含所访问页面的实际数据，请选择合适的目标页与输出位置。
