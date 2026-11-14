# dsh-doctor 工作约束

只改本插件；真实 DSH_HOME、App 和别人的插件只读。不要用降低供应链发布时间要求、切换模型或关闭合规守卫使报告变绿。未验证项独立列出，不计入通过数量。默认离线通过不代表供应链或 GUI 验证通过。

每次修复新的启动故障，都要增加能稳定发现它的检查和正常/故障成对 profile 夹具。先 `pnpm run check`，再实际 CLI；报告和后台工作必须全部收齐再交接。App 升级后必须重跑真实组合及宿主启动测试，不能只比较 npm 开发包版本。

## 历史故障 → 检查 → 成对夹具

App 成对 profile 夹具在 test/doctor.test.mjs，由 App 实际解析或启动；内容清单边界及独立报告契约在 test/build-manifest.test.mjs。

| 历史故障 | 检查 | 正常与故障证据 |
|---|---|---|
| 凭据重写成 644，只有只读 400 也不满足要求 | credentials-mode | 600 / 644 / 400；未授权不修，显式修复 re-stat 且内容不变 |
| 启动继承 ELECTRON_RUN_AS_NODE | electron-run-as-node | 污染 / 显式 sanitize |
| profiles 父目录误装依赖 | profiles-node-modules | 无 / 有 node_modules |
| 崩溃后 SingletonLock 留下 | singleton-lock | 存活 / 死亡进程 |
| 删除仍在读取的用户补丁导致链接断开 | profile-patch-target | 正常链接 / 删除目标后的断链 / 切到统一补丁后恢复；无用户补丁仍合法 |
| bundle 和用户补丁重复 insert | duplicate-entry-ids | 实际 App 同 scope 重复 / 不同 scope 复用 |
| 旧 peer 范围使插件静默跳过 | dsh-peer-ranges、bundles-active | App >=预发布下限 / 旧 ^范围 |
| 插件运行时加载的官方包只装在开发依赖、没声明为 peer：开发机能跑，别的机器拉取后起不来（2026-11-04 mbp-mm 升 0.2.2-rc.1 预检，python-repl 缺 dsh-tool-executor-ptc） | link-host-peers | 已声明 / 未声明的本地插件；宿主产物里静态导入、`import("…")` 与 `import(常量)` 都算 |
| 缺 bundle、断链、构建入口丢失 | bundle-artifacts | 实际 App 可读入口 / 缺包、断链、缺 lib |
| link 包源码更新但编译产物未重建，动态 Python 与 TS 旧产物混跑 | link-build-freshness | 明确内容清单匹配 / TS、Python 或输出变化；touch 同内容不误报；未声明协议只列未验证，声明缺清单失败，不用 mtime 当内容 |
| 客户端入口丢失、打包外壳错误，或访问 ctx.remote 却缺连接组件 / remote 注入 | client-artifacts | 有外壳与完整注入 / 缺文件、非函数、缺 remote 注入；factory 不执行 |
| XDG 与 Dock store 字符串不同、软链不能等价 | pnpm-store-path、pnpm-terminal-store | 实际 YAML 规范路径 / 其他字符串；终端优先级源码对照 |
| 全局配置 storeDir 压过规范路径 | pnpm-global-store-dir | 实际 App 解析无覆盖 / 有覆盖 |
| CI 冻结锁文件与 manifest 漂移，或借用临时目录锁文件导致全部本地插件断链 | lockfile-manifest | 实际 YAML 的 specifier 与 link 目标一致 / 漂移；真实 App 读取正常与借来路径成对夹具 |
| 新发布包被最低发布时间挡住 | pnpm-frozen-lockfile（仅 full） | 本机 registry 老版本 / 刚发布版本，实际 App pnpm |
| 普通插件 apply 抛错或 inject 缺失但 App 只警告 exit0 | isolated-startup | 实际 App 健康 / apply 抛错 / 服务缺失，所有 enabled fiber 必须 ACTIVE |
| 隔离共享整个 node_modules 后宿主回退漏掉实目录包 | isolated-startup | 真实 profile 逐包只读链接后启动；历史整目录方案实际产生 ERR_MODULE_NOT_FOUND（不保留错误方案） |
| 模型请求失败或只是回显 prompt | model-roundtrip | JSON final 回答 / 普通回显、user事件、exit失败 |
| doctor 注册工具或远程服务接口形状错，本地可调用却缺 typertRemote 绑定 | isolated-startup | 实际 App 经 typertGateway 调用 doctor/getReport；健康绑定 / 删除绑定成对夹具，不能用本地服务调用代替远程网关验收 |
| 试启动超过时限被停掉，报告只剩一条 Node 废弃警告，会话照着警告查了 35 步（2026-10-14） | isolated-startup 及其他子进程检查的失败说明 | 超时的说明第一行写明没在时限内跑完，修复建议给放宽时限重查；正常非零退出写退出码、不提时限 |
| 测试夹具用错条目 id（写成 `web`，网页外壳的条目实际叫 `web-runtime`），关浏览器的覆盖落空，每跑一次测试就在默认浏览器开一个 DSH 标签（2026-10-01） | 测试 `startupFixture` | 启动输出不得出现 `opening the default browser`；改回旧 id 时该断言失败 |

