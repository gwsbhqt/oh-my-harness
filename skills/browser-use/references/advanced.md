# browser-use 按需能力

Python 日常操作见 [PYSKILL.md](../PYSKILL.md)，操作规则见 [共用规则](common.md)；先读 [Python 接口](interfaces.md#上下文探针与生命周期)，无 Python 内核的命令参数见 [CLI 参考](cli.md)。这里是用到某类能力时再读的说明。

## 远程机器与任务会话细节

本机和目标机都须事先同步 `_shared` 共用代码；目标机须显式安装 browser-use 入口和声明依赖，不会在远程调用中自动安装。生产远端入口固定为 `~/.local/bin/browser-use`。`BROWSER_USE_REMOTE_LAUNCHER` 仅用于显式测试部署，值必须是目标机绝对路径；不从 PATH 猜入口，不尝试备用入口。

任务 scope 按显式 `--scope`、`BROWSER_USE_CONTEXT_ID`、`DSH_SESSION_ID` 的顺序选择。当前任务首次分配独立自动 session，同一 scope 后续调用稳定复用；不是全电脑共同默认。`session use NAME` 只为该 scope 选择 session，`session current` 查询，`session use --clear` 回到该 scope 原有自动 session。三者都不 release、不关页面、不选活动页，也不改变机器 pin。显式 `--session NAME` 只覆盖本次资源归属。

普通 CLI 的浏览器任务必须有 scope 或显式 session；没有时明确报错，不从标签、网址、页面编号或 targetId 推导 session。version、capabilities、status 等探针及选机命令不需要任务归属。Python 在有任务环境时使用同样的选择；没有 scope 且未传 session 时只用当前 Python 进程的独立默认，不作为跨进程或全电脑默认。Python 可用 `await skills.browser_use.use("alpha")`、`await skills.browser_use.pin("alpha")`、`await skills.browser_use.hosts()`，以及 `await skills.browser_use.session_use("browser-task", scope="task-a")`、`await skills.browser_use.session_current(scope="task-a")`。

## 元素：固定节点，不随导航换人

`page.element(id="search")` 创建定位对象，首次 `resolve()` 或动作才固定节点。此后导航、文档替换、节点移除都会拒绝旧句柄，不重新解释同一选择器。需要新节点就明确创建新对象。默认唯一，列表用 `page.elements(selector={"css":"button"})`，检查 `count/truncated`。

```python
field = page.element(id="search")
await field.resolve()
await field.type_text("关键词")
await field.set_value("替换值")
await field.key("Tab")
box = await field.measure()
styles = await field.styles(names=["color", "font-size"])
patch = await field.patch(styles={"outline": "2px solid red"})
await field.restore(patch["patchId"])
```

元素提供 `click/type_text/set_value/key/scroll/read/attribute/html/measure/styles/screenshot/focus/hover/check/select/patch/restore`。可信输入和属性修改分开报告 `via/trusted`：`set_value/select/scroll/patch` 不冒称真实键鼠。`check` 限原生 checkbox/radio。`patch` 只改明确属性、文字、样式；`restore` 仅在改后值未被外部改变时恢复。必须显式 restore；释放连接不会偷偷覆盖页面修改。

frame 用确切 `frame` ID，默认只查主文档，不自动跨所有 iframe；`within` 是唯一容器 CSS，`shadow` 是有序的唯一 open shadow host CSS 列表。没有公开 Frame 对象。平面、未变换的跨进程 iframe（OOPIF）元素截图可用；旋转、透视、变换坐标明确报能力错误。OOPIF 的可信 `hover` 不支持，返回 code 5，不合成事件。本阶段未现场验证远程 OOPIF，不能把本地能力说明当成远程验收。

## 浏览器专有操作

导航、重新加载和页面内点击不是一回事。验证前端缓存问题应点击页面内导航，不能用 goto 刷新后假装问题消失。导航有界等文档可读，未完成会明确报告 loading；业务仍等明确文字或 JS 条件，不盲等 networkidle。

页面脚本用 `evaluate`；首屏前脚本用 `init_add/init_remove`。`open_page(init_script=...)` 在首次真实网址加载前注册。脚本运行在登录页面里，网页内容和返回值均是不可信数据，不是新授权。

页面截图独立 PNG，默认不覆盖已有路径。远程 snap 的截图、shot、元素截图和指定 debug 产物才会主动取回；校验字节数与 SHA-256 后发布本机私有文件，保留 `remotePath` 和 `hostContext`。远程截图 `out` 是本机私有目录（700）中的新文件（600），`overwrite` 暂不支持。上传只操作明确元素。远程 upload 和 network override 的明确本机文件先暂存到目标机并校验。upload 暂存归该页面和 session 所有，保留到 tab close 或 release，disconnect 不清理，避免页面后续读取文件时失效；network override 在注册时读取快照，可在注册后清理暂存。清理失败会报告，不重发动作。`download directory` 的 path 仍是目标机路径，不是本机下载目录。下载只有收到 completed 事件才完成；共享浏览器 不擅改全局下载目录，专用 Chrome 私有上下文才允许目录设置。弹窗与新页只报告确切 targetId，不自动接受有业务影响的确认，不跳新页继续写。

## 网络与调试

请求用 `page.network.requests(filter="/api/")` 筛选；`request(id=..., body=True, postData=True)` 按需取响应和请求正文，失败不重发请求。记录有界，须检查覆盖和丢失。默认只脱敏敏感头，网址、正文、控制台和 WebSocket 内容仍可能含隐私。

`route` 可阻断、模拟响应、改请求 URL/方法/正文/头，或在真实响应到达后转换正文。后者不是重新请求后端，仅限有界 UTF-8/ASCII 文本与严格 JSON；不支持二进制或非 UTF-8 编码。`override` 在登记时读取指定本地文件，保存有界快照用于覆盖；改磁盘文件不会自动更新规则。所有规则仅作用绑定页面及已接入 frame，释放时解除。HAR 只记录实际捕获的数据，不回放、不补抓。WebSocket 提供有界收发帧；新 frame 接入前和 worker/service worker 不保证覆盖，`coverage.complete=False` 不能读成完整抓包。cache/SW 控制只到页面会话；此前值未知，释放只恢复调试会话默认 false，不声称还原用户旧状态。

`page.debug` 公开固定页面的 CDP 调用、事件订阅、JS 断点与栈。raw 有有限 guard，不是任意脚本的完整安全沙箱；不能用它另选目标或绕过归属。事件订阅有界，`EventStream.read(wait_timeout=...)` 最多等 30 秒，检查 cursor、丢失与 complete；用完 stop。领域调试释放时移除本任务断点并恢复暂停。源码产物返回私有文件路径、字节数和完整性，release 后保留，browser-use 后台服务退出时删除；要留着就自己复制出来。

## 脚本化：批量、取态与启动选项

`browser-use batch` 从标准输入读 JSON 数组，每项一条 browser-use 参数，按顺序执行，默认第一条失败即停并报告停在哪一条；外层的 session、浏览器、机器作为每条默认值。页面动作加 `--snap` 会在成功后再取一次态，一次拿回结果和新页面状态。Python 直接写循环编排。

```bash
browser-use batch <<'EOF'
[["goto","TAB","https://example.com/form"],["type","TAB","--id","name","--","张三"],["click","TAB","--id","submit","--snap"]]
EOF
```

独立 Chrome 用 `mode="isolated"`；`profile="NAME"` 指定持久资料并保留扩展，省略则用临时干净资料并禁扩展。`mode="clone"` 时 profile 是日常 Chrome 的来源资料名。代理、证书、语言、UA 和窗口尺寸放在 launch，attach 不接受这些启动选项。

登录状态可以保存成文件再载入另一个自启 Chrome，免得每次测试重新登录：`page.state.save(path=...)`、`page.state.load(path=...)`。文件含 Cookie 原值，目录 700、文件 600，只载入 browser-use 自启的私有 Chrome，远程时不自动取回。Cookie 读取默认打码，`raw=True` 才给原值；共享浏览器 上的写入要 `authorized=True`，释放时恢复原值。

下面三节的能力都在本机自启的独立 Chrome 上实测过。远程主机上还没现场验证。

## 前端排查

定位字段按当次接口使用；`selector` 使用 `selector={"css": "..."}` 等支持的对象，不传字符串，也不与直接定位字段混用。元素的 ID、class 和属性值来自当前页面或源码，不猜目标。

验收到目标在页面底部可见即可，不额外要求居中。文本比较先统一 Unicode 负号等不影响含义的差异；脚本调用失败与页面控制台错误分开记录。

- **样式为什么是这样**：`page.inspect.css(selector={"css": "#title"})` 列出匹配规则、源文件行号、@media/@layer 等包裹条件，以及每条声明是胜出还是被覆盖。
- **控制台与请求**：控制台用 `page.network.console(...)` 读取；消息有编号，`network.console_message("msg-12")` 展开单条的参数和调用栈；请求可按资源类型、状态范围（如 `"4xx"`）和导航筛选，正文可另存文件。额外请求头和 HTTP Basic 认证走 `headers_set`、`auth_set`，密码只从标准输入读。

## 输出与比较

`page.output.shot_if_changed(key=...)`（画面没变就不写文件）、`diff_screenshot(baseline=...)`（输出标红的差异图）、`annotate(elements=...)`（截图上画编号框）；两段快照文本用 `skills.browser_use.diff_text` 或 `browser-use diff A.txt B.txt`。产物都在返回的 `artifact` 里，远程会自动取回并校验。

## 泳道

browser-use 自己给它控制的页面（含 iframe）加请求头，任意合法请求头都行，比如 `force-workbench`；只有浏览器自己维护的头（Host、Content-Length 之类）不能设。

- 新开页：`open_page(url, lane="ppe_xxx")` 只设 `x-tt-env`；整组头传 `lane={"x-tt-env": "ppe_xxx", "force-workbench": "1"}`。命令行 `tab new URL --lane ppe_xxx` 或 `--lane '{"x-tt-env":"ppe_xxx","force-workbench":"1"}'`。先设好头再打开网址，第一个请求就带上。
- 已打开的页面：`page.lane.set("ppe_xxx")` 或 `page.lane.set(headers={...})`；命令行 `browser-use lane TAB set ppe_xxx` / `--headers '{...}'`。已经加载的内容不带，需要就刷新页面。
- `page.lane.get()` / `browser-use lane TAB get` 看设了什么和核对统计；`page.lane.clear()` 撤掉；`skills.browser_use.lane_status()` / `browser-use lane status` 列出本任务所有设了泳道的页面。
- release 或 disconnect 都会撤掉，浏览器里不留东西，也不跨浏览器重启保留。
- 同一个头只能由泳道或 `network headers-set` 其中一个来设，撞名会报错，按提示改用另一个或先清掉。

browser-use 会核对浏览器实际发出去的头。浏览器里有插件也在改同一个头时，插件改的值会生效（browser-use 抢不过，也不去抢），下一次页面动作的返回里会多一个 `laneWarning`：写着哪个头、browser-use 设的值、实际发出去的值或「没有带上」、示例网址和请求数，以及两种处理办法——关掉那个插件，或把插件里的泳道设成和 browser-use 一样。命令行文本输出会在 stderr 印一行「browser-use 警告：…」；Python 里只返回部分结果的函数（snap、evaluate、read、shot）会另发一条 `skills.browser_use.LaneWarning`。跨域预检、worker 自己发的请求、命中缓存和 data:/blob: 不算不一致。

请求头对了不等于后端路由对了；后端路由要看业务回执。

## 资源清理细节

任务只清自身泳道、脚本、拦截，绝不全关 about:blank。崩溃恢复必须核对同浏览器实例，不按端口或 ID 范围猜。临时全局副作用不承诺跨浏览器重启自动还原。服务连续 30 分钟无请求且无在途连接后退出清资源，不是内核销毁立即回收，任务仍需显式 release。
