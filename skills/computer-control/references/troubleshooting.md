# troubleshooting

有 Python 内核时直接用 `skills.computer_control`，权限先查 `await skills.computer_control.perms(host="local")`，应用用 `skills.computer_control.app(..., host=...)` 固定目标。以下 computer-control 命令行诊断例子仅供无内核传统 agent，完整参数见 [CLI 参考](cli.md)。

按当前问题读取对应章节。常用路径见 [CLI 主说明](../SKILL.md) 与 [Python 主说明](../PYSKILL.md)，安全和归属规则见 [共用规则](common.md)，完整参数见 [接口参考](interfaces.md)。

## 安全网：它会主动拦住你点错

每个元素在缓存里同时记了**位置路径**、**AXIdentifier** 和**角色+标签**。执行时会校验：

- 有 ID 就先比 ID（语言无关、不随内容变，最可靠），否则比角色+标签
- 位置变了但 ID/标签还在 → 自动重定位，stderr 提示"已按 ID 自动重定位"
- 都对不上 → **拒绝执行并报错**，要求重新 snap

**这是纯坐标方案和纯编号方案都没有的保护。** 实测价值：在计算器上点了一次按钮后，
"全部清除(AllClear)"会变成"清除(Clear)"，编号全体偏移——没有校验就会点错而毫不知情。

所以看到 `元素已变` / `已不存在` 的报错，是保护生效了，重新 `snap` 再来，**不要**改用坐标硬点。

---

## 会踩的坑

- **应用没开会后台启动。** `snap` 和动作会自动启动可识别的已安装应用；`COMPUTER_CONTROL_NO_AUTOLAUNCH=1` 关闭。需要主动启动时用 `computer-control open <名字>`。
- **冷启动慢。** `open` 会等窗口出现（最多 12 秒）。别自己 `sleep 2` 就接着操作。
- **中文应用名。** Finder 叫"访达"、Calculator 叫"计算器"。`open`、`snap` 和各动作用同一套规则找应用：中文名、英文名、bundle id 都认，
  运行中的应用还认名字的一部分。名字写错会报找不到并列出相近的应用；`apps` 列出来的名字最准。
- **标签为 `·` 表示该元素没有可读标签。** 常见于图标按钮。这时看它的 FRAME 配合截图判断，
  或者用它相邻的、有标签的兄弟元素。实在不行才用 `--at X,Y`。
- **键盘事件在后台可能被忽略，AX 动作不会。** 这是实测教训：对着后台的模态对话框发 `key Escape`
  毫无反应，但 `click --label "取消"` 一击命中。所以顺序是：
  **能用 `click --label` / `set` / `act` 解决的，就不要用 `key` / `type`。**
  如果目标应用注册的是系统全局快捷键（例如启动器），后台定向投递不会触发它；先确认应用在前台，再用 `key <app> <键> --system`（Python `key(..., system=True)`），它发一次真实公开事件，不重试。
  确实需要键盘（比如输入长文本、触发复杂快捷键）且后台无效时，才考虑 `--front` 带到前台，
  并且要先告知用户你要抢焦点。
  排查第一步永远是 `computer-control perms`：如果是**事件合成**权限缺失，投递前就会拦住你并返回退出码 5
  （不会静默）；只有权限正常、命令也返回成功、界面却没变，才是"这个应用真的不理后台键盘"。
- **目标窗口已变（退出码 4）** 表示原窗口已消失、进程代际改变或无法可靠确认身份。稳定引用始终认原窗口号；不会按同名、同位置或当前默认窗口替代。先发现并明确绑定本任务的新窗口，再取完整 snap；不要改用坐标绕过拒绝。浏览器窗口仍在而用户切到另一个窗时，后台 AX 读取可继续，但键盘、粘贴和菜单选择拒绝；不自动抢回焦点。
- **输入框优先用 `set` 而不是 `type`**：瞬间赋值、不受焦点影响、不会被输入法干扰。
  `type` 只在 `set` 不可用（元素不可写）时用。
