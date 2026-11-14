---
name: browser-use
description: "操作 Chrome 或 Arc 网页时使用；原生应用、浏览器外壳和网页外浮层交给 computer-use。"
---

# browser-use（浏览器控制）

有 Python 技能内核时读取 [PYSKILL.md](PYSKILL.md)，直接使用 `skills.browser_use` 的完整下划线入口，不另起模块别名；无内核时读取 [SKILL.md](SKILL.md)，使用正式 CLI。入口、读取、依赖或调用出错必须保留错误并查明原因，不得换接口绕过。

先固定机器、任务和窗口内的页面，再观察、操作、核对并清理自建页面。操作前读 [共用规则](references/common.md)；页面授权、机器与任务归属、结果未知和清理只在该页维护，业务动作共用 [安全分档](../computer-use/references/common.md#安全分档)。

## 安装检查与选机

目标机需要 Python 3.12 以上、Chrome、技能声明依赖及共用远程库。正常调用不联网自动安装；日常先明确目标机器和页面。仅在首次部署、环境变化或相关失败时查看版本、实现能力和状态。这些探针不启动浏览器，也不证明权限或网站可用。

```bash
browser-use --local version --json
browser-use --local capabilities --json
browser-use --local status --json
browser-use hosts
```

能力表各项的 mode/reason 说明实现范围。

## 运行方式

日常与真人并行、共用登录时，优先为每个任务开独立窗口；任务沿用自己的 session 和 Page，不借用真人当前页。资料、Cookie 和网站设置共同生效，任务退出账号也会影响其他窗口。需要独立资料时才选 isolated 或 clone。

新建普通窗口时，浏览器可能把新窗置前；Arc 实测会如此，即使请求 background=True，windowState=minimized 也未生效。不能承诺首次建窗不切前台，也不自动切回用户窗口来掩盖这件事。窗口建立后的网页操作仍在固定 Page 后台执行。

```bash
browser-use --browser Arc --session task-a tab new URL --new-window --mode attach --restart never --fallback never --json
browser-use --browser Arc --session task-a tab window TAB --json
```

多个资料同时打开时，加 `--source-target SOURCE_TAB` 指定要共享登录的现有页面。不同任务各自固定窗口和标签页，网页操作可以并行；原生窗口由 computer-use windows 发现并使用稳定窗口引用。browserWindowId 与原生窗口 ID 不同，不能混用。菜单和键盘等前台动作仍会争用桌面焦点，不用应用级退出命令收尾共享浏览器。

默认 `browser="Chrome"`、`mode="isolated"`。三种方式只改变实例与资料来源，页面操作和验收流程相同。没装正式版 Chrome 或 Chromium 时，isolated 和 clone 自动使用本机下载的最新 Chrome for Testing。

| mode | 用途 | 资料与扩展 | 释放边界 |
|---|---|---|---|
| `attach` | 使用日常 Chrome 的当前登录态 | 保留当前资料与扩展 | 只处理本任务标签，不退出日常 Chrome |
| `isolated` | 启动独立 Chrome | 临时资料禁扩展；持久资料保留扩展 | 结束自有实例，持久资料保留 |
| `clone` | 模拟日常 Chrome 但隔离写入 | 复制资料与扩展到本任务私有目录 | 清理副本，不回写原资料 |

`attach` 需要先在 `chrome://inspect/#remote-debugging` 开启远程调试并授权；已开启但连接失效时可正常重启一次并返回 browserRestarted，`restart="never"` 禁止重启。清理阶段绝不退出日常 Chrome。attach 连接失败时默认自动改用 clone，结果带 fallbackFrom=attach；fallback="never" 可关闭。attach 连接日常 Chrome 时，computer-use 只在可确认的授权窗口已经位于前台时点击唯一允许按钮；后台等待不激活浏览器，其他系统弹窗不处理。授权窗不在前台时，需先将它置前再重试连接。isolated 和 clone 使用屏蔽自动化提示条的启动参数。同一 Chrome 实例只保留一条共享调试连接，各会话复用，减少授权弹窗；页面归属仍按会话隔离。服务按需启动，DSH 重启不断连；Chrome 或连接失效时服务退出，下次 attach 再启动。clone 要读取日常 Chrome 资料目录；macOS 会拦截没有「完全磁盘访问权限」的程序，此时报错退出码 5，需给启动 browser-use 的程序（如 DeepSeek Harness）开启该权限。`clone` 在本机复制敏感资料，不保证所有网站都接受克隆会话；线上账号数据的改动仍然真实生效。

`browser="Arc"` 只支持 attach，不改用 clone，默认不重启 Arc；独立实例请用 Chrome。目标浏览器必须提供可用的本机远程调试接口；工具可读取资料目录的 `DevToolsActivePort`，也保留调用者显式给定的端口或 pipe。能否开放接口取决于浏览器发行版，inspect 设置页显示开启不代表握手成功。返回 HTTP 403 时先核对浏览器端的调试入口，不自动重启或改成另一种模式绕过拒绝。Chrome 与 Arc 的连接和页面归属分别管理；一个连接断开时，只要另一个仍可用就保持服务运行。release、disconnect 省略 browser 时两个都处理。

```bash
# 日常 Chrome：新开任务专属标签，不默认碰当前标签。
browser-use --session task-attach --mode attach tab new URL --json
# 独立持久资料：登录一次后跨任务保留，扩展可用。
browser-use --session task-work --mode isolated --profile work tab new URL --json
# 克隆日常资料：不影响原浏览器资料。
browser-use --session task-clone --mode clone --profile Default tab new URL --json
```



初次缺依赖时显式安装到本技能独立缓存环境，远端须在目标机安装。安装与机器参数同时参阅 [命令参数参考](references/cli.md#部署与探针) 和 [内核参数参考](references/interfaces.md#python-显式安装)。安装入口是部署管理能力，不是日常动作失败的替代接口。

```bash
browser-use --local install
```

各技能的机器默认值独立，显式机器只覆盖本次调用；只有需要改变后续默认值时才设置，清除后默认本机。失败不回退本机。

```bash
browser-use use
browser-use use alpha
browser-use use --clear
```

## 任务归属与固定页面

下面的 task-a 必须换成本任务唯一名称，所有页面动作沿用同一机器和 session。机器默认值与任务内页面分组分别管理；查询或设置任务分组不操作浏览器、不清理页面。

```bash
browser-use --scope task-a session current
browser-use --scope task-a session use task-browser
browser-use --scope task-a session use --clear
```

日常直接创建本任务页面。固定工具真实返回的 targetId 后观察，targetId 不是编号或网址。下列自建表单仅用于学习接口、部署验收或排障，不是业务任务的前置步骤。

```bash
browser-use --local --session task-a tab new "data:text/html,<input id='search' aria-label='搜索'><p>结果</p>" --json
browser-use --local --session task-a snap TAB --json
```

页面绑定固定机器、任务与目标，之后修改默认值不改变原绑定。对应上下文、定位和页面参数同时参阅 [命令参数参考](references/cli.md#页面定位与收尾) 和 [内核参数参考](references/interfaces.md#页面方法与普通-cli)。

## 观察、操作与等待

先确认完整快照中存在唯一搜索框，再输入相同关键词，等待结果文字并重新取态。示例中的 search 来自上面自建页面，真实任务须换成观察到的 ID 或标签。

```bash
browser-use --local --session task-a click TAB --id search --json
browser-use --local --session task-a type TAB --id search --json -- '关键词'
browser-use --local --session task-a wait TAB --label '结果' --json
browser-use --local --session task-a snap TAB --json
browser-use --local --session task-a release --json
# 编号动作另需最近完整快照凭证：--idx 12 --snapshot TOKEN。
```

定位优先 DOM id，其次精确标签，再用最近完整快照的编号和凭证。编号不是 id；引用失效重新观察，不猜新目标。语义定位还支持文字、placeholder、alt、title，默认精确匹配，可明确包含匹配和第几个匹配。

整段插入与逐键输入是不同能力，后者会发送逐个键盘事件；换行须显式允许。点击默认中心，也可选左上角；遮挡时只尝试可见点，全遮挡则报告遮挡元素。批量填表出错即停并返回停止位置。等待用文字、元素状态、网址、加载阶段或多段文字任一出现，不用固定延时。

## 独立核对结果

取态默认不截图，按需开启。原始返回数据保留完整已返回内容，表格和树只是缩减展示。检查 truncated、timed_out 或 timedOut、warnings；默认最多 300 元素，达到上限时读截断提示，扩大最大元素数或深度，或缩小观察区域，不能把部分页面当成全部。

输入、按键、编辑、设值和填表返回 target/targetText 与 before/after，密码类值只给长度。不带定位的输入发给当前焦点，先核对目标。点击检查 focusedText/focusInTarget，焦点未进入目标时不盲输。

动作回执成功后仍须重新读页面确认业务结果，同时检查进程退出码和 JSON 的 ok/error/code。退出码：0 成功，1 动作失败，2 参数错误，3 找不到，4 引用失效或超时，5 能力、权限或环境不足，6 安全拒绝。超时、断连和未知结果处理见 [共用规则](references/common.md#结果未知)。

## 更多能力与收尾

元素、iframe/shadow DOM、脚本、截图、上传下载、网络与调试、泳道、状态与画面比较按需读 [进阶能力](references/advanced.md)。完整生命周期同时参阅 [命令参数参考](references/cli.md) 和 [内核参数参考](references/interfaces.md#上下文探针与生命周期)，维护与部署读 [实施参考](references/implementation.md)。

```bash
browser-use --local --session task-a release --json
```

用原机器和任务收尾并检查返回结果。只处理本任务；页面 release 不释放 computer-use 应用归属。disconnect、单页关闭、临时产物、远程文件与服务更新等待见 [共用收尾规则](references/common.md#释放文件与服务)。
