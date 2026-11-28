中文 | [English](maintenance.en.md)

# 怎样持续维护

[← 文档导航](README.md) · [贡献指引](../CONTRIBUTING.md)

每轮维护以一个可复现的问题和一个能检查的结果收尾。首页帮助人找到入口；部件说明帮助人使用；测试和设计文章帮助后来者安全修改。

## 改什么，检查什么

| 改动 | 必要验证 |
| --- | --- |
| 文档、链接、公开元数据 | `pnpm run check:public`；有视觉变化时查看实际渲染。 |
| 一个 DSH 插件 | 该插件的 `pnpm run check`；涉及宿主加载时再做隔离启动与真实界面验收。 |
| Python 技能 | 用技能自己的开发环境跑测试；入口、打包和实际操作分别验证。 |
| `tooling/` 或 `skills/_shared/` | 共享代码测试，加上真正受影响的使用方。 |
| 测量结果或所测源码 | `python3 benchmarks/run.py --check benchmarks/results.json`；解释输入、估算和哈希为何变化。 |
| 演示素材 | 复核真实操作，抽帧看画面，检查身份信息和元数据；图示不能冒充录屏。 |

`check:public` 是不安装组件依赖也能运行的第一道检查，覆盖文档链接、发布清单、许可和明确的敏感内容模式。它不替代人工隐私审查，也不证明真实网站或桌面操作成功。

## 下一步优先做什么

这些是可供贡献的方向，不是交付日期承诺。

| 方向 | 做到什么算完成 |
| --- | --- |
| 让首次安装更容易复现 | 在干净环境按上手文档装一个插件，记录实际支持版本、失败点和验收结果。 |
| 让演示更容易更新 | 给每段演示保留虚构输入、录制步骤和核对方法；第三方能重做同一条操作。 |
| 补明确的兼容证据 | 将跨平台测试和真实平台验收分开列，依据结果扩展支持范围。 |
| 提炼更多通用技能 | 拆清依赖与权限，保留许可证，独立构建、测试和验证，再迁入公开边界。 |
| 升级 DSH 时更早发现变化 | 根据上游实际接口调整契约测试，核对加载、取消、回执与恢复路径。 |

优先修用户能重现的故障和首次使用阻碍。结构调整需要说明现有目录为什么不够用；新增常驻服务、抽象层和依赖需要有明确收益。

## 固定提交构建、校验与回退

Source code ZIP 适合审阅，不是已构建成品，也不带 DSH 构建需要的 `.git`。下面的步骤只在 macOS 上实际验收，其他平台未在本说明中验证；在干净完整克隆根目录运行。`REV` 是可复现的公开示例，不是“最新稳定版”承诺，维护者可换成另一已审核的完整提交。

```sh
set -eu
REV=57cfccb03b4f39121facc575a91bcff055d59fed
test -z "$(git status --porcelain)"
git checkout --detach "$REV"
test "$(git rev-parse HEAD)" = "$REV"
OUT="$(mktemp -d)"
pnpm --dir dsh-python-repl install --frozen-lockfile
uv python install 3.14
UV314="$(uv python find --managed-python 3.14)"
export PATH="$(dirname "$UV314"):$PATH"
python3 --version
pnpm --dir dsh-python-repl run check
pnpm --dir dsh-python-repl pack --pack-destination "$OUT"
AGY_DIR="$OUT/agy-python-repl"
sh agy-python-repl/scripts/bundle.sh "$AGY_DIR"
agy plugin validate "$AGY_DIR" --strict
git rev-parse HEAD > "$OUT/SOURCE_COMMIT"
set -- "$OUT"/*.tgz
test -f "$1"
tar -tzf "$1" package/lib/index.js package/lib/dsh-build.json package/vendor/PROVENANCE.md package/vendor/prime/LICENSE package/LICENSE
test -f "$AGY_DIR/_bundled/vendor/PROVENANCE.md"
test -f "$AGY_DIR/_bundled/vendor/prime/LICENSE"
test -f "$AGY_DIR/LICENSE"
test -x "$AGY_DIR/scripts/start_mcp.sh"
test -x "$AGY_DIR/skills/agy-use/scripts/agy-use"
(cd "$OUT" && shasum -a 256 ./*.tgz > DSH-SHA256SUMS)
(
AGY_UNSORTED=$(mktemp "$OUT/.AGY-SHA256SUMS.XXXXXX")
AGY_SORTED="$AGY_UNSORTED.sorted"
trap 'rm -f "$AGY_UNSORTED" "$AGY_SORTED"' EXIT
trap 'exit 1' HUP INT TERM
(cd "$AGY_DIR" && find . -type f -exec shasum -a 256 {} + > "$AGY_UNSORTED")
LC_ALL=C sort "$AGY_UNSORTED" > "$AGY_SORTED"
mv "$AGY_SORTED" "$OUT/AGY-SHA256SUMS"
)
```

若另行运行 AGY 的 Python 测试，macOS 可能因 Unix socket 路径过长报 `AF_UNIX path too long`；保留失败日志，改用更短的临时 `TMPDIR` 后重跑。

DSH 成品是 `.tgz`，其中必须有 `lib/index.js`、构建清单和 Prime 来源清单；AGY 成品是通过严格校验的 `$AGY_DIR` 独立目录。交付时同时保留 `SOURCE_COMMIT`、两个 `SHA256SUMS` 和成品。文件名中的版本不能代替提交和哈希；哈希用于辨认与完整性检查，不等同签名。

