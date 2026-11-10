# computer-control 完整接口参考

网页内容优先 browser-control；本参考保留 computer-control 的原生操作和辅助功能网页能力。带 Python 内核直接用 `skills.computer_control`，Python 常用入口见 [PYSKILL.md](../PYSKILL.md)，授权和归属见 [共用规则](common.md)，无内核命令集中在 [CLI 参考](cli.md)。

## 选择机器

`computer-control`、`remote-host`、`dsh-control` 和 `browser-control` 共用同一份选机和 SSH 代码（`_shared/agentkit/remote/`），但各自保存默认目标。
`computer-control` 未设置默认目标时操作本机；不是沿用 `remote-host` 的默认机器。

```bash
computer-control -H beta snap Finder --json   # 临时指定机器
computer-control use beta                    # 设置 computer-control 的默认机器
computer-control pin                            # 查看默认目标
computer-control hosts                          # 查看可用机器
computer-control use --clear                    # 清除 computer-control 默认目标，回到本机
```

机器选项放在命令前面。远程截图由共享传输层取回本机，JSON 中 `shot` / `path` 是本机路径，`remotePath` 保留远程原路径。
computer-control 的 Python 包和启动器都按自身真实路径找到旁边的 `_shared`，从 `agentkit.remote` 加载这份共用代码；找不到时直接报错，不改成本机执行。

## 命令参考

完整命令、参数、示例与部署入口集中在 [CLI 参考](cli.md)，仅无 Python 内核的传统 agent 使用。

## Python 选机管理

日常通过 `skills.computer_control.app(..., host=...)` 或具名函数的 host= 显式选机。默认值管理没有专用 hosts/use 函数，低频操作使用公开 Python 入口：`await skills.computer_control.cli("hosts")`、`await skills.computer_control.cli("use", "alpha")`、`await skills.computer_control.cli("use", "--clear")`。不在 shell 中运行，也不把它当动作失败后的替代路径。

## Python 内核里调用

有 Python 内核时直接调用 skills.computer_control 的具名函数，不用拼命令、不用解析输出。每个子命令对应一个异步函数，返回字典、列表或字符串，出错抛 `ComputerControlError`。

本机默认走同一个常驻的 `computer-control serve` 进程，空闲 10 分钟自己退出，下次调用自动重开（`COMPUTER_CONTROL_SERVE_IDLE=秒数` 可改，0 为不退出）。`COMPUTER_CONTROL_NO_SERVE=1` 显式改为单次进程。请求发出后超时或断连，执行结果未知，不自动改道重试。远程仍是单次 SSH 请求，没有常驻桌面服务；停止本机等待不能保证停止远端动作。

点击、输入、按键、滚动、拖拽这类动作会**等界面稳定再返回**（普通点击约 0.15~0.2 秒；网页在加载时最多等 5 秒），返回值里的 `settled` 是等了多少秒。紧接着读界面就是新样子，不用自己加等待；不想等时加 `--no-settle` 或设 `COMPUTER_CONTROL_NO_SETTLE=1`。

```python
calc = skills.computer_control.app("计算器")              # computer-control：绑定应用，后面不用再写名字
s = await calc.snap()                # computer-control：默认只要元素清单；shot=True 顺带截图
s                                    # computer-control：摘要：几个元素、有没有截断
s.table()                            # computer-control：编号、角色、标签、#ID、当前值、状态
s.tree()                             # computer-control：按层级缩进，看得出哪个按钮属于哪块区域；空分组折叠掉
s.children(21)                       # computer-control：某个元素下面直接列出来的子元素
s.one(id="Seven")                    # computer-control：恰好一个匹配才返回，零个或多个都报错，免得点错
s.find(role="button", contains="清除")
await calc.click(id="Seven")         # computer-control：idx= / id= / label= / at=(x, y) 四选一
await calc.snap(diff=True)           # computer-control：与上次取态的差异，没变化时为假值
await calc.type_text("12+3=")
await calc.menu("显示")              # computer-control：列菜单项；再给 item= 就点它
```

| 函数 | 对应命令 |
|---|---|
| `snap(app, shot=, diff=, all=, max=, depth=, window=, out=, shrink=)` | `snap` |
| `click(app, idx=None, id=, label=, at=, count=, button=, coord=)` | `click` |
| `type_text` / `key(..., system=False)` / `paste(settle=)` / `set_value` / `act` / `selecttext` | 同名命令（`type` → `type_text`，`set` → `set_value`） |
| `scroll(app, idx, direction, pages=)` / `drag(app, start, end)` | 同名命令 |
| `read(app, idx, selected=)` → 字符串 | `read` |
| `wait(app, label, gone=, timeout=)` | `wait`，超时抛错，`code` 为 4 |
| `menu(app, menu=None, item=None)` | `menu` |
| `shot(app)` → 图片路径 / `clip(text=None)` / `winmove` / `winsize` | 同名命令 |
| `apps(all=)` / `screens()` / `perms()` / `wake(hold=3, input="none")` / `version()` / `open_app(name, front=, lease=)` | 同名命令（`open` → `open_app`） |
| `webmode(app, off=, timeout=)` | `webmode`：让 Chrome/Electron 把网页内容交给辅助功能 |
| `cli(*args)` | 直接跑任意子命令 |
| `version()` / `capabilities()` | 返回版本和能力字典 |
| `app.element(idx= / id= / label= / role=)` | 创建固定目标的元素对象，首次 resolve 时取态 |
| `disconnect()` | 停止本 Python 调用进程的常驻连接，不退出应用 |
| `release()` | 返回空释放列表和原因；computer-control 不拥有用户应用或窗口 |

