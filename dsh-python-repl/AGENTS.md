# dsh-python-repl 开发约束

## 阅读与状态

开发入口、配置和运行边界见 README.md；本文件记录维护约束。

**核心已实现并有测试覆盖**，`pnpm run check` 一把跑完（不在文档里写测试条数——写死就会过期；判成败看退出码，别套 `| tail`，管道会吞掉它）。

- 基础渐进披露已实现：六工具完整契约、其他工具摘要、详情按需；可信技能启动前静态发现，只声明配置与发现，不冒充加载。加载、内核及安全恢复状态放动态上下文；自动排名未实现。
- 2026-09-22真实GUI探索已验证持久执行、单个子代理返回及图片上下文。2026-11-03 在真实 DSH 会话里验过：一格内同时开 3 个子代理（各自进程、运行时间重叠、变量互不影响）、代码里提问并等待回答、计划审批（退回带意见、批准返回 approved）、真实 MCP 调用与失败报错；多 Agent 并发时的提示组装未单独验。快照恢复 2026-10-15 在真实 DSH 里验过。历史已挂载不等于当前进程已载入最新构建。
- 设置为 0.1.7 的 volatile 模型：Config 全字段 volatile，loader 原地提交不重启插件；GUI 入口是 client 半自注册的插件页配置卡片（`src/client/settings.tsx`——0.1.7 没有自动生成表单这回事）。变更只影响新会话内核，不自动重启已有内核。工具桥等待上限默认0，沿用DSH生命周期；显式超时不代表外部动作已取消，不自动重放。

## 开工审查修订

按DSH热路径采用read/write/edit/bash/glob/grep六个固定顶层工具，完整契约常驻且不占动态名额；Python 直接写文件不提醒不拦（用户 2026-11-05 定），交付仍要 `present`。默认首次run_code懒启动、用户格前预导入可信技能（内核前静态扫描明确配置根，不执行Python；首次导入结果与恢复状态通过动态上下文说明）。P0交付独立测试进程/HOME/profile/端口与回滚方案，未授权不动日常宿主或复制凭据。P3先落实缩减展示、变量复用、部分失败和present义务；自动披露第二段由数据决定是否实施。vendor默认冻结。ToolCallError不编造retryable/幂等保证。

**Python 下限 ≥ 3.11**，和 Prime 内核一致，启动时断言版本。默认 `3.14`：写成版本号就是 uv 管理的 Python，缺了首次用到时 `uv python install`；和 Prime 一样把内核放在 `dill` 能完整快照的版本上（`dill` 0.4.1 在 3.15 上存不了函数和类）。配置里写的是裸名字时按 DSH 的 PATH 找；登录 shell 的环境由 `host launch environment` 统一补进宿主，本插件不再自己问 shell、也不给内核另配 PATH。不内置任何猜测的安装位置。不达标时立即失败，报错写出试过什么和怎么修（裸名字提示先在终端确认再重启 DSH）。P0的隔离交付物含Python侧：记录解释器/venv/sys.path，负向断言 `import rlm` 不会解析到本机全局Prime。取消必须以 `CancelledError`（BaseException子类）到达Python，**绝不包装成 `ToolCallError`**，否则用户的 `except ToolCallError` 会吞掉取消继续跑。依据见技术方案 §8.4、§10.2.1、§10.2.2。

## 重复代码提醒

`python/habits.py` 的阈值是在真实会话上校准出来的。改阈值或改特征定义必须用 `scripts/habits/` 重跑校准、以 `evaluate.py exact` 的全量准确率定参，并同步更新 `habits.Policy` 注释里的校准结果。校准数据是会话原文，只放 `~/.cache/dsh-python-repl/habits/`，不进仓库。

## 不改变的方向

