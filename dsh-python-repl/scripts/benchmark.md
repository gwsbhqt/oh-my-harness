# 内核同题评测

这套入口通过 App 自带的无界面运行方式调用真实模型。每题新建独立工作目录、会话和 DSH_HOME，只允许在该题的临时目录里写文件。日常 profile 不会被修改。隔离进程的宿主策略设为 danger-full-access，避免 macOS 不支持嵌套 Seatbelt；所有进程的实际写入仍由外层 sandbox-exec 限制在该题目录内，测试会真实验证目录外写入被拒绝。两种模式共用这层边界，命令执行后端不可用的样本不会计入对照。凭据由宿主只读引用原文件，不复制密钥。

首批十二题来自真实的进程日志分析任务，保留 CSV 的输入结构，使用确定生成的数据。四类题分别检查总量、按进程汇总、内存峰值和时间范围，每类有 24、600、12000 行三个规模。这里没有私人进程日志，也不能把这些题说成十二种独立业务。它们尚未覆盖取消、审批、长任务和多 Agent。为统一三组条件，本入口不加载日常记忆、技能目录和项目说明，结果不能等同于日常完整上下文的用量。

## 运行

需要 macOS、当前 DSH App、已构建的插件和已经准备好的 Python 3.14 内核环境。先查看完整参数：

```sh
node scripts/benchmark.ts --help
```

只生成测试数据，不调用模型：

```sh
node scripts/benchmark.ts --output /tmp/ptc-bench-fixtures --dry-run
```

真实运行必须显式选同一个模型、网关和凭据引用。下面的大写内容是待替换参数，不是密钥：

```sh
node scripts/benchmark.ts --output /tmp/ptc-bench-run \
  --provider PROVIDER --model MODEL --base-url GATEWAY --key-ref KEY_REFERENCE \
  --mode native --variant current
node scripts/benchmark.ts --output /tmp/ptc-bench-run \
  --provider PROVIDER --model MODEL --base-url GATEWAY --key-ref KEY_REFERENCE \
  --mode ptc --variant current
```

推荐用一个交替批次保持三组条件一致：

```sh
node scripts/benchmark.ts --output /tmp/ptc-bench-matrix \
  --provider PROVIDER --model MODEL --base-url GATEWAY --key-ref KEY_REFERENCE \
  --matrix --baseline-root /absolute/baseline/dsh-python-repl
```

它对每道题轮换普通工具、当前内核和旧内核的先后顺序，最终写入批次根目录的 results.json。旧插件必须先在隔离工作副本里构建。也可以单独传 `--plugin-root /absolute/baseline/dsh-python-repl --variant baseline` 运行旧版。每个版本与模式的输出目录必须不存在，入口拒绝覆盖旧结果。`--tasks total-24,groups-600` 可以缩小范围。用 `--kernel-venv` 指定现有 kernel-venv 父目录；评测只读复用它，不临时安装解释器或依赖。

合并多份结果：

```sh
node scripts/benchmark.ts \
  --reports /tmp/ptc-bench-run/current-native/results.json \
  --reports /tmp/ptc-bench-run/current-ptc/results.json \
  --reports /tmp/ptc-bench-run/baseline-ptc/results.json
```

## 结果口径

每题保留原始事件、诊断、输入摘要和结果。验收检查实际生成的 answer.json，并核对输入未被改动；助手说“完成”不算通过。超时、非零退出、缺失成功终态和插件未激活都会标为无效。答案错误单独记失败。任意题失败或无效时，命令最终退出 1。答案错误会继续后续题；环境无效会立即停止该批次，已完成的结果仍会保留。

输入摘要、模型和 App 构建必须相同才能比较。PTC 在开跑前固定一份运行副本，并记录宿主代码及 Python 源码的指纹。准备期间源文件发生变化会拒绝开跑，避免构建影响正在比较的版本。不同版本的输入必须一致；重复任务会被拒绝。比较用量、步数和耗时只取双方都正确完成的同一批题，提前失败不会被当成更快或更省。

用量来自宿主提交步骤时返回的 usage。缺失字段保留 null，不按零处理。totalTokens 包括提供方计入的缓存用量，不能直接当成费用。modelToolCalls 统计模型直接发出的调用：PTC 中是代码格，普通模式中是工具调用，不能把它当成两边实际动作数。耗时包含启动和执行。

每题默认只跑一次，模型输出有随机性。正式判断改进效果应增加重复轮次并交替版本顺序，记录缓存命中和运行环境。一次日志分析评测不能证明对 Prime Agent、Factory 或所有任务的优势；没有真实运行的产品不能列入胜负表。
