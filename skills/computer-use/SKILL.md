---
name: computer-use
description: "操作 macOS 原生应用、浏览器外壳和网页外浮层时使用；网页内容交给 browser-use。"
---

# computer-use（macOS 桌面控制）

有 Python 技能内核时读取 [PYSKILL.md](PYSKILL.md)，直接使用 `skills.computer_use` 的完整下划线入口，不另起模块别名；无内核时读取 [SKILL.md](SKILL.md)，使用正式 CLI。入口、读取、依赖或调用出错必须保留错误并查明原因，不得换接口绕过。

固定机器、任务和应用，取态后操作并重新验证。操作前读 [共用规则](references/common.md)，其中的 [安全分档](references/common.md#安全分档) 同时适用于 browser-use。机器选择、应用归属、前台影响、未知结果、密码与释放只在该页维护。

## 安装、权限与选机

目标机需要 macOS、Python 3 和 Swift 编译环境及辅助功能权限，截图另需屏幕录制权限。首次实际调用按源码编译并缓存；缺权限直接报告。日常先固定真实目标；仅在首次部署、环境变化或相关失败时查看版本、实现能力和当前权限，不顺手申请新权限。

```bash
computer-use --local version --json
computer-use --local capabilities --json
computer-use --local perms --json
computer-use hosts
# 机器参数在子命令前；远端以 -H alpha 代替 --local。
```

探针通过不代表 GUI 可用；权限申请和系统身份确认见 [共用规则](references/common.md#机器应用与任务)。远端必须先部署技能、共用库与命令入口并核对权限；入口或权限不符时拒绝，不去掉安全参数重试。构建和部署见 [维护说明](references/maintenance.md)。

命令提供机器列表与默认值管理；内核没有专用选机管理函数，日常在绑定应用或具名操作时显式指定机器，低频管理可用正式的内核参数入口。显式机器只覆盖本次调用，不沿用其他技能默认值。两种入口同时参阅 [命令参数参考](references/cli.md#机器与任务) 和 [内核参数参考](references/interfaces.md#python-选机管理)。

## 系统唤醒

锁屏后辅助功能操作和截图都会停摆。先用唤醒接口走正常的显示唤醒：它只声明用户活动和短暂阻止显示器睡眠，可选发一个非文本按键，不输密码、不改锁屏设置。返回的 `state` 是 `desktop` 才能继续操作；`loginwindow` 表示仍需要身份验证，立即停并报告；`asleep` 表示显示器没醒。

```bash
computer-use --local wake --hold 3 --json
# desktop / loginwindow / asleep / unknown
```

## 固定应用与任务

下面的 task-a 换成本任务唯一名称。非浏览器第一次取态登记应用归属；共享浏览器固定任务窗口，后续沿用同一窗口引用。计算器及 Seven 仅演示接口或用于部署验收，不是业务任务的前置步骤；ID 必须来自当前完整观察。

```bash
computer-use --local snap 计算器 --scope task-a --json
computer-use --local click 计算器 --id Seven --scope task-a --json
computer-use --local snap 计算器 --scope task-a --json
# 编号动作另带 --snapshot TOKEN，TOKEN 来自最近完整取态。
```

ID 优先，其次唯一标签，最后编号；ID 来自开发者，不是编号。搜索达到深度、节点或时间上限时拒绝，不从部分结果猜目标。编号动作必须带当前完整快照凭证；应用绑定会保存凭证，独立调用须显式带入。引用失效就重新观察。

应用绑定是同步工厂，固定创建时的机器和任务；取态、动作与释放是异步方法。命令每步显式携带同一机器与任务。绑定与任务规则见 [共用规则](references/common.md#机器应用与任务)，定位与快照参数同时参阅 [命令参数参考](references/cli.md#应用归属和元素) 和 [内核参数参考](references/interfaces.md#python-内核里调用)。

共享浏览器复用同一实例、用户 profile 和登录状态，真人与各任务各用独立窗口。先发现窗口，再明确选择本任务创建的那一个；不要按标题认领真人窗口。ref 的 id 是 CGWindowID，不能用浏览器调试协议或 AppleScript 的窗口编号替代。首次完整 snap 也会固定返回的稳定引用；之后每个动作都带它。窗口消失、进程重启、身份不唯一即拒绝，不按同名同位置找替代窗口。

```bash
computer-use --local windows Arc --scope task-a --json
# WINDOW_REF 是上一步本任务窗口的完整 JSON 字典。
computer-use --local snap Arc --window-ref "$WINDOW_REF" --scope task-a --max 800 --json
# 每条后续命令都带相同 --window-ref；无需长期 owner 或 lease。
```

## 输入、菜单与等待

浏览器键盘、粘贴和菜单选择必须由目标窗口实际获得前台焦点，工具不会自动激活；换行须显式允许。菜单先列出，再逐层读取后点击；等待明确文字出现或消失，不猜固定延时。截图按需开启，不把读取元素成功当作截图成功。

```bash
# 仅在已观察到的输入框确实获得焦点后输入；文本放 -- 后。
computer-use --local type 计算器 --scope task-a --json -- '7'
computer-use --local menu 计算器 --scope task-a --json
computer-use --local wait 计算器 --label '7' --scope task-a --json
computer-use --local snap 计算器 --shot --scope task-a --json
# 换行另加 --allow-newline；也可用 shot 计算器。
```

系统全局快捷键可显式启用系统投递（CLI `--system`，Python `key(..., system=True)`）：先严格核对目标应用是当前前台，否则拒绝；然后向全局事件流发一次真实公开事件，不重试、不模拟文本。它和 `--coord` 一样会动真实系统输入，使用前要先告知用户。

完整按键、菜单、窗口与截图参数同时参阅 [命令参数参考](references/cli.md#完整命令参数) 和 [内核参数参考](references/interfaces.md#python-内核里调用)。

## 独立核对结果

取态默认不截图。检查 snapshot、truncated、timed_out 或 timedOut、warnings；达到遍历上限也算不完整，不能证明目标唯一。先扩大最大元素数或深度，或缩小观察目标；不完整编号不能操作，唯一元素选择也会拒绝。原始已返回数据保留，表格只是缩减展示。

截图另查 screenshot.ok/via/error；矩形截图可能包含遮挡窗口。系统投递按键没有业务回执，必须重新读应用状态。动作后重新取态确认实际结果，同时检查退出码和 JSON。

退出码：0 成功，1 动作失败，2 用法错误，3 找不到应用或元素，4 界面或凭证失效、超时，5 能力或权限不足，6 安全拒绝。内核错误 ComputerUseError 保留 code/data/host/outcome。超时、断连或未知结果按 [共用规则](references/common.md#结果交接与清理) 处理，不重复提交。

## 交接、恢复与释放

以下应用归属流程仅适用于非浏览器。浏览器没有长期 owner 或 lease，App.release() 只结束当前绑定，不关窗口。示例把计算器从 task-a 交给明确的 task-b，再由新任务观察、释放。释放后需要再次操作时必须明确取得归属，不能靠取态悄悄抢回。每次交接后的持有凭证都不同，下例 LEASE 必须换成该步实际返回的当前凭证。

```bash
computer-use --local owner 计算器 status --scope task-a --json
computer-use --local owner 计算器 handoff --scope task-a --lease LEASE --to task-b --json
computer-use --local snap 计算器 --scope task-b --json
computer-use --local owner 计算器 release --scope task-b --lease LEASE --json
computer-use --local owner 计算器 claim --scope task-b --json
computer-use --local owner 计算器 release --scope task-b --lease LEASE --json
```

释放或交接后，再次打开同一应用必须携带当前持有凭证：命令行传 `--lease`；Python 用已绑定对象的 `app.open_app()`，或模块入口 `open_app(..., lease=app.lease)`。

归属恢复前的核对、授权与旧任务停止要求统一见 [共用规则](references/common.md#结果交接与清理)。完整归属参数同时参阅 [命令参数参考](references/cli.md#应用归属和元素) 和 [内核参数参考](references/interfaces.md#应用任务归属)。

## 配合 browser-use 登录

网页登录先由 browser-use 固定页面，确认停在登录页才调用登录；computer-use 只处理网页外的 1Password 浮层。自动流程失败后需重新观察，手动浮层处理与账号选择见 [共用规则](references/common.md#密码浮层与身份确认) 及 [浏览器共用流程](../browser-use/references/common.md#结果未知与登录)。

```bash
# 仅在网页已授权、账号框已点击且浮层已观察到后调用。
computer-use --local autofill Chrome --window-ref "$WINDOW_REF" --scope task-a --json
# 多个账号先确定后再加 --account；登录结果由 browser-use 读取原页面。
```

浮层处理只点击观察到的填充按钮，不完整或凭证过期时拒绝；看不到浮层先新截图，不猜坐标。跳转后用原页面核对，结束按各自归属释放。登录参数同时参阅 [命令参数参考](references/cli.md) 和 [内核参数参考](references/interfaces.md#python-内核里调用)。

attach 连接日常 Chrome 或 Arc 时，computer-use 只观察授权框，不长期占用整个浏览器。确认带远程调试字样、唯一「允许」按钮和稳定窗口引用后，在短操作保护中核对该窗口仍是前台再点击；不在前台就拒绝，需要用户把确切授权窗置前。不会自动激活、切回窗口或重设最小化状态。框消失只表示原生确认结束，连接成功由 browser-use 独立核对。只打开 inspect 设置页不算授权框，其他系统弹窗不处理。

```bash
# browser-use 接管日常 Chrome 时会自动调用；只在单独排查授权框时手动调用。
computer-use --local approve-debug "Google Chrome" --watch 30 --json
```

## 收尾与故障

```bash
# 非浏览器使用当前持有凭证释放应用归属。
computer-use --local owner 计算器 release --scope task-a --lease LEASE --json
```

逐个释放本任务碰过的 App 并核对回执；顶层 release 与 disconnect 不批量释放应用。App.release() 不退出应用、不关闭窗口。绑定窗口后 App.close(authorized=True) 只关闭该窗口并核对消失；共享浏览器拒绝整应用退出。非浏览器未绑定窗口时，明确授权的 App.close(authorized=True) 请求正常退出并核对进程结束，不强杀。权限和失效处理见 [排障说明](references/troubleshooting.md)。
