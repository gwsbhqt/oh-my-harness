# dsh-grep-scope

DSH 的官方 `dsh-tool-fs-search` 同时提供 `glob` 和 `grep`。本插件不禁用它，也不修改安装包，而是在每个 Agent 自身的工具层注册同名 `grep` 和 `glob`，遮蔽预设继承的官方版本。使用宿主的工具注册表、子进程、ripgrep 输出解析、搜索结果卡片和大结果保存接口。

`glob` 不是重写的：调用宿主导出的 `applyGlobTool`，给它一个转接用的上下文，拿到一份和官方一模一样的 glob（列表、排序、卡片、超过 100 条时保存完整列表都是宿主的），只在启动 ripgrep 前往参数里加排除规则、把打包文件里的路径换成副本。这样做是因为宿主的前置钩子只能放行或拒绝，不能改参数。采样开关按预设写死为 `sampleOverCapGlobResults: false`，预设改了要跟着改 `src/glob.ts` 的 `GLOB_CAPS`。

`grep` 输入保留官方的 `pattern` / `path` / `include`，增加可选 `scope`：

- `normal`（默认）：尊重忽略规则、不自动搜索隐藏目录；默认范围不能用于证明全库不存在。
- `all`：包括隐藏和被忽略路径，排除 `.git`、`.hg`、`.svn`、`.jj` 的元数据；请优先指定目录和文件类型，避免扫描依赖和缓存。

空结果和原生搜索结果都标出搜索范围。完整搜索返回官方兼容的 `{matches}`；仅当 ripgrep 退出码 2、原始 stdout 完整、stderr 完整且每行都是可验证的路径 IO 错误时，保留已搜到的匹配并返回 `unreadable: [{path, error}]`，文本明确写出不完整。`matches: []` 加 `unreadable` 只代表可读部分没有匹配，不能证明全域为零。诊断丢失、未知或歧义诊断、正则错误、取消与超时仍失败；不重跑搜索。可选 `unreadableIncomplete` 仅为已有消费者保留兼容，本插件不会用它放行 stderr 丢失。调用方必须根据自己传入的 `scope` 判断覆盖范围，不能由返回值猜测。根路径错误仍失败。宿主支持部分结果后，删除 `runScopedSearch` 捕获子进程的兼容层。超过默认 250 条的内容与原版一样只显示前部，能保存完整格式化列表时给出引用；PTC 保留可读范围内的完整匹配列表，底层原始 ripgrep 输出有官方 20 MB 限额，插件在 10 MB 处提前停并标明不完整，见下一节。

## 默认跳过依赖目录，输出太多就提前停

宿主的 20 MB 原始输出上限（`RAW_OUTPUT_MAX_BYTES`）和 30 秒工具时限（`SEARCH_TIMEOUT_MS`）都在宿主 `dsh-tool-fs-search` 里，插件改不了。在一个大型代码仓库里实测：全量 glob 输出 34 MB、23 万个文件、14 秒，其中 32 MB 来自 `node_modules`、`site-packages`、`.venv`；`scope: all` grep `error` 原始输出 127 MB，grep 一个常见词只有 95 KB 却要 18 秒，时间全花在走依赖目录上。

所以 `grep`（两种 scope）和 `glob` 默认不进这些目录：`node_modules`、`.venv`、`site-packages`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.tox`（`src/skip.ts`）。排除后同样三次搜索分别是 1.9 MB、5.1 MB 和 1.5 秒。`path`、`include`（glob 是 `pattern`）里只要出现其中一个名字，这次就一个都不跳过；路径在打包文件、它的副本或 `.asar.unpacked` 里时也不跳过，因为那里面大部分就是 `node_modules`。跳过时 grep 返回值带 `skippedDirectories`，文字结果和 glob 列表末尾都写明跳过了什么、怎么搜进去。

grep 一边跑一边看 ripgrep 已经输出了多少，过了 10 MB（宿主上限的一半）就停掉它，把已经完整输出的匹配交回来，返回值带 `outputCapped: true`，文字结果开头写「Incomplete」、列出命中最多的几个目录，让模型缩小范围。宿主上限先被冲破时（只剩尾部）也一样交回尾部的完整记录，并去掉开头那条被截断的。这不是完整结果，文字和返回值都说明了。超时仍然是宿主报错，插件拿不到半截结果。glob 不做提前停：宿主用 `--sort=modified`，要全部走完才会输出，停了也省不了时间；跳过依赖目录后整个仓库只有 1.9 MB。

## 长行在搜的时候就截短

官方 `grep` 用 ripgrep 的 JSON 输出，每处匹配都把整行原样带回来，原生结果再截到每行 2000 字节显示。一行很长的文件（压缩过的 JS、单行 JSON 缓存）能把原始输出撑过 20 MB，整次搜索直接报错，模型也看不出该缩小什么。在一个大型仓库里用 `scope: all` 搜索时：一个 2.6 MB 的单行插件缓存，加上各家助手的会话记录，原始输出 33 MB，连着两个会话都卡在这里。

所以本插件改用 ripgrep 的纯文本输出，让 ripgrep 自己把每行截到 2000 字节（`--max-columns`），再按字节截一次，防止中文超出。同一次搜索，原始输出从 33 MB 降到约 1 MB，在本机 20 秒内返回 1122 处匹配。被截的行以 `(line truncated)` 结尾，返回值带 `clippedLines: true`，文字结果开头也会写明。要看整行就去读文件。文件名按 NUL 分隔，文件名里的换行不会被当成结果换行。只搜一遍、不先试 JSON 再重搜，是因为工具总时限只有 30 秒，搜两遍会超时。

和 JSON 输出的差别：直接把一个二进制文件当 `path` 搜时，原版会返回里面的匹配行，这里不返回（ripgrep 纯文本模式只说「二进制文件有匹配」，这一行没有文件名分隔符，被跳过）。搜目录时两者一样，都跳过二进制文件。不是 UTF-8 的行，原版显示成 `(line is not valid UTF-8)`，这里按原字节解码。

## 搜 app.asar 里面

DSH 的系统提示让模型去 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/` 看实现代码，但 `app.asar` 是 Electron 的打包文件，ripgrep 进不去。现在 `grep` 的 `path` 只要落在某个 `.asar` 文件里面（或就是它本身后面带 `/`），就这样搜：