- 做薄桥：官方 run_code/PTC + vendor Prime 核心 REPL + DSH 外部能力。
- 模型写持久 Python 代码格，支持顶层 await、末表达式展示；不提供顶层 return，不做 AST return 仿真。
- 能力目录方案（CAPABILITY-DISCOVERY）取代全部顶层化。read/write/edit/bash/glob/grep 六个固定工具顶层直达；其他 DSH 工具在 tools，技能在 skills。MCP 工具由 dsh-mcp-client 注册成普通工具，按注册名留在 tools 里；它不提供「服务 → 工具」的对应关系，拆名字只能靠猜，所以不设按服务分组的 mcp 命名空间。
- tools/skills 同构提供异步 list/describe。特殊/元方法冲突名字用索引；无顶层 call_tool。
- 技能启动时预导入，不提供 skills.load；tools/skills 摘要常驻提示，完整签名/说明按需 describe。元查询不是权限授予，业务只用本格 PTC binding。
- 命名空间不同可以同名（skills.read 与顶层 read）；同 importName 技能仍拒绝冲突，其他正常技能继续。内部桥名字不能自动覆盖，元方法冲突可用索引访问。
- 保留 Python 内建、asyncio、最近非 None 结果 `_` 和真实 ToolCallError；内部状态不公开。MCP 层级必须有可靠宿主映射，不拆工具名猜测。
- 产品按能力命名 dsh-python-repl；Prime 仅作为核心代码和设计来源，继续保留 vendor/prime、许可证、来源清单与补丁记录。
- Python skills 来自明确配置的可信目录（`skillRoots`），加上会话所在仓库里的 `projectSkillRoots`（默认 `.agents/skills`，和 Prime、宿主技能列表同一个位置；仓库根取最近的 `.git` 祖先，子模块算自己的仓库）。同名时仓库里的优先，被盖掉的全局技能写进发现问题、不导入。清单在会话第一次建内核时按当时目录固定。按真实 Prime 技能格式扫描、检查和加载。不保证完整 Prime 技能兼容，不建设完整 rlm 兼容层。
- 技能只在宿主发现一次（`src/skill-discovery.ts`，导入名规则同 Prime），结果交给内核导入，也通过 `pythonSkills` 服务（`list(cwd)` 带上那个项目的技能）给 skill settings provider 的设置页；别处不再自己扫目录。
- 标准 `SKILL.md` 保留技能身份和命令行说明；有 Python 源码的技能优先选择 `PYSKILL.md`，仅该文件不存在才使用标准说明。Python 说明必须有非空 description，若声明 name 必须与标准身份一致；读取、解码、格式和身份错误保留为 unavailable 记录，不能导入或静默回退。自有技能两版只允许调用示例不同，元数据、描述、章节和其余正文同构。
- Python 初始目录、list、describe 与工具桥共用发现记录里的 `instructions_file`，正文仍按需读取。选定文件后读取失败就报错，不重新扫描或换版；文件布局变动需要新的会话发现记录。
- 工具桥只在本格原 `skill` 调用成功后，按 name 与真实 directory resourceBase 匹配配置目录再替换返回正文，保留原权限、暴露和原始审计。普通技能目录及显式 `/技能` 仍读标准说明，不根据插件全局开启猜语言，不另加宿主私有注册表补丁。
- 内核不是项目的运行环境（Prime 的使用规则）：分析用的库用 `repl.install` 装进内核，项目自己的代码和依赖走项目环境（`uv run`、项目的 `.venv`）。
- 不把 Prime 的原生 bash/MCP/子代理与 DSH 对应能力同时作为默认模型入口。
- 宿主下限 0.2.2-rc.1（三台机器 2026-11-05 都已升级，同伴依赖写 `>=0.2.2-rc.1`）：不再给 0.2.1 留退路（提示词钩子改写 run_code 说明、`sdkSchemas`、`dsh-tools` 里找 `renderToolsSdkPy`、没有管线或进度栏时的分支都已删）。
- 不用 DSH 工作流，不留 TypeScript 运行时（用户 2026-11-04 定：Python 代码格里已能派子代理）。官方 `dsh-workflow-ptc` 一加载就要求 TypeScript 运行时，所以 Host 层的 `workflow-ptc`、`tool-workflow` 在本插件 `cordis.patch.yml` 里关掉；模式里 delegation 组的那两条补丁层够不着，由 `src/preset-workflow.ts` 在模式注册表的记录上关掉并按宿主方式重新挂载（和官方 PTC 模式写法一样；与模式插件分别登记关闭原因，最后一方退出时还原）。依赖注册表内部成员 `definitions`、`activate`、`collect`，DSH 改了它们就不改写，创造、标准模式会加载失败。

## 常用快捷区

