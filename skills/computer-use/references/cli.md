# computer-use CLI 参数参考

本页维护 `computer-use` 的详细 CLI 参数和示例，日常流程见 [CLI 主说明](../SKILL.md)。带 Python 内核时读 [Python 主说明](../PYSKILL.md)，直接调用 `skills.computer_use`；调用失败先查原因，不用 CLI 绕过。授权、机器和任务归属、未知结果及收尾共用 [操作规则](common.md)。

## 机器与任务

机器参数必须放子命令前：`-H HOST`、`--host HOST` 或 `--local`。`use HOST`（同 pin）设置 computer-use 自己的默认机器，`use --clear` 清除，`hosts` 列机器；各技能默认目标互不影响，失败不回退本机。

```bash
# computer-use：先固定机器与任务范围，再取态、操作和核对。
computer-use --local perms --json
computer-use --local snap 计算器 --scope task-a --json
computer-use --local click 计算器 --id Seven --scope task-a --json
computer-use --local snap 计算器 --scope task-a --json
# computer-use：释放时 LEASE 是当前持有凭证，不是快照编号。
computer-use --local owner 计算器 release --scope task-a --lease LEASE --json
```

## 完整命令参数


安装后把 `scripts/computer-use` 加入 PATH，并执行 `computer-use --version` 核对命令来源。

入口是技能自身的 `scripts/computer-use`，也可在任意工作目录直接用其绝对路径运行。
首次运行自动调用本机 Swift 编译器；源码、系统或 CPU 架构变化后自动重建。只升级 Xcode 时不会自动重建，要强制重建就删掉下面的缓存目录。
产物位于 `${XDG_CACHE_HOME:-~/.cache}/computer-use/build`，不写源码目录、不入库；并发构建使用文件锁与原子替换。
需要 macOS、Python 3 和 Xcode Command Line Tools；缺编译器时按报错安装，不复制另一台机器的二进制。
系统辅助功能/屏幕录制权限仍需在各机对实际宿主授权，版本命令通过不代表 GUI 权限通过。
命令入口与技能、Python 包必须来自同一套安装。
仅非浏览器且未携带稳定窗口引用时，`snap` / `click` 等命令会在后台自动启动未运行应用（中文名、英文名、bundle id、`.app` 路径都认；`COMPUTER_USE_NO_AUTOLAUNCH=1` 关掉）。
也可以显式启动：`computer-use open 计算器 --json`，认名字的规则和 `snap` 一样；已在运行的应用不会被带到前台。名字写错时报退出3，并列出相近的应用名和 bundle id。