- **`snap` 默认过滤掉了纯装饰元素。** 找不到目标时加 `--all` 再看一遍。深度截止也会报告 `truncated=true`，用 `--depth` 明确扩大读取范围。
- **部分属性读取失败会报告取态不完整。** 已读内容仍返回供排查，但唯一判断和编号操作会拒绝；先确认应用没有卡住，再重新读。可选属性不支持或无值不算故障。附加展示字段（网址、子角色、焦点）及分隔条动作表通用失败仅给警告；无响应或元素失效仍须停止编号操作。
- **ID 和标签不是天然唯一。** 搜索最多 30 层、10000 节点、8 秒；超限或身份属性/子元素读取失败时退出 4，不使用部分匹配结果。多个同名元素不按是否可按下猜目标；重新取完整快照并用带凭证编号或严格元素选择器。

---

## 应用由其他任务持有

非浏览器退出 6 / not_sent 时先查 `computer-control owner APP status --json`，联系持有任务明确 handoff 或 release。不用换 scope、重试、前台点击或退出应用绕过。旧任务已崩溃也不会自动失效；恢复须核对 owner/lease 并授权，不能猜。单条命令冲突也即时拒绝，持有任务确认上一条终态后再决定是否发下一条，不自动重放。

## 能力边界（做不到的事，别硬试）

- **锁屏之后辅助功能操作和截图全部失效。** 先用 `computer-control wake`（Python `await skills.computer_control.wake()`）走正常显示唤醒；它只声明用户活动和发可选的非文本按键，不输密码、不改锁屏设置。返回 `state=desktop` 才能继续，`loginwindow` 表示仍需要身份验证，立即停并报告。长任务要先确认不会锁屏
  （系统设置 → 锁定屏幕，或让用户临时关掉）。
- **没有"正在操作"的提示浮层。** 用户看不到 agent 在动他的电脑，也没有一键中止。
  所以：涉及发送、提交、删除、付款这类不可逆操作，动手前必须先问用户。
- **动作会等界面稳定，但仍须验结果。** 长时间加载时用 `wait <app> --label "文本"` 等目标出现
  （或 `--gone` 等它消失），别用盲目 `sleep`。`--no-settle` 或 `COMPUTER_CONTROL_NO_SETTLE=1` 会关闭自动等待。
- **退出应用超时（退出码 4，`outcome=unknown`）。** 正常退出请求已发出，但进程在时限内尚未退出；应用可能在等确认或保存内容。先核对应用当前状态，不把超时当成功，也不强杀。
- **后台窗口不画选中高亮。** `selecttext` 生效了但截图上看不出来——这不是失败。
  验证要用 `read <app> <idx> --selected` 读 AX 层，**别靠肉眼看截图下结论**。
- **后台应用的部分菜单项是禁用的。** 实测：TextEdit 在后台时"文件→关闭"变灰点不了，
  因为系统认为它没有 key window。遇到这种情况改用应用自己的 AppleScript 接口，
  或确实必要时 `--front` 带到前台（先告知用户）。
- **拖拽默认后台。** 同窗口拖放默认不动真鼠标。后台不可用会报错；`--coord` 会移动用户鼠标，必须先告知，但仍要求路径属于指定应用，不支持跨应用拖放。
- **多显示器未做适配。** `screens` 能列出来，但坐标是全局的，副屏上的窗口可能定位不准。
- **Spotlight / 通知中心 / 登录窗口够不着。** Dock 和控制中心可以（`apps --all` 能看到），
  但 Spotlight 这类临时浮层通常抓不到。
- **浏览器先确认网页内容可读。** `snap` 会自动打开 Chromium 网页辅助功能；仍只有外壳时用 `webmode` 检查。需要 DOM、网络请求或脚本执行时用 `browser-control`（普通命令或 `skills.browser_control`），固定标签页后操作。

