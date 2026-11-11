中文 | [English](README.en.md)

# dsh-compaction-bound

[← 返回首页](../README.md#由哪几块组成) · [教程](../docs/dsh-compaction-bound.md)

**一句话：** 聊天记录太长要压缩时，你说过的原话照抄保留，不让模型转述；压缩后的总长度有固定上限。

给 DSH 自带的上下文压缩增加限制，控制压缩后保留的近期原文和摘要长度。它扩展官方 `@deepseek-ai/dsh-compaction-basic` 引擎，不改压缩触发点、模型上下文窗口或回复长度上限。

## 使用条件和安装

需要兼容的 DeepSeek Harness（DSH），提供模式注册表、LLM 运行环境、会话查询服务和官方基础压缩引擎。还需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。包清单记录已测试的宿主依赖；当前测试使用 DSH 0.2.2-rc.1。保留所在仓库中与插件相邻的共用 `tooling/` 目录。不能只拿这个源码目录单独构建。

在本插件目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

在 DSH profile 的包清单中合入链接依赖和组合包：

```json
{
  "dependencies": {
    "dsh-compaction-bound": "link:../../path/to/oh-my-harness/dsh-compaction-bound"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-compaction-bound"]
    }
  }
}
```

把示例链接改成相对于你的 profile 目录的路径。使用 DSH 支持的 pnpm 安装 profile 依赖。提供启动检查器时先校验 profile，再重启 DSH。组合包已经登记条目，不要重复插入。

## 行为和限制

对于已登记模式中的基础压缩条目，只有没有明确配置 `retainTokens` 和 `retainRatio` 时，插件才补上固定的 `retainTokens`。其他模式设置原样保留。重新挂载的模式影响新会话和 DSH 重启后恢复的会话；已经运行的会话可能仍绑定旧版模式。

识别出压缩请求后，只把最后一条压缩指令换成分栏限长的摘要指令。摘要成功生成后，单独附上一份从用户原文和此前已识别检查点附录直接整理的附录。不要求模型转述或挑选这些原话。非文本附件，以及通知、工具结果和助手回复里的文字，都不算用户亲手写的消息。

附录有两份独立额度。先在 `userMessageChars` 内逐字保留最新用户原文，再把更早的消息列成索引，记录轮次、时间、字符数和简短开头。索引超出 `userIndexChars` 时，把最早条目合成轮次范围。会话日志仍保留原文，但本插件不提供历史读取工具。索引对应的原文需要宿主另行提供的读取能力。默认附录会说明这个限制，不冒称某个不可用工具存在。如果宿主提供读取能力，可用 `historyReaderHint` 写明实际工具及调用方式；写提示不会安装或验证读取工具。

`summaryChars` 只管模型写的摘要，不含附录。摘要过长时，插件最多再请求模型一次，只压短这份摘要。只有压短稿不超限、必需栏目的标题和顺序都保留、**Active User Requirements** 一字不变时才采用。尝试失败或核对不过时，保留原稿并记录 `over-kept`，所以这不是严格的输出长度保证。最初的摘要没完成或失败时，沿用宿主失败处理，不附用户原文。

宿主注册表结构或压缩指令变了，对应接入处会警告，并保留宿主原行为。测试会核对这些宿主约定。保留量使用宿主每四字符估算一个 token 的口径，不是模型分词器的精确计数；不承诺固定的实际 token 节省或费用下降。

## 配置

在 profile 补丁中覆盖现有组合包条目：

```yaml
- id: compaction-bound
  config:
    retainTokens: 12000
    boundSummary: true
    summaryChars: 12000
    userMessageChars: 8000
    userIndexChars: 2000
    historyReaderHint: ''
```

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `retainTokens` | `12000` | 基础压缩保留的近期原文估算 token 数，最小 1000。修改会重新挂载模式；重启 DSH 后，恢复的会话才使用新一代模式。 |
| `boundSummary` | `true` | 改写可识别的压缩指令，并附用户原文。设为 false 使用宿主原有摘要流程。 |
| `summaryChars` | `12000` | 模型摘要的目标字符数，最小 2000，不含附录。超长时最多压短一次。 |
| `userMessageChars` | `8000` | 逐字用户原文的额度，按写成序列化行后的长度计，最小 1000。 |
| `userIndexChars` | `2000` | 更早消息的索引额度，按序列化行长度计，最小 300。 |
| `historyReaderHint` | `''` | 可选的会话历史读取提示替换句。每个 `{sessionId}` 都按字面替换成当前会话 ID；仍追加轮次范围说明。空值使用通用宿主读取提示。不知道会话 ID 时不写这句话。 |

除 `retainTokens` 外，设置均即时生效，在新压缩请求中读取。禁用整个条目时，在 `id: compaction-bound` 上设 `disabled: true`。只关闭 `boundSummary` 不会撤掉保留量调整。

插件写入 `$DSH_HOME/plugins/compaction-bound/status.json`；未设置变量时使用 DSH 默认状态目录。文件记录已挂载的保留量和最近 20 次摘要报告，包括附录计数，以及 `within`、`condensed`、`over-kept` 或 `failed` 结果。这些用于排查运行情况，不是费用报告。

## 开发和验证

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

测试覆盖模式保留量、请求改写、附录长度和来源选择、既有检查点格式、压短核对、取消和状态持久保存。宿主链路测试使用真实的会话存储和官方引擎，配合虚构模型适配器连续压缩三次。它验证原消息仍能从会话事件中读回；不调用真实模型，也不证明某个服务商的 token 节省。

## 许可

MIT。见 [LICENSE](LICENSE)。