- 六基础工具之外，三类共享最多10个重点披露位置，不足不填满。按使用老化LFU、同分按最近使用；不用DSH不衰减，100格/7天窗口均已被替代，具体老化参数待定。
- 同能力每格最多计一次；元查询与六基础工具不参与。DSH/MCP观测注册工具入口；技能只观测明确公共入口并按模块汇总，不追踪任意内部函数。
- 最新基线取消自动顶层别名：只提升常用接口说明，稳定命名空间不变；Agent自己的别名是普通变量。清单只在冷边界（会话开始、恢复、压缩后）且内容真变了才换，不在格间更新：它在系统提示的 tools:sdk 段里，改一个字就让整段提示词前缀缓存作废（Prime 的长期内容也只在冷边界送）；不额外唤醒模型。
- 当前DSH配置环境内个人级共享统计，区分真实来源并过滤当前可见能力；只排名Agent直接选择入口，技能内部工具/嵌套入口不重复竞争。不支持可靠观测的技能正常使用但统计不完整，不做全Python追踪。
- 先实现核心桥、目录、最小repl和轻量记录，再用真实任务数据做自动披露；关闭优化不影响核心。详见能力设计§10。

## REPL 环境感知

- CAPABILITY-DISCOVERY §11 为环境感知契约：repl.info/list/describe读取真实内核状态，与能力目录分开；repl为系统保留入口，不参加快捷统计。
- 格边界检查新增/删除/重绑，错误与取消也刷新；不把原地对象变化或模块identity当作源码/值完整追踪。默认不执行任意repr、property或动态属性获取。
- 自动提示关键覆盖/丢失，普通变量按需查看，不全量倾倒globals；状态与快捷区共享真实绑定记录。
- 修改普通状态用Python，桥绑定恢复须显式；接口repl.restore_binding已接入并测试，不暗含reload/restart/数据回滚。修复repl自身和卡死中断必须有宿主路径，不依赖排队Python调用。

## 不变量

