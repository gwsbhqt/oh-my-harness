# Running commands

有 Python 内核的 agent 必须直接用 `skills.remote_host`；先读 [Python 接口](python.md)。本页的 remote-host 命令行示例仅供无内核传统 agent，统一入口见 [CLI 参考](cli.md)。

Read for pinning details, the full command list, interpreters, `run` vs `send`, and how output arrives.

## Pin the host first

remote-host 的远程执行命令必须有 host。本机管理命令 `use` / `pin` / `hosts` 不连接远端。Name it once and the rest stays short:

```bash
remote-host use worker                  # pin the host
remote-host use worker -i fish          # pin the interpreter too
remote-host use worker -C '~/project'   # and where a fresh context starts (remote ~, quoted)
remote-host use                         # show what is pinned
remote-host hosts                       # everything in ~/.ssh/config, pinned one marked
remote-host pin worker                  # exactly the same as use
remote-host use local                   # unset the default host; does not enable local run
```

The pin lives in `~/.local/state/remote-host/pin.json` — local to this machine, independent of the working directory. `-H <host>`, `-i <interp>` and `-C <dir>` override it for one call without disturbing it, before the payload starts (prefer before the subcommand). `remote-host use` shows the saved pin without connecting. Before `remote-host status` connects, it prints the selected alias and its effective local SSH target (`ssh -G`); for a pinned private IP it also warns when the local route appears to leave that LAN. This is a hint, not proof of machine identity; changing networks never silently changes the pin. Use `-H` to override it for one call or `remote-host use <host>` to change it deliberately.

**Interpreter and directory are remembered per host.** `remote-host use alpha -C '~/workspace'` then `remote-host use worker` keeps both: `-H alpha` gets alpha's directory, and a host with nothing pinned starts in its home — another host's directory is never carried over. `remote-host use <host> --clear` forgets one host, `remote-host use --clear` everything. `remote-host use local` drops the default host but keeps per-host settings; `remote-host -H local run` and `remote-host --local run` are rejected. Unknown aliases are rejected rather than passed to SSH or run locally. computer-use/dsh-use share this implementation but have independent pins and a local default; their target flags belong before the command.

A leading `~` in `-C` is the **remote** home — quote it (`-C '~/project'`), because an unquoted `~` is expanded by the local shell into this machine's home before `remote-host` sees it.

Pinning a directory is worth it as soon as the work has a home on the host. `run` starts a fresh shell every time, so without it every payload opens with a `cd`; with it, `run` and any newly created session start there. It only sets *where a fresh context begins* — once a session exists, its own `cd` wins, because that state is the point of a session. With nothing pinned and no `-H`, `remote-host` refuses rather than guessing.

Examples below assume a host is pinned.

## Commands

| | |
| --- | --- |
| `remote-host use [host] [-i interp] [-C dir]` | pin host, interpreter and start directory (`--clear` to unset) |
| `remote-host hosts` | host names from `~/.ssh/config` |
| `remote-host stats` | what gets run over and over — read this before adding a subcommand |
| `remote-host status` | pinned host and interpreter, ticket, uptime, multiplexer, which interpreters the host has |
| `remote-host run [cmd]` | run it in a fresh shell and wait; **reads stdin when `cmd` is omitted** |
| `remote-host run -i py` | same, with the payload as a Python script (`-i` also takes fish, js, sh, zsh) |
| `remote-host send [cmd]` | run it in the persistent session and wait; state survives |
| `remote-host send -d` | same, but return immediately instead of waiting |
| `remote-host send -t 900` | wait up to 900s instead of the default 300 |
| `remote-host send -n 2000` | cap each stream at 2000 lines (default: no cap) |
| `remote-host peek [-n N]` | tail of the session's stdout, and stderr if any, default 30 lines |
| `remote-host put <local> [remote]` | copy up (default `~/`) |
| `remote-host get <remote> [local]` | copy down (default `.`) |
| `remote-host attach` | open the session in this terminal — for a human, needs a TTY |
| `remote-host reset` | kill the session |
| `remote-host discover` | machines on this LAN: address, SSH on/off, alias, likely user |
| `remote-host onboard <alias>` | first contact end to end ([first-contact.md](first-contact.md)) |
| `remote-host doctor` | reachability and setup check, with fixes |
| `remote-host -H a,b run [--table]` | same payload on several hosts in parallel |
| `remote-host job start\|list\|wait\|follow\|tail\|kill` | background jobs, no multiplexer needed |
| `remote-host wait --port\|--proc\|--file\|--cmd` | block until ready (`--gone` for the opposite) |
| `remote-host app start\|stop\|restart\|status <App>` | macOS app lifecycle, in the right order |
| `remote-host -P …` | use this machine's proxy from the host |
| `remote-host manifest <loc>`, `remote-host verify <a> <b>` | canonical tree listing; entry-by-entry comparison |
| `remote-host copy <src> <dst>` | staged, verified copy between any two places |

