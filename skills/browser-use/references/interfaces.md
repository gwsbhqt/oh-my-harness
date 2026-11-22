# 网页控制和调试 API

`skills.browser_use.cra` 和 `skills.browser_use.chrome` 每次分别创建一个 `Browser("cra")` 和 `Browser("chrome")`。在同一次任务中复用取到的对象。若需连接指定的实例，可用 `Browser("chrome", endpoint=...)`。工具名、输入参数和调试返回值在两端共用同一份定义。`Browser.tools()`、CLI 的 `tools` 以及 MCP 的 `tools/list` 都提供实际参数、必填项、枚举和范围。`capabilities` 按所选浏览器报告具有实现的操作。某个工具的个别选项仍可能受浏览器限制。

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

### 用当前网页中的 JavaScript 读界面

Cra 设置中打开「允许代理在页面运行 JavaScript」后，`page_evaluate` 可以读取当前文档中的文字、控件状态、最终样式和布局。普通 Cra 操作使用原生 MCP。下面的表达式在表单按钮唯一时返回读数，调用方能看到实际匹配数量。

```javascript
(() => {
    const matches = document.querySelectorAll("form button");
    if (matches.length !== 1) return {count: matches.length};
    const button = matches[0];
    const {width, height} = button.getBoundingClientRect();
    return {count: 1, text: button.textContent.trim(), width, height,
            color: getComputedStyle(button).color};
})()
```

把表达式交给 `page_evaluate(tabId=tab, expression=...)`。成功时从 `result.value` 读取这个对象。复杂的异步状态可以用有超时的 `Promise` 观察并返回，普通文字或元素状态可直接用 `page_wait`。点击、填写和键盘输入使用 `page_click`、`page_fill` 和 `page_press`。

网页刷新或导航到新文档会清除旧文档上的观察器。跨来源的 iframe 和样式表受浏览器同源规则限制。`getComputedStyle` 能读到生效的颜色，定位覆盖它的规则和来源行号可用 `debug_css_styles`。页面脚本运行时，载入当前文档的请求已经发出。脚本可以给随后由它发起的请求加测试标记。

在隔离测试页上，Google 调试器给已绑定标签预设的请求头，可以随下一次导航的首个文档请求发出。另一来源的图片和后续导航也收到该标记，显式清除后才消失。这个验证使用无敏感信息的标记。设置请求头仅在独立的 Google 调试连接上验证，尚未作为 BU 接口发布。 官方的域名白名单会连其他来源的子资源一起拦截。目前缺少只给目标来源加标记、同时允许其他来源资源照常加载的上游选项。

### Chrome 输入的具体范围

Chrome 支持能对应 Google 无障碍控件的 `ref` 或唯一 CSS，左键单击和双击，也支持用当前截图的坐标点击。元素悬停、填写普通输入框和可编辑区域、发送按键、按值或文字选择原生单选下拉框、在两个控件间拖放，均使用 Google 的输入工具。覆盖目标的浮层、焦点被别的输入框抢走或引用失效时，先核对状态再操作。

Chrome 的 `humanize`、带修饰键的点击、右击、中击、三击、坐标悬停、像素滚轮和自定义下拉组件无法兑现相同动作时会明确报错。上传针对能确切定位的文件控件，每次 1 到 8 个普通文件，每个不超过 16 MiB，合计不超过 64 MiB。动作回执中的写请求来自前后两次观察期间的同页请求，同时发生的独立请求也可能出现在其中。

成功的动作回执表示对应输入已执行。Chrome 对支持的动作在前后分别观察能取得的控件、网页和网络记录。两端可观察的请求及事件并不总是相同。读回业务结果再判断提交是否成功。遇到 `BrowserError`，Python 可查看 `code`、`outcome` 和 `data`。`not_sent` 表示该动作在发出前被拒绝。`unknown` 表示结果需要复核。MCP 错误通过 `isError` 报告。保留原始错误块才能看见批处理中的部分结果。

## 调试

每个 `debug_*` 指令都传此前选定的 `tabId`。Google 调试结果保留在 MCP `content` 和可用的 `structuredContent` 里。整页原图和开发页测试响应也通过 `structuredContent` 提供文件信息或命中回执。

| 动作 | 主要参数 | 结果 |
|---|---|---|
| `debug_console` | `tabId`，可选 `types`、`pageSize`、`pageIdx` | 当前页的控制台记录 |
| `debug_console_message` | `tabId`、`msgid` | 用本页 `debug_console` 返回的 `id` 查看参数、源位置和可用调用栈 |
| `debug_viewport` | `tabId`，可选 `viewport` | 在本次新开的测试标签应用指定视口，省略 `viewport` 时恢复默认尺寸 |
| `debug_css_styles` | `tabId`、`selector`，可选 `scope`、`pageSize` 和 `pageIdx` | Google 检查器列出的匹配规则、优先级和可得的来源行号 |
| `debug_element_screenshot` | `tabId`、`selector`，可选 `scope` | 指定元素的 PNG 截图 |
| `debug_full_page_screenshot` | `tabId`、`filePath` | 保存整页原始 PNG，返回路径和实际像素尺寸 |
| `debug_mock_json` | `tabId`、`url`、`json`，可选 `status`、`resourceType` | 为本次新开的回环开发页设置专用测试响应 |
| `debug_mock_status`、`debug_mock_clear` | `tabId` | 核对命中及实际送达次数，或撤销规则 |
| `debug_network` | `tabId`，可选 `resourceTypes`、`pageSize`、`pageIdx` | 当前页的请求与请求编号 |
| `debug_request` | `tabId`、`reqid` | 同一页里该请求的详情。可选保存请求、响应文件 |
| `debug_trace_start` | `tabId`，可选 `reload`、`autoStop` | 启动性能记录。自动停止时可同时传入 `filePath` |
| `debug_trace_stop` | `tabId`，可选 `filePath` | 停止记录，返回摘要，可写文件 |
| `debug_heap_snapshot` | `tabId`、`filePath` | 从目标页采集并保存内存快照 |