1. 读打包文件的目录表，把里面打包的文件原样解到 `$DSH_HOME/plugins/grep-scope/asar/<路径哈希>-<文件大小>-<修改时间>/`，文件设成只读。只读打包文件，不碰 `app.asar` 本身。解到临时目录里，解完整再改名成正式目录，所以中途被打断不会留下半份缓存。
2. 用 ripgrep 同时搜这份副本和旁边的 `app.asar.unpacked`（打包时被拆出来放在外面的文件，比如二进制和 `pako`），各自只搜内部路径确实存在的那边。
3. 结果里的副本路径改回 `app.asar/...`；unpacked 的文件本来就是真实路径，显示成 `app.asar.unpacked/...`。返回值多一个 `asar: {archive, copy}`，文字结果开头说明映射关系。宿主的 `read` 读不了 `app.asar/...` 路径，要看全文就把前缀换成 `copy` 读副本。
4. App 更新后大小或修改时间变了，第一次搜索会解一份新的，并删掉同一个打包文件的旧副本；同时发起的几次搜索只解一次。

宿主的 `read` 和 `glob` 也进不去打包文件：`read` 报「Cannot mix BigInt and other types」，`glob` 报「Not a directory」，模型看不出原因（读取会失败）。`glob` 已由本插件接管，路径在打包文件里时直接列副本和 `app.asar.unpacked`，返回的路径能直接读。`read` 仍是宿主的，宿主的前置钩子不能改参数，所以在 `tools/pre-execute` 里拦下，拒绝原因直接写出同一个文件在副本或 `app.asar.unpacked` 里的路径，模型照着再调一次就行；里面没有这个路径时说「路径不存在」。名字叫 `.asar` 但不是打包文件、或者路径就是打包文件本身时不拦，照旧交给宿主。宿主的 `read` 支持进打包文件后删掉这个钩子。

App 更新后旧副本会被删掉，模型手里还拿着旧副本路径（曾遇到 grep 指向已删除的副本目录）。`grep`、`glob` 碰到旧副本路径时自动换成同一个打包文件的当前副本；`read` 被拦下，拒绝原因写出当前副本里的同一路径。缓存被整个删掉时，只有当前 App 自己的 `app.asar` 能按需重建。Python 内核里直接 `Path.read_text` 读打包文件里的路径不经过 DSH 工具，本插件管不到。

实测（`app.asar` 约 121 MB，12973 个文件，其中 1493 个在 unpacked）：首次解包在 App 自带的 Electron 里约 2.4 秒、系统 node 里约 1.3 秒，副本 142 MB、11480 个文件；之后搜整个 `dsh/` 约 1 秒，不再解包。缓存不自动过期，想腾地方直接删 `$DSH_HOME/plugins/grep-scope/asar/`。

- 搜副本时加了 `--no-ignore-parent` 等参数：`$DSH_HOME` 本身可能在某个 git 仓库里（可能整个被忽略），不加会什么都搜不到。打包文件内部没有 `.gitignore`，`scope: normal` 和 `all` 的差别只剩隐藏文件。
- 文件名叫 `.asar` 但不是打包文件时报错说明，不当成空目录；内部路径用 `..` 跳出打包文件的不当作打包路径。
- 打包文件里的符号链接条目不解出（当前 App 里没有）。
- 列打包文件里的目录时，副本和 `app.asar.unpacked` 各跑一次宿主 glob 再拼起来，所以修改时间排序只在各自内部成立。

## 修改和验证

修改后先跑 `pnpm run check`。DSH 内部会话再跑 `await tools.doctor({})`；外部 agent 跑 `dsh-use doctor`。失败就继续修到全部通过，不许让用户重启碰运气。pnpm 没有 `install --dry-run`，不要再用它当验证。`test/asar.test.ts` 最后一条用本机真实的 `app.asar` 搜 `old_string was not found in`，App 不在就跳过；跑它会在临时目录解一份约 140 MB 的副本，结束删掉。Desktop 当前进程是否重新装载、真实 GUI 中 PTC 工具是否替换，必须另外验；不要把静态组合与单测误报成当前桌面已生效。