---

## 编号的有效期（实测踩过）

snap 编号绑定本次 snapshot 凭证。浏览器缓存按进程代际、窗口和任务隔离；同一窗口同一任务的新 snap 会更新该缓存，其他任务或窗口不覆盖。非浏览器沿用应用缓存；旧凭证退出4，不会解释成新编号。

```bash
computer-control snap X --json           # 记下 snapshot 和编号4
computer-control read X 4 --snapshot TOKEN --json
```

Python `App` 自动保存和使用凭证；独立函数传 `snapshot=s.snapshot`。原始 CLI 编号同样必须传凭证；缺失或为空时退出 4，不读取其他任务的最新编号。

进程和窗口 ID 也必须匹配；应用重开、窗口身份无法唯一确认时要求重新取态。优先 `--id`，其次唯一标签；编号必须来自刚取得的有效凭证。

## 权限

授权对象是**运行 agent 的那个宿主应用**（不是 `computer-control` 自己——未签名二进制继承宿主的授权）。
权限随机器和宿主变化，不用旧的“已授权宿主”名单代替现场检查。DSH 内可先跑 `computer-control --local perms --json`，再在计算器验证取态、AX 点击、后台键盘和窗口截图；本机这条链已跑通。其他宿主与远端仍须各自检查。三项权限，用途不同：

| 权限（系统设置 → 隐私与安全性） | 管什么 | 缺了会怎样 |
|---|---|---|
| **辅助功能**（Accessibility） | 读元素树、AX 点击/赋值/滚动 | 所有读和 AX 动作都失败 |
| **屏幕录制**（Screen Recording） | 截图 | 只影响 `shot` 和 `snap --shot`，元素清单照常 |
| **事件合成**（Event Synthesizing，TCC 服务名 `kTCCServicePostEvent`） | 向别的进程投递键盘/滚轮事件 | **事件被系统静默丢弃**：命令返回成功、界面没反应 |

第三项是 macOS 14/26 之后新增的，也是**最难查的一类失败**——所以 `key` / `type` / `paste` / `scroll`
在投递前会自检 `CGPreflightPostEventAccess()`，缺权限直接报错（退出码 5），不让调用方误以为成功。
自检误报（罕见）时用 `COMPUTER_CONTROL_ALLOW_POST_DENIED=1` 降级成警告后继续。

**投递通道**：优先私有 SkyLight 的 `SLEventPostToPid`，不可用时回落公开的 `CGEventPostToPid`。
两条都不经全局光标与焦点，也都**没有回执**（系统不回报目标是否处理了事件）。键盘、文本、粘贴及对应滚轮投递的 `--json` 结果里，
`delivery` 字段会写明实际通道（`skylight` / `cgpost`）；AX 点击、赋值和其他动作则看 `via`，不能要求它们都有 `delivery`；怀疑私有通道有问题时用
`COMPUTER_CONTROL_PUBLIC_POST=1` 强制走公开 API。

自检一条命令搞定：

```bash
computer-control perms          # 三项权限 + 实际投递通道 + 权限归属进程
computer-control -H laptop perms --request --json  # 触发远端三项系统授权申请，由用户亲手允许
# Python：await skills.computer_control.perms(host="laptop", request=True)
```

SSH 执行时，系统可能把授权归到 `/usr/libexec/sshd-keygen-wrapper`。以系统实际显示和重新运行 `perms` 的结果为准；屏幕录制列表没有该条目时，可由用户点“＋”添加这个系统入口。不要把给 DSH、终端或 Snipaste 的授权当成 SSH 已授权，也不要替用户操作授权框。

注：`perms` 里的屏幕录制自检在部分宿主下会误报 `false`（本机 pa daemon 就是），
以 `computer-control shot <app>` 能否出图为准。换宿主（换终端、换 agent runtime）需要重新授权。
