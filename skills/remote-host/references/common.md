# remote-host 共用操作规则

[CLI 主说明](../SKILL.md) 与 [Python 主说明](../PYSKILL.md) 共用本页；操作前读取，规则只在这里维护。

## 机器与执行

remote-host 只执行远端操作。它使用真实 SSH、暂存脚本并返回远端退出码，不让脚本被 fish 登录 shell 再解析。载荷作为 Python 字符串原样送到远端 stdin，引号、循环和命令替换不用嵌套转义。

一次调用固定读取到的机器和每机设置，不随其他调用修改 pin 而变化。`host="local"` 拒绝；`use("local")` 只清默认 host，不授权本机执行。未知 alias、损坏 pin、缺 SSH/远端工具或连接失败都失败，不回退本机。各技能独立保存默认目标；browser-use、computer-use、dsh-use 无 pin 时默认本机，不沿用 remote-host。

默认进程等待 600 秒，`timeout=None` 可明确取消本地上限。超时会停本地进程组及 SSH，不能证明远端动作停止；`outcome="unknown"` 时先查远端终态，不自动重发写操作。载荷自身 stdin 为 `/dev/null`，需要交互的 `attach` 必须真实 TTY。只读大输出在源头用明确范围限制；安装、构建、复制不靠管道末端退出 0 判断，脚本用明确失败检查或 pipefail。

## 任务归属与终态

`run()` 不保留 shell 状态。确需跨调用保留目录、变量时用 `send()`，远端需要 tmux；显式命名 `session=` 防止两个任务共用 shell。`peek()` 只看输出，`reset()` 会终止会话，不当作普通连接释放。

分钟级安装、构建用 `job()`，记录机器和任务名。`follow=True` 一次跟到退出，返回该任务退出码；在支持后台 Python 执行的内核交给托管后台机制，保留句柄，不在单元格结束后遗留失去工具权限的 asyncio 任务。下面载荷换成用户已授权的真实工作，名字每个任务唯一。

后台启动回执不等于完成；`job("list")`、`job("wait", name)`、`job("follow", name)`、`job("tail", name)` 查询已有任务，停止用 `job("kill", name)`，都带原 host，不重复启动。结束前收齐相关任务终态，不相关且获准停止的任务明确 kill。`wait()` 还支持 `proc/file/check`、`gone=True`，不把端口就绪当业务验收。

## 应用、迁移与校验

应用 `start/stop/restart/logs` 用 `app()`；日志支持 `since/lines`。复制用 `await skills.remote_host.copy("alpha:~/source", "beta:~/destination")`，默认暂存后落位并逐文件校验；单独比对用 `verify()`，清单用 `manifest()`。`quick=True` 只比大小，不能声称内容一致。覆盖须明确授权再 `replace=True`。远端文件先取回本地编辑再传回，不用 SSH sed 改配置。

迁移前先选策略：推荐盘点后只搬必需，拿不准留旧机，全量镜像先问用户。装不确定软件前核对来源、维护版本、应用标识、商店账号和设置兼容，不悄悄替换成停维护或不同来源软件。写入远端软链会修改它指向的文件；改本机副本不等于已改远端。

## 共用远程与收尾

browser-use、computer-use、clash-use、dsh-use 的能力优先用各自技能的正式入口，并显式指定同一机器；有 Python 内核时直接用各自 Python 入口。remote-host 的代理借用在 CLI 用 `-P`，Python 用 `run(proxy=True)` 或 `use(proxy=True)`，不把本机局域网代理地址写进远端配置。选机、探针、端口、远程产物和重启回执约束见 [共用远程边界](transport.md)。

跨网络反向代理由本任务保留句柄，优先用 async with；跨调用持有时 finally 中 `await proxy.close()`，只关闭自己创建的连接。启动失败、超时或取消会收回部分资源；不能关闭其他任务的通道。不改全局代理或 pin，不搬运模型凭据。完整边界见 [跨网络代理](hosts-and-proxy.md#跨网络借用本机-http-代理)。

remote-host 没有统一 release 函数。`run()` 的本地连接随调用结束，持久 shell 和 job 是独立远端资源，只有自己创建且不再需要时明确结束；其他技能的应用归属、浏览器 session 要通过其各自入口释放。超时与断连先观察，不能用清理当作撤销业务动作。

超时、断连或返回结果未知时，先读取目标机的真实状态与原任务终态；不自动重放可能已执行的写操作。清理连接或停止等待不能撤销业务动作。
