# remote-host CLI 参数参考

本页维护 `remote-host` 的详细 CLI 参数和示例，日常流程见 [CLI 主说明](../SKILL.md)。带 Python 内核时读 [Python 主说明](../PYSKILL.md)，直接调用 `skills.remote_host`；调用失败先查原因，不用 CLI 绕过。授权、机器和任务归属、未知结果及收尾共用 [操作规则](common.md)。

## 入口与共用参数

入口为部署到 PATH 的 `remote-host`，真实代码是技能 `scripts/remote-host`。远程执行必须有显式 `-H HOST` 或本技能 pin；`--local` 和 `-H local` 拒绝执行。机器参数放在业务载荷前，推荐放子命令前；job 的机器参数放 job 前。`-H a,b` 多机，`-i INTERP` 解释器，`-C DIR` 起始目录，`-P` 借本机代理；`-s NAME` 区分持久会话。`~` 要引用，避免先被本机 shell 展开。

```bash
# remote-host：机器列表与默认值只影响 remote-host。
remote-host hosts
remote-host use alpha
remote-host use alpha -i sh -C '~/workspace'
remote-host use
remote-host use --clear
# remote-host：载荷从 stdin 原样传入，不经过本机 shell 展开。
remote-host -H alpha run <<'EOF'
git -C ~/workspace status --short
EOF
# remote-host：多机 key=value 输出可直接比较。
remote-host -H alpha,beta run --table <<'EOF'
echo "macos=$(sw_vers -productVersion)"
EOF
```

## 完整命令与参数分册

- [执行与上下文](running.md)：use/pin/hosts/stats/status、run、send、peek、put/get、attach、reset 的全部参数，解释器、stdout/stderr 和会话后端。
- [首次连接](first-contact.md)：discover、onboard、doctor 的参数、认证和 cannot reach 诊断。
- [多机与代理](hosts-and-proxy.md)：逗号多机、table、局域网代理，以及 `proxy-run --local-proxy URL --connect-timeout 30` 的跨网络反向代理与收尾。
- [长任务与应用](jobs-and-apps.md)：job start/list/wait/follow/tail/kill、wait、app start/stop/restart/status/logs、screenshot 的参数和返回。
- [复制与校验](copy-verify.md)：copy、verify、manifest 的完整位置、覆盖、压缩、校验参数。
- [载荷第三方库](payload-libraries.md)：Python/JS 载荷依赖选择。

## 任务与收尾示例

```bash
# remote-host：一次调用跟到远端任务退出，退出码就是任务退出码。
remote-host -H alpha job start task-a-check --follow <<'EOF'
uname -s
EOF
# remote-host：查询和停止已有任务必须保留原机器与名字，不重复 start。
remote-host -H alpha job list
remote-host -H alpha job wait task-a-check
remote-host -H alpha job tail task-a-check -n 40
remote-host -H alpha wait --port 9090 -t 120
# remote-host：复制默认逐文件校验；替换目标须另外明确授权。
remote-host copy alpha:~/source beta:~/destination
remote-host verify alpha:~/source beta:~/destination
```

`run` 每次新 shell，`send` 才保留状态；`send -d` 只发不等，不证明完成。CLI 远端退出码原样返回，SSH 失败常为 255；超时或断连先查终态。检查和失败处理见主说明，不用管道末端成功代替真实结果。交互 attach 需要真实终端，不能让 agent 伪装交互成功。
