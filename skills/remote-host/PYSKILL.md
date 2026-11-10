---
name: remote-host
description: "通过真实 SSH 操作另一台主机：首次连接、执行命令、多机对比、后台任务、等待就绪、macOS 应用、远端截图、借本机代理、主机间复制并校验。本机操作不使用。"
---

# remote-host（远程主机）

有 Python 技能内核时读取 [PYSKILL.md](PYSKILL.md)，直接使用 `skills.remote_host` 的完整下划线入口，不另起模块别名；无内核时读取 [SKILL.md](SKILL.md)，使用正式 CLI。入口、读取、依赖或调用出错必须保留错误并查明原因，不得换接口绕过。

固定远端机器、发送载荷并检查真实退出码。先读 [共用规则](references/common.md) 和按需的 [共用远程边界](references/transport.md)；机器选择、授权、任务归属、结果未知、迁移和收尾只在共用规则维护。

## 安装检查与选机

本机需要已部署的技能包、随附启动器、共用远程代码与真实 SSH；目标机需开启远程登录、配置 SSH alias 和对应认证。先读机器列表，再检查已授权的目标。机器列表只读 SSH 配置，不连接远端；状态与诊断会实际连接。

```python
hosts = await skills.remote_host.hosts(quiet=True)
hosts.ok, hosts.code, hosts.out, hosts.err
status = await skills.remote_host.status(host="alpha", quiet=True)
status.ok, status.code, status.out, status.err
doctor = await skills.remote_host.doctor(host="alpha", quiet=True)
doctor.ok, doctor.code, doctor.out, doctor.err
```

没有远端默认值必须显式选机，不根据当前网络或旧 IP 猜机器，不回退本机。只有确实需要改变后续默认值时才设置；设置按机器分别保存，清除后下次仍须重新指定远端。

```python
pinned = await skills.remote_host.use("alpha", cwd="~/workspace", quiet=True)
pinned.ok, pinned.code
cleared = await skills.remote_host.use(clear=True, quiet=True)
cleared.ok, cleared.code
```

