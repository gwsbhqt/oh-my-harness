中文 | [English](dsh-python-repl.en.md)

# 使用保留变量的 Python 代码单元

`dsh-python-repl` 为每个 DSH 会话提供一个 Python 解释器，在多次 `run_code` 调用之间持续运行。任务需要多次工具调用、复用分析过程，或避免把同一份数据反复打印进对话时，可以使用它。变量和函数在后续代码单元中继续可用，顶层 `await` 让 Python 能协调异步工作。

## 先处理完整值，再展示证据

从一个小代码单元开始，定义数据或收集工具结果。把完整结果保存在变量，只展示下一步判断需要的证据。下面的虚构例子只使用内存数据：

```python
records = [
    {"item": "sample-a", "passed": True},
    {"item": "sample-b", "passed": False},
]
failed = [record for record in records if not record["passed"]]
{"total": len(records), "failed": len(failed)}
```

后续代码单元能查看 `failed`，无需重新创建 `records`。末尾表达式会产生结果，单独赋值不会。对于较大的对象，`await repl.preview(records)` 提供有限预览。预览不能证明上游响应完整。计数或下结论前，检查分页、截断和命令退出状态。`await repl.require_complete(result)` 可以校验前台 Bash 结果，但不能证明任意文件读取或分页响应完整。

DSH 工具通过 `tools` 调用。六个固定辅助函数是 `read`、`write`、`edit`、`bash`、`glob` 和 `grep`。受信任 Python 技能位于 `skills` 下，调用陌生技能前先用 `await skills.list()` 和对应的 `await skills.describe(...)` 查看说明。发现技能与成功导入是两种状态，要检查启动报告中不可用的导入。

## 确认进展与恢复

内核页签展示变量名和执行历史。在后续代码单元检查先前的值，确认它确实保留。内核或 DSH 重启后，先读恢复报告再继续：可序列化的值可能恢复，但打开的连接、进程和运行中任务不会作为活资源恢复。重试前，先核对尚未确定结果的外部动作。

必须在代码单元结束后继续执行的 Python 工作，使用 `repl.background`。之后收取结果并检查失败。必须跨内核存活的服务，应放进受管理的 DSH 后台任务。解释器是分析环境，项目测试和脚本应通过项目自己的环境运行，不要把项目依赖装进内核。

## 理解信任边界

这是在 DSH 中运行的受信任 Python 环境，不是沙箱。Python 代码和导入的技能可以直接访问文件、网络和进程。通过 DSH 工具发起的调用仍需经过审批和策略检查。这些检查不会把任意 Python 操作隔离起来。只配置你信任其代码的技能目录。

取消不会撤销已经发生的外部效果。线程或脱离进程可能继续运行，超时也不能证明远程动作是否完成。恢复前检查已保存结果。

该实现只支持并测试了 macOS。它替换 TypeScript 代码运行环境，并禁用依赖该运行环境的工作流。运行要求、安装、全部设置和快照行为见[插件说明](../dsh-python-repl/README.md)。[Python 数据留在本地](design/python-data-locality.md)解释为什么保留完整值和控制展示量有用。