提醒项（不算失败、不挡启动）：`preset-ptc-cordis` 对照 App 自带的 PTC、创造模式清单，列出 dsh-presets 的 PTC 创造模式继承不到的官方改动（PTC 模式那一侧新增或写法不同的条目）；有就只列进「未验证」，因为要人判断要不要跟进，不是启动故障。比对规则在公共 `tooling/preset-drift.mjs`，只检查已加载且声明参与的 bundle；测试在公共 `tooling/test/preset-drift.test.mjs`。

## 共用构建与内容清单

插件的构建入口调用 `await buildPlugin(import.meta.url,{steps})`（[共用构建工具](../tooling/build.mjs)）。`steps` 按顺序执行：命令数组只调用插件自身 `node_modules/.bin`，异步函数接收 `{dir}`。各插件保留自身构建步骤；doctor 只保留工具注册和薄 CLI 包装，检查核心及离线入口统一来自公共 tooling。

`dsh.build.inputs`、`outputs`、`manifest` 只认包内相对路径。`repositoryInputs` 逐文件列出 tooling/ 或 shared/ 下的规范文件，不接受目录、通配符、依赖、缓存、向上路径或其他插件。仓库根必须有非符号链接的 .git 标记；只有 tooling 顶层可为指向正在执行的公共 tooling 的相对链接，其目标也必须有非符号链接的仓库标记。其余每段路径与文件都拒绝符号链接。

清单分别存包内和仓库输入 SHA256。构建前后同时比较两类输入；命令失败、被信号终止或构建中输入改变，不写新清单。成功后使用独占临时文件加原子改名替换清单。共用工具、基础 TypeScript 配置和被内联的共用运行时文件改变后，`inspectBuild` 会报告 `stale`。缺共用文件、缺仓库标记或旧清单没有所声明的仓库输入哈希时报告 `unverified`；发布产物脱离源码仓库不能假定已核实。

共用工具不引入依赖。构建与运行时校验共用公共 [tooling/build-manifest.mjs](../tooling/build-manifest.mjs) 的内容清单协议；检查流程与离线入口分别由公共 [tooling/doctor.mjs](../tooling/doctor.mjs) 和 [tooling/doctor-cli.mjs](../tooling/doctor-cli.mjs) 提供。私有插件不保留另一份核心实现。新增边界用例在[内容清单测试](test/build-manifest.test.mjs)，失败、信号、顺序、构建中变化及原子替换在[共用构建测试](../tooling/test/build.test.mjs)。

## 必须讲清的限制

- pnpm store 是仓库规范校验，不是任意全局/workspace/命令行配置的完整动态计算。新增覆盖支持先补成对真实 fixture。
- 客户端检查是静态打包验证。GUI 激活、组件形状、渲染和交互只能在 GUI 验证。
- 默认不会测远程发布时间，也不会调用模型。full 可以按真实政策失败，不得当作产品代码故障或伪造通过。
- 总预算控制子进程；强制清理可另用最多 3 秒。不要承诺硬实时完成。
- 显式 disabled 跳过激活审计；因 peer/导入/服务未满足导致的静默未激活不能跳过。