- 每个会话独立内核；缺调用身份时拒绝，不退到公共内核。
- 内核跟着会话的工作目录走（宿主 `workingDirectory`，0.2.1 起会话能中途 cd）：每格开跑前对齐，只在 DSH 那边变了才切，格里自己 `os.chdir` 的保留到下次变化；切不进去就让这一格失败，不在和文件工具不同的目录里跑。
- 精确 live Agent、每格 run id、有效绑定缺一不可；旧异步任务不得借用下一格权限。
- 持久函数可以再次调用；它引用的工具代理按当前有效调用上下文解析，不能永久捕获创建函数那一格的 bindings。
- 格结束/失败/取消撤销的是DSH桥授权，不是Python副作用能力。和 Prime 一样，格里建的 asyncio 任务格结束后照常运行，但再调 DSH 工具会被拒；它们打印的内容和裸 fd 输出一样，攒到下一格以 `[background output (unattributed)]` 给出（上限 64 Ki 字符）。没人接收的任务失败在格末报一次。只有内核答不上格末请求（事件循环被同步卡住）才换内核。取消照 Prime：中断后等 1 秒就返回「已取消」，内核和变量不动；格没停下的话，下一格到来时每 0.5 秒再中断，过了 `interruptGraceMs` 还不停才强杀换内核（新内核从快照恢复）。线程/外部进程/已发生副作用不保证被取消或回滚，绝不自动重放。
- 内核自成进程组，格里开的程序默认留在组里，跟着内核一起结束：会话关闭、内核重启、内核自己死掉时，宿主先 SIGTERM 整组、1 秒后 SIGKILL；宿主被强杀时只剩内核看门狗，它只发 SIGTERM。要长期跑的走 bash 后台任务；`start_new_session=True` 是显式脱离，之后归调用者自己管。
- 程序中的完整值、模型展示文本、持久日志分开；Prime repr 不冒充原始 JSON。工具结果里嵌套的字典和列表也包成可点号访问的视图（`r.stdout.text`、`rd.lines[0].text`），底层仍是 dict/list，下标、`isinstance` 和 `json.dumps` 不变。
- 宿主往内核发的内部代码（同步工具、格末收尾、快照、恢复、取消、闲置检查）一律写成 `__import__("模块").函数(...)`，不在 `__main__` 落 `_b`、`_j` 这类名字：以前会盖掉用户自己的同名变量（2026-11-04 复现）。Prime 快照本来跳过单下划线开头的名字，现在 `python/snapshot_refs.py` 包住 Prime 的 `_snapshot_state`/`_restore_state`，存时临时改名为 `dsh_user_<名字>`、恢复时改回，用户的 `_x` 也能跨内核恢复；vendor 未改，升级 Prime 时先核对这两个函数名和签名。引用 `skills` 的函数存快照时，`skills` 命名空间只按引用存、恢复时取新内核的那个，不把技能模块的内部状态一起存下（9f8a120）。
- 用户停掉的格子在会话里显示「已停止」不是「失败」（`src/client/model.ts`）：宿主报 `ABORTED`/`ABORTED_BEFORE_DISPATCH`/`AbortError`；0.2.1 时期记下的会话只有 `CODE_RUN_FAILED` + 文本前缀，这条判断留着给那些历史记录用，不是给旧宿主。`repl.describe("repl")`、`repl.describe("tools")` 列出公开方法及说明首行。只有说明文字、没有 Python 入口的技能，写 `skills.<名字>` 时报错提示改用 `await tools.skill({"name": ...})`。
- 格子报错（`python/cell_errors.py`，接在 Prime 的 `_error_event` 外面，不改 vendor）：模型自己代码（`<cell-N>`，含格里定义的函数）的调用位置全留；别处的折成一行「N frames inside … not shown」；库或技能里非业务错误保留抛出的那一层；工具失败和技能自己的错误类算业务错误，一层不留；末尾那句重复的错误说明去掉（宿主已在开头写过）。常见工具失败补一句可照做的话，宿主说明里已有建议就不补。依据：2026-11-03 真实会话中技能报错平均 2218 字符，84% 是内部调用位置。
- subprocess 提醒在内核按语法树判断真实调用（`python/detours.py`），字符串里出现的不算。用 Python 的 `open()`/`write_text` 写文件不提醒、也不拦（用户 2026-11-05 定：怎么写都行，沙箱也全关了），给模型的说明里也不再劝它改用 `write`/`edit`；只保留「做好的文件要 `present`」这条交付要求。「手写改文件」（读出来、替换、写回）那条是 `habits.py` 的重复代码提醒，另算。宿主 `usageHint` 只管给 `repl` 赋值这一条。循环里 sleep 的格子提醒「结束这一轮等通知」。
- 格里不死等（`cellWaitMs`，默认 5000，依据 2026-11-03 真实会话中 3.6 万次内核 bash：95% 在 5 秒内完成）：宿主给前台 bash 加 `timeoutMs` 上限，只在 DSH 到点转后台（参数说明含「moves to the background」）时加，到点杀命令的配置不动；`job_output` 的 `wait` 同样封顶；内核里 `await job` 到点抛 `JobStillRunning`（`TimeoutError` 子类）。DSH 的任务插件默认在任务结束时唤醒空闲的 agent，所以等待交给通知，不在格里等。
- 单格超时（`maxCellTimeoutMs`，默认一天）：运行时声明 `timeout`（默认值和上限都是它），官方执行器于是给 `run_code` 开 `timeoutMs` 参数，比上限大的按上限，`null`（工作流适配器）不设截止。到点走和中断完全相同的取消路径（收回授权、`CancelledError` 到 Python、1 秒后返回、内核和变量不动、不回滚不重放），只是结果种类报 `timeout` 并说明内核还在；格不停下的照旧由下一格按 `interruptGraceMs` 处理。和 `cellWaitMs` 互不相干：后者只限格里单个 bash 或任务的等待。2026-11-04 真实会话验过：3 秒超时的格收到 `CancelledError`，内核没换、变量还在。
- 每格经桥的工具调用由宿主记下（`src/cell-trace.ts`，目录查询不算）：格失败或被取消时报错末尾列出调用（最近 10 条，其余汇总，标出最后成功的一个，注明已完成的不撤销）；内核补一句从第几行起没执行、哪些定义因此不存在或仍是旧值。格末提醒：扣掉工具等待后 Python 本身超过 60 秒。
- 单格输出照 Prime 在宿主侧按格限量（`maxCellOutputTokens`，估算 token）：超出只给首尾，全文交 DSH 的 `spillStore` 存；没挂存储或存失败就原样返回，不另造存储、不藏模型拿不回的内容。截断时宿主把「被截断」传给格末收尾，内核（`python/output_notes.py`）说明 `_` 是这一格的值还是之前的（按对象身份比），只描述精确内置类型的类型、长度和前几个键，不调用户代码。没截断但超过 4000 token 的格给一句软提醒，每 10 格最多一次。
- 工具失败的下一步（`python/cell_errors.py`，内核在 `call_tool` 外把参数挂到 `ToolCallError` 上）：读不到文件给同目录相近名字或最深的存在目录；edit 找不到原文时在 2 MB 内的文件里找最相近的一段（相似度 60% 以上才给，最多显示 12 行）；offset 越界给总行数。`skills.<名字>` 不存在时给退役名的新名字或相近拼写。
- bash 默认可并行（`src/bash-jobs.ts`）：DSH 只让声明「并行安全」的工具同时跑，bash 没声明，一律独占。所以格里的前台 bash 由宿主改成「后台任务 + 宿主直接等它」：经 DSH 的 bash 工具以 `run_in_background` 启动（审批、沙箱照旧），再用 DSH 的 `jobs` 服务 `wait`，结束就按 DSH 前台 bash 的结果形状还原（stdout/stderr 按输出块的 channel 分开、退出码和附注从 detail 读）并 `remove` 掉记录，和 DSH 前台 bash 内部的做法一样。`await bash; await bash` 串行，`gather` 并行（实测三条 1 秒命令 1.0 秒对 3.1 秒）。到 `cellWaitMs` 还没完就交回 DSH 的 `promoted` 收据，内核里这个结果本身可 `await`/`peek`/`kill`；格被取消时宿主停掉命令。拿不到 `jobs` 服务或 bash 不能起后台任务时退回原来的前台调用。`bash.start` 是 `run_in_background=True` 的旧写法，说明里不再教。
- 后台任务结束通知由本插件合并发（`JobNotices`）：宿主一直 `wait` 着转后台的任务，DSH 的 tool-jobs 见到有人在等就不发单条通知；2 秒内结束的合成一条，空闲时叫醒、忙时排进下一步。`job_output` 读到已结束、或模型 `job_kill` 过的任务不再通知。依据：DSH 只在任务结束那一刻有人等着时跳过通知，实测 38 条在格里取走结果的后台命令一条通知都没有。
- 长计算转后台走显式的 `repl.background(work)`（`python/background.py`），不做「一格跑久了自动转后台」：Prime 内核一次只处理一个请求，正在跑的格子转去后台会让后面所有格子排在它后面。`repl.background` 把协程建成 asyncio 任务（普通函数放线程），这一格立刻结束；内核经 `host_request` 的 `background` 类请求让宿主在 DSH 的 `jobs` 服务登记 `kind: 'python'` 的任务，跑完报回结果（写进任务输出）并结掉任务，结束通知走 `JobNotices` 合并。`job_kill` 让宿主在内核里取消任务（线程里的函数停不了，如实说明）；内核换掉时没跑完的一律记为失败。格子结束后，后台任务仍能调起它那一格有的工具（`src/background-tools.ts`）：内核给任务里的调用带上任务编号，宿主见到任务还在（不管原格结束没有），就经 DSH 0.2.2 起公开的 `@deepseek-ai/dsh-tools/pipeline`（`ToolExecutionPipeline` 的 prepare → dispatch → complete）在任务主人 agent 的范围里发起，pre-execute 钩子、审批、守卫、工具自己的沙箱、post-execute 和 `tools/result` 都照常；DSH 标成独占的调用在本会话内一个个来。范围只有原格的工具名，任务结束、被 `job_kill`、内核换掉或会话关闭时收回，在途调用被取消、以 `CancelledError` 到 Python。每次调用记进任务输出（`[tool] bash ok`）并算进原格在内核页的工具次数；不经 PTC 执行器，所以会话里没有 `tool/ptc-dispatch` 记录。管线要在声明了 `tools` 依赖的插件上下文里建（`ctx.inject(['tools'], …)`），否则 cordis 拒读。加载结果按工具注册表缓存（`sharedPipeline`），加载失败当场记一条 warn，不会因为没有后台任务去等它而变成未处理的拒绝；真去调用的任务照样拿到原因。任务里 `repl.progress(text)`（`python/background.py`）两边都写（每行最多 500 字符）：DSH 任务的进度栏（`JobHandle.updateProgress`，只存最新一条，任务运行中 `job_output` 的状态里显示它），同时往任务输出追加一行 `[progress] …` 留下每一步。只写进度栏时前面几步看不到，2026-11-05 实测运行中任务输出为空；它不用 await（返回值可 await，写了也不错），线程里的普通函数也能调，靠记下的内核事件循环转过去；在普通格子里调直接报错让模型改用 print。格后调用拿到的图片（每个任务最多 8 张，多的只计数）记在任务名下，任务结束时随合并通知那条消息带回对话；模型已经用 `job_output` 读过结束、不再发通知的，单独发一条不叫醒的消息只带图片（`JobNotices.attach`）。工具的 post-execute 钩子附加的其他上下文也一样随通知带回。加载 `@deepseek-ai/dsh-tools/pipeline` 失败一律带原因报出来。原格还在跑时任务发的调用也走任务授权：走原格的 PTC 通道的话，格结束时宿主清掉这一格的待回复调用，格结束后才返回的结果被丢掉，任务永远停在运行中（2026-11-06 evolve I-074，`repl.background(tools.doctor({}))` 等了 13 分钟）。格子自己的调用照旧走 PTC 执行器，图片照官方附到下一步。普通函数返回协程时任务明确失败并提示直接传协程或异步函数，不能把没执行的协程当作完成。普通 asyncio 任务（没经 `repl.background`）格后照旧被拒。2026-11-04 在真实会话验过：格子结束 3 秒后任务调 bash、read 成功，任务结束后留下的协程再调被拒。`await job` 同样受 `cellWaitMs` 限制。
- `repl.agent(prompt, schema=, model=, provider=)`（`python/agents.py`、`src/agent-runs.ts`）在 Python 里派子代理并拿回结果，补上 `tools.subagent` 只回编号、结果只发给模型的缺口；不用 DSH 工作流（见上）就靠它在 Python 里编排。照官方工作流引擎的 `agent()`：经 DSH 公开子代理服务 `startActivation({ provider: 'spawn', delivery: 'caller' })`（结果交给调用方、不通知上级），等结果后总是 `dispose`；返回最后的文本，给了 `schema`（对象 JSON Schema）返回结构化值，子代理没正常完成返回 None；起不来、被拒报 `ToolCallError`。权限：本格得有 `subagent` 工具，格子结束后只有 `repl.background` 任务的授权（同样要含 `subagent`）还能派。归属：在后台任务里派的属于任务，否则属于那一格；格子结束或被取消、任务结束或被 `job_kill`、内核换掉、会话关闭时，没跑完的子代理一并停掉，Python 侧被取消（如 `asyncio.wait_for` 超时）时内核发 `cancel` 单独停掉那一个，都以 `CancelledError` 到 Python。DSH 每棵树最多同时 `maxActiveSubagents`（默认 8）个子代理、超出直接拒绝不排队，所以被拒时等本会话自己的某个子代理结束再试，本会话一个都没在跑才报错。任务输出逐个记 `[agent] 标签: 结束原因`，原格在内核页的工具次数里记 `repl.agent`。闲置回收见到还有子代理在跑就不停内核。
- 闲置内核回收（`idleKernelMinutes`，默认 60，0 关闭；依据 2026-11-03 本机 2 个内核共 247 MB、另一个运行环境 1 个 60 MB）：运行时每 5 分钟巡检，`ReplSession.reclaimIfIdle` 只在没有排队/启动/面板操作、没有 `repl.background` 任务、恢复完整、内核里没有活着的 asyncio 任务/非守护线程/进程组里的子程序（`python/idle.py`，看事件循环本身，排除当前格与内核服务协程）时，存快照、确认快照没有存不下的名字，再停掉内核；下一格换新内核恢复并被告知原因。检查读不到答复一律按「保留」处理。
- 压缩结束（`session/event` 的 `compaction/end`）向内核要一次名字清单，写进动态上下文，直到下次压缩；内核换了（epoch 变）就不再列。只在压缩时变，不会每格多一份运行时上下文。
- 压缩时同时记下还在跑的工作（`listUnfinished`，`src/bash-jobs.ts`）：DSH 任务服务里属于这个会话 agent 的运行中任务，加上本会话格子里 `tools.subagent` 开过、DSH 里状态还不是 idle 的子代理（各最多 10 个），写进动态上下文直到下次压缩，提醒模型别重开。DSH 的压缩摘要只有笼统的 Pending Jobs 一节，不留编号（2026-11-03 读 dsh-compaction-basic 确认）。目标不列：每个目标轮次 DSH 都会重发目标原文。
- 这是受信 Python 环境，不是沙箱。工具权限不隔离任意 Python；运行时不声明 `sandboxMode`。
- 恢复对话、恢复变量、恢复任务是三件事；必须显式说明丢失状态。
- 变量跨内核恢复照 Prime 的命名空间快照做：成功的格子结束 1.5 秒后保存，`repl.restart()` 和关闭会话前补存；新内核先装运行环境、再恢复；桥实际装进去的名字（`tools` 这类系统名、本格授权的顶层工具、预导入的标准库名）照 Prime 对自己启动名字的做法，不进快照也不恢复，用户自己的同名值照常回来；首个格子用 Prime 原文 `[python-state-restored]` 列出回来的名字、恢复失败的名字和快照没存进去的名字。恢复不完整时关闭会话不覆盖磁盘上的快照。能按名字重新导入的模块（在 `sys.modules` 里、不是 `__main__`）和技能绑定（`reader = skills.demo_reader`）只按名字进快照，恢复时重新导入（`python/snapshot_refs.py`，在 dill 的模块保存规则外包一层，不改 vendor）：避免 dill 把非标准库模块的全局变量一起存下、恢复成「新代码配旧数据」，也让引用技能的函数能恢复；代价是手动挂到模块上的值不保留。恢复提示里恢复失败、没存进快照的名字各最多列 50 个，其余报数。快照在 `DSH_HOME/plugins/python-repl/state/<会话哈希>/kernel-state.{dill,json}`。需要真实内核环境的测试（快照、控制、名字去留、代理排除项）共用 `test/fixtures/test-kernel.ts`：uv 的 3.14 建的测试 venv，装 `dill` 和 `httpx`，缓存在 `~/.cache/dsh-python-repl/test-kernel-venv`；不依赖系统 `python3` 里装了什么。

