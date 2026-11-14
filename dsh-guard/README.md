中文 | [English](README.en.md)

# dsh-guard

[← 返回首页](../README.md#由哪几块组成) · [教程](../docs/dsh-output-guard.md)

**一句话：** 模型输出失控时及时停下并可重试一次，同时让模型自己管目标、知道什么时候该收口。

在 DeepSeek Harness（DSH）里提供两套护栏，作为两个独立条目加载：

- **输出护栏**（条目 `output-guard`）：拦下失控的模型输出——文字死循环、大段空白、过长的工具参数，以及没有正文或可用工具调用就结束的回复——并带着一条纠正提醒重试失败步骤一次。覆盖主助手和子代理，非 Agent 模型请求原样通过。
- **目标护栏**（条目 `goal-guard`）：让模型自己暂停、修改、完成目标，并告诉它什么时候该收口；模型连工具都调不动时按会话记录数续跑空转，必要时替模型把目标停下。

## 使用条件和安装

DSH 需要提供兼容的 LLM、agent、tools 和 systemPrompt 服务。开发依赖面向 DSH 0.2.2-rc.1。需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。这是宿主插件，没有独立界面或外部服务。

保留所在仓库中与插件相邻的共用 `tooling/` 目录。不能只拿这个源码目录单独构建。在本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

在 DSH profile 的包清单中合入链接依赖和组合包，保留已有条目：

```json
{
  "dependencies": {
    "dsh-guard": "link:../../path/to/oh-my-harness/dsh-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-guard"]
    }
  }
}
```

把示例链接改成相对于你的 profile 目录的路径。使用 DSH 安装所支持的 pnpm 安装 profile 依赖，再重启 DSH。组合包已经登记了 `output-guard` 和 `goal-guard` 两个条目，不要重复插入。安装环境提供启动检查器时，重启前先校验 profile。

## 输出护栏检查哪些情况

- 思考和正文中的连续文字循环。比较时忽略空白和常见 Markdown 强调符号；不把纯数字或纯标点结构算作循环。工具参数不做重复检测，避免普通代码触发误判。
- 思考、正文或工具参数中的过长连续空白。工具参数中的 JSON 空白转义也计入上限。
- 每次工具调用的参数总长度。不同调用分别计数。
- 正常结束或达到输出额度时，没有正文，也没有可用的工具调用。因输出额度耗尽而被丢弃的工具调用，不算可用结果。

达到上限时，插件会关闭上游输出流，把这次尝试记为失败。启用 `autoRetry` 后，写入标有 `dsh-guard` 来源的通知，并对每个助手、每轮、每步最多重试一次。不会把失控内容再塞回提示。第二次失败交给宿主原有的错误处理。插件不换模型，也不改长期系统提示。

## 目标护栏做什么

- 在每个 agent 自己的工具层遮蔽同名 `update_goal`：`pause` 改成模型能自己恢复的停止（记成 blocked），不再卡死；在宿主不给权限的「继续 / 结束」通知轮，顶层会话直接调目标服务补上 `edit`、`complete`、`blocked`、`resume`；用户亲手点的暂停不恢复，子代理不补位。
- 在有目标工具的会话里加一段收口规则：什么时候该完成、暂停、改终点，别把「等别人、等用户」当成剩余工作一轮轮空转。
- 按会话记录数自动续跑的空转：连续若干轮没有一次工具调用成功，就替模型把目标停下，免得干烧。

## 配置

在 DSH profile 补丁中分别覆盖两个条目（命名空间就是各自 id）：

```yaml
- id: output-guard
  config:
    enabled: true
    autoRetry: true
    maxBlankRun: 2000
    maxToolArgsChars: 50000
- id: goal-guard
  config:
    enabled: true
    modelControl: true
    wrapUpGuidance: true
    stallRounds: 3
```

所有设置都会即时生效，在新请求或下一步开始时读取。

**输出护栏**

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

**目标护栏**

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关：关掉后收口规则、工具包装、空转刹车一起停用；关掉期间不累计空转，重开后从零开始。 |
| `modelControl` | `true` | 模型暂停改成可恢复的停止；没权限的轮次补上 edit / complete / blocked / resume（用户亲手点的暂停除外）。关掉退回宿主原样。 |
| `wrapUpGuidance` | `true` | 有目标工具的会话里加收口规则。 |
| `stallRounds` | `3` | 自动续跑连续几轮没有一次工具调用成功就停下目标；`0` = 不管。 |

用 `enabled: false` 可绕过输出护栏；`goal-guard` 的 `enabled: false` 会把收口规则、工具包装、空转刹车一起停掉（关掉期间不累计空转、重开后从零开始）。要禁用整个条目，覆盖对应 `id` 并设 `disabled: true`。

## 开发和测试

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

测试使用虚构文字、工具参数和假宿主，检查重复边界、输出分片、上游取消、空白、参数限制、正常透传、只重试一次、目标暂停与补位、收口规则的空转计数等。真实 DSH Session 测试核对失败尝试不会进入整理后的会话历史、纠正通知会保留。这些测试不调用模型，也不能证明真实服务商的行为。

## 许可

MIT。见 [LICENSE](LICENSE)。