`-s <name>` gives `send`/`peek`/`reset`/`attach` a separate session, so two long jobs can run side by side.

## Which interpreter

`-i` picks what reads the payload. A payload is always a *script* — `remote-host` writes it to a file on the host and runs the interpreter on it, so nothing is re-parsed on the way and any syntax is legal.

| `-i` | runs as | also accepts |
| --- | --- | --- |
| `bash` (default) | `bash -l file.sh` | |
| `fish` | `fish -l file.fish` | |
| `sh`, `zsh` | `sh file.sh`, `zsh -l file.zsh` | |
| `python` | `python3 file.py` | `py`, `python3` |
| `js` | `bun file.js`, falling back to `node file.js` | `javascript` |
| `bun`, `node` | that runtime and no other | |
| a path | that exact interpreter — a project venv, a pinned runtime | |

Windows 原生命令用 `-i powershell` 自动优先选择 PowerShell 7（`pwsh.exe`），未安装时使用 Windows 自带的 PowerShell；Python 调用传 `interp="powershell"`。明确需要 PowerShell 7 时可传 `-i pwsh`，未安装会报错。脚本经 SSH 标准输入送入 PowerShell 内存，UTF-8 输出及退出码原样返回，并禁止 SSH agent 转发。`-C` 接受 Windows 路径。PowerShell 抛错或 `Write-Error` 返回 1，显式 `exit N` 返回 N；未显式退出时沿用最后一个原生命令的退出码，脚本只运行 PowerShell 命令则成功返回 0。该支持仅限 `run`，持久会话、后台任务、文件复制、状态和诊断仍依赖原有类 Unix 环境；PowerShell 执行不支持 `--proxy` 或 `--with`。未指定解释器时仍默认 bash。

## Payload 依赖

远程脚本需要第三方 Python/JS 库时，读 [payload-libraries.md](payload-libraries.md)；普通命令无需加载。

## Ask for machine-readable output

A remote command has no terminal. Programs that notice fall back to 80x24 and wrap
their tables into something no parser can recover; `remote-host` therefore exports
`COLUMNS=200 LINES=50`, which a payload may override.

Wide output is a patch, not a fix. **Before parsing anything meant for a human,
read that subcommand's own `--help`** — the flag that hands over JSON is usually
right there, and a top-level `--help` will not show it. Parsing a rendered table
with `awk` is a decision to redo the work later, when a column shifts.

```bash
remote-host run 'hermes plugins list --json'      # one call, exact
remote-host run 'hermes plugins list | awk …'     # a table, re-wrapped, re-guessed
```

The same instinct covers size: `run` streams everything a payload writes, with no
cap, so bound it at the source — `| head -50`, `| wc -l`, `--limit` — rather than
discovering how large it was after it arrives. (`send` reads captured output files on the host, so its `-n` cap is applied there.)

## Pass the command on stdin

Arguments work for one-liners (`remote-host run uptime -p`), but a heredoc is the reliable form — nothing is re-parsed on the way, so quotes, `$(...)`, loops and nested heredocs all survive verbatim:

```bash
remote-host run <<'EOF'
cd /etc/mihomo
echo "files=$(ls | wc -l)"
systemctl is-active mihomo
EOF
```

The remote exit code becomes the local one, with `remote-host: <host> exit N` on stderr when it is non-zero.

## `run` or `send`

`run` is a fresh shell each time — nothing carries over, output streams live. Right for most things.

`send` runs inside a persistent pane, **waits for the command to finish**, and prints what it produced. Use it when state matters or the job is slow:

```bash
remote-host send <<'EOF'
cd ~/project && ./build.sh 2>&1 | tee /tmp/build.log
EOF
```

`cd` and exported variables set by one `send` are still there for the next one. Each `send` clears the pane first, so its output is that job and nothing older.

