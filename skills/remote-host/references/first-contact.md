# First contact and diagnosis

有 Python 内核的 agent 必须直接用 `skills.remote_host`；先读 [Python 接口](python.md)。本页的 remote-host 命令行示例仅供无内核传统 agent，统一入口见 [CLI 参考](cli.md)。

Read when reaching a machine for the first time, or when a host will not connect.

## First contact: `discover` and `onboard`

```bash
remote-host discover                                   # every Mac on this LAN, its address, whether SSH is on
remote-host onboard alpha --ip 198.51.100.11 --wait 600
```

`discover` reads Bonjour, so it needs no scanning: a Mac with Remote Login on announces `_ssh._tcp`; every Mac announces Continuity (`_companion-link._tcp`) regardless, which is how a machine that is **there but has SSH off** shows up as `ssh OFF` instead of not at all. It also names the likely account (macOS names a machine after its first user: `alexdeMac-alpha` → `alex`) and any ssh alias already pointing at it. Bonjour stays inside one LAN — from the office, home machines are invisible.

`onboard <alias>` does the rest in order, idempotently — re-run it after each step the user takes:

1. **locate** — the alias from `~/.ssh/config`, `--ip`, or a Bonjour match on the alias
2. **Remote Login** — a real TCP connect to port 22. Closed: it prints exactly what to switch on (System Settings → General → Sharing → Remote Login, or `sudo systemsetup -setremotelogin on`), and with `--wait N` it waits for the user to do it and carries on
3. **host key** — recorded in `known_hosts`, fingerprint shown
4. **key login** — needs the account password **once**. Either the user runs the printed `ssh-copy-id` line, or they give the password and `printf '%s\n' '<pw>' | remote-host onboard … --password-stdin` installs the key through `SSH_ASKPASS` (no tty, no expect script; the password is never on a command line — but it does land in the conversation log, so say so first). A missing `~/.ssh/id_ed25519.pub` is derived from the private key.
5. **alias** — appends a `Host <alias>` block (ControlMaster, keepalive) to `~/.ssh/config` if absent; keep the entry in the SSH configuration you manage
6. `--sudo` — optionally passwordless sudo, with the same password
7. **session backend** — for `send`/`peek`/`attach`: keeps an existing tmux, else installs it (Homebrew, then apt/dnf/yum through `sudo -n` only — a password prompt counts as "cannot install"). If nothing installs, onboard still finishes and says so: `run` and `job` need no backend. Install output goes to `/tmp/remote-host-mux-install.log` on the host

It ends by pointing at `remote-host -H <alias> doctor`. For an **existing** alias, onboarding leaves its `HostName` unchanged: compare the effective `ssh -G <alias>` hostname with `remote-host discover` on the same LAN first. A discovered address alone does not prove the machine is the same; match a unique Bonjour hostname and SSH host-key fingerprint before carefully editing the original SSH config. If the identity is ambiguous, stop rather than repoint an alias or reset the pin. A `.local` hostname follows address changes on its own LAN but does not resolve from every network.

## Installing and selectively migrating to a new Mac

Before bulk copying or installing, inventory the old host and recommend a selective move: necessities go first, uncertain or unused apps and data stay untouched on the old host. Ask **once** whether the user wants this or an exact mirror; do not silently assume an exact mirror. If the policy changes during an existing copy, finish/account for work already in progress before any cleanup; do not delete material merely because it no longer belongs in the new plan.

Before installing each uncertain app, compare the original installation source and current proposed source (App Store, official site, package manager), maintained version, application bundle ID, whether App Store sign-in is needed, and whether existing settings can actually be reused. Treat deprecation warnings or a source/version mismatch as a reason to pause and explain the differences to the user, rather than silently installing a same-name but different app. An App Store install may require the user to sign in or complete it manually; installed does not itself mean migrated.

## Diagnose: `doctor`

