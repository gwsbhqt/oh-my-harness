# dsh-monitor

把 Claude Code 的 `Monitor` 工具搬到 DSH：**起一条长驻命令，它的 stdout 每出一行就送进会话**。
适合日志跟随、构建状态和其他逐行输出的事件流。

条目 id / 设置命名空间都是 `monitor`。公开安装和使用说明见 [README.md](README.md)。

## 它补的是哪个洞

DSH 原本只有「**先跑完，再去看**」这一种后台任务（`bash run_in_background` + `job_output`）：
输出攒在缓冲区里，等模型想起来读才被读走。编译、跑测试够用，但**事件流**不行——
事件是现在发生的，等模型去 poll 就已经晚了；而让模型自己轮询，就是拿 token 买延迟。

| | `bash run_in_background` | `monitor` |
|---|---|---|
| 输出什么时候到模型手里 | 模型调 `job_output` 时 | 产生的那一瞬间，**自动送进会话** |
| 会话闲着的时候 | 不会醒 | **直接开一轮**（`agent.steer`） |
| 适合 | 编译、跑测试、跑脚本 | IM 监听、日志跟随、CI 状态、文件变化 |

## 三个现成机制拼出来的，没有重造

| 要的东西 | 用的是什么 |
|---|---|
| 进程生命周期、并发上限、会话销毁时自动收尸、GUI 任务面板 | `ctx.jobs`（登记为 `kind: 'monitor'` 的后台任务） |
| 把内容送进会话 | `agent.steer()` —— 闲时开一轮、忙时在下一步边界收 |
| 分离的 stdout / stderr、进程组终止 | `ctx.subprocess.spawn`（`stdout: 'pipe'`） |

所以 `job_list` / `job_kill` 对 monitor 照样管用，它只是多了一层「输出自动送进会话」。

## 工具

| 工具 | 干什么 |
|---|---|
| `monitor` | 起一条长驻命令。参数 `command` / `description` / `persistent` / `timeout_ms` / `workdir`，另有单条 `delivery` 和 `ignore_stdout_lines`；基础用法对应 Claude Code 的 `Monitor`，这两个参数是本插件扩展 |
| `monitor_output` | 回看最近 N 行（**不消费**，游标不动） |
| `monitor_kill` | 停掉（等价于对这条 job 调 `job_kill`） |
| `monitor_list` | 列自己起的 monitor，运行中的排前面；带 `last_line_at`（最后输出时间，被排除的心跳行也计入），是「还在不在干活」的判据 |

送进会话的消息长这样，抬头是 id + 标签，后面是原始行：

```
<system-reminder>
[dsh-monitor] monitor-1 · Example events

{"event_id":"example-1","channel":"demo","sender":"Example User","content":"A test event arrived."}
</system-reminder>
```

提醒正文和一行摘要都由 `tooling/runtime/notice.mjs` 生成：`[dsh-monitor] <task> · <event>`，正文是英文。

## 单条投递和已知心跳

- `delivery: "inject"` 只让这条监听的通知排入上下文，不唤醒空闲会话；`steer` 会唤醒，`followup` 单独开回合。
- 没传 `delivery` 时仍现读插件的 volatile 配置。显式传入的值留在这条监听记录中，进程崩溃重拉、跟着 DSH 重启接回后都不变。
- `ignore_stdout_lines: ["heartbeat"]` 只排除明确指定的**完整 stdout 行**的自动投递。默认空，不猜哪条是心跳、不按前缀或正则吞业务内容；匹配在截断前进行。
- 被排除的行仍按既有预算留在 `monitor_output` 和 `job_output` 中。异常退出仍是真失败，stderr 诊断照常保留；只有已知心跳的正常退出不误报「没产出 stdout」。
- 这只控制 monitor 自己的通知。通用 tool-jobs 的任务结束通知由宿主 `completionDelivery` 另行控制。
- `persistent:false` 在代理下次 idle 时停，即使命令还没跑完。返回说明会明确这一点；不能结束回合后又承诺这条监听稍后唤醒自己。
  命令还没自己退出就被这样停掉时，补一条不唤醒的通知（固定走 inject，不看投递设置），下一轮开始时模型能看到它；命令已经自己退出的不补。这只管 monitor 自己，宿主通用的后台任务结束通知照旧由宿主管。

## 三条容易踩空的地方（都已处理）

1. **stdout / stderr 必须分开**。`ctx.shell`（bash 执行器）的 `readOutput()` 会把 stderr 拼进
   同一个 delta（`[stderr]` 分段）——对「stdout 是事件流、stderr 是诊断」是致命的：一句报错会被
   当成一条事件送进会话。这里直接走 `ctx.subprocess`，拿两个独立的 `Readable`。
   stderr 落 `$DSH_HOME/monitor-logs/<id>-<uuid>.log`，每条监听独立建档，重拉追加。
2. **多字节字符会跨 chunk 断开**。包含中文的事件流中，一个 UTF-8 汉字可能被切成两半，
   `chunk.toString()` 拼行会拼出乱码。用 `StringDecoder` 兜住半个字符。