The pane is a **shell**, so what persists is shell state. A `-i py` or `-i js` payload runs as a fresh process inside that pane: it inherits the pane's working directory and environment — a previous `send 'cd /etc/mihomo'` is visible to it — but its own variables die with it. To carry state between Python payloads, write it to a file.

Waiting is capped by `-t` (default 300s). On timeout `remote-host` exits 124, says so, and **leaves the job running** — pick it back up with `remote-host peek`.

Three things `send` refuses or reports rather than corrupting:

- **A busy session is refused** (`remote-host: session agent is busy running cargo`) instead of typing into a running job and losing its output. Use `-s <other>` for a parallel session, or `remote-host peek` to watch.
- **A payload that calls `exit`, or gets killed, takes the pane's shell with it.** The pane is kept for its output, `remote-host` reports the real status (`exit 42`, `137`) and says the state is gone; the next `send` starts a fresh session.
- **Output is complete by default**; `-n` caps each stream and says so on stderr (`remote-host: showing the last N of M lines`) when it bites. For something genuinely long, `remote-host send -d` returns at once and you poll:

```
remote-host peek -n 40
[worker/agent] busy: cargo   ← still running; the word is the foreground command
[worker/agent] idle          ← finished, the pane is back at a prompt
```

Poll on a cadence that matches the job, not in a tight loop.

## Both give you the payload's real streams

Neither command reads a terminal. `run` inherits the process's stdout and stderr
straight down the ssh connection; `send` redirects them to files on the host and
copies those back on their own descriptors. Either way what arrives is what the
program wrote — separated streams, exact bytes, no wrapping:

```
                       run          send
binary \xc3\x28\xff       c328ff0a     c328ff0a
a 500-column line      1 line       1 line
stdout vs stderr       separate     separate
100k lines             complete     complete
```

The difference is *when*, not *what*: `run` streams as the job writes, `send`
hands everything over once the job finishes (or on `remote-host peek` while it runs).

`send` reads the pane only to answer two questions — is the job still running,
and did the shell die — never for output. So a redrawing progress bar reaches
you as the raw carriage returns the program emitted, and a program that checks
for a terminal will see none in either command, exactly as it would over a pipe.

A payload's stdin is `/dev/null` in both, since the connection's stdin carries
the script itself. A payload that wants input should read a file.

## Editing a remote file

`remote-host get` it, edit the local copy with the ordinary file tools, `remote-host put` it back. Do not build `sed` incantations — round-tripping is shorter and the edit is reviewable.

Check the remote path’s resolved target first. If it belongs to a managed configuration repository, edit that source file on the remote host (round-tripping it if needed) and use that host’s configuration manager only if links need updating. Editing a local copy alone does not update the remote host.

## The session backend

`remote-host` keeps persistent sessions in `tmux`; `remote-host status` reports whether the host has it.

Completion is detected with the multiplexer's `wait-for` channel, not by watching output go quiet — a build that sits silent for a minute would fool a quiet-timer, and this does not. That is also why one `remote-host send` costs a single SSH round trip no matter how long the job runs.

## Traps

**`remote-host attach` and a bare `ssh` land in the host's own login shell**, whatever that is, with no `-i` in effect. Only `remote-host run`/`send` control the interpreter.

**`send`, `peek` and `attach` need tmux on the host**; `run`, `put`, `get` and `status` do not. Missing it, `remote-host` says so and exits 127 — use `run` or `job` if persistence is unnecessary; otherwise re-run `remote-host onboard <alias>`, which installs tmux (step 7 in [first-contact.md](first-contact.md)).

**A non-interactive login shell has neither Homebrew nor mise on `PATH`** even when the interactive shell has both. `remote-host` prepends the Linuxbrew and macOS Homebrew directories plus mise's shims to everything it sends, and passes absolute interpreter paths into panes, because a pane inherits the multiplexer server's environment rather than ours. A raw `ssh` call gets none of that.

**One session, one shell.** The pane's shell is fixed when the session is created, and a shell payload is *sourced* into it — that is what preserves state. Asking for a different shell in the same session is refused (`remote-host: session agent runs fish, not bash`); use `-s <other>` for a second session or `remote-host reset`. Python and JS payloads are exempt: they run through a bash wrapper, so they work in any pane and still inherit its directory.

**Adding a host means adding it to `~/.ssh/config`** — `remote-host` resolves nothing itself, which is why `ControlMaster`, `ProxyCommand` and Kerberos all keep working.
