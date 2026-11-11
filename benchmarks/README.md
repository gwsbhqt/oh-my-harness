中文 | [English](README.en.md)

# 可重复运行的文本量测量

这些测量只使用虚构数据和本地代码。它们不调用模型或接口，也不操作浏览器或访问网络。它们测量返回给对话的文本量，以及当前压缩附录的实现。它们不测量回答质量、延迟、服务商账单、缓存命中，也不测量真实 DSH 会话。

## 运行两项测量

需要 Python 3.10 或更新版本，以及支持直接处理 TypeScript 类型标注的 Node.js 22.18 或更新版本。不需要第三方包、模型密钥或插件安装。在仓库根目录运行：

```sh
python3 benchmarks/run.py --output benchmarks/results.json
```

脚本会根据自身位置找到根目录。对于尚未发布的临时副本，可以用 `--source-root` 指向含有 `dsh-compaction-bound` 的源码副本。这里只读取源码。报告只包含相对于仓库的源码名称和 SHA-256 哈希，不包含源码副本的实际位置。

要校验已有结果而不覆盖它，运行：

```sh
python3 benchmarks/run.py --check benchmarks/results.json
```

任何不一致都会以非零状态退出，包括源码哈希不一致。重新生成基准前，先审查变化。仓库中的 [results.json](results.json) 是这些命令实际生成的输出，不是手工填写的表格。结果不含时间戳和机器身份信息，因此相同源码和样例会产生相同结果。

## 1. 返回整份日志，还是把日志留在本地只返回答案

[run.py](run.py) 默认以固定方式生成 10,000 条 JSONL 记录。每条记录包含序号、虚构服务、状态、延迟和重复的示例诊断文字。没有导入用户日志。要查看完整样例和结论，运行：

```sh
python3 benchmarks/run.py --export-log example-log.jsonl --export-conclusion example-answer.json
```

生成器就是样例的定义，大体积原始日志有意不提交。报告包含原始日志哈希。`--rows` 接受 1 到 100000，只改变本地保留数据这一测量的工作量。

两种方式都读取同一份完整日志。对照方式返回全部 JSONL 文本。本地方式把日志解析到 Python 变量。随后统计各服务错误数和慢记录数，并找出最大延迟。最后返回结论和三条带序号的示例错误记录。报告大小前，它会检查记录是否完整、独立算出的预期错误数、各服务计数总和，以及从原始数据中查找样本的结果。

估算方法是 **ceil(UTF-16 code units / 4)**，分别应用于每份返回文本。UTF-8 字节数另行报告。这是固定的字符估算方法，不是任何服务商的分词器。它对部分语言、大量符号和图片输入会不准确。文本减少来自这次查询和这个冗长的虚构样例，不是插件普遍能达到的比例。如果任务需要每一行日志，就必须返回或查看更多数据。

[results.json](results.json) 中的 `locality.raw` 和 `locality.filtered` 是可比较的两份返回内容。`locality.result` 是筛选后大小所对应的确切答案。可选导出的结论是这个答案的规范 JSON 序列化形式。两边都不计入提示词、Python 代码、工具定义、中间推理、服务商封装、输出 token 和缓存计价。脚本用标准 Python 演示数据流原则，不声称测量 DSH 传输或内核恢复。

## 2. 压缩后的保留量与附录预算

Python 入口从[真实插件配置定义](../dsh-compaction-bound/src/index.ts)读取数字默认值，再调用 [compaction-budget.mjs](compaction-budget.mjs)。后者直接从[生产实现](../dsh-compaction-bound/src/summary.ts)导入 `boundItems`、`itemLine`、`attachmentText` 和 `parseAttachment`，没有另写一份限额算法。找不到源码、无法解析默认值、无法导入 TypeScript，或任一必须成立的条件不满足，都会以非零状态退出。

样例覆盖短历史、逐渐变长的历史、单条超过原文预算的消息，以及包含引号、换行和补充平面 Unicode 字符的文字。每次运行都检查几项条件：序列化后的原文行不超过 `userMessageChars`。索引与范围行不超过 `userIndexChars`。每个原始条目仍由完整条目、索引条目或范围计数代表。附录还能解析回限额后的条目。所有样例轮次、时间戳和会话标识都是虚构的。

`verbatim_line_utf16_units` 和 `index_line_utf16_units` 包含每条 JSON 行及其换行。`framing_utf16_units` 计算剩余的标题、标签和历史读取说明。这些说明不在两类条目预算内。`appendix_estimated_tokens` 使用与日志测量相同的字符估算方法。`unbounded_appendix_utf16_units` 是对照值：使用同一生产渲染逻辑和全部原始样例消息，但不限制长度。

保留量设置 `retainTokens` 本身已经使用 DSH 近似的文本 token 单位。脚本给出一个有前提的示意计算：

```text
ceil((retainTokens * 4 + summaryChars + measured_appendix_utf16_units) / 4)
```

这是**在所述前提下的文本目标量**，不是下一次请求的严格最大值。它假设保留的近期历史符合 DSH 估算，且模型摘要没有超过目标。DSH 可能会保留一条跨越边界、不能拆分的消息。如果唯一一次缩短尝试未通过验证，插件会保留超长摘要。系统指令、工具、图片、协议编码，以及任意长度的自定义 `historyReaderHint` 都不在这个示意计算内。测量样例使用通用默认读取说明和固定长度的虚构会话 ID。

因此，报告不会把合计目标量说成真实模型 token、注意力质量、吞吐或费用。要测量这些，需要另行规定协议和模型，并在有权处理数据的前提下收集完整最终请求与服务商用量。这份离线测量不做这些事。

## 结合设计文档阅读结果

- [数据留在本地](../docs/design/python-data-locality.md)解释为什么可以把数据保留在内核变量中。
- [三代压缩方案](../docs/design/three-generations-of-compaction.md)解释当前的安全与可观察性选择。
- [输出防护](../docs/design/output-guard.md)区分对话展示预算与防止模型输出失控的措施。

引用数字时，链接到相关报告字段，并紧邻说明估算方法、工作量和未计入项。源码默认值或附录格式变更后，重新运行。