## 内核标签页

- 状态轮询只列名字和摘要，不能自动读取值、执行代码格或启动内核。用户点选名字后，才通过同源只读接口读取单个顶层对象；不接受表达式。
- 执行记录（`src/cell-log.ts`）只记宿主自己看到的事：每格的排队、开始、结束时间，结果状态，首行代码，经桥调用的工具次数，以及内核换代。限量（200 格、20 代），存在快照目录的 `cell-log.json`，改动后 1 秒内写盘，DSH 重启后读回；读回时还没结束的格记为「DSH 重启时中断」，每条带写入时的 DSH 进程启动时间（`host`），页面据此画重启分隔线。不存代码全文、输出内容或命名空间里的值。重置只清变量，执行记录照留。
- 只有用户点标题行的按钮才会动内核（`/dsh-python-repl/control`，只收本页同源 POST）：启动、关闭（先存快照）、重启（存快照后换新内核）、重置（不存、删快照、换空内核，页面先原位确认一次）。有格子在跑、正在启动或上一个操作没完时一律拒绝，不打断模型；下一格经 `takeStateLossNotice` 被告知内核被手动关闭、重启或重置。DSH 重启后会话还没有内核时，按 DSH 记录的会话工作目录新建，找不到会话就拒绝。
- 名字去留（`python/lifecycle.py`，依据 2026-11-03 真实会话中 219 个长会话：96% 的复用在 100 格内、98% 在 200 格内）：只按模型的代码格计数，不按时间；每格编译前从源码读出它读写的全局名（含它调用的本会话函数里用到的，展开三层），按字面算，没执行的分支也算用过。连续 `archiveAfterCells`（默认 100）格没用的名字存进快照目录的 `archive/`、移出内核、不进快照；代码用到时执行前自动取回并在格末说一次。`deleteAfterCells`（默认 200）格没用就删除，只在 `lifecycle.json` 留记录供 NameError 说明。`repl.keep` 钉住的名字不受影响。恢复提示只全列钉住的名字，函数和变量按最近使用各列最多 10 个，模块最多 5 个，归档只报数，删除不提，恢复失败照旧逐个列出。页面的钉住、取消钉住、取回、归档和控制按钮同一套拒绝规则；重置连归档和记录一起删。
- 打开本页时照 dsh-context 的做法，在对话滚动区挂标记隐藏底部输入框；有待处理的审批、提问或计划审阅时仍显示。离开本页即撤标记。
- 预览只读取精确内置类型或原始存储字段，不调用用户的 `repr`、迭代器、动态属性或描述符。函数先读内核缓存；缓存未命中时只把源码位置交给宿主，异步限量读取普通文件。
- 快照里每个名字的字节数由宿主按 Prime 快照的记录头（名字长度、名字、内容长度）跳读得到，不读内容、不反序列化，限时 150 毫秒，文件没变就用缓存；旧格式或损坏的文件不显示大小。页面「快照里最大的」分组按它排。
- 对象、技能导入与快照条目共用目录和详情区；技能与快照读状态记录，只有点击当前对象才请求值。快照保存记录不能冒充对象当前值。
- 函数缓存源码必须对应编译时的同一个代码对象，不能只按文件名查缓存；重启恢复后的旧函数与新格可能重名。身份记录要限量并用弱引用清理，找不到对应原文就明确说明。
- 预览必须同时限制耗时、字节、层级和数量；页面只保留当前一份结果，并校验会话、名字、内核代数。取消或超时不打断用户正在运行的代码，未结束的读取仍占用原请求位置，直到内核答复及文件关闭。

