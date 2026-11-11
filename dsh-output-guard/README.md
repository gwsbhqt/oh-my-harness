中文 | [English](README.en.md)

# dsh-output-guard

[← 返回首页](../README.md#由哪几块组成) · [教程](../docs/dsh-output-guard.md)

**一句话：** 发现模型开始复读、刷空行、什么都没答就结束时，及时拦下，可以自动重试一次。

在 DeepSeek Harness（DSH）中拦下失控的模型输出，也可以带着一条纠正提醒重试失败步骤一次。保护范围包括主助手和子代理的文字循环、大段空白、过长的工具参数，以及没有正文或工具调用就结束的回复。

## 使用条件和安装

DSH 需要提供兼容的 LLM 和 agent 服务。开发依赖面向 DSH 0.2.2-rc.1。需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。这是宿主插件，没有独立界面或外部服务。

保留所在仓库中与插件相邻的共用 `tooling/` 目录。不能只拿这个源码目录单独构建。在本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

在 DSH profile 的包清单中合入链接依赖和组合包，保留已有条目：

```json
{
  "dependencies": {
    "dsh-output-guard": "link:../../path/to/oh-my-harness/dsh-output-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-output-guard"]
    }
  }
}
```

把示例链接改成相对于你的 profile 目录的路径。使用 DSH 安装所支持的 pnpm 安装 profile 依赖，再重启 DSH。组合包已登记 `output-guard`，不要重复插入。安装环境提供启动检查器时，重启前先校验 profile。

## 检查哪些情况

- 思考和正文中的连续文字循环。比较时忽略空白和常见 Markdown 强调符号。不把纯数字或纯标点结构算作循环。工具参数不做重复检测，避免普通代码触发误判。
- 思考、正文或工具参数中的过长连续空白。工具参数中的 JSON 空白转义也计入上限。
- 每次工具调用的参数总长度。不同调用分别计数。
- 正常结束或达到输出额度时，没有正文，也没有可用的工具调用。因输出额度耗尽而被丢弃的工具调用，不算可用结果。

达到上限时，插件会关闭上游输出流，把这次尝试记为失败。启用 `autoRetry` 后，写入标有 `output-guard` 来源的通知，并对每个助手、每轮、每步最多重试一次。不会把失控内容再塞回提示。第二次失败交给宿主原有的错误处理。插件不换模型，也不改长期系统提示。不是助手发起的模型请求原样通过。

这是根据输出特征作判断，不能保证答案正确，也不能保证发现所有循环。需要正常重复输出或传入大块工具参数时，可调整阈值。

## 配置

在 DSH profile 补丁中覆盖组合包条目：

```yaml
- id: output-guard
  config:
    enabled: true
    autoRetry: true
    maxBlankRun: 2000
    maxToolArgsChars: 50000
```

所有设置都会即时生效，在新请求开始时读取。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 启用输出流检查和带纠正提示的重试处理。 |
| `reasoningOnlyGuard` | `true` | 拒绝没有正文或可用工具调用就结束的回复。 |
| `autoRetry` | `true` | 每步对被拦下的失败最多重试一次。 |
| `repeatCount` | `8` | 一段文字至少连续重复多少次。 |
| `minCycleChars` | `4` | 去掉比较中忽略的字符后，重复单元的最短长度。 |
| `maxCycleChars` | `160` | 去掉比较中忽略的字符后，重复单元的最长长度。 |
| `minRepeatedChars` | `64` | 重复片段本身至少覆盖多少字符。 |
| `windowChars` | `1000` | 用于检查重复的最近字符数，按处理后的文本计算。 |
| `maxBlankRun` | `2000` | 连续空白的最大长度。 |
| `maxToolArgsChars` | `50000` | 单次工具调用的最大参数字符数。 |

用 `enabled: false` 可绕过保护；要禁用整个插件条目，覆盖 `id: output-guard` 并设 `disabled: true`。

## 开发和测试

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

测试使用虚构文字和工具参数，检查重复边界、输出分片、上游取消、空白、参数限制、正常透传和只重试一次。真实 DSH Session 测试核对失败尝试不会进入整理后的会话历史，纠正通知会保留。这些测试不调用模型，也不能证明真实服务商的行为。

## 许可

MIT。见 [LICENSE](LICENSE)。