`remote-host -H beta doctor` 按 `ssh -G` 的 `AddressFamily` 解析地址，检查 TCP 和 SSH 横幅，再新建 SSH 连接验证登录，不复用旧连接。登录后检查 shell、免密 sudo、PATH 中的工具、tmux 和是否能借用本机代理。`Permission denied (publickey)` 要先区分服务端来源限制和钥匙问题；主机指纹变化须先核实身份，若 `known_hosts` 是链接，先核对真实目标，再更新对应记录，保留配置管理关系。

The TCP checks here and in `discover`/`onboard` survive macOS **Local Network privacy**: an interpreter started under an app that was never granted it (seen under an Electron desktop app) gets `No route to host` for every LAN address while ssh — an Apple binary, exempt — works. When Python is refused a private address, remote-host retries through `/bin/bash`'s `/dev/tcp` and `doctor` prints a `·` line saying so, instead of blaming Remote Login.

## When a call cannot connect

Every command that ends in ssh's own failure (`exit 255`) prints the likely cause right away, from one name lookup, one TCP connect and the route this machine would use — no `doctor` needed first:

| remote-host says | meaning | what to do |
| --- | --- | --- |
| `… does not resolve — this machine is not on the same LAN` | a `.local` name only resolves on its LAN | be on that network; `remote-host discover` shows what is visible |
| `… timed out, and this machine (203.0.113.49, the office network) is not on that LAN — you are away from it` | a home address from the office or a phone hotspot (named when recognised) | reachable only from home, or over a VPN/mesh |
| `… timed out — the machine is asleep or off, or its address changed` | same LAN, nothing answers | wake it; `remote-host discover` finds a new address |
| `… is up but refuses port 22 — Remote Login is off` | the machine is there, SSH is not | System Settings → General → Sharing → Remote Login |
| `登录认证失败` / `Permission denied (publickey)` | 已到 SSH 服务，但来源、账号或钥匙可能被拒 | 先按下节核对目标和来源；不要据此安装新钥匙或要求 1Password 授权 |

Payload exit codes (anything but 255) are never diagnosed.

## 认证被拒时先查地址与来源

1. 用 `ssh -G alpha` 核对实际配置，重点看 `hostname`、`addressfamily`、`proxycommand`、`identityfile` 和 `identityagent`。配置里的主机名、原始 IP 和 `alpha` 别名不是同一入口；直接连名字会跳过 `Host alpha` 的设置。
2. 在已确认是家中局域网、且目标主机指纹一致时，对照同一磁盘钥匙的 IPv4 和 IPv6 新连接。禁止借用旧连接作认证证据，也不要关闭主机身份检查。无内核的人工排障可运行：

   ```bash
   ssh -4 -o BatchMode=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none alpha true
   ssh -6 -o BatchMode=yes -o IdentityAgent=none -o ControlMaster=no -o ControlPath=none alpha true
   ```

   有 Python 内核时，日常复测用 `await skills.remote_host.doctor(host="alpha", quiet=True)` 和 `await skills.remote_host.run('printf "%s\n" "$SSH_CONNECTION"', host="alpha", quiet=True)`；专门比较地址族时通过 remote-host 在获准的远端发起真实 SSH，并注明来源机器，不能把远端自连当作本机链路验收。
3. IPv4 成功而 IPv6 返回 `publickey`，先查 sshd 的 `AllowUsers` 和系统 SSH 日志。端口回答或主机钥匙相同，只能说明连到同一服务，不能说明这个来源被允许。来源限制也会表现为公钥拒绝。
4. alpha、beta、gamma 的客户端别名保持 `AddressFamily inet`，与现有 IPv4 来源限制配套。外网的 alpha 入口交由 Origin 的代理规则解析，不要拿外网的 `-6` 结果推断家中 IPv6 是否获准。未经授权不扩大 sshd 来源名单。
5. 确认目标、来源、账号正确后，再检查既有磁盘钥匙是否被提供、是否被服务端接受，以及是否实际配置了 SSH agent。已有磁盘钥匙可用时不需要 1Password；只有配置和日志证明依赖该 agent，才检查它的授权。新机器确实没登记公钥时才进入首次接入流程。
