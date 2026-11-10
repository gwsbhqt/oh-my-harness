# browser-control CLI 参数参考

本页维护 `browser-control` 的详细 CLI 参数和示例，日常流程见 [CLI 主说明](../SKILL.md)。带 Python 内核时读 [Python 主说明](../PYSKILL.md)，直接调用 `skills.browser_control`；调用失败先查原因，不用 CLI 绕过。授权、机器和任务归属、未知结果及收尾共用 [操作规则](common.md)。

## 部署与探针

入口为 `~/.agents/skills/browser-control/scripts/browser-control`，可把该入口加入 PATH；Python 3.12 以上，依赖显式装进技能独立缓存环境。远端需在目标机安装。

```bash
# browser-control：显式安装和只读探针；探针不等于浏览器权限可用。
browser-control --local install
browser-control version --json
browser-control capabilities --json
browser-control status --json
```

## 共用参数与机器

共用参数：`--session NAME`、`--scope ID`、`--browser Chrome|Arc`、`--mode attach|isolated|clone`、`--profile NAME`、`--restart never|if_needed`、`--fallback clone|never`、`-H HOST|--host HOST|--local`、`--json`、`--socket PATH`、`--tab TARGET`、`--rpc-timeout SECONDS`。可放子命令前后，必须在原样文本分隔符 `--` 前。远端与 `--local` 冲突拒绝；`--socket` 只适用于本机，不混远端。`--tab` 代替目标位置参数时不能重复给目标。

`--snap` 在成功动作后再取态，结果放 `snap`；不截图，且只适用于确切页面动作，tab/lane/policy 不接受。普通任务必须有 scope 或显式 session，不能靠页面编号猜归属。

```bash
# browser-control：机器默认值与任务默认值分别选择。
browser-control hosts --json
browser-control use alpha --json
browser-control pin --json
browser-control use --clear --json
browser-control --scope task-a session current --json
browser-control --scope task-a session use task-browser --json
browser-control --scope task-a session use --clear --json
browser-control -H alpha --scope task-a tab list --json
```

## 页面、定位与收尾

以下 TAB、IDX、TOKEN 必须替换为实际返回值，先观察后操作。编号必须携带本次快照 TOKEN。普通文本放 `--` 后，换行须 `--allow-newline`，不要让文本被当成参数。

```bash
# browser-control：自建页的最短流程；真实目标来自 tab new 的 targetId。
export BROWSER_CONTROL_CONTEXT_ID=task-a
browser-control tab new https://example.com --json
browser-control snap TAB --json
browser-control click TAB --id search --json
browser-control type TAB --id search --json -- '关键词'
browser-control wait TAB --label '结果' --json
browser-control release --json
# browser-control：编号与语义定位；所有目标须按实际观察替换。
browser-control click TAB IDX --snapshot TOKEN --json
browser-control click TAB --selector '{"text":"搜索"}' --json
# browser-control：已获网站查询授权时找原标签，停在登录页才登录。
browser-control tab find 古歌云 --json
browser-control login TAB --native-window WINDOW_JSON --account 文字 --field 'input[type=email]' --timeout 20 --json
# browser-control：借用页关闭仅在明确获准后使用 authorized。
browser-control tab recover TAB --json
browser-control tab close TAB --authorized --json
browser-control disconnect --json
browser-control release --json
```

`tab recover` 仅恢复原绑定，不新开页面、不重发此前动作。成功后重新观察；自定义设置与归属不能确认时报错。完整边界见 [断线恢复](common.md#断线后的显式恢复)。

## 完整参数按能力查

现有接口参考保留 CLI 与 Python 对照。以下链接包含对应命令的全部参数、返回和限制，不再另存一份规则：

- [上下文、探针与生命周期](interfaces.md#上下文探针与生命周期)
- [页面方法与普通 CLI](interfaces.md#页面方法与普通-cli)
- [远程 RPC 与文件](interfaces.md#远程-rpc-与文件)
- [Snap / Diff](interfaces.md#snap--diff)
- [Element 与定位 scope](interfaces.md#element-与定位-scope)
- [Debug：页面固定，字段有限](interfaces.md#debug页面固定字段有限)
- [State：Cookie、网页存储与登录状态文件](interfaces.md#statecookie网页存储与登录状态文件)
- [Inspect：CSS 来源](interfaces.md#inspectcss-来源)
- [Output：截图比较与标注](interfaces.md#output截图比较与标注)
- [Network：匹配和改写分开](interfaces.md#network匹配和改写分开)
- [Lane](interfaces.md#lane)

批量参数 `batch [--file PATH] [--continue-on-error]`；最多 500 条、4 MiB，不嵌套 batch/serve/install，默认失败即停。自启 Chrome 参数 `tab new --profile NAME --proxy URL --proxy-bypass HOSTS --ignore-https-errors --lang zh-CN --user-agent UA --window-size W,H` 只用于独立 Chrome。完整部署和维护见 [实施参考](implementation.md)。

```bash
browser-control --session task-a snap TAB --json
```

失败 JSON 带 `ok/error/code`，还可能包含 `command/host/outcome/data`。退出码含义和未知结果处理见主说明，不重发动作。服务按需自动启动，普通任务无需手动 serve；维护服务参数见接口参考。
