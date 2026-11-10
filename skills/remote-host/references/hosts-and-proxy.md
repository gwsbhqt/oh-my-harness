# Several hosts, and this machine's proxy

有 Python 内核的 agent 必须直接用 `skills.remote_host`；先读 [Python 接口](python.md)。本页的 remote-host 命令行示例仅供无内核传统 agent，统一入口见 [CLI 参考](cli.md)。

## 已知主机环境


目标、登录账户、认证方式、代理跳转和端口都由用户自己的 SSH 配置决定。先读取 `remote-host hosts`，再对明确目标检查连通性；工具不会创建内置机器名单或替用户选目标。

目标系统必须与对应功能兼容。Unix 上可使用完整功能；Windows 目标只在已配置 SSH 和可用解释器时执行相应载荷，不能据此声称能控制 Windows 桌面。



## Several hosts at once

`-H` takes a comma list for `run`, `status`, `doctor`, `wait` and `app`. Every host runs in parallel as its own `remote-host` call, so pins and flags behave exactly as for one host; output comes back in one section per host, then `remote-host: alpha=0  beta=1` on stderr, and the exit code is the worst one.

```bash
remote-host -H alpha,beta run --table <<'EOF'
echo "formula=$(brew list --formula | wc -l | tr -d ' ')"
echo "cask=$(brew list --cask | wc -l | tr -d ' ')"
echo "shell=$(dscl . -read /Users/$USER UserShell | awk '{print $2}')"
EOF
```

`--table` aligns each host's `key=value` lines into one table and marks rows that differ with `≠`. If a value would make a column too wide, it instead prints **complete original output by host**, including lines not parsed as `key=value`; it never judges equality using truncated previews. A host named twice gets `host#2`.

## Proxy through this machine

同一局域网的目标用 `-P` 或 Python `run(proxy=True)`：远端子进程的代理环境变量指向本机面向目标的局域网地址，端口 7890；本机代理需允许局域网连接。经中转连接的目标不能直接回连，工具会拒绝并给出提示；改用下文的反向 SSH 代理。

```bash
remote-host -H alpha -P run 'brew install zstd'
remote-host use alpha -P                      # this host always uses it (--no-proxy to undo)
```

`REMOTE_HOST_PROXY=addr:port` overrides the address. `remote-host doctor` reports whether the host can reach it.

## 跨网络借用本机 HTTP 代理

`skills.remote_host.reverse_proxy(*, host, local_proxy, timeout=30)` 返回一次性异步上下文。`host` 必须是一个明确的已知 SSH alias，不采用或修改默认机器；`local_proxy` 是调用机已经确认可用的 `http://LOOPBACK:PORT`，支持 IPv4、IPv6 和 localhost，不接受账号密码、远端地址或路径。它只转发 TCP，不启动或修改调用机代理，也不证明代理能访问业务目标。

SSH 沿用 alias 的认证和跳板配置，但每个句柄使用私有控制套接字与独占 master，禁用认证后 fork、SSH agent 转发和继承的端口转发。端口由 SSH 服务端动态分配，不预选空闲端口。远端用 `lsof` 检查监听地址；没有 `lsof`、转发被禁止或服务端强制绑定所有网卡时，启动失败并关闭该连接。适用于有 `sh` 和 `lsof` 的 Unix 远端；Windows 不支持。

```python
async with skills.remote_host.reverse_proxy(
    host="alpha", local_proxy="http://127.0.0.1:7890", timeout=30
) as proxy:
    result = await skills.remote_host.run(
        "curl --noproxy '' --max-time 20 -sS -o /dev/null -w '%{http_code}\n' https://example.com",
        proxy=proxy, quiet=True
    )
    result.ok, result.code, result.out, result.err
```

`run(proxy=proxy)` 固定使用句柄所属目标，只给本次调用的子进程传代理地址；另传不同 host 或 table=True 会拒绝。既有 `proxy=True` 的局域网语义不变。句柄还提供 `url`、`port`、`host`、`alive`、`closed` 和 `env`，其中 `env` 包含大小写 HTTP/HTTPS/ALL_PROXY 并清空 NO_PROXY，仅用于明确选中的远端子进程，不能写进全局配置。`alive` 表示 SSH 进程仍在，业务是否通要用真实请求验证。隧道只保证 TCP 转发；Node 应用可能需要显式启用环境代理，后台程序还可能过滤环境变量，须按目标程序自己的规则传给最终消费请求的进程。不能用 curl 成功代替后台业务验收。`run(proxy=proxy)` 沿用既有执行前导，不改远端已有 NO_PROXY；业务必须经过代理时，按目标客户端明确禁用绕过，例如 curl 的 `--noproxy ''`。

需要跨单元格持有时，保留句柄，使用 `proxy = skills.remote_host.reverse_proxy(...)`、`await proxy.open()`，在任务 finally 中 `await proxy.close()`。`close()` 可重复调用，只终止和回收自己的 SSH master，再删除私有套接字目录；关闭后不能重开，须新建句柄。优先用 async with 自动收尾。启动超时、启动失败和取消也会回收部分创建的资源；硬杀内核或调用机断电不能保证执行 Python finally，SSH 断开后远端监听由 sshd 回收，须核查实际端口，不把它当作业务回滚。

无内核时使用同一实现的受管单次执行：

```bash
remote-host -H alpha proxy-run --local-proxy http://127.0.0.1:7890 --connect-timeout 30 <<'EOF'
curl --noproxy '' --max-time 20 -sS -o /dev/null -w '%{http_code}\n' https://example.com
EOF
```

`proxy-run` 支持现有解释器和起始目录，读取 stdin 或命令余下部分作为载荷；不支持 `--with`，需先准备载荷依赖。机器参数放在子命令前；只支持一个目标，不提供持久隧道 CLI。远端载荷退出码原样返回，建立代理失败返回 1；Ctrl-C 退出时关闭代理。两种入口都不读取模型凭据，不要求将家中已有登录搬到调用机。关闭连接不会停止已经独立运行的远端业务任务。
