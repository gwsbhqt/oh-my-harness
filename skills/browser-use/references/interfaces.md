# browser-use 公开接口与命令参考

## Python 显式安装

仅初次部署缺依赖时，使用 `await skills.browser_use.cli("--local", "install")` 显式安装到本技能独立缓存环境。正常调用不自动联网安装；远端需在目标机显式安装，不能把本机安装冒充远端安装。日常动作优先使用下面具名 Python 函数，cli 不是失败兜底。


本文说明当前接口；带 Python 内核直接使用 `skills.browser_use`，实现范围以 `await skills.browser_use.capabilities()` 为准，无内核用法集中在 [CLI 参考](cli.md)。Python 日常流程见 [PYSKILL.md](../PYSKILL.md)，操作与授权规则见 [共用规则](common.md)，工程限制见 [implementation.md](implementation.md)。普通命令以 `browser-use --help` 和子命令 help 为准；Python 领域对象的动态 kwargs 必须符合服务严格 schema，未知字段报 code 2。

## 上下文、探针与生命周期

Python 入口遇到启动或等待超时后，继续从 Python 查询本机后台服务，不改走 CLI：

```python
import asyncio
service_info = await asyncio.to_thread(skills.browser_use.get_client().service, "info")
# 关注 draining、waitingFor、startedAt、fingerprint。
```