3. **`bash -lc` 会读用户 profile**。若 `.profile` 输出诊断，`-l` 会把它写进 stderr，
   于是每条监听结束时都收到一条假警报。改用 `bash -c`（环境本来就是显式传下去的，
   不需要靠登录 shell 找 PATH）。

## 结束通知什么时候补

正常退出**不补**——`dsh-tool-jobs` 已经发过一条通用任务结束通知，每条都补是噪音。
只在三种「不说就不知道」的情况下补一条，并把 stderr 末尾带上：

- 异常退出（非 0）
- 超时被停
- 进程自己退出、**一行都没产出**——这正是「命令写错了，Monitor 起了就结束」的形状
  （未知 flag / scope 未开 / auth 过期，stderr 里有原文）

被人叫停（`monitor_kill`、会话销毁、插件卸载）不补：
那是有人决定的，没出过行只说明事件还没来；补一条还会把闲着的会话叫醒。
例外是非持久监听随回合结束停掉、命令还没跑完：模型多半以为结果稍后会自己送来，所以补一条
「因本轮结束被停止，命令没有跑完」的通知，固定不唤醒。

进程结束时队列里还没送出的行，会在结算前全部分批送完，不会停在「还有 N 行在排队」。
stderr 日志写不进去（目录不可写、磁盘满）时只记一条 warn，这条监听之后不再写日志。

## 插件间直接挂接后台服务

其他插件可用 `await ctx.parallel('dsh/monitor-start', request)`，请求为
`{ owner: string, command: string, cwd: string, label: string, restart?: 'never' | 'on-failure', quiet?: boolean, result?: { id, owner, label, command, cwd } }`。
启动登记完成后才填写 `result`；未安装本插件时它仍缺省，调用方可据此报告不支持。校验、会话解析、启动失败直接向调用方抛错。

`owner` 经现有会话服务解析，返回的 `result.owner` 是实际目标会话 id。命令、主人不能为空；目录必须是确实存在的绝对目录，不会回退到调用方目录。
启动沿用工具和重启恢复的同一套任务、进程与环境计算。固定持久运行、无寿命上限；`restart` 缺省 `on-failure`（异常退出重拉），给 `never` 则退出即结束。stdout 以 `inject` 排入目标会话，不主动开启模型回合；`quiet: true` 时一行都不送进会话，只留在 `monitor_output` / `job_output` 里供主人回看。暂停、重启接回也沿用已有记录和恢复协议，不另设服务管理器。

## 跟着 DSH 重启续上

持久监听跟着重启暂停并接回。本插件和 dsh-use 约定了三个事件（两个插件不互相导入，只认名字，定义在 `src/index.ts` 的 `RESTART_*_EVENT`）：

| 事件 | 谁发 | 本插件做什么 |
|---|---|---|
| `dsh/restart-survivors` | `quit-check` | 把持久、有主人、还在跑的监听 id 填进传来的 Set，重启命令据此把它们当成「不用等」 |
| `dsh/restart-prepare` | `restart-prepare`（重启命令退出前调） | 先写 `$DSH_HOME/monitor/suspended.json`（600 权限，不存环境变量），再逐条停掉；停之前挂一个 `jobs.wait`，宿主看到有人在等就不发通用的结束通知，免得把闲着的主人叫醒、App 又退不出去 |
| `dsh/restart-abort` | `restart-abort`（没退出成时调） | 按文件马上接回 |

新进程加载插件时先读文件，对每条：经会话服务的 `resolveAgent` 找到主人（没加载就先加载，服务没就绪最多等 60 秒），用主人会话现算环境、同一条命令同一个目录重新拉起。确认成功后才移除该项，并给主人送一条**不唤醒**的说明：新编号、旧编号作废、中间停了多久、这段输出没收到。暂停超过 30 分钟的记录不自动接回（那是很久以前的一次关机）；恢复失败项保留，可再次调用 `restart-abort` 重试，下一次暂停也不会覆盖它们。主人还能找到时，失败会唤醒主人告知原因；主人无法加载时保留日志，`restart-abort` 也会返回失败原因。损坏或读不出的文件原样保留并报错。

`restart-abort` 使用异步确认协议：监听方恢复结束后填入 `{ revived: string[], failed: { id, owner, error }[] }`，调用方必须等待事件完成；`revived` 只含确认成功的旧编号。启动恢复和回滚串行处理，不能因并发请求重复拉起。

- 接回后是**新编号**：宿主的任务注册表是进程内的，新进程发新编号（0.2.1 起是随机串），没法沿用旧的。
- 非持久监听不接：它本来就随回合结束。
- 剩余寿命（`timeout_ms`）照算，不重新给满。
- 重启期间的输出是真丢了，不补：本插件不知道每条命令怎么「从断点续」。说明里提醒模型自己补查这段时间。

## 没有超时，但有崩溃自愈