元素调试默认从主文档查找。可选的 `scope` 从外到内逐层进入同源 iframe 或开放的 Shadow DOM。每一步的选择器和最终元素都须在各自范围内唯一匹配。目标还须能对应到 Google 无障碍快照的节点。控件名称相同也按实际 DOM 节点定位。

```python
scope = [{"kind": "frame", "selector": "iframe#editor"},
         {"kind": "shadow", "selector": "format-toolbar"}]
styles = await browser.debug_css_styles(tabId=tab, scope=scope, selector="button.save")
image = await browser.debug_element_screenshot(tabId=tab, scope=scope, selector="button.save")
```

在本次会话用 `tab_open` 新开测试页后，可调用 `await browser.debug_viewport(tabId=tab, viewport="390x844x2,mobile,touch")` 模拟手机尺寸。宽、高以 CSS 像素计，`2` 为设备像素比。需要保留该标签时，在会话结束前用 `await browser.debug_viewport(tabId=tab)` 撤销。Google 切换时可能刷新该页，也会重置该页已有的弱网等其他模拟条件。网页自身的 viewport 声明会影响最终布局。

Cra 模式用两端都能观察的随机文档标记验证同一页。完成或出错时清理标记，页面关闭或导航期间无法确认时停止调用。Chrome 模式复用当前连接的确切页号。不要把另一个标签的请求编号交给 `debug_request`，两个标签的请求编号可以都是 1。性能录制按浏览器实例独占，记录范围可包含该实例中的其他页面。网络详情、快照和性能文件可能包含所访问页面的实际数据，请选择合适的目标页与输出位置。

### 本机开发页的接口测试

用本次会话的 `tab_open` 打开专用本机开发页。接口必须与顶层文档同源，主机使用 `localhost`、字面 IPv4 回环地址或 `[::1]`。`localhost` 与 `127.0.0.1` 各算一个来源。指定完整接口 URL 和资源类型。`fetch` 是默认值，`XMLHttpRequest` 使用 `xhr`。路径和查询均精确匹配。每张测试页一次使用一条规则，紧凑 UTF-8 JSON 正文上限为 1 MiB。

下面的例子假设 `tab` 是会话新开的本机开发页，`api` 是该站的商品列表读取接口。用真实控件触发请求，核对页面状态和命中回执，再撤销规则。

```python
await browser.debug_mock_json(tabId=tab, url=api, json={"items": []})
try:
    await browser.page_click(tabId=tab, ref=refresh_button)
    await browser.page_wait(tabId=tab, text="暂无商品")
    status = (await browser.debug_mock_status(tabId=tab))["structuredContent"]
    assert status["hits"] > 0 and status["errors"] == 0 and status["served"] > 0
finally:
    await browser.debug_mock_clear(tabId=tab)
```

错误场景可传 `status=500, json={"error": "fixture"}`。浏览器实际收到 HTTP 500。BU 用测试期间的本机固定 JSON 响应提供状态码。浏览器的网络记录仍显示原接口地址。官方模拟器由调试进程接收 GET 或 HEAD 的替代响应。匹配条件没有 HTTP 方法维度，同 URL、同资源类型还被用于写操作的接口不适合这项测试。POST 命中这条规则会被官方工具中止，并增加错误数。网页注册的服务工作线程可能自行给出结果，只有页面状态和计数都吻合才算复现。

同源重载保留规则。BU 在主动跨来源导航、未知目标的历史跳转、关页和会话结束时撤回本会话的规则。网页自行跳转后，规则仍按原接口地址匹配。测试期间让该标签专用于当前场景。生效期间，Google 会停止使用该页 HTTP 缓存，性能测量应在撤销之后进行。

### 整页原图与本机差异图

```python
from pathlib import Path

before = Path("before.png").resolve()
after = Path("after.png").resolve()
await browser.debug_full_page_screenshot(tabId=tab, filePath=str(before))
# 触发需要验证的页面变化，等到界面显示预期结果，再保存第二张图。
await browser.debug_full_page_screenshot(tabId=tab, filePath=str(after))
change = await browser.compare_screenshots(baseline=str(before), current=str(after),
                                           output=str(Path("difference.png").resolve()))
```

整页截图使用独立的官方调试连接，重新核对所选文档，保存原始设备像素。原图输出请选已有目录中的新 `.png` 路径。Chromium 对单个方向超过 16384 设备像素的页面无法保证整页正确，BU 会报告限制。截图只包含捕获时页面已渲染的内容。

`compare_screenshots` 也可独立使用，不需要连接浏览器。返回 `changed`、`sizeMismatch`、两张图的尺寸、变化像素数 `changedPixels` 和变化范围 `bounds`。同尺寸且有变化时，传入 `output` 才写红色差异图。相同或尺寸不同均不生成图，已有文件会保留。 支持 8 位非交错的灰度、灰度加透明度、RGB 和 RGBA 截图。每张至多 16,777,216 个像素，超过限制会明确报错。
