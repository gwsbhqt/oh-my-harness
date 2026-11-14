# dsh-runtime

DSH 启动即生效的无界面宿主钩子，一个包、一条 loader 条目（id / 设置命名空间都是 `runtime`），做两件互不耦合的事：

1. **登录环境**：DSH 启动时按系统账户登记的登录 shell（`os.userInfo().shell`）跑一次 `-l -c 'env -0'`，把结果补进宿主的 `process.env`，并让启动快照的继承层先看这份。目标是「和从终端里启动 DSH 一样」，与启动方给了什么无关。
2. **顺链接写 + 归一化**：DSH 保存文件时，若临时文件顶替的是软链接，就改名到链接最终指向的文件。落盘前，命中 `cordis.patch.*.yml` 的内容做行级归一化。

## 登录环境

- 探测时只给 shell 最基础的 HOME、USER、LOGNAME、SHELL、TMPDIR 和系统默认 PATH，让它的配置从零算；不要改成继承 `process.env`，否则结果又跟着启动方走。
- 例外是 launchd 用户会话里的代理变量（`launchctl getenv`）：终端里的登录 shell 本来就继承它们，本机的代理只登记在那里（fish 配置只设 `NO_PROXY`）。不交给 shell 的话宿主直连，Codex 超时、Claude 回 403（2026-09-30 踩中）。shell 自己的配置仍可覆盖。
- 不动：`PWD`、`OLDPWD`、`SHLVL`、`_`，以及 `DSH_*`、`ELECTRON_*`（宿主要靠 `ELECTRON_RUN_AS_NODE` 以 Node 方式运行）。
- 宿主代理：按登录 shell 的代理变量（再加 `~/.dsh/.env`）经宿主那一份 `dsh-http-proxy` 重装；启动方给的代理名先删掉。必须经 `ctx.loader.internal.import` 引入，插件自己 node_modules 里的副本状态不共享。Magpie 网关的远端出口由 Magpie 管理。
- 其他插件不要再自己问登录 shell 或另配 PATH（dsh-python-repl 原有的那套已删），缺环境就修这里。
- 读失败（找不到 shell、超时、输出没有标记）只记一条警告，环境保持原样，不拦启动。

## 顺链接写与归一化

- 保存路径：`@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` 写 `<目标>.<随机串>.tmp`；插件加载器保存 profile 用 `<目标>.tmp` 或隐藏名 `.<目标>.<进程号>.<序号>.tmp`，两种都认。包住 `node:fs/promises` 的 `rename`，只在「同目录的 `.tmp` 顶替链接」时把目标改到链接最终指向的文件。
- 归一化规则**只由本插件维护**（原先还有 git 的 `dsh-volatile` 过滤器分担同一套规则，已移除）：去多余引号、行内数组去内边距、还原 `\U` emoji 转义；逐行处理、保留注释与 `!!js` 标签、幂等，块标量内容不动。改规则只改这里。
- **取舍**：移除提交兜底后，只有经过本插件 `rename` 包装的 DSH 保存才会归一化。插件加载前发生的保存、以及手动编辑后直接提交的文件都不处理（用户接受此取舍）。漏掉时链接可能被换成真文件，dotfiles 的链接工具下次运行会报冲突。
- 归一化出错一律回退原样，绝不影响保存本身。

## 验证

在本目录独立安装依赖后运行 `pnpm run check`（typecheck + build + 单测）。真实效果看宿主进程：`ps eww -o command= -p <host pid>` 看 PATH，再在会话里让命令工具跑 `command -v node`；保存验证看 `.credentials.yaml` 这类链接在 DSH 保存后仍是链接、内容落进带后缀的真文件。
