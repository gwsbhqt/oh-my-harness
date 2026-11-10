# maintenance

本文件说明执行入口与维护边界；具体参数见 [接口参考](interfaces.md)。相对路径以技能根目录为基准。


# computer-control（macOS 桌面控制）

带 Python 内核时使用 `skills.computer_control` 操作图形界面，只有无内核传统 agent 使用 [CLI 参考](cli.md)。核心循环：

```
snap（取态：带 ID/标签的元素清单，--shot 才截图）→ click --id（按稳定标识操作）→ snap --diff（只看变化）
```

构建、安装、权限与使用边界以本目录的主说明和参考为准。
（设计取舍、全部踩坑记录、维护指南。改代码前先搜它。）

**调用入口**：有 Python 内核用 `skills.computer_control`；无内核 CLI 的软链在 `~/.local/bin/computer-control`
**源码**：原生执行器为 `bin/computer-control.swift`，Python 包为 `src/computer_control/`；启动器为 `scripts/computer-control`。
二进制由启动器在本机缓存目录自动构建，部署方法见 [CLI 主说明](../SKILL.md) 与 [CLI 部署参数](cli.md#完整命令参数)。

自检与重建：
```bash
computer-control version --json                 # 结构化版本和能力，不是 GUI 权限验收
computer-control --local --capabilities --json   # 免编译的本机能力探针
# 源码、系统或架构变化后，下一次调用自动重建；仅升级 Xcode 不触发快速缓存重建
```

---

## 公共接口的维护边界

Python `version()`、`capabilities()` 返回字典，不再返回版本字符串。传输 `protocol` 保持1；修改探针不能让现有 SSH 入口失配。本机 `--capabilities` 不读取默认机器、不编译，远程探针必须显式 `-H`。

旧模块 `close()` 已移除。`disconnect()` 仅停本调用进程常驻连接；`release()` 报告空自建资源，不退出应用。App.release() 释放本任务应用归属，不关闭目标；App.disconnect() 不释放归属。`App.close(authorized=True, timeout=10)` 与 `target-close` 使用 `NSRunningApplication.terminate()` 请求正常退出，不激活应用、不模拟按键，也不调用 `forceTerminate()`；随后核对 `isTerminated`，超时返回退出4和 `outcome=unknown`，不能写成成功。退出命令不得自动启动未运行的应用。

普通扩展命令 `element`、版本探针与 Python 共用包装逻辑；内部原生命令直接调用 Swift，不能再次绕启动器递归。原生帮助后补充扩展命令，不删旧命令说明。元素句柄固定应用、机器和快照凭证，拒绝遍历不完整时的唯一性推断。`Element` 与 `element` CLI 只保留真实动作 `resolve/read/click/set_value/scroll/act/measure`，不留 styles/html/focus/hover/check/select/patch/restore/元素截图等必然退出5的占位入口。`measure` 是快照屏幕坐标；没有可靠遮挡检测，必须明确未知。


## 可重复本机 GUI 验收

默认测试不启动真实窗口。明确验收用 `COMPUTER_CONTROL_GUI_TESTS=1 python3 -m unittest discover -s tests -p test_gui.py -v`，只编译并运行唯一 bundle id 的自建 AppKit 应用，缓存使用独立目录，不操作计算器、Chrome 或其他用户应用。测试覆盖 CLI/Python、两任务竞争、交接前后凭证和正常菜单选择。

新增归属功能不改传输 protocol=1；能力探针需报告 task-ownership。归属校验在原生命令锁内，Python 的单对象锁不是唯一防线。恢复不得按时间自动抢占，损坏状态必须拒绝。owner 查询不续持有、释放不关应用。

## 设计来源

接口形态参考了 OpenAI Codex Computer Use 的核心思路——**一次取态同时拿到截图和结构化元素，
后续按引用操作**，避免让模型反复算坐标。本实现使用 Accessibility、CoreGraphics 和 SkyLight 定向事件；
私有符号不可用时回落公开 API，源码在 `bin/computer-control.swift`。

相比参考对象额外做的：默认后台不抢焦点；`--id`/`--label`/编号三种定位；执行前校验元素身份并在
界面变化时拒绝旧凭证，要求重新取态；按窗口 ID 截图避免截到覆盖窗口；`--diff` 精确列出增减元素
`--diff` 在本地缓存上计算，所以跨进程有效、可结构化输出（`--json` 给 added/removed 数组）——
sky 的 diff 同样会列出具体增减元素（还多一个 `~ changed` 类别），但它是 node_repl 会话内的状态；
额外提供 `wait`/`menu`/`clip`/`open`/窗口管理。

本机权限来自运行命令的宿主。远程调用经过 `_shared/agentkit/remote/` 的共用 SSH 代码；缺权限时按报错在对应机器检查宿主授权，不切换到另一套控制工具。