机器与默认值参数同时参阅 [命令参数参考](references/cli.md#入口与共用参数) 和 [内核参数参考](references/python.md)。

## 首次连接

新机器先发现候选，再按 [首次连接](references/first-contact.md) 核对身份、认证和权限后 onboard。需要实体登录、系统确认或交互认证时交给用户，不伪造完成。发现和 onboarding 是不同步骤，不能仅凭发现记录执行写操作。

```python
discovered = await skills.remote_host.discover(quiet=True)
discovered.ok, discovered.code, discovered.out, discovered.err
# NEW_HOST 换成身份和权限已核对的新目标。
onboarded = await skills.remote_host.cli("onboard", "NEW_HOST", quiet=True)
onboarded.ok, onboarded.code, onboarded.out, onboarded.err
```

onboard、put/get、attach 没有专用内核函数，由正式的内核管理入口提供；attach 仍需真实交互终端，不能在无终端环境伪装完成。管理参数同时参阅 [命令参数参考](references/cli.md#完整命令与参数分册) 和 [内核参数参考](references/python.md#无专用函数的管理入口)。

## 执行与结果核对

普通执行每次都是新 shell，不继承本地工作目录，目录与解释器要明确。载荷原样送入远端：命令使用带引号的 heredoc，内核使用字符串，不让本机 shell 提前展开。

```python
result = await skills.remote_host.run(
    "git status --short", host="alpha", cwd="~/workspace", quiet=True
)
result.ok, result.code, result.outcome, result.out, result.err
```

远端退出码原样返回，SSH 失败常为 255。先检查退出码与 stderr，再解析 stdout 或执行依赖步骤；代码调用成功不等于远端命令成功。命令行通过进程退出码及输出判断；内核异步返回 Result 对象，不是 dict。

Result 的 ok 只表示 code=0，out/err 分别是 stdout/stderr，text 合并两者，lines 是 stdout 非空行，last_line 是最后非空行；另有 seconds、timed_out、remote_unknown、outcome。默认回显输出，quiet 只影响显示，不改变结果。结果字段和超时细节同时参阅 [命令参数参考](references/cli.md) 和 [内核参数参考](references/python.md#结果对象与超时)。

## 解释器、多机与代理

更换解释器只影响远端载荷；脚本通过暂存文件执行，不依赖多层 shell 拼接。同一载荷可在明确列出的多台机器执行，用 key=value 输出比较。

```python
result = await skills.remote_host.run(
    "import platform\nprint(platform.node())\n",
    host="alpha", interp="py", quiet=True
)
result.ok, result.code, result.out, result.err
comparison = await skills.remote_host.run(
    'echo "macos=$(sw_vers -productVersion)"',
    host="alpha,beta", table=True, quiet=True
)
comparison.ok, comparison.code, comparison.out, comparison.err
# 借本机代理时传 proxy=True，不写固定代理地址。
```

借本机代理使用工具的代理借用能力，不写死本机局域网代理地址。持久默认值也可管理代理，但显式机器、解释器和目录始终优先按任务确定。执行参数见 [执行与上下文](references/running.md)，多机和代理见 [主机与代理](references/hosts-and-proxy.md)，两种入口同时参阅 [命令参数参考](references/cli.md) 和 [内核参数参考](references/python.md)。

同一局域网继续用 `-P` 或 `run(proxy=True)`。跨网络时用任务独占的反向 SSH 代理：调用方显式提供已确认可用的本机 HTTP 代理，SSH 为远端动态分配端口，并核实仅监听 loopback。Python 用 `reverse_proxy()` 上下文和 `run(proxy=proxy)`，命令行用 `proxy-run`；退出、异常或启动失败都会关闭自己的连接。远端需有 `lsof`，不支持 Windows。不会改全局代理、默认机器或其他 SSH 通道，不读取或搬运模型凭据。详见 [主机与代理](references/hosts-and-proxy.md#跨网络借用本机-http-代理)。

```python
async with skills.remote_host.reverse_proxy(
    host="alpha", local_proxy="http://127.0.0.1:7890"
) as proxy:
    result = await skills.remote_host.run(
        "curl --noproxy '' --max-time 20 -sS -o /dev/null -w '%{http_code}\n' https://example.com",
        proxy=proxy, quiet=True
    )
    result.ok, result.code, result.out, result.err
# 离开上下文自动关闭；代理只用于本任务的远端子进程。
```

## 持久会话与任务归属

确需跨调用保留目录或变量时才用持久发送，需要目标机有 tmux，并带本任务唯一 session。普通执行不用持久会话；只读输出与终止会话是不同操作。

```python
sent = await skills.remote_host.send(
    "pwd", host="alpha", session="task-a", quiet=True
)
sent.ok, sent.code, sent.out, sent.err
```

会话归属、未知结果与终止限制见 [共用规则](references/common.md#任务归属与终态)。持久会话参数同时参阅 [命令参数参考](references/cli.md) 和 [内核参数参考](references/python.md)。

## 长任务与等待

分钟级安装或构建交给受管 job，名字须唯一，记录原机器与任务名。启动后查询同一任务，不重复启动；一次跟到退出时才用对应退出码判断终态。

```python
job_result = await skills.remote_host.job(
    "start", "task-a-check", script="uname -s",
    host="alpha", follow=True, timeout=None, quiet=True
)
job_result.ok, job_result.code, job_result.outcome, job_result.out, job_result.err
jobs = await skills.remote_host.job("list", host="alpha", quiet=True)
finished = await skills.remote_host.job("wait", "task-a-check", host="alpha", quiet=True)
tail = await skills.remote_host.job("tail", "task-a-check", host="alpha", lines=40, quiet=True)
ready = await skills.remote_host.wait(host="alpha", port=9090, timeout=120, quiet=True)
ready.ok, ready.code, ready.out, ready.err
```

后台启动、端口就绪和截图路径各只证明对应一步，业务完成还须读真实结果。等待还支持进程、文件、检查表达式与消失条件，不用固定延时轮询。支持后台执行的内核使用其托管后台机制并保留句柄；不在单元格结束后遗留失去工具权限的异步任务。终态、超时与取消规则见 [共用规则](references/common.md#任务归属与终态)，参数同时参阅 [命令参数参考](references/cli.md#任务与收尾示例) 和 [内核参数参考](references/python.md)。

## 应用、截图与复制

macOS 应用生命周期交给专用能力，提供状态、启动、停止、重启和日志，不拆成不受跟踪的退出与打开。截图成功后才把返回的本机路径作为可读取图片。

```python
app_status = await skills.remote_host.app("status", "Chrome", host="alpha", quiet=True)
app_status.ok, app_status.code, app_status.out, app_status.err
image = await skills.remote_host.screenshot(host="alpha", screen=0, quiet=True)
image.ok, image.code, image.last_line, image.err
```

复制默认先暂存再落位并逐文件核对内容，单独比对和生成清单另有专用能力。以下仅示范已授权的自有目录，不擅自覆盖现有目标。

```python
copied = await skills.remote_host.copy("alpha:~/source", "beta:~/destination", quiet=True)
copied.ok, copied.code, copied.out, copied.err
verified = await skills.remote_host.verify("alpha:~/source", "beta:~/destination", quiet=True)
manifest = await skills.remote_host.manifest("beta:~/destination", quiet=True)
verified.ok, verified.code, manifest.ok, manifest.code
# 覆盖必须已获授权才传 replace=True；quick=True 只比大小。
```

覆盖授权、迁移策略与快速比较的局限见 [共用规则](references/common.md#应用迁移与校验)；快速比较只比大小，不能声称内容相同。应用和任务读 [长任务与应用](references/jobs-and-apps.md)，复制读 [复制与校验](references/copy-verify.md)，完整签名同时参阅 [命令参数参考](references/cli.md#完整命令与参数分册) 和 [内核参数参考](references/python.md)。

## 主机与按需参考

机器的认证方式、登录 shell、跳转和代理按用户自己的 SSH 配置读取。Kerberos 目标需要有效票据；SSH 库不能替代真实 SSH 的系统认证。目标的登录权限和解释器必须实际核对，工具不安装或升级远端软件。环境与代理说明见 [主机与代理](references/hosts-and-proxy.md)。

载荷依赖读 [第三方库](references/payload-libraries.md)，实现维护读 [维护说明](references/maintaining.md)，传输与远程产物限制读 [共用远程边界](references/transport.md)。其他技能的浏览器、桌面、代理与 DSH 控制能力优先走各自正式入口，并显式选同一机器，见 [共用远程与收尾](references/common.md#共用远程与收尾)。

## 收尾与未知结果

结束前收齐已启动任务的终态。停止不再需要且获准停止的任务时保留原机器与名字；只有自己创建且不再需要的持久会话才终止。

```python
# 只对仍需要停止且已获授权的原任务执行。
stopped = await skills.remote_host.job("kill", "task-a-check", host="alpha", quiet=True)
stopped.ok, stopped.code, stopped.out, stopped.err
# 仅终止自己创建且不再需要的持久会话。
reset = await skills.remote_host.reset(host="alpha", session="task-a", quiet=True)
reset.ok, reset.code, reset.out, reset.err
```

普通执行没有统一 release，其他技能持有的页面与应用分别释放。超时或断连不证明远端已停，先查原任务终态；停止等待、清理连接不能撤销业务动作，不自动重放可能已执行的写操作。统一见 [共用规则](references/common.md#共用远程与收尾)。