若收到 ZIP，先解压到一个新的空目录，再 `cd` 到实际含 `SOURCE_COMMIT` 的目录；不要覆盖已有解压目录，以免旧文件残留。`REV` 填维护者声明的完整提交；下面沿用示例提交。DSH 用 `shasum -c` 核对整个 `.tgz`；AGY 只去掉两边 `shasum` 行中摘要和模式分隔符后文件名开头可选的一个 `./`，再分别排序比较，因此接受两种正式前缀写法和早期未排序的完整清单，同时核对两个交付命令仍有执行权限：

```sh
set -e
OUT="$PWD"
AGY_DIR="$OUT/agy-python-repl"
REV=57cfccb03b4f39121facc575a91bcff055d59fed
test "$(cat "$OUT/SOURCE_COMMIT")" = "$REV"
(cd "$OUT" && shasum -a 256 -c DSH-SHA256SUMS)
test -x "$AGY_DIR/scripts/start_mcp.sh"
test -x "$AGY_DIR/skills/agy-use/scripts/agy-use"
(
AGY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/agy-verify.XXXXXX")
trap 'rm -rf "$AGY_TMP"' EXIT
trap 'exit 1' HUP INT TERM
AGY_NORMALIZE='s/^([0-9a-f]{64} [ *])\.\//\1/'
sed -E "$AGY_NORMALIZE" "$OUT/AGY-SHA256SUMS" > "$AGY_TMP/expected.unsorted"
LC_ALL=C sort "$AGY_TMP/expected.unsorted" > "$AGY_TMP/expected"
(cd "$AGY_DIR" && find . -type f -exec shasum -a 256 {} + > "$AGY_TMP/current.raw")
sed -E "$AGY_NORMALIZE" "$AGY_TMP/current.raw" > "$AGY_TMP/current.unsorted"
LC_ALL=C sort "$AGY_TMP/current.unsorted" > "$AGY_TMP/current"
diff -u "$AGY_TMP/expected" "$AGY_TMP/current"
)
```

这些检查不需要网络或源码。生成与接收都先完成扫描再排序，读取、规范化或排序失败会非零中止。生成在同目录写临时文件，成功后再改为正式名，不会留下部分正式结果或替换既有完整清单；接收只在新建的系统临时目录写临时文件，并在退出时清理，所以交付目录可以只读。比较不去重，也不清理路径其他部分。DSH 的单个归档哈希覆盖包内全部内容；AGY 的清单差异会指出普通文件的内容变化、额外文件和缺文件。AGY 清单不检查目录结构、符号链接或其他文件类型，权限检查也只覆盖上述两个命令。不再要求接收方为了发现额外文件而重新构建。

平台安装沿用现有入口。DSH：把入门页 profile 中的 `link:` 依赖改为指向已校验 `.tgz` 的绝对 `file:` 路径，保留组合包登记，再用 DSH 所配 pnpm 安装、运行启动检查并重启。安装 Antigravity 插件时，执行 `agy plugin validate "$AGY_DIR" --strict && agy plugin install "$AGY_DIR"`，再用 `agy plugin list --json` 核对。严格校验能在覆盖现有安装前检出损坏的工具或钩子配置。只做临时验收时，为 AGY 命令设置一个新的空 `HOME`；先确认 `plugin list --json` 为 `[]`，不要操作日常 App。

宿主输入不能互换：DSH 的 `file:` 必须指向通过 `DSH-SHA256SUMS` 检查的 `.tgz`，不能指向 `$AGY_DIR`；Antigravity 必须安装通过上述目录清单检查的 `$AGY_DIR`，不能安装 `.tgz`。pnpm 能把本地目录安装成依赖并返回成功，但这不会产生可加载的 DSH 插件，所以安装命令退出 0 不能代替宿主输入检查。

回退前保留上一组已校验成品和现有快照。DSH 把 `file:` 指回旧 `.tgz`，重新安装 profile 依赖、检查并重启。AGY 可在现有安装上直接回退。把上一已校验独立目录设为 `PREVIOUS_AGY_DIR`，执行 `agy plugin validate "$PREVIOUS_AGY_DIR" --strict && agy plugin install "$PREVIOUS_AGY_DIR"`。随后用 `agy plugin list --json` 找到安装路径并设为 `AGY_INSTALLED`，执行 `diff -r "$PREVIOUS_AGY_DIR" "$AGY_INSTALLED"`；无输出且退出 0 才说明内容恢复，不要用相同的版本号判断。仍用源码 `link:` 的 DSH 安装则检出旧提交并重跑组件检查，不能把已改源码当成已回退的运行实例。

## 发布前检查

1. 审查 diff，只包含本轮改动；中英文入口一致，公共示例能脱离私人配置运行。
2. 完成相关检查，说明真实验收与尚未验证的部分；截图、录屏和数字都能追到来源。
3. 检查工作树、打包内容、提交身份与相关历史。移除当前文件中的敏感值，不代表它已从历史消失。
4. 更新[变更记录](../CHANGELOG.md)，写清用户能看到的变化、兼容影响与迁移步骤。
5. 审核实际发布内容后再打标签。版本标题和排队中的工作流都不等于发布成功。

安全发现走[私密报告](../SECURITY.md)。私人审计词表和真实发现清单留在仓库外；仓库内只保留通用预防规则和虚构回归样例。
