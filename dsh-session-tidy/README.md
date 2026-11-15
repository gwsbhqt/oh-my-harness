# dsh-session-tidy

工作区「…」菜单里加一项「整理本工作区」：点一下把该工作区里没用的一次性/测试会话批量归档，可恢复。

## 它做什么

- 菜单项在「删除工作区」上方，order 250。点它页面不弹遮罩，后台静默执行，完成后顶部横幅提示「已归档 N 个」（或「没有需要归档的」），失败也提示。归档可恢复。
- 判定交给外部模型（Jev）：每条候选会话带上标题、创建时间、多久没用、第一段用户消息（截断），问「是不是一次性的测试/临时/调试会话」，概率高就归档；另有两问补强。
- 只处理没在跑、没打开、非子代理、非置顶、非已归档的会话；归档可恢复（在「存档」里恢复，不是删除）。
- 同一操作也暴露成 agent 工具 `tidy_workspace_sessions`。

## 安装

profile 的 `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-session-tidy`。插件自带补丁层插入一条 `id: session-tidy`，**不要**再手写第二条 insert。条目 id 与设置命名空间都是 `session-tidy`。

## 配置

三项都标了 volatile，改完即时生效（不用重启）：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyRef` | `TYPESAFE_API_KEY` | 取 key 的凭据引用名，不能填钥匙本身 |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Jev 的完整请求端点（含 `/systemone`） |
| `model` | `jev-latest` | 模型名 |

默认指向通用 Typesafe 网关；要用别的网关（例如自建的 Magpie）时，在 profile 只带 id 的覆盖行里把这三项改成对应值即可，代码不用动：

```yaml
- id: session-tidy
  config:
    apiKeyRef: <你的凭据引用名>
    baseUrl: <你的完整端点>
    model: jev-latest
```

## 依赖与降级

- 没有外部服务也能加载：取不到 key 时退回纯规则（标题模板 + 超过 3 天没用户消息）；单条模型调用失败或超时则该条保留，不会因失败误归档。
- 有 key 但模型服务不可用、或单条调用失败/超时时，该条保留、不再往下判；只有没配 key（apiKeyRef 为空）才退回纯规则。两种情况都不影响插件加载和其它功能。

## 验证

`pnpm run check`（typecheck + build + test）。真实界面：菜单出现「整理本工作区」，点后静默执行、Toast 报数，归档可恢复；运行中/置顶/当前/已归档会话不动。

## 升级注意

依赖宿主 `workspaceRegistry`、`sessionQuery`、`ctx.contextMenus`、`credentials.resolve` 等内部接口；DSH 升级后重跑 check 并实际点一遍。