| 命令 | 说明 |
|---|---|
| `version` / `capabilities` | 返回结构化版本和能力；`--capabilities` 是免编译的本机探针 |
| `element <app> <action> --selector JSON` | 唯一定位原生元素；支持 resolve/read/click/set_value/scroll/act/measure |
| `disconnect` / `release` | 不关闭应用；前者断开本调用进程连接，后者报告本包装没有自建资源 |
| `target-close <app> --authorized [--timeout 秒]` | 请求正常退出并核对进程结束；缺授权退出6，超时仍未退出为4，不强杀 |
| `windows APP` | 只读发现稳定原生窗口引用；不激活、不 claim 浏览器 |
| `window-close APP --window-ref JSON --authorized` | 只关闭该引用的窗口并核对消失 |
| `apps` | 列出运行中的应用（名称 / bundle id / pid / 窗口数 / 谁在前台） |
| `apps --all` | 列出 Dock / 控制中心 / 菜单栏图标这类系统 UI 进程 |
| `menu <app>` | 列出应用的菜单栏（File / Edit / View …） |
| `menu <app> "File"` | 列出该菜单下的项（带快捷键和禁用状态） |
| `menu <app> "File" "存储"` | 点击菜单项。**很多功能只在菜单里，够不着按钮时走这条** |
| `drag <app> X1,Y1 X2,Y2` | 拖拽（后台，不动真鼠标；同一个窗口里拖滑块、拖选文字、拖元素都行。后台不可用直接报错；`--coord` 也要求路径命中指定应用，不支持跨应用拖放） |
| `snap <app>` | **取态**：元素清单，默认不截图，`--shot` 顺带截图。选项见下 |
| `click <app> --id "Seven"` | **按 AXIdentifier 点击（最稳：语言无关、不随内容变）** |
| `click <app> --label "文本"` | 按标签点击（中文系统下标签是中文） |
| `click <app> <idx>` | 按编号点击，必须带 `--snapshot TOKEN`，缺失或过期退出4 |
| `click <app> --at X,Y` | 按屏幕坐标点击（后台投递，不动鼠标；加 `--coord` 才真的移动鼠标去点） |
| `click <app> <idx> --count 2` / `--button right` | 双击默认后台；右键仅支持 AXShowMenu，没有可靠菜单动作则明确拒绝 |
| `type <app> <文本>` | 输入文本；共享浏览器需要稳定窗口引用且目标窗已在前台 |
| `key <app> <键> [--system]` | 按键：`Return` `Tab` `cmd+c` `shift+Left` `cmd+shift+p`。`--system` 发真实系统热键，只限当前前台应用；与 `--coord` 一样先告知用户，不重试 |
| `set <app> <idx> <值>` | 直接给输入框赋值（后台、瞬间、不走键盘） |
| `act <app> <idx> <动作>` | 执行元素的其他动作，如 `ShowMenu` `Increment` |
| `scroll <app> <idx> <up\|down\|left\|right>` | 滚动，`--pages N` 控制页数；网页里的小列表也能滚（传列表里任意一行的编号） |
| `read <app> <idx>` | 读元素全文（snap 里只给 46 字预览） |
| `read <app> <idx> --selected` | 只读当前选中的文本 |
| `selecttext <app> <idx> <文本>` | 选中文本元素里的一段文字 |
| `wait <app> --label "文本"` | 等元素出现；`--gone` 等它消失；`--timeout N` 默认 10 秒 |
| `paste <app> <文本>` | 临时使用剪贴板；仍由本命令持有时还原，期间新复制则保留新内容。未验证时不自动重试 |
| `clip [文本]` | 读剪贴板（无参）/ 写剪贴板（带参） |
| `screens` | 列出显示器 |
| `winmove <app> X,Y` / `winsize <app> 宽,高` | 移动 / 调整窗口（后台生效） |
| `shot <app>` | 只截图，返回文件路径 |
| `open <名字>` | 启动应用（中文名、英文名、bundle id、`.app` 路径都认；默认后台，`--front` 才抢焦点） |
| `webmode <app>` | 让 Chrome / Electron 把网页内容交给辅助功能（默认只给浏览器外壳）。`snap` 第一次读浏览器时会自动做这件事，一般不用手动调；`--off` 关掉 |
| `perms` | 查权限与投递通道：辅助功能 / 事件合成 / 截图 / 权限归属进程 |
| `wake [--hold 秒] [--input none\|space\|return\|escape]` | 正常唤醒显示器并核对桌面状态；只做公开电源活动声明和非文本系统输入，不输密码、不改锁屏设置。`state=desktop` 才能继续，`loginwindow` 表示需要身份验证 |

**`--json`（全局选项，所有命令可用）**：输出单行 JSON 供程序消费。
stdout 只有 JSON，诊断信息一律走 stderr；失败含 `ok:false`、`error`、`code`，原生动作及扩展入口还提供 `command`、`host`、`outcome`。`outcome:"unknown"` 表示结果未知，不得重放动作。
配合退出码判断最稳。原生命令人跑用默认表格；扩展入口始终返回 JSON，脚本仍应显式带 `--json`。

```bash
computer-use snap 计算器 --json | jq '.elements[] | select(.axid=="Seven")'
computer-use snap 计算器 --diff --json
computer-use click 计算器 --id Seven --json | jq '.ok'
```

其余参数补充：`paste --settle MILLISECONDS` 默认 400；`webmode --off --timeout SECONDS` 默认 4 秒；`perms --request` 触发系统授权申请；`--no-settle` 禁用动作后稳定等待；`winmove/winsize --window N` 选择窗口；`shot --out PATH --shrink N` 与取态截图一致。输入 `type --allow-newline` 明确允许换行，编号动作的 `--snapshot TOKEN` 必须来自完整取态。

`snap` 的选项：
- `--shot` 同时截窗口图；默认不截图，和 Python `shot=False` 一致
- `--diff` 只输出与上次 snap 的差异，无变化就一行带过（**轮询和验证操作结果时用这个，极省 token**）
- `--all` 不过滤，输出全部元素（默认只输出可交互的和有文字的）
- `--max N` 最多 N 个元素（默认 120）
- `--depth N` 最大遍历深度（默认 25）
- `--window N` 第 N 个窗口（默认主窗口）
- `--shrink N` 截图长边缩到 N 像素（默认 1400；`0` 不缩放）
- `--out PATH` 截图存到指定路径；省略时每次生成 UUID 图片，避免覆盖其他调用