应用操作函数及版本探针接受关键字参数 host=、scope=、window=稳定字典；模块 `disconnect()`、`release()` 没有机器参数。绑定应用时也可以绑定机器：

```python
finder = skills.computer_control.app("Finder", host="beta")
s = await finder.snap(shot=True)
s = await skills.computer_control.snap("Finder", host="beta")
```

独立函数没有 `host` 时，每次读取 `computer-control` 自己的默认目标。`App` 在创建时固定当时选中的机器，后续不随 `computer-control use` 改变，也不允许临时换机器；需要换机器就新建一个 `App`。
本机保留常驻进程的速度，远程请求通过 `scripts/computer-control` 启动器取回 JSON，仍返回 `Snap` / `Diff`。
App 方法同对象串行执行，固定创建时的 scope，并保存 snapshot 和稳定窗口引用；仅非浏览器保存长期 lease 并拒绝其他任务读写。浏览器按窗口短锁执行，单条命令锁冲突立即退出 6；不是用户界面事务锁，不阻止用户本人改变窗口。原始 CLI 编号必须带凭证，持有代次变了也拒绝。独立函数的编号参数可传 `snapshot=s.snapshot`。`Snap` 保留 `screenshot`、`remote_path`、`host_context`；错误保留 `ComputerControlError.data`、`host`、`outcome`，超时的 `outcome` 为 `unknown`。

剪贴板命令有跨进程锁，空剪贴板也会恢复为空。正常错误和 SIGTERM/SIGINT 会尽力按所有权恢复；SIGKILL、系统崩溃或外部应用同时改写无法保证恢复，不能据成功文案推断粘贴结果。

文件改名不会刷新当前内核里已经导入的旧模块；使用新 Python 技能需要重新加载技能或开启新内核。

### 元素与收尾

```python
seven = calc.element(id="Seven")
handle = await seven.resolve()
await seven.click()
await calc.snap()                   # computer-control：动作成功后独立核对结果
bounds = await calc.element(id="Equals").measure()
await skills.computer_control.disconnect()               # computer-control：不退出计算器
await calc.release()                         # computer-control：释放计算器归属，不关窗口
```

元素选择器只支持 `idx`、`id`、`label`、`role`，可组合，必须恰好匹配一个元素。截断或遍历超时不能证明唯一时拒绝。首次解析后固定应用、机器和快照凭证；之后读和动作携带原凭证，失效时要求新建元素并重新取态，不偷偷重新解释选择器。`read`、`click`、`set_value`、`scroll`、`act` 复用原生后台入口。`measure` 返回屏幕坐标，来源是快照几何，不是重新测量。

普通命令同样可用，不要求 Python：

```bash
computer-control --local element com.apple.calculator resolve --selector '{"id":"Seven"}' --json
computer-control --local element com.apple.calculator click --selector '{"id":"Seven"}' --json
computer-control --local element com.apple.calculator scroll --selector '{"role":"scrollarea"}' --direction left --pages 1 --json
```

要保留同一次解析，可把返回的完整句柄作为 `--handle JSON` 传给后续元素命令；再次 `--selector` 是新一轮解析。多个滚动区域会使示例选择器歧义，应加 `id` 或 `label`。

旧模块 `close()` 已移除，没有兼容别名。`App.disconnect()` 不关闭目标，也不释放归属；`App.release()` 明确释放本 App 的任务归属，不关窗口。绑定窗口后 `App.close(authorized=True, timeout=10)` 仅关闭该窗口并核对消失；CLI 使用 `window-close APP --window-ref JSON --authorized`。共享浏览器拒绝整应用退出。非浏览器未绑定窗口的 `App.close` 和 `target-close APP --authorized [--timeout 秒]` 请求 macOS 正常退出并等待进程实际结束，不抢前台、不模拟按键、不强杀；没有授权退出6，请求未被接受退出1，超时仍未退出则退出4且 `outcome=unknown`。进程退出不自动释放任务归属。`Element` 与 `element` CLI 只提供真实的 `resolve/read/click/set_value/scroll/act/measure`，不再暴露 styles/html/focus/hover/check/select/patch/restore/元素截图等必然退出5的占位入口；窗口截图仍用已有 `shot`。

