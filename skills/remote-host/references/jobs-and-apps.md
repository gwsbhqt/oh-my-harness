# Long jobs, readiness, macOS apps, screenshots

有 Python 内核的 agent 必须直接用 `skills.remote_host`；先读 [Python 接口](python.md)。本页的 remote-host 命令行示例仅供无内核传统 agent，统一入口见 [CLI 参考](cli.md)。

## Background jobs: `remote-host job`

For anything that takes minutes — installs, builds, hashing. Unlike `send -d` it needs no tmux, so it works on a bare machine.

```bash
remote-host job start brew --progress 'ls /opt/homebrew/Cellar | wc -l' --every 30 -- fish -lc 'br_init'
remote-host job start build <<'EOF'
cd ~/project && make -j8
EOF
remote-host job start install --follow -- brew install zstd # one program, literal arguments
remote-host job start install-several --follow <<'EOF'  # multiple commands: script on stdin
set -e                            # stop if an individual install fails
brew install zstd                 # critical install stands alone: do not hide its status with | tail
brew install jq
EOF
remote-host job start build --follow -- make -j8   # start AND stay attached: one call, ends with the job's exit code
remote-host job follow brew-base -t 1800    # attach later: live log + progress lines until it exits; exits with its code
remote-host job wait build -t 600           # block, then the log tail; 124 = still running (it keeps going)
remote-host job list                        # name, state, age, exit code
remote-host job tail build -n 80
remote-host job kill build                  # TERM then KILL, only the recorded job process tree
```

任务控制需要远端 `python3`。同名启动通过原子锁串行化，路径越界及 `.`, `..` 拒绝。PID 要与记录的启动时间及唯一调用参数一致，才允许取消；陈旧记录不会误杀复用 PID。任务丢失且没有退出码时，wait/follow 返回 125，不冒充仍在运行。取消确认后记录 143。

Python 结果的 `remote_unknown` 与 `outcome` 会指出远端终态是否未知。进程等待超时只终止本地连接，不能证明远端已取消，也不会自动重跑。使用 `remote-host job list/wait` 查终态，确认身份后 `remote-host job kill` 取消。

`remote-host send` 同一 session 以忙碌锁保护，每次载荷、输出与结果文件使用不同 UUID。超时 124 表示仍需查状态，不是取消；reset 成功将当前调用记录为 cancelled/143。载荷自行退出 shell 时状态丢失，忙碌锁必须经 reset 处理；不会静默重开并并发发送。

Everything lives on the host under `~/.cache/remote-host/jobs/<name>/` (`out.log`, `rc`, `pid`): the job survives the connection, and the exit code is the payload's own. `--progress` runs a shell every `--every` seconds and appends its last line to the log as `[progress HH:MM:SS] …`. A name that is still running is refused. Job options go right after the name; `--` or the first other word starts the command. Multiple command words are literal arguments; an independent `&&`, `|` or `;` is rejected before it reaches the host. For a program that genuinely needs such an argument, use a stdin script and quote the symbol there. A **single** command argument is still a script (e.g. `remote-host job start x 'echo a && echo b'`). `remote-host job` does not enable `pipefail` automatically: on bash scripts opt in with `set -o pipefail` only when required; a successful command piped to a `grep` with no match or a `head` that closes early could otherwise fail. For a multi-install bash script, add `set -e` and leave each critical command on its own line; inspect the log without piping the install through `tail`, and report success only when the job exit code and installed result agree. Never auto-retry a failed install.

**仅无 Python 内核的传统 agent 把 `remote-host job start --follow` 作为一次调用交给后台 shell 或 monitor**；有内核直接用 `await skills.remote_host.job("start", name, script=script, host=host, follow=True, timeout=None)` 并遵守内核托管后台任务约束。对于 CLI： it streams the log and exits with the job's own code when the job ends, so the tooling's exit notification *is* the job's completion — no second call, no polling `job list` in a loop. Its wait defaults to 6 h (`-t` to change); if that runs out, or the connection drops, the job keeps going on the host and `remote-host job follow <name>` re-attaches.

## Wait for readiness, drive macOS apps

```bash
remote-host wait --port 7890 -t 60                 # a TCP connect from the host's side (not nc)
remote-host wait --proc 'sidecar/mihomo' -t 60
remote-host wait --file '~/Library/Logs/x.log'
remote-host wait --cmd 'docker info' -t 120
remote-host wait --proc OrbStack --gone -t 30      # until it is NOT true
remote-host app restart "FlClash" --port 7890  # quit politely, wait, TERM/KILL only if ignored, open, wait
remote-host app status OrbStack
```

`app stop` asks the app to quit and escalates only when it does not; killing first is how stale sockets and half-written state appear.

```bash
remote-host -H alpha app logs "FlClash"             # last 60 min
remote-host -H alpha app logs "FlClash" --since 1440 -n 40
```

`app logs` prints three sources: errors and faults of that process in the system log (`log show`), its crash reports, and the error lines (`error`, `EACCES`, `denied`, `fatal` …) of its own log files — or their last lines when they have none. Apps rarely log under their own name: Clash Party writes to `~/Library/Application Support/mihomo-party/logs`, matching neither its name nor its bundle id `party.mihomo.app`. So directories under `~/Library/Logs` and `~/Library/Application Support` are matched on the *words* of the app name, executable and bundle id, and the header says which words it used; Electron browser storage (leveldb) is skipped.

## See the screen: `remote-host screenshot`

```bash
remote-host -H alpha screenshot              # all displays, a JPEG (longest edge 2400) under ~/.cache/remote-host/shots/; prints its path
remote-host -H alpha screenshot --screen 0   # only the main display (1, 2 … the others, in AppKit's order)
remote-host -H alpha screenshot --png -o /tmp/s.png   # full resolution
```

The printed path is a local file — read it with the image tool. The capture is taken by the host's own **Snipaste** (the Brewfile installs it on every Mac): its CLI only messages the Snipaste running in the logged-in session, which already holds Screen Recording from everyday use. A plain `screencapture` over ssh cannot work — macOS grants that permission to an app, and a command over ssh belongs to sshd.

- Snipaste not running: remote-host starts it and waits. Not installed: exit 127 with the install command.
- No image within ~20 s: nobody is logged in, Snipaste has no Screen Recording (System Settings → Privacy & Security → Screen & System Audio Recording), or the installed Snipaste build does not answer this CLI form (seen on gamma 2.10.1 with the screen unlocked and permission already granted). On a fresh Mac Snipaste never answers until that is granted; remote-host gives up instead of hanging. A locked screen gives the lock screen.
- An image of one flat colour: taken without Screen Recording (or the display asleep) — remote-host still returns it and says so on stderr.
- When Snipaste returns no image while the screen is unlocked and its permission is granted, do not switch to `screencapture` over ssh (it runs as sshd and fails with `could not create image from display`) or to `launchctl asuser` (it fails with audit-session errors). Use window-level CuaDriver captures, or run the capture from a GUI-session helper that already holds Screen Recording; if that is not available, report the permission/session block instead of trying more workarounds.
- `--screen N` crops from the display layout AppKit reports; if that cannot be read over ssh, or the displays mix scales, the whole capture comes back and remote-host says so.