JSON `snap` / `diff` 返回 `snapshot` 凭证，并报告 `truncated`、`timedOut`；达到深度或元素数上限也算不完整。树、身份或操作状态属性读取失败同样标记 `truncated=true` 并给警告；可选属性不支持或没有值不当成故障。网址、子角色、焦点及分隔条动作表返回通用失败时只给警告，不把元素树标成不完整；无响应或元素失效仍算读取不完整。Python `Diff` 保留 `truncated/timed_out`，不完整时不能把 `changed=False` 当作整屏无变化。`Snap.one()` 在取态不完整时拒绝判断唯一；`App` 会清空编号凭证，原生层也拒绝使用不完整快照的编号，须重新取得完整取态。完整 `snap` 的 `screenshot` 包含 `requested`、`ok`、`via`（`none` / `window` / `rect`）、`error`。截图失败时元素清单仍可成功返回；必须检查截图状态。`diff` 不截图，会说明跳过原因。缺辅助功能权限退出5，不覆盖已有缓存。

`computer-use version --json`、`computer-use capabilities --json` 返回 `{ok:true,tool:"computer-use",protocol:1,version,features,capabilities}`。每项能力含 `supported`、`mode`、`reason`，不支持的能力不模拟。Python 的 `version()`、`capabilities()` 返回同样字段但没有 `ok`；`version()` 不再返回字符串，取版本用结果的 `version` 字段。原生 `computer-use --version` 仍是简短版本入口。

`computer-use --capabilities --json` 或 `computer-use --local --capabilities --json` 是不依赖路由、编译或 GUI 的本机探针。远程探针必须显式 `-H`，不会拿本机能力代替远端能力。传输 `protocol` 保持1以兼容现有 SSH 分发。

原生快照提供 `settable`、按 AX 可得的 `hidden`、按元素与窗口相交得到的 `offscreen`。`occluded:null` 表示没有遮挡检测，不能解释成“没有遮挡”；滚动能力按 AX 容器报告，不保证每个方向都能改变内容。

退出码：`0` 成功 / `1` 动作执行失败 / `2` 用法错 / `3` 找不到应用或元素 / `4` 界面或窗口已变、定位失败 / `5` 缺系统权限 / `6` 敏感应用拒绝操作。

---


## 应用归属和元素

共享浏览器不使用长期 owner/lease。先 `windows APP --scope TASK --json` 或首次完整 snap 获取 window 字典；每个后续原生命令传 `--window-ref JSON`，字段为 id、pid、startedAt，可附 bundleId。id 必须是本工具发现的 CGWindowID，不可拿浏览器调试协议或 AppleScript ID 替代。窗口消失、PID 或进程代际变化即拒绝，不按标题或位置替代。原始编号同时传当前 `--snapshot`。`--window N` 只是首次选择，越界拒绝。浏览器拒绝 quit 和未绑定窗口的 target-close；绑定窗口的 target-close 仅关本窗。

键盘、粘贴、菜单选择要求确切前台窗口，跨进程短锁冲突即拒绝。投递中切窗停止，结果 unknown，不重发。真实用户仍可能在两次核对之间切换，不能保证绝对隔离。下面 owner 交接流程仅用于非浏览器。

`owner APP status|claim|release|handoff|recover`，通用任务参数 `--scope ID`、`--lease LEASE`；handoff 用 `--to ID`，recover 用 `--expected-owner ID --authorized`。释放和交接须当前 lease；归属查询不等于已持有。完整返回与拒绝条件见 [应用任务归属](interfaces.md#应用任务归属)。

`element APP resolve|read|click|set_value|scroll|act|measure` 用 `--selector JSON` 首次解析，用 `--handle JSON` 复用完整句柄；`--selector` 与 `--handle` 不混用。元素支持范围及每动作参数见 [元素与收尾](interfaces.md#元素与收尾)。


文本用 `--` 分隔并原样放后面，例如 `computer-use type Finder --scope task-a --json -- --json`；换行须 `--allow-newline`。编号操作用 `--snapshot TOKEN`，TOKEN 来自刚才完整取态。只有明确需要前台时先告知再 `--front`；`--coord` 会动真鼠标也先告知。排障见 [权限与故障](troubleshooting.md)。

`approve-debug APP [--watch 秒]`：只观察并在短操作保护下点击唯一的远程调试允许按钮；要求确认窗本来就在前台，不自动激活或恢复桌面。框消失不代表连接成功；连接由 browser-use 核对。