### 共享浏览器窗口

`await skills.computer_control.windows("Arc", host="local", scope="task-a")` 与 `await app.windows()` 返回 `{mode:"windows", windows:[...]}`。每项包含 `id`（真实 CGWindowID）、`pid`、`startedAt`（NSRunningApplication.launchDate 的 Unix 秒）、`bundleId`，以及观察信息 `title/x/y/w/h/isFocused/isFrontmost/minimized`。用本任务创建窗口的字典构造 `skills.computer_control.app("Arc", window=ref, host="local", scope="task-a")`。引用只使用身份字段，标题和位置不是替代依据；来自浏览器调试协议或 AppleScript 的 ID 不可混用。

App 首个完整 snap 保存稳定引用，后续动作、等待和截图固定它。模块应用函数接受 window=ref；snap、winmove、winsize 的 window=整数仅用于首次观察选择，不是稳定身份。浏览器使用每条命令的窗口锁和独立任务缓存，无长期 owner/lease；release 无需 lease，只结束绑定。同一窗口正执行命令时其他命令立即拒绝；不同窗口可使用。已释放窗口对象需重新构造绑定，不能通过 claim 取得整个浏览器。

浏览器焦点输入及菜单选择需要确切目标窗已在前台，取得全局短锁后复核，不自动激活。长序列分步和完成后复核，投递后失焦为 outcome=unknown。锁仅协调工具进程，不能阻止真人在检查之间切换；不保证竞态完全消失。读取菜单不抢前台。浏览器截图只用确切窗口号，失败不回退屏幕矩形；定向鼠标通道不可用时拒绝，不偷偷按 PID 投递。

### 应用任务归属

以下长期归属流程仅适用于非浏览器；浏览器 owner status 返回 resourceMode=window 和空 owner/lease，claim/handoff/recover 不适用。

CLI 任务标识按 `--scope`、`COMPUTER_CONTROL_CONTEXT_ID`、`DSH_SESSION_ID` 选择；普通终端没有默认全电脑任务，必须明确指定。Python `skills.computer_control.app(APP, host=, scope=)` 固定机器与任务；独立函数 `scope=` 只覆盖本次。文本 `--` 后的同名选项仍原样输入。

```bash
computer-control --local snap 计算器 --scope task-a --json
computer-control --local owner 计算器 status --json
computer-control --local owner 计算器 handoff --scope task-a --lease LEASE --to task-b --json
computer-control --local snap 计算器 --scope task-b --json
computer-control --local owner 计算器 release --scope task-b --lease NEW_LEASE --json
```

`owner` 的查询不取态、不启动应用、不改归属。`claim` 取得无人持有的应用，其他任务持有时拒绝；同一任务释放后显式 claim 才能重新取得。`release` 和 `handoff` 必须传当前 lease；返回 `targets_closed:false`。每次交接生成新 lease，交接前的编号缓存不可重用。

Python `App.owner()` 查询，`claim()` 明确重新取得，`release()` 释放，`handoff(to)` 交给指定 scope。App 保存实际应用标识，应用已退出时仍可查询和释放原控制记录，不重开应用；释放继续核对原 scope 和 lease，其他任务或过期凭证仍被拒绝。原始 owner 命令在应用退出后须提供实际应用标识、可解析的已安装应用名或路径，只允许 status 和 release。没有持有凭证的 App 不能释放；模块 `ownership(APP, action, host=, scope=, lease=, to=, expected_owner=, authorized=)` 对应同一原生协议。模块 `release()` 不批量动用户应用。

崩溃恢复：不会自动过期。只有已确认旧任务停止操作并取得交接授权后才能调用 `owner APP recover --scope new-task --expected-owner old-task --lease OLD_LEASE --authorized`，或 `App.recover(expected_owner=..., lease=..., authorized=True)`。旧 owner 与 lease 任一不匹配均拒绝。持有状态在磁盘按机器和应用保存；应用重开也不擅自抢占。

任务名是本账户内的协作隔离标识，不是阻止恶意程序的权限边界。全局剪贴板、系统授权请求、屏幕枚举和内部窗口截图不属于某个应用任务，不因此获得业务授权。

### 浏览器远程调试授权

browser-control 接管日常浏览器时按应用名调用 approve_chrome_debugging(app_name="Google Chrome", watch=30)；Arc 使用 app_name="Arc"。on_ready 在开始观察前调用，命令行在 stderr 输出 approve-debug ready。观察不长期 claim 浏览器；只处理带远程调试语义、唯一允许按钮和可靠窗口引用的确认框。点击前重新读取同一窗口并核对语义，短保护中要求确切前台窗口，不自动激活或恢复桌面、最小化状态。窗口不在前台时返回 not_sent，需要人工置前；发出后状态改变或框不消失返回 unknown，不重发。原确认框消失返回 approved=true、connectionVerified=false，连接成功必须由 browser-control 独立核对。没有弹框返回 approved=false；其他弹框不处理。
