# dsh-doctor

启动前检查。CLI 和宿主工具共用相邻 tooling/ 目录中只依赖 Node 内置模块的 doctor.mjs。

```sh
cd dsh-doctor
pnpm run check
node bin/doctor.mjs --json --sanitize-env
node bin/doctor.mjs --full --json --sanitize-env
```

可选参数：`--home`、`--profile`、`--app`、`--json`、`--repair-credentials`、`--full`、`--timeout-ms`、`--sanitize-env`。默认检查 desktop；默认总预算 120000ms，退出清理最多另用 3 秒。退出码 0 表示检查通过，1 表示检查失败，2 表示 CLI 参数错误。未验证项独立列出，不算通过项。

## 宿主入口

- 工具 `doctor`，参数同名 camelCase。
- 只读 typert 接口 `doctor/getReport`，请求 `{ "options": { "profile": "desktop" } }`，直接返回 Report，不包 envelope。
- Report：`{ok, checks: [{id, ok, message, fix?}], unverified, ...}`。
- 宿主入口清理 `ELECTRON_RUN_AS_NODE` 污染；凭据修复永不默认开启。CLI 必须显式 `--repair-credentials` 才会把真实凭据权限修为精确 `0600`，内容不改变。

## 安全及验证边界

默认使用真实 App 的版本、组合器、兼容性判定和 CLI。配置复制到短路径临时 DSH_HOME；依赖逐包只读链接；所有写入只允许临时目录，默认网络只允许本机。逐一检查所有 enabled 宿主插件是否激活，不只看 App 的核心启动通过。挂载 doctor 的 profile 还会经真实 typertGateway 调用 doctor/getReport，检查远程绑定和返回格式；探测使用不存在的 App 路径提前结束，不递归试启动。插件 apply 抛错或依赖服务未满足必须失败。临时副本及子进程在结束时清理。

实际桌面外壳不适用于 CLI，隔离启动会停用桌面窗口，保留其他宿主插件并让已有网页服务用本机随机端口，不打开浏览器。客户端检查只验证文件和打包外壳，不执行 factory，不证明 React、apply、连接或页面实际渲染正常。必须在真实 GUI 补验。

store 检查按本仓库 macOS 规范校验 `~/Library/pnpm/store/<App store version>`，**不是** pnpm 对任意用户配置的完整动态计算；合法但不合仓库规范的覆盖仍会失败。路径按字符串比较，不取 realpath。全局 storeDir 不允许覆盖；终端环境按 PNPM_HOME、XDG_DATA_HOME 的优先级比较。

`--full` 才联网验证 App pnpm 的冻结锁文件和最低发布时间政策，并发送一次真实默认模型请求。保留自定义 bundles、模型、代理和合规设置；仅替换 web/desktop 交互外壳为官方 headless runner。仅官方 JSON `final` 的真实回答及成功退出才算通过，提示文本回显不算回答。不切换模型、不关闭合规守卫、不自动放宽 minimumReleaseAge。真实政策拒绝意味着完整检查失败，默认离线通过不能取代它。

凭据和订阅设置中的字符串值用于输出脱敏，不输出文件内容。证据只保留脱敏 Report，不保存未经处理的原始凭据或插件日志。

## link 插件的构建内容检查

profile 的 `link:` bundle 可在包的 `package.json` 中声明 `dsh.build`：

```json
{
  "manifest": "./lib/dsh-build.json",
  "inputs": ["src", "python", "vendor", "package.json", "pnpm-lock.yaml", "cordis.patch.yml", "tsconfig.json", "tsdown.config.ts"],
  "outputs": ["lib"]
}
```

只列实际存在的输入文件与目录。`package.json` 必须列入输入；包中存在 `src`、`python`、`vendor` 时必须完整列入。这使动态读取的 Python 与 TS 产物属于同一份构建记录，而不是只证明 JS 文件存在。输出必须覆盖宿主和客户端入口，清单自身放在输出目录内并排除于哈希。

成功构建后生成 JSON 清单：`{schemaVersion: 1, algorithm: "sha256", inputs: {相对文件路径: SHA256}, outputs: {相对文件路径: SHA256}}`。`../tooling/build-manifest.mjs` 的 `snapshotInputs(dir, declaration)` 返回输入哈希映射，不要求产物已存在；`snapshotBuild(dir, declaration)` 返回完整清单。这两个函数都不写磁盘。构建脚本需在编译前记录输入，编译成功后核对输入未变，再原子写清单；构建失败不得生成或更新清单。不能拿事后重新计算哈希给未构建的旧产物背书。

`link-build-freshness` 比较完整文件清单和逐文件内容哈希：源码、动态 Python 或产物改了，以及文件新增或删除都会失败；touch、chmod 或 git checkout 只改变时间但内容相同不会误报。只遍历声明的根，不扫描依赖和缓存，不跟随内部符号链接；跳过 `node_modules`、`.git`、`.cache`、`__pycache__` 和 `.pyc` / `.pyo`。每包最多检查 20000 个文件和 128 MiB 内容，超预算明确为不能判断。

未声明协议的旧 link 包进入 Report 的 `unverified`，不计入通过检查，也不声称最新；原有缺入口检查仍失败。已声明协议却缺清单、清单损坏、输入遗漏或入口漏记时，检查为 `ok: false, status: "unverified"`；内容不同为 `status: "stale"`；全部匹配才为 `status: "verified"`。没有时间戳兜底。

此项证明构建时记录的内容与磁盘现状一致，不证明编译器正确或当前 GUI 进程已重新载入。各包须接入可信构建脚本；未接入者仍是未验证，不能为了绿报告手工伪造清单。

## 测试

`syntax-check` 只做 JavaScript 语法检查，不冒充类型检查。`check` 顺序执行语法检查、构建、Node test。需要本机安装实际 App 才能跑 App 夹具；缺 App 会明确 skipped。

历史问题和正常/故障夹具的映射见 AGENTS.md。完整供应链测试用本机 registry 返回新旧发布日期，实际调用 App pnpm，不依赖公共 registry 的时间和网络。

真实 profile 的挂载和 GUI 补验由协调会话执行；其他会话在跑时不直接修改 profile，放进 `dsh-use restart --detach --before '<命令>'`。要重启时用 `dsh-use restart --detach`，不交给用户手动重启。
