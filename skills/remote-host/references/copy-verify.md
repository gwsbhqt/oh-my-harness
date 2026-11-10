# Copy and verify

有 Python 内核的 agent 必须直接用 `skills.remote_host`；先读 [Python 接口](python.md)。本页的 remote-host 命令行示例仅供无内核传统 agent，统一入口见 [CLI 参考](cli.md)。

## Copy and verify

```bash
remote-host copy beta:'~/Library/Containers/com.tencent.xinWeChat' alpha:'~/Library/Containers/'
remote-host copy worker:'~/data' ./backup          # either end may be this machine
remote-host verify beta:'~/project/x' alpha:'~/project/x'
remote-host manifest alpha:'~/x' [--quick] [--full]
```

`copy SRC DST` puts SRC **into** the directory DST:

- streams `tar` (zstd when both ends have it) — nothing is written on the way, so a nearly full source disk is fine
- keeps holes in sparse files (a 246 GB VM image with 12 GB of data stays 12 GB) and, Mac to Mac, extended attributes; Mac to Linux it drops them instead of creating `._name` files
- unpacks into a unique `DST/.remote-host-incoming-<uuid>-<name>`, **verifies**, and only then moves it into place; a failure leaves the staging for inspection and the target untouched
- refuses an existing target; `--replace` moves the old one aside as `<name>.remote-host-old-<timestamp>` rather than deleting it; target placement takes a per-target lock, refuses dangling symlinks without `--replace`, and stops when backup fails
- prints progress every `--every` seconds (0 to silence); `--no-verify` / `--quick` trade certainty for time

## 安全编辑单个文件

`remote-host get REMOTE [LOCAL]` 与 `remote-host put LOCAL [REMOTE]` 只接受单个普通文件。目录源、断开的链接和硬链接目标明确拒绝；复制树请使用 `remote-host copy`。需要两端都有 `python3`，不降级回直接覆盖的 scp。

源端先完整下载到本机私有临时文件并确认传输成功（需单文件大小的本机临时空间），再写真实目标同目录的唯一临时文件，再核对 SHA-256，最后原子替换。目的地是软链接（例如由配置管理器创建的链接）时保留链接，更新它指向的普通文件。传输前后核对真实目标及链接链，变化就拒绝落位。失败不会覆盖原文件。目的地目录仍按原语义使用源文件名，不自动下载整棵树。

编辑前后的并发保护可加 `--expect-sha256 HASH`：仅当现有目标内容仍是该 hash 时允许替换。例如先记录原文件 hash，编辑后 `remote-host put ./config '~/.config/config' --expect-sha256 <原hash>`。不带该字段时，也会拒绝传输过程中目标变化，但不能识别 get 到 put 之间其他人的编辑。保留原文件模式及所有者、组；扩展属性一并保留并纳入变化检查；目标存在特殊 ACL 时明确拒绝，不丢弃后继续成功。新文件使用私有临时文件模式。原 inode 不保留；硬链接目标拒绝。

Between two remote hosts the data is relayed through this machine — it always works, at the cost of one extra LAN hop.

`verify`/`manifest` compare **every file's SHA-256 and size, the directory tree and symlink targets**, relative to each root (sockets and fifos — git's `fsmonitor--daemon.ipc` — are runtime handles that tar cannot carry, so both leave them out; tar's `cannot archive sockets` warning is expected); the report names what is missing, extra or different. Hashing reads everything, so budget time for large trees (`--quick`: sizes only). Needs `python3` on the host — a brand-new Mac gets it with the Command Line Tools.
