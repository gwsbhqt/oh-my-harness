# browser-use 的工程维护

## 事实源与分层

所有带 Python 内核的 agent 读 [PYSKILL.md](../PYSKILL.md) 并直接使用 `skills.browser_use`；只有无内核传统 agent 使用 [CLI 参考](cli.md)。普通命令解析在 `commands.py`，网页实现模块为 `driver.py`。

两入口共用 Engine/CDP/Driver/Element/Diagnostics/Network/Lane/Policy，不维护两套动作逻辑。`contexts.py` 管任务默认 session，`transport.py` 管真实 SSH RPC 与显式文件传输，`rpc.py` 只接收目标机本地请求。选机和 SSH 用 `_shared/agentkit/remote/` 的共用代码。

维护时核对当前 `__init__.py` 公开对象、`commands.py` parser、`actions.py` 页面动作参数表和各领域服务的严格 schema。未知字段、错误类型和错误作用域必须拒绝。Snap/Diff 保留已返回数据，展示缩减不等于原始记录完整。模块生命周期入口是 release/disconnect；Page.close 仅关闭确切目标。

## 连接、归属与生命周期

isolated 和 clone 由 browser-use 自己启动，每个任务使用独立实例；attach 按浏览器实例共享一条调试连接（Chrome、Arc 各一条），跨会话复用且只在服务整体退出时关闭。临时资料使用私有浏览器 context，持久资料使用默认 context 以便写回登录态。CDP 响应接收和事件分发分离，回调不能堵接收线程。命令通过私有 Unix socket 共用执行核心。

ResourceLedger 只保存浏览器 WebSocket UUID、任务归属、目标标识和 owned，不存页面或认证内容。私有目录 700，文件和锁 600，损坏或权限异常不重置。UUID 变化不认领旧页。

release 只关闭本任务自建页，借用页只断开绑定；disconnect 保留页面和归属，清理连接、初始化脚本、网络拦截、页面附加头和泳道等调试副作用。目标关闭需观察实际消失后再删归属账。

超时、取消等待和断连均不能证明动作未发生。客户端不重发写操作。错误保留 code、command/host、outcome 和 data；unknown 必须先观察。

## 代码更新后怎么生效

服务默认按需启动。attach 共享连接健康时不因空闲退出，接管连接失效且没有其他可用浏览器时立即退出；其他模式没有在途连接且 engine.idle() 为真时，上次请求结束后 2 分钟退出，还有占用时 30 分钟没请求才退出。调用者仍需显式 release。

后台服务记着自己启动时的代码版本。每次调用前客户端核对版本；版本不同就请旧服务进入排空。旧任务照常发给旧服务并自行 release，新任务等待旧服务退出后再启动新版。同一动作只会真正执行一次。不能用 kill 或 SIGTERM 催旧服务退出。

## 选机、任务上下文与远程传输

无显式机器且无 pin 时默认 local。本次 -H/--host/--local 与任务 session 选择互不代替。未知 alias、损坏或不安全的 pin、共享库缺失、能力不足、SSH 失败均明确拒绝，不回退本机。

CLI 的任务 scope 按显式 --scope、BROWSER_USE_CONTEXT_ID、DSH_SESSION_ID 选择。普通浏览器任务没有 scope/session 就拒绝。Page 创建时解析并固定 host/session/targetId，后续改 pin 不重路由已有对象。

## 元素与坐标边界

元素引用固定节点身份，导航或文档变化后旧引用失效。点击只使用能证明的可见点；旋转、透视或遮挡无法证明时拒绝。取态和动作必须检查完整性、快照凭证和实际业务结果。

## 网络边界

网络拦截、请求头、泳道、HAR、控制台和事件订阅都按实际实现声明范围。worker、service worker、跨进程 iframe 和完整抓包不是无条件支持。远程产物只取回明确白名单，并校验来源、字节数和 SHA-256。

## 当前未支持

公开 Frame 对象、OOPIF 可信 hover、旋转或透视元素的可靠坐标、任意 CDP、全 worker 流量和所有网页无损观察都不是当前承诺。临时 isolated 默认禁用扩展；持久 isolated 与 clone 保留扩展。attach 连接失败时默认回退到 clone，并在结果中标记 fallbackFrom；fallback=never 禁止回退。isolated/clone 屏蔽自动化提示条。attach 可配合 computer-use 处理日常 Chrome 的 1Password 浮层；克隆登录态需逐站验证，不承诺全部有效。

## 检查方法

显式 `browser-use --local install` 安装声明依赖到独立缓存环境，不在普通调用中自动联网安装。测试在技能根目录用同款环境：

```bash
PYTHONPATH=src:tests ~/.cache/browser-use/venv/bin/python -m unittest discover -s tests -v
```

真实网页测试只用专用 BROWSER_USE_TEST_CHROME_ENDPOINT 和独立 HTTP 夹具，禁止连接用户日常浏览器。真实 skills.browser_use、普通 CLI、用户活动目标不变和 release 不损借用页须分别验证。测试与临时 Chrome 收尾后检查没有残留进程。