**dsh-monitor 默认不带任何超时**——连定时器都不起，不存在「多久没输出就停」这种逻辑。
默认持久监听会在进程自己退出（且不重拉）、显式 kill、会话销毁、插件卸载或 App 退出时停。
`persistent:false` 另有明确的回合结束即停规则。`timeout_ms` 是**寿命上限**，缺省 `0` = 不设；给长驻监听设它，等于给自己埋一个「到点自己死」。

要挂几个星期，用 `restart: "on-failure"`：

| 策略 | 行为 |
|---|---|
| `never`（默认） | 退出即结束。一次性命令（`echo`、跑个脚本）要的就是这个 |
| `on-failure` | 非 0 退出 / 起不来才重拉，正常退出（exit 0）不重拉。**长驻监听用这个** |
| `always` | 只要不是被人叫停的，一律重拉 |

重拉的四条设计：

- **被人叫停永远不重拉**。kill、超时、会话销毁、插件卸载——这四种是「有人决定了」，
  重拉等于抗命。判断顺序也是刻意的：先看是不是被叫停，再看策略，最后才看次数上限。
- **id / 历史 / 日志都不变**。重拉是同一个 job、同一个编号，不是新开一条——
  模型不用重新认 id，`monitor_output` 也还看得到崩溃前的输出。
- **两条流必须重建**。`LineReader` 自带解码器和半行残留，跨进程复用会把上一轮没凑完整的
  那半行粘到新进程的第一行前面，看起来像一条根本不存在的消息。
- **崩溃循环不刷屏**。2 倍退避（封顶 60s）；通知前 3 次每次都报、之后每 10 次报一次；
  跑满 `restartLimit` 就按失败结算并报一次。退避计数在「一轮活过 `restartResetMs`」之后
  清零——把「崩溃循环」和「跑了一周崩一次」分开对待（`restartResetMs: 0` 的语义是
  **从不判定健康**，否则退避永远涨不起来、次数上限永远够不到）。

## 选项

三层叠加：schema 默认值 → `cordis.patch.yml` 条目 config → profile patch（GUI 设置页
改的就是这层）。所有字段都是 volatile：改完立刻生效、不重启插件。**GUI 表单不是宿主
自动生成的**——内置插件页里那张配置卡片是 client 半自己注册的（`src/client/index.tsx`，
按官方 agent-loop 的模式：`plugins.item` 槽位 + ui-primitives 的 SettingsForm 套件）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `delivery` | `steer` | `steer` 闲时开一轮 / `inject` 不唤醒 / `followup` 每条单独开一轮 |
| `coalesceMs` | 200 | 攒多少毫秒合成一条消息再送；0 = 每批就送 |
| `maxLinesPerNotice` | 50 | 一条通知最多带多少行，超出的下一批继续 |
| `maxBytesPerNotice` | 32768 | 同上，按字节 |
| `maxLineBytes` | 8192 | 单行超限就截断，并显式标注截掉多少 |
| `historyLines` | 2000 | 内存里保留最近多少行供回看 |
| `stderrTailLines` | 20 | 结束通知里附多少行 stderr |
| `defaultTimeoutMs` | 0 | `timeout_ms` 缺省值；0 = 不设上限 |
| `maxTimeoutMs` | 86400000 | `timeout_ms` 上限 |
| `graceMs` | 3000 | 终止进程的宽限期 |
| `restart` | `never` | 进程自己退出后的重拉策略（见上一节） |
| `restartDelayMs` | 1000 | 第一次重拉前等多久；连续失败 2 倍退避 |
| `restartMaxDelayMs` | 60000 | 退避上限 |
| `restartLimit` | 0 | 连续重拉次数上限；0 = 不限 |
| `restartResetMs` | 60000 | 一轮活过这么久算健康，退避清零；0 = 从不判定健康 |
| `logDir` | `""` | stderr 日志目录；空串用 `$DSH_HOME/monitor-logs` |

## 关掉它

在 profile 的 `cordis.patch.yml` 里给同一个 id 写 `disabled: true`
（GUI「插件列表」页点禁用写的也是那一行）：

```yaml
- id: monitor
  disabled: true
```

## 验证

```bash
pnpm run check      # typecheck + build + 单测
```

- `test/monitor.test.ts` —— 插件自己的行为：按行切流、多字节跨 chunk、合并成一条通知、
  stderr 不进事件流、结束通知的三种触发、`monitor_kill`、非持久监听随 idle 停掉（没跑完补一条不唤醒通知、已跑完不补、持久监听不受影响）
- `test/delivery.test.ts` —— 真 jobs + 真 subprocess：单条投递、默认实时配置、心跳精确排除但回看保留、重拉设置不变、真实失败及返回说明。
- `test/integration.test.ts` —— **真** `LocalJobRegistry` + **真** `LocalSubprocessRuntime`
  跑一条真命令，验插件对两个 seam 的用法与真实现一致。它抓到过一个真 bug：
  漏写 `export const inject` 时，cordis 的 context Proxy 会让 `ctx.jobs` 直接抛
  `cannot get property "jobs" without inject`，插件在真宿主里根本起不来