这个查询会按需启动本机后台服务，但不连接浏览器、不执行页面动作。它只查本机，不跟随远程机器 pin。查询得知正在等其他任务释放时保留对方任务；耗时诊断及外层执行预算见 [结果未知](common.md#结果未知)。

Python `page(target_id, *, browser="Chrome", host=None, session=None)` 返回惰性 Page；`open_page(url=None, *, browser="Chrome", host=None, session=None, mode=None, profile=None, restart=None, fallback=None, lane=None, init_script=None, capture=True, executable=None, headed=False)` 新建页面。省略 mode 时 Chrome 使用 isolated，Arc 使用 attach；restart 和 fallback 省略时按浏览器取默认值，见主说明的运行方式。host 为 `local` 或已配置 SSH alias，省略时读取 browser-use 独立机器 pin，无 pin 默认本机。Page 在创建时固定 host/browser/session/targetId；改变 pin 或任务默认不改变已有对象，方法不接受临时换 browser/host/session。

`open_window(url=None, *, browser="Chrome", host=None, session=None, source_target=None, lane=None, init_script=None, capture=True)` 在日常实例另开任务窗，固定 attach、restart=never、fallback=never，不复制资料。`open_page` 另支持 `new_window=False, source_target=None`；source_target 只用于新窗口。attach 发现多份 browserContext 时必须指定来源，不猜当前资料。`await page.window()` 返回 `{browserWindowId, bounds, targetId, title, browserContextId}`，只读固定页面所在窗口；browserWindowId 是浏览器内部编号，不是 computer-use 的原生窗口编号。新窗口仍返回 Page，关闭或 release 只处理自建页面；不要为了收尾退出共享浏览器。首次建窗可能被浏览器置前；Arc 实测后台与最小化创建请求仍会置前，不保证这个阶段不打断用户。

CLI 对应 `tab new URL --new-window --mode attach --restart never --fallback never [--source-target SOURCE_TAB]` 和 `tab window TAB`。不同任务分别固定 session；同一任务复用已有 Page，不反复新开窗口。

| 接口 | 含义 |
|---|---|
| `await version(host=None)` | `{tool, version, protocol}`，不连接浏览器 |
| `await capabilities(host=None)` | `{tool, version, protocol, features, capabilities}`；只列 browser-use 实现了的能力，每项 supported 为真，按项有 mode/reason，不是环境在线证明 |
| `await status(browser=..., host=..., session=...)` | 只检查服务/浏览器状态；`connected` 表示缓存连接仍活着；缓存已断线时为 false，已持有页面须显式恢复 |
| `await up(browser=..., host=..., session=...)` | 后台启动或连接浏览器 |
| `await tabs(browser=..., host=..., session=...)` | 返回标签页列表，不自动选择活动页 |
| `await find_tab(query, *, browser="Chrome", host=None, session=None)` | 在当前任务指定的浏览器中按网址或标题找唯一已加载标签并借用；没有匹配报 code 3，多个匹配报 code 2 |
| `await login(page, *, account=None, field=None, timeout=20, native_window=WINDOW_REF)` | 先从 computer-use windows 确认本任务稳定窗口引用；该窗口须已在确切前台，否则未点击账号框即拒绝。 用 1Password 登录停在登录页的已绑定 Page：点账号框（`field` 为它的 CSS，省略按常见写法找），让 computer-use 点 1Password 浮层里的账号（多个账号时 `account` 是按钮文字里要包含的内容），等页面离开登录页，返回 `{loggedIn, account, url, title}`；只点按钮，不读、不填密码；只支持本机；超时没离开登录页报 code 4、outcome 为 unknown，先看页面，不要重试登录 |
| `await release(session=..., browser=None, host=None)` | 释放本任务的浏览器，省略 browser 时 Chrome、Arc 都释放；只关自建页 |
| `await disconnect(session=..., browser=None, host=None)` | 断开任务连接并清脚本、网络、泳道等调试副作用；保留目标和归属 |
| `await page.recover()` | 显式重建原页面调试绑定；无参数，沿用 Page 固定上下文；返回原页面摘要和 `recovered`，重建时另有 `observationsReset=true`、`snapshotRequired=true`；不重放业务动作，限制见 [断线恢复](common.md#断线后的显式恢复) |
| `await page.close(authorized=False)` | 只关此目标；借用页须用户明确允许并传 True |
| `await cli(*args, **options)` | 同一命令解析器入口；不是任意 RPC 绕过 |

capabilities 中 trace 的 scope 为 entire_owned_browser，不是共享浏览器；page_lane 为 page_sessions；remote 为 ssh_rpc。能力清单只列 browser-use 能做的事；做不到的限制写在各自章节，例如跨进程 iframe 里的元素不支持可信悬停。没有公开 Frame 或 PPE preset 接口。

### 选机与任务默认

| Python 接口 | 含义 |
|---|---|
| `await use(host=None, *, clear=False)` / `await pin(host=None, *, clear=False)` | 设置或查询 browser-use 自己的机器 pin；clear=True 恢复默认本机 |
| `await hosts()` | 返回 ok/tool/target/hosts，包含 local 与配置的 SSH alias |
| `await session_use(name=None, *, scope=None, clear=False)` | 为一个任务 scope 选择默认 session；clear=True 回该任务原有自动 session |
| `await session_current(*, scope=None)` | 查询该任务的有效 session，不操作浏览器 |

session 控制返回 `{ok, scope, session, source, pinned}`，source 为 pinned 或 automatic。任务 scope 按显式 `--scope`（Python 控制接口的 `scope`）、`BROWSER_USE_CONTEXT_ID`、`DSH_SESSION_ID` 选择；同一 scope 的自动 session 稳定，不是全电脑默认。显式 session 优先于任务 pin 和自动 session。普通 CLI 浏览器任务无 scope 且无 session 会报 code 2；不按 label、URL 或 targetId 推导。Python 无任务环境且未传 session 时使用进程独立默认。session use/current/clear 不 release、不关页，不修改机器 pin；控制接口必须有 scope，不能借显式 session 代替。

```bash
browser-use hosts --json
browser-use use alpha --json
browser-use pin --json
browser-use use --clear --json
browser-use --scope task-a session current --json
browser-use --scope task-a session use task-browser --json
browser-use --scope task-a session use --clear --json
browser-use -H alpha --scope task-a tab list --json
browser-use --local --scope task-a tab list --json
```

`remote-host` 必须选择远端；browser-use/computer-use/dsh-use 各自没有显式机器与 pin 时默认 local。各工具 pin 独立，失败不回退本机。`-H` / `--host` 仅本次选机，`--local` 明确本机，两者远端冲突报错。探针 version/capabilities/status、选机命令不要求浏览器任务 session。

CLI 共用选项：`--session NAME --scope ID --browser Chrome|Arc -H HOST|--host HOST|--local --json --socket PATH --tab TARGET --rpc-timeout SECONDS`。选项可以放子命令前后，但必须在文本分隔符 `--` 前。`--tab` 可代替目标位置参数；不要重复给两者。以下 `TAB/IDX/TOKEN/REQUEST/ROUTE/PATCH/SUB/SCRIPT/FRAME/CALLFRAME` 为调用结果中的真实值，不是序号推断。路径示例是调用者自己准备的文件。

CLI 共用选项还有 `--snap`：页面动作成功后再取一次态（不截图），结果放在 `snap` 字段；只用于针对确切页面的动作，tab/lane/policy 等命令带它在发送前报 code 2。

批量执行：`browser-use batch [--file PATH] [--continue-on-error]` 从 stdin 或文件读 JSON 数组，每项是一条 browser-use 参数列表，按顺序执行；默认第一条失败即停，返回 `completed`、`stoppedAt` 与每条的 `ok/result` 或错误。外层的 `--session/--scope/--browser/-H/--local/--socket/--rpc-timeout` 作为每条的默认值，单条里显式写的选项覆盖默认；单条不能嵌套 batch、serve、install，最多 500 条、4MiB。Python 直接写循环编排，不另设批量接口。

```bash
browser-use --session task-a batch <<'EOF'
[["goto","TAB","https://example.com"],
 ["type","TAB","--id","name","--","中文"],
 ["click","TAB","--id","go","--snap"]]
EOF
```

运行方式由 `mode=attach|isolated|clone` 选择。isolated 的 `profile=NAME` 是持久资料名，保存在 `$XDG_STATE_HOME/browser-use/chrome-profiles/NAME`（700），登录态和扩展跨 release 保留；省略则用临时干净资料并禁扩展。clone 的 profile 是日常 Chrome 的来源资料名，例如 Default，复制到本任务私有目录并保留扩展。代理、证书、语言、UA、窗口尺寸放在 launch；attach 不改日常 Chrome，不接受这些启动选项。

```bash
browser-use version --json
browser-use capabilities --json
browser-use status --json
browser-use install
browser-use --session task-a up --json
browser-use --session task-a tab list --json
browser-use --session task-a tab new https://example.com --json
browser-use --session task-a tab bind TAB --json
browser-use --session task-a tab find 古歌云 --json
browser-use --session task-a login TAB --native-window WINDOW_JSON --account 文字 --field 'input[type=email]' --timeout 20 --json
browser-use --session task-a tab recover TAB --json
browser-use --session task-a tab close TAB --authorized --json
browser-use --session task-a disconnect --json
browser-use --session task-a release --json
```

`tab close --authorized` 仅在已获关闭借用页授权时用。release 和 disconnect 只处理本任务的浏览器，不写 `--browser` 时 Chrome、Arc 都处理。页面在这之前已被别处关掉（用户手动关了标签等）时照常成功，这些页面列在 `closedExternally` 里、记录已清理，不算失败；`tab close` 遇到这种页面返回 `closedExternally: true`。其他命令不写 `--browser` 默认 Chrome。`browser-use serve --socket /tmp/task-a-browser-use/service.sock` 是持有服务锁的常驻服务命令，socket 须在本用户专用私有目录中；启动脚本要求 serve 是第一个参数，不接受 --session，普通调用会按需连接，Python 不管理后台 serve。正常任务无需手动 serve。`--socket` 是调用端本机连接参数，不与远程 host 混用。

## 页面方法与普通 CLI

方法签名中的上下文已由 Page 固定。独立模块页面函数接受 targetId 或 Page。编号方法须 snapshot；Page 自动补最近凭证。`snap` 返回 Snap 或 Diff；`read` 返回文本，`shot` 返回路径，`evaluate` 返回 JSON 值，其余返回服务结果。

| Page 方法 | 主要参数 |
|---|---|
| snap | `shot=False, diff=False, all=False, max=300, depth=None, out=None, shrink=1400, within=None（唯一 CSS 容器，只在主文档）, interactive_only=None, include_urls=None, ax_properties=None` |
| click | `idx=None` 或 `id/label/selector/at` 五选一，`count=1, button="left", snapshot=None, position=None`（center/top-left） |
| type_text | `text, allow_newline=False, position=None`（cursor/start/end），定位 `idx/id/label/selector` 至多一个，省略则输入到当前焦点；整段一次性插入（259 个汉字约 0.1 秒），页面收不到逐个按键 |
| key | `keys`（如 `"Control+Shift+K"`、`"Meta+a"`、`"F5"`、`"Control++"` 表示加号），定位同上 |
| type_keys | `text, delay_ms=0, allow_newline=False, position=None`，定位同上；逐键发送，页面收到 keydown/keypress/keyup（259 个汉字约 0.25 秒） |
| key_down / key_up | `key`；按住的修饰键影响后续按键和鼠标，释放页面时自动松开 |
| edit | `command`：copy/cut/paste/select_all/undo/redo，定位同上；复制剪切粘贴只在无界面 Chrome，有界面浏览器报 code 5；undo/redo 任何浏览器都可用 |
| mouse_move | `x, y, steps=1` |
| mouse_down / mouse_up | `x=None, y=None, button="left", click_count=1`；省略坐标用上次位置 |
| wheel | `dx, dy`（至少一个）, `x, y` |
| page_info | 无参；url、title、readyState、视口与滚动位置、是否有未处理对话框 |
| page_text | `max_chars=20000, frame=None`；truncated 表示超出 |
| frames | 无参；frameId、父框架、url、是否跨进程 |
| fill_form | `items`，每项 `{selector, value, kind?, by?}`；kind 为 text/select/check/uncheck，省略时按元素推断；by 为 value/label，只用于下拉框；出错即停，返回已完成项与 stoppedAt |
| upload_via_chooser | `files`，定位 `idx/id/label/selector` 恰好一个，`timeout=5`；点击后拦截文件选择框填入文件，没弹出报 code 1 且不重点 |
| set_value / act / selecttext | `idx, value/action/text, snapshot=None`；act 仅支持 Press/ScrollToVisible，需与观察中的 actions 核对 |
| read | `idx, selected=False, snapshot=None` |
| scroll | `idx=None, direction="down", pages=1, snapshot=None` |
| drag | `start, end`，页面 CSS 坐标；不是 HTML5 data transfer 保证 |
| wait | 七选一：`label`、`text`、`expression`、`selector`（配 `state`：visible/hidden/attached/detached）、`url`（主框架网址通配）、`load`（domcontentloaded/load/networkidle）、`any_text`（文字列表，任一出现即返回 index）；另有 `timeout=10`、`gone`（只配 label/text/expression/url） |
| shot | `out=None, shrink=1400（0 为原图）, full_page=False, overwrite=False, format=None（png/jpeg/webp）, quality=None（jpeg/webp 0~100）` |
| goto / reload / back / forward | `url` / `bypass_cache=False` / 无参 / 无参；都可加 `timeout`、`before_unload`（report 默认：遇离页确认停下报告；accept；dismiss） |
| evaluate | `expression` |
| init_add / init_remove | `script` / `identifier` |
| upload | `idx, files, snapshot=None` |
| dialog | `accept=True, text=None`；业务确认仍须授权 |
| viewport | `width, height, scale=1, mobile=False` |
| download | `action="list", guid=None, timeout=10, path=None`；action 为 list/wait/directory |
| popups | 无参，只列目标，不切页 |

### 动作返回：落到哪、改前改后、页面稳没稳

输入类动作（type_text、key、type_keys、edit、set_value、fill_form 每一项）都回报落点，用来核对「字是不是进了想要的框」：

| 字段 | 含义 |
|---|---|
| `target` | 实际接收输入的元素：`tag`、`role`、`name`（无障碍名字、label 或 placeholder）、`id`（网页 DOM 的 id 属性）、`idx`（只在它属于你最近一次 snap 时给）、`editable`（input/textarea/contenteditable/select/checked） |
| `targetText` | 同一个元素的一句话描述，如 `textbox「标题」#title（编号 5）` |
| `before` / `after` | 动作前后的值：输入框是 value，富文本是整个编辑区的 innerText；超过 1000 字只给前 1000 字，并带 `beforeTruncated` / `afterTruncated`；`beforeLength` / `afterLength` 是完整长度 |
| `changed` | 值有没有变 |
| `redacted` | 密码框、`autocomplete` 含 password/one-time-code/cc- 的字段：`before`/`after` 为 null，只给长度 |
| `focus` | 怎么拿到焦点：`focus` 按定位聚焦；`editing-host` 定位的是富文本里的段落等不可聚焦元素，改为聚焦整个编辑区并把光标放进该元素（同时给 `caret`）；`current-focus` 没给定位，发给了当前焦点 |
| `note` | 没给定位时提醒输入去了哪个元素 |

`before` 就是撤销依据：写错了可以 `edit undo`，或把 `before` 写回去。

click 回报点完之后焦点在哪：`focused` / `focusedText` 是此刻拿着焦点的元素；`focusRelation` 为 self（就是被点元素）、descendant（在它里面）、editing-host（包着它的富文本编辑区）、none（没有元素拿到焦点）、other（别的元素）；`focusInTarget` 为前三种时真。点了编辑框但 `focusInTarget=false`，说明焦点没进去，后面不带定位的输入会落到别处。焦点在输入框或富文本里时还给 `caret`：输入框是 `{start, end}`，富文本是光标所在元素和前后 15 个字。`point` 是实际点的位置：`position` 为 center、top-left、visible-center、left-middle、top-middle；首选点被挡住、换点成功时带 `retried` 和 `note`。

输入和点击都会再给 `stable` 和 `settled`：动作后 browser-use 最多等 0.35 秒，页面 80 毫秒内不再有 DOM 变化就算稳定（`stable=true`），`settled` 是实际等了多少秒。`stable=false` 说明页面还在变，比如正在加载列表、弹窗正在打开；这时用 `wait` 等一个明确条件（文字出现、元素出现或消失、网址变化），不要固定 sleep。弹出了页面对话框时带 `settleReason="dialog"`。

### 插入位置、撤销、点击位置

- `type_text` / `type_keys` 的 `position`：不给或 `cursor` 是当前光标处（与以前一样：带定位时聚焦后光标停在浏览器默认位置，输入框是原有文字末尾）；`start` 插到元素开头，`end` 插到末尾。输入框用 setSelectionRange，富文本放到第一个或最后一个有字的位置，不动原有分段和列表。命令行 `--position start`。
- `edit undo` / `edit redo`：浏览器自带的撤销、重做（等同用户按 ⌘Z / ⇧⌘Z），对输入框和富文本都有效，页面能收到输入事件；返回 `after` 就是撤销后的值。只撤浏览器编辑历史里的步骤，页面用脚本直接改的值撤不了；页面自己拦截了 ⌘Z 时以页面行为为准，看 `after` 核对。
- `click` 的 `position`：不给或 `center` 点中心；`top-left` 点内容区左上角往里 4 像素，适合要把光标放进富文本开头的场景。点不到时会在元素看得见的部分里换几个点再试，全都被挡住才报错，报错写明挡住它的元素（标签、id、class、前 30 字）以及它是被点元素的外层还是无关元素。

### 找不到元素时的提示

id、label、selector 一个都没匹配到时报 code 3，并在 `data.candidates` 里列出最多 5 个最像的元素（按文字包含和相似度挑），每项有 idx（属于 `data.snapshot` 那次取态）、role、label、id。id 传了纯数字时提示「id 是网页元素的 id 属性，不是编号，按编号请用 idx」。定位的元素不能接收输入时（例如普通段落），报错写明原因和离它最近的可输入元素。

每个普通页面命令的 parser 示例：

```bash
browser-use --session task-a snap TAB --all --max 300 --json
browser-use --session task-a snap TAB --shot --json
browser-use --session task-a click TAB --id search --json
browser-use --session task-a click TAB IDX --snapshot TOKEN --json
browser-use --session task-a type --id search TAB --json -- "中文关键词"
browser-use --session task-a key TAB --json -- "Ctrl+a"
browser-use --session task-a click TAB --selector '{"text":"提交"}' --json
browser-use --session task-a type-keys TAB --selector '{"css":"#q"}' --delay-ms 20 --json -- "逐键"
browser-use --session task-a key-down TAB Shift --json
browser-use --session task-a edit TAB select-all --selector '{"css":"#q"}' --json
browser-use --session task-a type TAB --id editor --position start --json -- "前缀，"
browser-use --session task-a edit TAB undo --json
browser-use --session task-a click TAB --id editor --position top-left --json
browser-use --session task-a snap TAB --within '#content' --json
browser-use --session task-a mouse-move TAB 200 300 --steps 5 --json
browser-use --session task-a wheel TAB --dy 600 --json
browser-use --session task-a page-info TAB --json
browser-use --session task-a page-text TAB --max-chars 5000 --json
browser-use --session task-a fill-form TAB --items '[{"selector":{"placeholder":"邮箱"},"value":"a@b.c"},{"selector":{"css":"#city"},"value":"上海","by":"label"},{"selector":{"label":"同意条款"},"value":true}]' --json
browser-use --session task-a upload-chooser TAB /tmp/task-a-upload.txt --selector '{"text":"选择文件"}' --json
browser-use --session task-a wait TAB --selector '{"css":".spinner"}' --state hidden --json
browser-use --session task-a wait TAB --any-text "成功" --any-text "失败" --json
browser-use --session task-a wait TAB --load networkidle --json
browser-use --session task-a shot TAB --format jpeg --quality 70 --out /tmp/task-a-shots/page.jpg --json
browser-use --session task-a goto TAB --before-unload accept --json -- https://example.com/next
browser-use --session task-a set TAB IDX "替换值" --snapshot TOKEN --json
browser-use --session task-a act TAB IDX ScrollToVisible --snapshot TOKEN --json
browser-use --session task-a selecttext TAB IDX "选中文字" --snapshot TOKEN --json
browser-use --session task-a read TAB IDX --snapshot TOKEN --json
browser-use --session task-a scroll TAB --direction left --pages 1 --json
browser-use --session task-a drag TAB 10,20 100,120 --json
browser-use --session task-a wait TAB --expression 'document.readyState === "complete"' --timeout 10 --json
browser-use --session task-a shot TAB --out /tmp/task-a-page.png --full-page --json
browser-use --session task-a goto TAB https://example.com --json
browser-use --session task-a reload TAB --bypass-cache --json
browser-use --session task-a back TAB --json
browser-use --session task-a forward TAB --json
browser-use --session task-a eval TAB --json -- 'document.title'
browser-use --session task-a init TAB add --json -- 'window.taskProbe = true'
browser-use --session task-a init TAB remove SCRIPT --json
browser-use --session task-a upload TAB IDX /tmp/task-a-upload.txt --snapshot TOKEN --json
browser-use --session task-a dialog TAB --dismiss --json
browser-use --session task-a viewport TAB 1280 800 --scale 1 --json
browser-use --session task-a download TAB list --json
browser-use --session task-a download TAB wait --guid GUID --timeout 10 --json
browser-use --session task-a download TAB directory --path /tmp/task-a-downloads --json
browser-use --session task-a popups TAB --json
```

networkidle 取 Chrome 自己的 networkIdle 生命周期事件：当前文档 0.5 秒内没有网络连接。页面一直有长连接或轮询时它不会到来，业务等待优先用文字或元素条件。

截图默认写进 700 私有目录里的 600 新文件；默认不覆盖；本机显式 --overwrite 才覆盖。远程截图 overwrite 暂不支持；out 是本机用户拥有的真实私有目录（700）中的新文件，发布文件权限 600。download directory 只在专用 Chrome 私有上下文可用，远程调用的 path 仍指目标机目录，list/wait 不自动取回下载文件。以上对话框例子拒绝弹窗；接受具有业务影响的弹窗要先有对应授权。

## 远程 RPC 与文件

真实 SSH 携带结构化 JSON 请求到目标机 `~/.local/bin/browser-use rpc --json`，请求明确 `host="local"` 与 session，由目标机本地 Unix socket daemon 执行，不递归读取远端机器 pin，也不开放 CDP 端口。先验证工具名 browser-use、协议 1 与 local-routing/remote-rpc 能力，能力不足不发动作。调用端和目标机须已显式安装 `_shared` 共用代码、browser-use 入口与声明依赖；普通调用不自动安装。`BROWSER_USE_REMOTE_LAUNCHER` 仅供显式测试部署，必须是目标机绝对路径，不从 PATH 找替代。

自动取回严格限 `page_snap` 的 shot、`page_shot` / `element_screenshot` 的 path，debug source 的 artifact.path，以及 output_*、inspect_*、network_request 结果中的 `artifact.path` 和 `artifacts[].path`。state_save 的登录状态文件含 Cookie 原值，只留在目标机，不自动取回。先后核对远端文件字节数与 SHA-256，本机校验一致才发布私有新文件；返回路径改为本机路径，并保留 remotePath、hostContext、bytes、sha256。hostContext 包含固定 host/session/browser，页面请求另含 target。其他返回字段中的路径不猜测、不自动下载；HAR 是实际返回 JSON 的调用端写新文件，不是任意 artifact fetch。

远程 upload 的 files 和 network override 的 file 指明确本机文件，先上传至目标机私有 stage 并校验。upload stage 保留到页面 tab close 或 session release；disconnect 保留，不能在上传动作回执后立刻删掉供页面后续读取的文件。network override 注册时读取文件快照，注册后可清理 stage。清理只针对本次归属的暂存，失败明示，不重发业务动作。`route(action="fulfill", file=...)` 没有这条本机 stage 适配，file 仍是目标机绝对路径。下载目录也仍在目标机。

远程 OOPIF 尚未现场验收；接口支持声明不等于已部署或已验证。

第三阶段新增的能力（State、Inspect、Output、网络控制台详情与请求头认证、语义定位、键鼠、表单、等待、截图格式、文件选择框上传）都在本机 browser-use 自启的独立 Chrome 上实测过，普通命令与 Python 两个入口都跑过。远程主机上还没有现场验证：远程产物取回、文件选择框上传的暂存只有单元测试覆盖。

## Snap / Diff

Snap 的 `data/elements/snapshot/shot/screenshot/truncated/timed_out/warnings/page/window/remote_path/host_context` 保留已返回数据或对应元信息。`find(label=None, role=None, id=None, contains=None, action=None)` 只筛当前记录，`one(...)` 必须唯一；`table(limit=60)`、`tree(limit=200, keep_empty=False)` 缩减展示，`children(idx)` 看已记录直接子节点。它们不补抓截断内容。

取态默认最多列 300 个元素（`max`）、25 层（`depth`）。装不下时先保留此刻视口里看得见的元素，再按页面顺序补，所以长侧栏不会把屏幕上的主内容挤掉；保留下来的元素仍按页面顺序编号，table 也按页面顺序显示。`truncated=true` 时返回 `truncation`（Snap 对象上是 `snap.truncation`）：`limits` 撞到的是 max 还是 depth，`max`/`depth` 本次上限，`skippedNodes` 没检查的节点数，`estimatedMissing` 估计漏掉的元素数，`kept` 为 viewport-first 或 page-order，`suggestedMax`/`suggestedDepth` 建议值，`containers` 页面上最大的几个区域（`css` 可直接给 within，另有 tag、role、interactive 可交互元素数、main 是否主内容区、inViewport），`hint` 一句话补救办法。`repr(snap)` 和 `snap.one()` 的报错会带上这句 hint。实测 500 个按钮的页面：max=300 约 0.7~1 秒，max=500 约 0.8~1.1 秒。

Diff 提供 data/snapshot/changed/added/removed，无变化布尔值为假；updated 是公开对象的占位字段，当前后端不输出逐项更新，不承诺其有内容。

## Element 与定位 scope

Python：`page.element(selector=None, css=None, id=None, testid=None, label=None, role=None, idx=None, frame=None, within=None, shadow=None)`。selector 不得和直接定位字段混用。`page.elements(selector=None, frame=None, within=None, shadow=None, limit=100)` 返回列表及 Element 对象，每项已有句柄。列表默认 `{"css":"*"}`，limit 上限 1000。

- selector 字段只允许 css/id/testid/label/role/idx/snapshot、语义定位 text/placeholder/alt/title（四选一，可配 match=exact/contains、ignore_case）、nth，以及可放入 selector 的 frame/within/shadow。Python 的 `page.element(...)` 同样接受这些具名参数。
- text 匹配可见元素的可见文字（按钮类 input 用 value），压缩空白后比较，只取最内层命中。nth 从 0 起，负数从末尾数，必须配一个定位字段；不给 nth 时仍要求唯一，多个匹配报 code 3 并给出个数。
- css、id、testid 三者只能单独用；label 与 role 可以组合，精确匹配。idx 只能配 snapshot，不能再指定 scope。
- frame 为固定 frame ID，默认主文档。within 为唯一 CSS 容器。shadow 为依次进入的唯一 CSS host 列表，仅 open shadow root。scope 不可重复写在 selector 和顶层。
- resolve 固定 `{token,targetId,frame,document,loader,backendNodeId}` 句柄；不得修改或跨服务、目标使用。首次操作后导航/节点移除 code 4，不重新定位。

| Element Python | CLI/service action | 严格额外字段（除 handle） |
|---|---|---|
| resolve() / describe() | resolve / describe | resolve: selector, frame, within, shadow；describe 无 |
| 列表 page.elements(...) | list | selector, frame, within, shadow, limit |
| read() | read | 无 |
| attribute(name) | attribute | name |
| html(outer=True) | html | outer |
| measure() | measure | 无；返回 bounding/quads/coordinateSpace/frame/metadata |
| styles(names=...) | styles | names，非空 CSS 名称列表 |
| screenshot(...) | screenshot | out, shrink, overwrite, format, quality |
| click(count=1, button="left") | click | count, button；返回同页面 click 的焦点与点位字段 |
| type_text(text, allow_newline=False) | type | text, allow_newline；返回落点与前后值 |
| key(keys) | key | keys 或 key，恰好一个 |
| set_value(value) | set | value |
| scroll(direction="down", pages=1) | scroll | direction: up/down/left/right，pages |
| focus() / hover() | focus / hover | 无 |
| check(checked=True) / uncheck() | check / uncheck | checked；原生 checkbox/radio 直接设值，role 为 checkbox/switch/radio/menuitemcheckbox 时可信点击并核对 aria-checked，没变成期望值报 code 1，不重点 |
| select(value=None, values=None, label=None, labels=None) | select | 四选一；label 按选项可见文字匹配；原生 SELECT |
| fill(value, allow_newline=False) | fill | value, allow_newline；清空后可信插入并回读核对，支持文本框、多行文本框、可编辑区域；密码框不回传值 |
| evaluate(function, args=None, timeout=None) | evaluate | function（this 是元素）, args（JSON 列表）, timeout；页面异常报 code 1 并附原文 |
| drag_to(target=None, selector=None, mode="auto", steps=10) | drag_to | target（另一个 Element 或 handle）或 target_selector；可拖元素走浏览器拖放并核对目标收到 drop，mouse 模式不核对；源或目标在跨进程 iframe 里报 code 5 |
| patch(...) | patch | attrs, text, styles，至少明确一种 |
| restore(patch_id) | restore | 只传 patchId，不传 handle |

CLI 返回 handle 后后续动作必须原样回传。定位和字段示例：

```bash
browser-use --session task-a element TAB resolve --selector '{"id":"search"}' --json
browser-use --session task-a element TAB list --selector '{"css":"button"}' --params '{"limit":20}' --json
browser-use --session task-a element TAB styles --handle '{"token":"TOKEN","targetId":"TAB","frame":"FRAME","document":"DOC","loader":"LOADER","backendNodeId":1}' --params '{"names":["color","font-size"]}' --json
browser-use --session task-a element TAB restore --params '{"patchId":"PATCH"}' --json
browser-use --session task-a element TAB resolve --selector '{"text":"提交","match":"contains"}' --json
browser-use --session task-a element TAB evaluate --handle "$HANDLE" --file ./probe.js --params '{"args":[3]}' --json
echo 'function(){ return this.getBoundingClientRect().width }' | browser-use --session task-a element TAB evaluate --handle "$HANDLE" --file - --json
```

handle 示例只展示结构，实际必须整体复制 resolve 返回值，不能自己构造。元素 screenshot 支持平面未变换 OOPIF；旋转/透视/变换坐标拒绝。OOPIF hover code 5，不能用合成事件“补齐”。set/select/scroll/patch via=property、trusted=false；patch 必须显式 restore，外部值变化拒绝覆盖。

## Debug：页面固定，字段有限

`page.debug.call(method, params=None, timeout=20, session_id=None, authorized=False, scope=None)` 是公开 raw CDP；session_id 只能是绑定页面所属已接入会话。有限 guard 禁止另选 target/session/browserContext 以及归属、网络、初始化脚本等绕过；不是任意 JavaScript/DOM 的完整安全沙箱。Browser raw 仅显式 authorized=true、scope=browser 的 getVersion/getBrowserCommandLine，只读元信息。Target/Fetch/IO/Tracing/Storage/ServiceWorker/SystemInfo/Tethering/Security 不走 raw。领域接口是生命周期动作的唯一受管理入口。

`page.debug.subscribe(methods, limit=1000)` 返回 EventStream，`read(limit=100, wait_timeout=0)` 自动推进 cursor，`stop()` 停订阅。订阅只观察后续事件，不自动 enable 对应域；需要时先用受允许的 call 或领域 enable。动态领域方法均仅具名参数：

| action | 允许字段 |
|---|---|
| events_start | methods, limit, max_bytes |
| events_read | id 或 subscriptionId, after, limit, wait_timeout |
| events_stop | id 或 subscriptionId |
| enable | session_id |
| sources | session_id, after, limit |
| source | script_id, session_id, timeout |
| breakpoint | url 或 url_regex 或 script_id；line, column, condition, session_id |
| remove | id（本任务 breakpointId） |
| pause / resume / stack | session_id |
| step | kind: over/into/out, session_id |
| evaluate_frame | call_frame_id, expression, session_id, throw_on_side_effect, timeout |

line/column 从 0 起。enable 后才设置断点；script_id 要被本页面观察到。evaluate_frame 的 call_frame_id 属于当前已观察暂停栈，默认 throw_on_side_effect=true。timeout 为有限正数，最大 600 秒；wait_timeout 为 0~30 秒。events_start 方法名精确，不通配 callback；最多 64 方法、32 订阅，缓存默认 1000 事件/4MiB。事件返回 cursor/latestCursor/oldestCursor/dropped/lostSinceCursor/truncated/upstreamDropped/complete。

```bash
browser-use --session task-a debug TAB call --params '{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true},"timeout":10}' --json
browser-use --session task-a debug TAB events-start --params '{"methods":["Debugger.paused"],"limit":100}' --json
browser-use --session task-a debug TAB events-read --params '{"id":"SUB","after":0,"limit":20,"wait_timeout":1}' --json
browser-use --session task-a debug TAB events-stop --params '{"id":"SUB"}' --json
browser-use --session task-a debug TAB enable --json
browser-use --session task-a debug TAB sources --params '{"limit":20}' --json
browser-use --session task-a debug TAB source --params '{"script_id":"SCRIPT"}' --json
browser-use --session task-a debug TAB breakpoint --params '{"url":"https://example.com/app.js","line":10}' --json
browser-use --session task-a debug TAB remove --params '{"id":"BREAKPOINT"}' --json
browser-use --session task-a debug TAB pause --json
browser-use --session task-a debug TAB stack --json
browser-use --session task-a debug TAB evaluate-frame --params '{"call_frame_id":"CALLFRAME","expression":"count","throw_on_side_effect":true}' --json
browser-use --session task-a debug TAB step --params '{"kind":"over"}' --json
browser-use --session task-a debug TAB resume --json
```

source 返回 `artifact={path,bytes,complete,summary}`，目录 700、文件 600，release 后保留，browser-use 后台服务退出时删除。summary 标明真实来源。

## State：Cookie、网页存储与登录状态文件

Python `page.state.ACTION(**params)`；CLI `browser-use state TAB ACTION --params JSON [--authorized]`，动作名的下划线写成短横线。共享浏览器 上的写操作和导出必须 `authorized=true`，否则 code 6。

| action | 字段 | 说明 |
|---|---|---|
| cookies_get | urls, raw, authorized | Cookie 值默认打码，只给长度和前后各 2 个字符（8 个字符以下全部打码）；raw=true 才返回原值，共享浏览器 上还要 authorized |
| cookies_set | name, value, url 或 domain, path, secure, httpOnly, sameSite, expires（Unix 秒）, partitionKey, authorized | 用页面会话写入 |
| cookies_delete | name, url 或 domain, path, partitionKey, authorized | |
| cookies_clear | authorized | 自启 Chrome 只清本任务的私有空间；共享浏览器 会清掉所有站点的 Cookie 且无法撤销 |
| storage_get | kind(local/session), origin, frame, limit | 只能访问当前页面主框架与 iframe 里出现的来源，其他来源 code 6 |
| storage_set / storage_remove / storage_clear | kind, origin, frame, key, value, authorized | |
| state_save | path, origins, session_storage, authorized | 写成新文件：目录 700、文件 600，不覆盖；只含所选来源对应的 Cookie 原值与 localStorage，sessionStorage 可选 |
| state_load | path, origins, cookies, storage | 只载入 browser-use 自启的私有 Chrome；文件必须是本人的 600 普通文件。当前页面没有的来源列在 pending，先导航过去再用 cookies=false 载一次存储 |
| state_show | path | 只给摘要：域名、Cookie 个数、存储键数，不给值 |

共享浏览器 上设置或删除 Cookie、写网页存储时，先记下原值，释放页面时恢复；释放前若已被用户或页面再改过同一项，就不覆盖，记进清理错误。登录状态文件含 Cookie 原值，远程时只留在目标机，不自动取回。

```bash
browser-use --session task-a --browser Chrome state TAB state-save --params '{"path":"/abs/dir/login.json","origins":["https://example.com"]}' --json
browser-use --session task-b --browser Chrome state TAB state-load --params '{"path":"/abs/dir/login.json"}' --json
```

## Inspect：CSS 来源

Python `page.inspect.ACTION(**params)`；CLI `browser-use inspect TAB ACTION --params JSON [--handle JSON] [--authorized]`。都不写盘。

| action | 字段 | 返回要点 |
|---|---|---|
| css | handle 或 selector{css}（只查主框架、必须唯一）, page_idx, page_size(1~100，默认 10) | rules[]：type（inline/attributes/matched/inherited/pseudo/keyframes/property/at-rule）、selector、source{url,line,column}、specificity、ancestors（@media/@container/@supports/@layer/@scope 等）、properties[{name,value,status: active/overloaded/invalid/disabled}]；另有 customProperties 与分页 |

CSS 胜出与覆盖由 browser-use 按层叠规则计算（来源、!important、行内、@layer、优先级、书写顺序），未计入动画、过渡、@scope 就近规则与 shadow DOM 层叠；@container 只给查询条件和容器名，指不出容器元素。

```bash
browser-use --session task-a inspect TAB css --params '{"selector":{"css":"#title"}}' --json
```

## Output：截图比较与标注

Python `page.output.ACTION(**params)`；CLI `browser-use output TAB ACTION --params JSON`。写盘产物都在 `artifact`（没写文件时为 None）。没给 out 写进私有临时目录；给了 out，所在目录必须是本人所有的 700 目录且不是链接，不存在时以 700 新建。默认不覆盖已有文件（code 6），overwrite=True 时先写临时文件再整体替换。

| action | 字段 | 说明 |
|---|---|---|
| shot_if_changed | key（必填）, threshold(0~1), format, quality, full_page | 与同一 key 上次写出的图比较，未变时不写文件、changed=false；最多 16 个 key，只在内存里，释放页面清空 |
| diff_screenshot | baseline（PNG，必填）, out, overwrite, color_threshold(0~1，默认 0.1), full_page | 任一通道差超过 color_threshold×255 记为变化；输出红色标记的差异图。尺寸不同时 size_mismatch=true，不写文件 |
| annotate | elements[{idx, bounds{x,y,width,height}}], out, format, quality, full_page, overwrite | 隔离世界里画编号框、截图后移除；bounds 用根视口 CSS 像素，iframe 元素用 snap 的 rootBounds |

截图比较与差异图用纯 Python 解码 PNG，单张上限 1600 万像素，大图会慢；jpeg/webp 的变化检测会截两次图（先截 png 比较）。

两段文本的比较：`skills.browser_use.diff_text(before, after, context_lines=3)` 或 `browser-use diff A.txt B.txt [--context N]`，返回 changed/added/removed/diff，输出有上限并标截断。与基准快照比较时，先把快照文本存成文件再比较。

```bash
browser-use --session task-a output TAB diff-screenshot --params '{"baseline":"/abs/base.png"}' --json
```

## Network：匹配和改写分开

`page.network` 动态方法见下表；仅 request/request_body/console_message 的 id、route/override 的 pattern、unroute/unoverride 的 routeId 允许一个位置参数，其余具名。所有方法严格拒绝未知字段。

| action | 允许字段 |
|---|---|
| requests | filter（URL 子串）, url（通配）, method, status（200、"2xx" 或 "400-499"）, resource_types（Document/XHR/Fetch 等，不分大小写）, limit 或 page/page_size 或 after（"req-N" 游标）, include_previous_navigations, raw |
| request | id 或 requestId, body, postData, save_body, save_post_data, raw |
| request_body | id 或 requestId, raw |
| ws_frames | connectionId, after, limit |
| ws_connections | limit |
| cache / service_worker | disabled / bypass（必须布尔值） |
| controls / clear / har_stop | 无 |
| har_start | content（none/text/all）或旧的 body（等同 text）, raw |
| console / errors | limit 或 after（"msg-N" 游标）+ page_size, types, include_previous_navigations |
| console_message | id（"msg-N"）, property_limit（1~200） |
| headers_set | headers, origin, replace |
| headers_get | raw |
| headers_clear | origin, names |
| auth_set | username, password, origin（必填）, authorized |
| auth_clear | origin |
| route | url 或 pattern, action, method，及下表动作字段 |
| override | url 或 pattern, file, status, headers, method |
| unroute / unoverride | routeId 或 id；省略则清本记录器全部规则 |

| route action | 允许动作字段与含义 |
|---|---|
| continue | headers 或 rewrite；rewrite={url,method,postData,headers,removeHeaders}；顶层 method 是匹配，rewrite.method 是新方法 |
| abort | errorReason（合法 CDP 网络失败原因） |
| fulfill | headers, body 或 file, status；直接模拟响应 |
| response_transform | transform={json 或 text,status,headers,removeHeaders}；真实响应阶段转换 |

`transform.json={set:{JSON_POINTER:VALUE}, remove:[JSON_POINTER]}`，支持明确对象/数组位置，不是任意 JSON Patch 脚本。`transform.text={replace:[{from:"旧",to:"新"}]}`，字面替换。JSON/text 互斥。响应只接受有界 UTF-8/ASCII 支持文本类型；JSON 要求 JSON Content-Type，拒绝重复键/非法常量。失败、重定向、HEAD、204/205/304 等无正文响应、二进制、非 UTF-8 明确失败，不重发、不静默继续。保留未变的头，去旧压缩/分块/完整性头并重算长度。默认单正文 2MiB、保留总正文 8MiB。file 是绝对普通文件，登记时读取快照，磁盘变化需重新登记。

CLI network 的 --params 使用同一字段；--action block/headers/fulfill/response-transform 分别映射 abort/continue/fulfill/response_transform。--status 只筛 requests，--status-code 是模拟响应状态，不能混淆。CLI ws-frames/ws-connections 是实际动作；parser 虽列 websockets，但没有同名服务实现，不作为推荐入口。

```bash
browser-use --session task-a network TAB requests --url '*/api/*' --method GET --status 200 --limit 20 --json
browser-use --session task-a network TAB request REQUEST --body --params '{"postData":true}' --json
browser-use --session task-a network TAB request-body REQUEST --json
browser-use --session task-a network TAB route '*/api/*' --action headers --params '{"rewrite":{"method":"POST","postData":"{}","headers":{"X-Test":"1"},"removeHeaders":["X-Old"]}}' --json
browser-use --session task-a network TAB route '*/api/result' --action response-transform --params '{"transform":{"json":{"set":{"/ready":true},"remove":["/debug"]}}}' --json
browser-use --session task-a network TAB override '*/app.js' --params '{"file":"/tmp/task-a-app.js","headers":{"Content-Type":"application/javascript"}}' --json
browser-use --session task-a network TAB unoverride ROUTE --json
browser-use --session task-a network TAB unroute ROUTE --json
browser-use --session task-a network TAB ws-connections --limit 10 --json
browser-use --session task-a network TAB ws-frames --params '{"after":0,"limit":20}' --json
browser-use --session task-a network TAB cache --params '{"disabled":true}' --json
browser-use --session task-a network TAB service-worker --params '{"bypass":true}' --json
browser-use --session task-a network TAB controls --json
browser-use --session task-a network TAB console --params '{"types":["error","warn"],"page_size":50}' --json
browser-use --session task-a network TAB console-message msg-12 --json
browser-use --session task-a network TAB requests --status 4xx --params '{"resource_types":["XHR","Fetch"]}' --json
browser-use --session task-a network TAB headers-set --params '{"headers":{"X-Debug":"1"},"origin":"https://api.example.com"}' --json
printf '%s' "$PASS" | browser-use --session task-a --browser Chrome network TAB auth-set --password-stdin --params '{"username":"u","origin":"https://intranet.example"}' --json
browser-use --session task-a network TAB errors --limit 20 --json
browser-use --session task-a network TAB har-start --body --json
browser-use --session task-a network TAB har-stop --out /tmp/task-a.har --json
browser-use --session task-a network TAB clear --json
```

每条请求与消息都带 `navigation`（主文档每次新导航加一），include_previous_navigations=false 只看当前导航。`save_body`/`save_post_data` 取 true 或绝对路径，把解码后的原始字节写进新私有文件，结果放在 `artifacts`；取不到正文不留半个文件也不重发。

控制台消息与错误共用递增编号 `msg-N`，含 type、level、text、args 预览、stackTrace、url/行列号与 navigation；日志的 warning/info/verbose 记为 source=log，浏览器「问题」记为 type=issue。console_message 逐个展开参数一层（对象的自有属性，不调用取值函数）；导航后对象失效时在 reason 里说明，不报错。不做 source map 还原。

额外请求头：不给 origin 时作用于页面与已接入 iframe 的会话，给了 origin 时用请求拦截只加在该来源的请求上。泳道五头报 code 6，只走 lane；Host、Content-Length 这类网络栈维护的头报 code 2；headers_get 的敏感头值默认脱敏。HTTP Basic 认证只回应 origin 服务器的 Basic 质询，同一请求被二次质询就取消，不再重试；密码只存在内存，任何输出都不回显。共享浏览器上 auth_set 必须 authorized=true，因为认证成功后浏览器会在同一资料里缓存这组凭据，auth_clear 和释放都清不掉。CLI 只接受 `--password-stdin` 从标准输入读密码；写进 --params 报 code 6。释放页面撤销请求头与认证拦截。

兼容变化：har_start 的旧 body=true 现在只抓文本类正文，二进制要 content="all"；errors 里网络失败记录的请求编号字段是 requestId，id 是消息编号。

request 返回缺正文原因，不补发请求；multipart 文件可能省略。帧有 sequence、connectionId、direction、timestamp、opcode、payloadEncoding、payloadTruncated 等，文本 UTF-8、二进制 base64。coverage 的已启用/待接入/失败 session 和 dropped/limits 必须检查，worker/SW 不保证覆盖。默认只敏感头脱敏；raw、正文、URL 和帧仍可能含私密数据。cache/SW `priorStateKnown=false, releaseResetsTo=false`；这里 false 是释放恢复的默认值，不代表知道原值。HAR 写新文件，不自动覆盖。

## Lane

`page.lane.set(env=None, *, headers=None, header=None, value=None)` 三选一：`env` 只设 x-tt-env；`headers` 是任意合法请求头对象；`header`/`value` 设单个头。位置参数是 env 文本，也接受请求头 JSON 文本。浏览器网络栈维护的头（host、content-length、transfer-encoding、connection、upgrade、te、trailer、keep-alive、proxy-connection）报 code 2；和 network headers-set 撞名报 code 6。返回 `{headers, check, appliedSessionIds, failedSessions, note}`，note 提醒已加载内容不带新头。`page.lane.get()` 返回同样的 `headers` 和 `check`；`page.lane.clear()` 返回 `{cleared: [头名], ...}`。模块函数 `await lane_status(browser=..., host=..., session=...)` 返回 `{pages: [{targetId, url, headers, check, ...}]}`，只列本任务设了泳道的页面。`open_page(url, lane=...)` 收 env 文本、请求头 JSON 文本或对象，结果多一个 `lane: {headers}`。

`check` 是核对统计：`requests`（核对了多少个上线请求）、`matched`、`mismatched`、`mismatches`（每种不一致一条：`header`、`expected`、`actual`，没带上时为 null、`requests`、`sampleUrl` 截到 120 字符）、`scope`。重新 set 会清零重算。

页面动作（goto、click、type、snap、wait、read、eval、network 等经页面会话的调用）在出现新的或数量变了的不一致时，结果里多一个 `laneWarning: {text, mismatches}`；text 是给人看的一段话，含两种处理办法。命令行非 `--json` 输出把 text 以「browser-use 警告：」印到 stderr。Python 页面函数里只返回结果一部分的（snap、evaluate、read、shot）会另发一条 `skills.browser_use.LaneWarning`；snap 返回的 `Snap.lane_warning` 也带原字段。

```bash
browser-use --session task-a tab new URL --lane ppe_task --json
browser-use --session task-a tab new URL --lane '{"x-tt-env":"ppe_task","force-workbench":"1"}' --json
browser-use --session task-a lane TAB set ppe_task --json
browser-use --session task-a lane TAB set --headers '{"x-tt-env":"ppe_task","x-use-ppe":"1"}' --json
browser-use --session task-a lane TAB set --header force-workbench --value 1 --json
browser-use --session task-a lane TAB get --json
browser-use --session task-a lane TAB clear --json
browser-use --session task-a lane status --json
```

release、disconnect、关闭页面都会撤掉泳道。worker 和 service worker 自己发的请求不带页面附加头。


CLI JSON 错误与 Python BrowserUseError 共用 ok/error/code，按链路补 command/host/outcome/data。1 动作失败；2 参数；3 找不到；4 stale/timeout；5 能力、环境、权限；6 安全拒绝。停止本机等待不等于撤销动作，unknown 先取态，不自动重复。