## 工程边界

- 只修改本插件授权范围；本机 DSH、Prime checkout 是只读参考。
- 当前公开 seam 不足时显著告知用户：需求是什么、接口缺什么、上游补还是暂不做。不能静默换架构、伪造成功或使用私有 scheduler 作为扩展点。
- vendor 记录精确来源、版本/commit、许可证、文件哈希和补丁理由。不要修改已安装 Prime 来完成适配。
- **`vendor/` 整个目录只放上游原件，一个字节不改，也不许放我们自己的文件。** 归属按目录区分，不按文件列例外（那种清单下次 bump 就会过期）：
  - `vendor/prime/` = 上游 prime-agent 的东西，只读
  - `python/compat/` = 我们为让上游内核跑起来写的兼容垫片
  `rlm` 是 PEP 420 命名空间包，跨这两个目录，**两边都不要放 `__init__.py`**（放了就塌成普通包，另一边的模块会消失）。PYTHONPATH 顺序 `vendor/prime` → `python/compat` → `python`，上游永远不会被遮蔽。
  `vendor/PROVENANCE.md` 记录哈希，`test/python/test_vendor_integration.py` 每次跑测试都校验哈希、校验 vendor 目录里除上游文件外空无一物。细节见 `python/compat/README.md`。
- Python 测试放 `test/python/`，和 TS 测试同级；`python/` 只放运行时源码。
- `python/` 和 `vendor/` 是运行中的 DSH 每开一个新内核都直接读的，宿主的 `lib/` 却要重启才换：在这个目录里直接改，旧宿主会配上新 Python 文件。2026-10-15 删掉 `revive.py` 后所有 `run_code` 都报 `KeyError: 'revived'`。改这两处要在 git worktree 里做和测，部署交给 `dsh-control restart --detach --before '<打补丁并构建>'`。
- 内核跑在宿主建的专用 venv 里，照 Prime 的 kernel-venv：`DSH_HOME/plugins/python-repl/kernel-venv/<小版本>`，用配置的 Python 建，建时一次装好 Prime 的 12 个预装包、快照要的 `dill`，再加 matplotlib 和 openpyxl（`KERNEL_PACKAGES`；实测缺这两个时，数据任务跑去技能自带的解释器、在内核外做完全部分析），提示词照 Prime 写明预装了哪些。venv 里的标记记着用哪个 Python、装了哪份清单：一致就什么都不做、不联网；换了 Python 重建，换了清单只补装；建或装失败，这一格报错带原因，下一格重试。`repl.install` 用 `uv pip install --python <内核的 python>` 装进同一个 venv；内核不在 venv 里就拒绝，免得装进本机共用的 Python。不按每个工作区分环境：分析用的库各工作区一样，项目自己的依赖走项目环境。
- 仓库里只导入 `projectSkillRoots` 指定的目录，不扫整个工作区；除上面的固定清单外不自动装包（装库只走模型显式调用的 `repl.install`）、不静默吞导入失败。
- 运行状态归 DSH_HOME，不写源码树；文档中的本机路径是证据，不得硬编码进发布代码。
- package 名 dsh-python-repl；loader id / settings namespace python-repl。
- 构建与测试脚本已建立（`pnpm run check` = typecheck + build + TS 测试 + Python 测试）；`lib/` 是 tsdown 产物，不入库。
- 不未经授权安装 profile、改 GUI 宿主、提交、推送或发布。不要覆盖聚合仓库既有未提交修改。

## 完成口径

真实 Python + 真实 PTC 集成必须覆盖持久变量/函数、顶层工具、询问等待/取消、技能导入、图片/上下文、状态丢失、旧格越权拒绝。stub 探针不能替代集成验证。交付报告区分通过、未测试和受接口限制；实现行为变化时同步更新相关说明。
