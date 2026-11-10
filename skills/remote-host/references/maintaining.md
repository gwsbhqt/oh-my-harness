# Maintaining remote-host

`scripts/remote-host` is only the entry point: it imports the canonical `remote_host` package from `src/`, then runs `remote_host.commands.cli.main`. The package loads shared code from its sibling `_shared` in a source checkout, or its private `_shared` resources in an installed wheel. The `src/remote_host/commands/` package holds what only remote-host uses, one module per concern:

| module | owns |
| --- | --- |
| `core.py` | interpreters, per-host interpreter/directory pins, payload dependencies, persistent-session helpers, usage log |
| `cli.py` | remote-host argparse; routes `-H`/`use`/`hosts` through the shared code, then fan-out and proxy dispatch |
| `basic.py` | `run`, `put`, `get`, `status` |
| `session.py` | `send`, `peek`, `reset`, `attach` |
| `config.py` | `stats` |
| `fanout.py` | several hosts, `--table` |
| `jobs.py` | `remote-host job` |
| `ready.py` | `wait`, `app` |
| `shot.py` | `screenshot` (through the host's Snipaste) |
| `doctor.py` | `doctor` |
| `onboard.py` | `discover`, `onboard` |
| `transfer.py` | `manifest`, `verify`, `copy` |

SSH calls, `use`/`pin`/`hosts`, the reachability diagnosis and machine selection live in `skills/_shared/agentkit/remote/` (next section); remote-host imports them from there.
Remote behaviour is built as shell text by pure functions (`job_start_script`, `wait_script`, `app_script`, `manifest_script`, `copy_scripts`, …); the tests run that shell **locally** under a throwaway `$HOME` — it is the same bash on either side. Run them after any change:

```bash
python3 -m unittest discover -s tests -v    # from this skill's directory
```

Anything sent over ssh passes the host's **login shell** (fish on the Macs): keep that command a single `exec`, and put real logic in a staged script.

## 共用远程控制代码

remote-host、computer-control、dsh-control、browser-control 共用的远程控制核心在 `skills/_shared/agentkit/remote/`，这些工具都从这里加载，不复制 SSH 代码，也不调用 remote-host 命令行子进程：

| 模块 | 管什么 |
| --- | --- |
| `ssh.py` | SSH 参数、PATH 前导、脚本暂存、借本机代理时对方连的局域网地址、连不上时的提示、`ssh -G` 与 `~/.ssh/config` 主机列表 |
| `proxy.py` | 任务独占反向 HTTP 代理：异步生命周期、动态端口、loopback 检查与失败清理 |
| `reach.py` | 连不上时判断原因（不在同一网络、对方睡眠、远程登录没开） |
| `pins.py` | 每个工具自己的默认机器：pin 文件读写和锁，`use` / `pin` / `hosts` |
| `target.py` | 选机、`-H` / `--local` 解析、把 computer-control / dsh-control 命令转发到目标机同名工具、能力握手 |
| `adapters.py` | computer-control 远程截图取回，dsh-control 远端重启回执 |
| `notifications.py` | dsh-control 远端重启的本机观察进程（子进程用 `python -m agentkit.remote.notifications`） |
| `done_watch.py` | dsh-control 跨机器派单 `--notify self` 的本机观察进程：远端真做完后通知本机发起会话（子进程用 `python -m agentkit.remote.done_watch`） |

入口找它的方法统一是「按自身真实路径推出 `skills/_shared`」，缺了就报错退出：remote-host 在 `src/remote_host/__init__.py`，computer-control 在 `src/computer_control/__init__.py` 和 `scripts/computer-control`，browser-control 在 `src/browser_control/__init__.py`，dsh-control 在插件仓库 `dsh-control/bin/dsh-control`。共用部分的测试在 `_shared/tests/`。

- `dispatch(tool, argv) -> (args, code)`：computer-control、dsh-control、clash-control 用。消费机器参数与 `use` / `pin` / `hosts`；`code` 为 `None` 表示继续本机入口，整数表示命令已在远端或本地完成。
- `select_target(tool, argv)` / `control_target(tool, argv)`：browser-control 用，只选机或只执行 `use` / `pin` / `hosts`，不经 SSH 执行业务命令。
- `route("remote-host", argv) -> (args, host, code)`：remote-host 用。只消费机器参数、处理 `use` / `pin` / `hosts`，把 `-H` 的原值交回 remote-host；`-H a,b` 的多机并发和不需要机器的命令由 remote-host 自己判断。
- `resolve_target(tool, host=None)`：无副作用读取各工具的默认目标，返回 `local` 或已知 SSH 别名；无效目标抛 `ValueError`，不能据此静默回本机。
- 远程 `computer-control serve` 明确拒绝：脚本暂存不支持双向标准输入流，不能以空输入的成功退出伪装长驻服务。
- computer-control/dsh-control 机器参数只在命令前消费；非文本位置的错位机器参数直接拒绝。remote-host 到业务载荷开始后停止消费机器参数，防止 `curl -H` 被吃掉。远端调用总是前置 `--local`，压过远端自己的默认机器。
- 转发的参数用 `shlex.join`，脚本用 `stash_here` 暂存，沿用 `PRELUDE`、真实 `ssh`、退出码与诊断。远端工具只取 `~/.local/bin/<tool>` 并检查可执行，不误跑系统里的同名 `computer-control`。
- computer-control 截图只解析主动请求的 JSON：snap 字段 `shot`、shot 字段 `path`。字节通过同一 SSH 下载，缓存目录 700、图片 600；`remotePath` 保留原值，`path` 和原截图字段改成本机路径。下载失败必须返回非零；普通输出不猜 JSON。
- dsh-control 转发保留 `DSH_SHELL`，本机有 `DSH_SESSION_ID` 时至少导出 `DSH_SHELL=1`，不转发会话 ID。远程 detached 重启按 requestId 在本机观察，再通知本地来源会话；`restart-watch` 只读本机记录，远端终态用 `restart-status --request-id`。
