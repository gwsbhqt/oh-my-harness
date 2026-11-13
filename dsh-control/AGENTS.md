# dsh-control

命令、Python API、条目 id、设置命名空间、通信与重启状态目录、通知来源统一使用完整名称 `dsh-control`；Python 导入名为 `dsh_control`。升级必须先处理旧后台重启请求和跨机器监听，不能让两代执行者分别持有不同目录的锁。

把**正在运行的 DSH** 开放给同一台电脑上的外部 agent（Hermes、Claude Code、Codex……）。一共四块：

| 块 | 在哪 | 做什么 |
|---|---|---|
| 插件 | `src/`（入口 `index.ts`） | 在 DSH 进程里开本机通信口，命令全在这里实现 |
| 命令行 `dsh-control` | `src/cli/dsh-control.ts` → `lib/dsh-control.js`，入口 `bin/dsh-control` | 转发在线命令；doctor 离线检查、启动保护和等待由命令行完成 |
| Python API | `skills/dsh-control/src/dsh_control/__init__.py` + `skills/dsh-control/pyproject.toml` | `skills.dsh_control` 异步调用现有命令行，保留退出码、错误和回执；取消不自动重放 |
| skill | `skills/dsh-control/SKILL.md`（`skills/dsh-control/HERMES.md` 是 Hermes 接入步骤） | 教外部 agent 怎么用 dsh-control |

## 为什么要插件

DSH 没有给外部程序控制「正在运行的这一个」的入口（2026-09-30 核对 0.2.0-rc.2）：

- 网页端口 19387 只认浏览器登录；一次性令牌只在 App 启动时塞进打开的网址。
- `dsh` 命令行是另起一个新 DSH，不连现有的那个。
- SDK（JSON-RPC）服务也是新进程，里面的会话不是界面上的那批。

插件在 DSH 进程里，能直接调界面自己用的内部接口 `ctx.typertGateway.invoke({namespace, method, args, peer})`，
走的参数校验和界面完全一样。DSH 0.2.1 起每次调用都要带调用者身份（`peer`），不带就报 `Cannot read properties of undefined (reading 'signal')`；
本插件用连接服务建一个本机所有者身份，和网页端登录的本机用户权限相同（共用代码 `tooling/runtime/gateway.mjs`）。接口描述从 `ctx.typert.local.list()` 读（当前 140 个），
所以 DSH 升级新增的接口不改代码就能通过 `dsh-control api call` 调。

## 通信口

- Python 入口在共享 dispatch 前响应 `--capabilities --json`：`{ok:true,tool:"dsh-control",protocol:1,features:["local-routing","task-outcomes","send-receipts","chat-preflight","restart-receipts","settled-wait","done-notify"]}`，无需在线服务。
- `GET /v1/health` 也包含 tool/protocol 和 task-outcomes、send-receipts、settled-wait、done-notify（命令行带 `--settled` / `--notify` 时先核对后两项，旧插件在发送前拒绝）；CLI send/chat/wait 写前核对运行中服务，不将新入口握手当作旧插件已更新。

- `$DSH_HOME/dsh-control/dsh.sock`，目录 0700、socket 0600：只有同一系统账户连得上。同机不设令牌——能连它的
  程序本来就能改 `~/.dsh` 的一切。
- 通信口文件被删（DSH 进程还开着、外面却连不上）时，每 5 秒自查一次，没了就在原路径重新监听；路径上已是别的 socket 就不抢。
- Node 关监听时按绑定时的路径删文件，不管那里现在是谁的：插件热重载或重启时旧实例晚于新实例关闭，会把新实例的通信口删掉（复盘 I-029 复发的一种可能，文件实际被谁删的没有日志证实）。所以先绑在每次不同的临时名上，再硬链接到 `dsh.sock`（路径被占时链接失败，不顶掉别人），关闭时只在 inode 还是自己的时候删 `dsh.sock`。
- 命令行连不上时按 App 在不在跑给下一步：没在跑让跑 `start`；开着就说通信口会自动重建、稍等再试，仍不行跑 `doctor`、再 `restart`，不叫人去 `start`。
- 上面跑普通 HTTP：`GET /v1/health`、`GET /v1/commands`、`POST /v1/run {command,args,options}`。
  排查可以直接 `curl --unix-socket ~/.dsh/dsh-control/dsh.sock http://x/v1/health`。
- 每次调用记一行到 `$DSH_HOME/dsh-control/audit.log`（时间、命令、成功与否、耗时；不记消息正文）。
- 不对网络开放。跨机器由命令入口通过可选共享库 `agentkit/remote/` 里与 remote-host、computer-control、browser-control 共用的 SSH 代码，在远端运行 dsh-control；不新增网络通信口或令牌。`-H` 单次选机器，`use` / `pin` 记住 dsh-control 自己的默认机器，`use local` / `use --clear` 恢复本机。

## 命令

命令表在 `src/commands.ts` 的 `COMMANDS`，参数解释也在那里；`dsh-control help` 从插件实时取。实现都在 `src/service.ts`。

- 读：`health` `workspaces` `sessions` `status` `cwd`/`goal`（不带动作） `schedule`（列表、history） `last` `read` `quota` `models` `pick` `plugins` `config`（不带 --set）`api list|describe`
- 读：`web-url [--base 网址]`（这次启动的网页登录网址。口令只在 DSH 进程内存里、每次启动换一个，桌面端只交给自己的窗口，别处打开网页只能经这里取；口令不绑地址，`--base` 换成 SSH 转发后的地址照样能登录）
- 设置侧栏「远程机器」一页（`src/machines.ts` 宿主半，`src/client/` 页面）和命令 `open <机器> <服务>`、`tunnel close <机器> <服务>` 共用一套隧道。机器和服务都写在 profile 的 `dsh-control` 覆盖配置 的 `machines`、`services` 里，代码不认任何具体服务：每个服务不一样的地方都写成在对面跑的命令，`check` 检查（退出 0 算在跑，显示输出第一行；不写就在对面 `nc -z` 它的端口），`open` 取要打开的网址（只认以隧道地址开头的那一行；不写就直接开隧道地址），`actions` 卡片按钮（`confirm` 先确认）。命令里可写 `{base}` `{port}` `{localPort}` `{machine}`；命令经 `ssh <机器>` 交给对面登录 shell，参数使用 bash、zsh、fish 都支持的单引号拼接转义。本机端口 = 服务端口 + 10000 + 机器编号（例如 alpha 为 0、beta 为 1），清单重名、编号重复、算出的端口撞上都直接报错。按 `scutil --get LocalHostName` 认出本机不列（`os.hostname()` 有时会返回局域网地址）；`secondary` 的机器排在主机器后面，不另起分组。打开页面不自动查：先点「检查」，连得上之后「打开」和按钮才可点，隧道开着「关隧道」才可点。检查结果记在网页内存里，刷新才清空。页面把地址栏端口交给宿主：它等于本机某个服务的隧道端口，说明这页是别的机器经隧道打开的，这时按钮都在本机执行、「打开」会在本机屏幕弹浏览器，所以「打开」「关隧道」停用并标「经隧道查看」，检查和清单按钮照常。服务行不换行：一台机器的服务共用一组列（名字按最长的定宽，标签上下对齐），按钮文字和端口标签宽度固定，进行中的提示单独一格放在按钮左边，放不下就省略；标签那一格能压缩，窗口窄到放不下时先裁标签，不会压到右边的按钮上。点「检查」期间整张卡片压暗、所有按钮和临时端口的叉都停用，行高不变。隧道每个服务一条单独的 `ssh -f -N -L 127.0.0.1:<本机端口>:127.0.0.1:<服务端口>`，不走连接复用；关隧道只停在那个本机端口上监听的 ssh，别的程序占着就不动。`open` 取回的网址只在宿主交给 `open`，不回给页面（DSH 的网址带登录口令）。每台卡片末尾一行「临时端口」：只有一个「扫描」按钮，点了才 SSH 过去跑 `lsof` 列 TCP 监听（只回端口和进程名，命令行可能带口令），不自动扫；下拉右对齐、最高 360 像素、超出在菜单里滚（宿主菜单按整个视口算高度，放进设置弹窗会顶出屏幕），选中一个就拉起隧道并直接在本机浏览器打开，不用再按第二次，「对面是这台机器上清单里的服务」的行不可选并指回上面那行。没有手填端口的输入框：能看到的端口都从扫描结果里选，少一条重复的路。本机端口就用对面同一个号；本机这个号被占、或正好是清单里某台机器服务的隧道端口，就往上 +1 找第一个空的，提示里写实际用的端口。临时端口不进清单、不落盘：开着哪些按本机 ssh 监听的启动参数反推（`-L 127.0.0.1:<本机>:127.0.0.1:<对面> <机器>`），ssh 报错日志读完即删；开着的隧道在下面列成一行，点一下就在浏览器打开。端点 `/api/dsh-control.<端点>`（临时端口用到 `plan`、`scan`、`tempOpen`、`tempBrowse`、`tempClose`），自带浏览器登录校验。
- 读：`quit-check`（按当前活会话、后台任务和已打开会话的定时提醒核对退出阻碍；区分下一轮消息与下一步待领消息。不是宿主所有退出条件的公开承诺，系统权限提示和计划提醒仍须实际核对）
- 写：`notify [正文] [--title 标题|--no-title] [--body 正文|--no-body] [--sound|--no-sound]`（macOS 系统通知，默认标题「DSH」、正文「有一条新通知」、有声音；各项可独立关闭，纯声音不弹窗；与送给会话的 `notice` 不同）
- 写：`cwd <会话> <目录>` `goal <会话> pause|resume|clear` `schedule delete` `send` `notice` `new` `archive` `unarchive` `rename` `fork` `cancel` `monitor` `requeue-lost` `kill-jobs` `answer` `model` `plugin` `config --set` `api call`
- 命令行自己做的：`wait`（一段段问，DSH 中途重启会重连接着等）、`chat`（send + wait）、`start`、`restart`（见下文「重启」）、`doctor`、`version`、`help`。
  命令行带一份 `COMMANDS` 副本（构建时打进 `lib/dsh-control.js`），DSH 没运行时 `help` 也能列全；新增命令行自己做的命令要同时加进 `dsh-control.ts` 的 `LOCAL`。
- `start` 就是「确保在运行」：通信口已通直接返回 0，可重复跑。宿主只要继承了非空的 `SSH_CONNECTION` / `SSH_TTY` 就认定是远程启动，把选目录窗口换成网页版（App 内 launch-environment 的判断，2026-10-01 核对 0.2.0-rc.2）。所以在 SSH 里 `start` 改用 `launchctl print gui/<uid>` 的环境段，再补 HOME、USER、LOGNAME、TMPDIR、SHELL、LANG，SSH 变量一个不带（`src/cli/doctor.ts` 的 `appLaunchEnv`）；读不到图形会话（没人登录桌面）就拒绝打开，不退回 SSH 环境。

### 重启：不弹框、打断的会话自动续上

`dsh-control restart` 是命令行自己做的（DSH 退出时插件也跟着没了）。`--quit-via apple-event|menu` 显式选择普通退出入口，默认 `apple-event`。`menu` 依赖本机 `~/.local/bin/computer-control`：先离线核对本机路由协议，再只读精确核名，仅执行“退出 DeepSeek Harness”或“Quit DeepSeek Harness”中唯一已启用的普通退出项。不选 Quit and Keep Windows、开发重启、确认框，不发送全局快捷键、不强杀，也不自动改换路线。应用用 `DSH_APP` 的绝对路径定位，并禁止 computer-control 自动启动应用；其他应用路径或未支持的本地化明确报错。已排请求退出策略不同会拒绝附着，不吞新策略。菜单动作成功仍要观察旧实例退出、新实例就绪；20 秒动作超时只表示未确认，保留阶段、进程退出码、信号、错误代码和完整输出，不认定权限原因。

流程：

1. 先跑离线检查，不过就不重启；退出前重新查实际全局配置、凭据和 link 插件产物。带 `--before` 时，首次检查不过也可以先中止会话并执行命令，跑完重查，仍不过就不重启。
2. 一律强制重启，没有等空闲这一档，也不需要 `--force`。CLI 继承非空 `DSH_SESSION_ID` 或 `DSH_SHELL=1` 时自动带上 `--detach`，并默认通知发起的会话。已经有一个执行者时只登记结果通知，不另起或改写原请求；另一份 `--before` 不静默合并。
3. **退出前清掉会让 App 弹确认框的东西**。先暂停在跑会话的自动续跑目标，再中止会话和子代理、停掉普通后台任务；能跨重启保留的监听交给 dsh-monitor 暂停。排队消息没清完或还有东西没停下时最多清场 5 秒，仍不干净就结束进程再拉起。退出命令报错、30 秒没退出、锁屏点不到框也一样；只有结束进程本身失败才报重启失败。
   定时提醒会让 App 弹退出框。dsh-control 在点「退出」前再确认没有会话、排队消息和后台任务，只对整句匹配「只剩定时提醒」的框点唯一的「退出」。其他框不替你点，超时后结束进程再拉起。锁屏且只剩提醒时直接结束进程再拉起，提醒存在磁盘上，不会丢。
   开着的持久监听不算阻碍：`restart-prepare` 先记下并暂停，新进程里由 dsh-monitor 接回；如果后续真正失败、没有重启，则 `restart-abort` 马上接回。事件约定见 `dsh-monitor/AGENTS.md`「跟着 重启 DSH续上」。
4. 会话和后台任务分开处理（用户 2026-10-26 定：会话算会话，后台任务算后台任务；任务被停只在原会话拉起任务，不主动拉起会话）。
   - 会话：重启那一刻在跑的会话先记下来，重启后逐个送「继续」通知。读者是那个会话里的模型，它不关心重启，所以文案只说三件事：刚才停下是系统中止、不是用户叫停（宿主中止只记「已中止」不写是谁，模型容易当成用户叫停然后干等）；接着做完原来的事，会改东西的半截操作先核对再决定重不重做；不用向用户解释这次中断。
     例外：被中止的那一轮里用户的话还没回应完（`requeue-lost` 结果里的 `interruptedUser`，找的是那一轮最后一条用户亲自发的消息），通知改为原样带上这句话、让它先回应，不再说「不用解释」。否则用户刚问的事会被「任务没变、接着做」盖掉（2026-11-04 会话 cac50301：用户问「是不是不会主动停止目标」，重启后模型照旧干活）。
   - 被吞的消息：宿主处理一条消息时先把它从排队区取走，准备 1~5 秒才写进会话记录（`dsh-agent-loop` 的 preStep 到 step）。这期间被中止，消息既不在排队区也不在记录里，界面和上键都找不回（2026-11-03 19:37 清场途中真丢过一条）。取走那一刻原文已经在日志的插入记录里，所以发「继续」之前先对每个被中止的会话跑 `requeue-lost <会话> --since <重启开始时刻>`，把这之后被中止轮次里取走未写入的用户消息原样（同一编号）放回下一轮排队区。同一编号再插入过、或用户已重发同样文字的不再放，重复调用安全。插件通知、目标提示不放。被中止的只有被吞消息开启的那一轮时，放回去会话自己会重跑，不再另发「继续」；还有别的轮次也被中止（原来的活被打断）就照发。放回了哪些写进发起者收到的重启结果。
   - 被停任务叫醒的闲会话不算在跑：宿主停掉后台任务时会给闲着的主人发「任务结束」并开一轮，清场又把这一轮当在跑会话中止，重启后再送「继续」，模型就会重新开工（2026-10-26 一个早就做完的建站会话因此两次重开预览、改了站点）。所以停 bash 任务前先挂一个等待（`jobs.wait`），宿主看到有人在等就不发这条通知；万一还是被叫醒并被中止，只记进 `woken`，不送「继续」。
   - bash 后台任务：只有强制重启会停。`kill-jobs` 停之前从主人会话记录查出启动目录（`job/registered` 的调用编号对上同一调用记下的 `meta.cwd`），重启后用 `monitor <主人> --command <原命令> --cwd <原目录> --restart never --quiet` 在原会话重新拉起；`--quiet` 是因为开发服务器这类任务的日志刷进会话只会占上下文、没人要看（用户 2026-10-27 定）；换成持久监听后下次重启会自动接回，`never` 是因为原来的一次性任务退出后也不会重拉。查不到目录或拉起失败不猜，如实写进说明。
   - 子代理：清场时用宿主 `subagents/interruptByParent` 按其上级中止，并等实际停下；进程没了，宿主也没有跨重启续跑子代理的接口，接不回来。它算上级会话没做完的活，上级闲着也唤醒，说明里让它用 send_message 让子代理接着做或重新派。上级由 `quit-check` 的 `parents` 给出。
   - 说明怎么送：主人在跑或有子代理被停，用普通通知（会唤醒）；只丢了后台任务的闲主人用 `notice --quiet`（只放进上下文、不唤醒），并把这些会话和任务汇总进发起者收到的重启结果。
5. `dsh-control restart-status --json` 读最近一次重启的阶段、真实阻碍、时间和日志。排队回执只表示已安排，不能说已完成；执行进程消失但没有终态记录时显示未确认中断。启动成功同时要求旧实例退出、新实例身份不同、会话服务能返回有效状态。`--notify <会话>` 不论成败都给它送结果；DSH 会话里自动转后台时默认通知发起的会话（读 `DSH_SESSION_ID`）。
6. `--before '<命令>'`（不能配 `--kill`）：所有会话中止后、退出 DSH 之前，用 `/bin/sh -c` 跑一次，最多 10 分钟，去掉会话专属变量。会话、子代理或用户排队消息未清完，或后台已崩溃时，明确报告命令未执行且不重启，不走跳过更新的强制重启。只有后台监听或内核任务的安静通知留在待处理区时，不主动删除通知，允许执行更新。未读通知跨重启不保证保留；监听接回时会发新的提示。用来写 profile 补丁、装依赖；profile 变了会重跑离线检查。命令失败就不重启，原因转告发起的会话，已中止的会话照样收到「继续」。跑完命令后等通信口回来，再清一次场才退出。标准输出和错误输出分别完整保存，失败记录保留阶段、退出码、信号与日志路径；已经执行过的命令不得自动重放。
7. 自动续跑的目标先暂停再中止会话，免得中止后马上开下一轮；重启结束时（成没成都算）用 `goals/resume` 恢复。DSH 刚起来时最多重试 30 秒，恢复不了就通知那个会话请用户点恢复。这里用 `goals/pause` 是有意的：宿主会当场中止这一轮，正是强制重启需要的效果。

**DSH 里的 agent 用 `restart --detach`**：前台命令是 DSH 的子进程，DSH 一退出命令就没了。`--detach` 把自己放进新进程组的后台进程，
去掉 `DSH_SESSION_ID` 这类会话专属变量（否则会带进新拉起的 DSH）。每次重启一份日志：`$DSH_HOME/dsh-control/restart-logs/restart-<年月日>-<时分秒>-<进程号>.log`，
只留最近 20 份；路径经 `DSH_CONTROL_RESTART_LOG` 传给后台进程，通知里写的就是这一份。
注：dsh-python-repl 从 2026-10-09 起给内核带上 `DSH_SESSION_ID`，Python 内核里起的子进程和 bash 工具一样：默认通知自己所在的会话，同样自动转后台、默认强制。更旧的构建没有这个标记，要通知就显式写 `--notify`。
同一时间只有一个执行者：`restart.lock` 独占创建，取得、回收、登记和释放由短登记锁串行保护；普通争用异步等最多5秒，不把空锁或无法确认的进程当成功。等待者按执行者进程分批保存，登记和关闭批次互斥。已有执行者时无更新命令的请求只登记结果通知；带 `--before` 的请求明确拒绝，不丢命令后报成功。强制请求遇到已有执行者也只登记，另写 `restart.upgrade.<执行者进程号>`：执行者还在等空闲就改为立刻强制重启（没跑过的 `--before` 交给强制路径跑），已经在退出的照原样做完。登记过结果的会话若被这次中止，重启结果和「继续」并成一条发。以前直接拒绝，后来的会话收不到「重启完成」，只好请用户重启完回来说一声（2026-10-09 复盘 I-008）。

送进会话的话用插件通知（来源标记为 `dsh-control`，dsh-message-tidy 用同名来源识别通知）（`notice` 命令：`source: { kind: 'dsh-control', form: 'notice' }`，空闲会话用公开 `agent.followup` 安排下一轮，运行中用 `agent.steer` 插话；带 `--quiet` 用 `agent.inject` 只放进上下文、不唤醒），
界面显示成一行通知，dsh-message-tidy 新版默认来源名单会给此 notice 包上 “the user did not write this” 的英文标记（显式自定义名单仍以用户配置为准）；插件版本旧、没有 `notice` 时退回普通 `send`。
会话没加载时 `notice` 先经会话控制器的 `resolveAgent` 加载它（和网页发消息同一条路）。回执分 `accepted`（已记录）与 `scheduled`（宿主状态已进入运行）；后者仍不证明模型已回复。已记录但未确认调度时报 `notice-wakeup-unconfirmed`，不能重发或退回 `send`。重启通知状态使用 `scheduled`、`recorded-unconfirmed`、`failed`、`not-requested`；旧 `delivered` 只作记录未确认。

测试不许碰本机真的 App：退出、打开、强杀都经 `AppControl`，`test/cli-fixture.ts` 给的是一碰就报错的版本，
`test/restart.test.ts` 用只记录调用的假 App（2026-10-08 写测试时直接调了真退出，把正在用的 DSH 关了）。

跨机器重启通知由共享目标入口在发起机器观察，再调用本机通知接口；不回拨远端、不把本机会话编号当远端 ID。子代理的 `DSH_SESSION_ID` 是裸 UUID，没有可通知的会话：远端照常排队、退出 0，回执写 `watchSkipped` 和查询命令；这一步在远端排队之前判断（2026-10-24 以前排在之后，重启排上了命令却退出 1）。`restart-watch WATCHID` 查本机监听记录。CLI 排队回执提供 UUID requestId，状态逐阶段写入 `dsh-control/restart-requests/<UUID>.json`；`restart-status --request-id UUID` 精确读取，附着执行者只跟固定 executionRequestId，不读下一次 latest。状态查询退出 0 不是重启成功，必须看 phase。记录目前保留不自动清理。

### 升级 App（`upgrade`，`src/cli/upgrade.ts`）

把 `/Applications/DeepSeek Harness.app` 升到更新源（默认官方 nightly-mac 清单，`--feed` 可换）的版本，复用上面的重启流程：

1. 读清单；版本和现装一样就直接退出 0（`--force` 才重装）。
2. 下载到 `~/.local/state/dsh-control/app-upgrade/<版本>/`（可能超过 GB，避免放进包含同步配置的 `DSH_HOME`），核对大小和 sha512，解包，核对 `codesign --verify --deep --strict`、`spctl` 公证、开发者编号和现装一致、包内版本号和清单一致；大小或 sha512 不对就删掉下载的包，任何一项不对都直接退出，不碰 DSH。
3. 用解出来的新版 App 对实际配置跑离线检查（含隔离试启动），不过就停；`--check` 到这里为止。
4. 交给 `restart --install-app <新版>`：会话都中止、`--before` 跑完、旧进程确认退出后，才把旧版挪到 `backups/`、新版挪进 `/Applications` 并核对版本，然后拉起。挪的过程出错就把旧版挪回原位再拉起；新版两分钟内没就绪就结束它、换回旧版再拉起，两种情况都按失败通知。成功后只留刚换下来的那一版备份，删掉下载和解包目录。
5. `--rollback` 把 `backups/` 里最新的旧版当作新版走同一条路。

替换只发生在拉起前（`start` 里），`kill` 路线也经过这里；重启状态阶段名不新增（远程监听有阶段白名单），换 App 只写在 `starting` 的说明里。

### 退出码：没做成就非 0

外部 agent 只看退出码判断成没成，所以「DSH 拒绝了」「没东西可选」「宿主报告失败」都不能返回成功。服务端的约定：

- 调用方的问题或被规则拦下（找不到、对上多个、只读、拒绝换模型、会话正在跑、整档没有可用模型、回答没被接收）抛 `UsageError`，
  通信口回 HTTP 400，命令行退出 2。
- 执行了但没做成（宿主报告装插件失败、拿不到额度报告）抛 `CommandFailure`，通信口回 500，命令行退出 1。
- 两者都带稳定的英文 `code`，`--json` 输出 `{ok:false,error:{code,message}}`。命令行按 HTTP 状态分 1 和 2，不维护 code 名单。
- 任务失败或中止：`wait` 返回 HTTP 200 的 `{ok:false,status:failed|aborted,error,data}`，退出 1；只有最后一轮 `completed` 才成功。`data.turns` 保留结束原因、详情、回复。
- 成功时 `status` 提示特殊退出码：`waiting-input` 10（wait、status）、`idle` 11（wait 没有新内容）、`running` 124（wait 超时）。

### 读会话

- 会话列表、状态、待办、排队、提问、当前模型：`session/list` 的摘要和投影（`projections.values`）。
- 历史：`ctx.sessionQuery.readSession(id)` 读完整原始日志，`src/transcript.ts` 整理（结构参照 the session transcript reader，插件间
  不能互相导入，所以是精简副本）。思考块不输出；注入的背景内容只标长度。
- 会话标识：完整 id、去掉 `session-` 的开头或末尾至少 4 位、标题里的词；对上多个报错列候选，不猜。

### 会话管理与未分组

- 0.2.1 起会话能中途换工作目录：会话摘要里的 `cwd` 只是起始目录，现在的目录在投影 `workingDirectory`。`status`、`sessions` 显示和 `--cwd` 筛选都用现在的目录（筛选也认起始目录）。`cwd <会话> <目录>` 经会话控制器加载会话，再调宿主 `workingDirectory.set`，和模型调 `working_directory` 工具同一条路；网关没有这个接口。只收绝对路径或 `~/`，因为命令行和 DSH 不一定在同一个目录。
- `goal` 走 `goals/get|pause|resume|clear`，带当前版本号，版本过期由宿主拒绝。`schedule` 走 `schedule/catalog|history|delete`；宿主没有对外的新建接口，新建只能在会话里由模型调。

- `archive` / `unarchive` 走 `workspace/archiveSession` / `unarchiveSession` 并检查返回存档集合；存档不传 `stopActivity`，宿主发现活动任务就拒绝，绝不自动中止。
- `rename` 走 `session/rename`，返回宿主接受的标题与序号；`fork` 走 `session/fork`，默认复制最近已完成轮次，`--at-seq` 是含该事件的边界，不发消息。
- `workspaces` 与 `sessions --workspace` 已有；工作区筛选接受 id、名字或路径，精确匹配优先。
- `sessions --ungrouped` 只按完整工作区登记集合排除，不按 cwd 或 parentSessionId 判断；始终排除子代理。工作区读取失败就报错，不能退回所有会话，避免批量存档误伤。
- 默认隐藏空白与归档；`--include-blank` / `--all` 分别显式包含，`--limit 0` 返回全部，JSON 提供 `archived`、`blank` 和完整性计数。

### 等待「跑完」的判据

`wait-idle [会话]` 等指定会话当下没有运行和真实排队，不指定时等全部；指定会话正在等回答返回退出码 10。加 `--timeout 秒` 连续等待，否则只挂一段 `--slice`。空闲不检查后台任务，也不代表任务完成，后续可能自动再开一轮；任务终态仍用 `wait` 或状态与历史核对。

`wait --settled`（`chat --settled` 同）等「真做完」：在下面「已经结束」的条件之外，还要求会话和它的子代理（按 `quit-check` 的 `parents` 逐层找）名下没有在跑的后台任务、子代理不在跑或排队、目标不是 active+armed（`goals/get` 的 activation）、没有重启在排队或执行（`restart-state.json`），并且插件启动 2 分钟内、上次退出时被中止（`turn/end` 时间早于插件启动）的那一轮不算终态，等重启的「继续」接上；全部满足再连续保持 3 秒（任务刚结束到宿主把「任务结束」通知排进会话之间可能有空档）。没做完时 `data.blockers` 写原因。不看回复内容。
`send` / `new` / `chat` 的 `--notify <会话>`（命令行把 `self` 换成 `DSH_SESSION_ID`，子代理的裸 UUID 拒绝）在发送前核对通知对象，发出后由 `src/done-watch.ts` 登记监听：记录写 `$DSH_HOME/dsh-control/done-watches/<编号>.json`，插件启动时读回 `watching` 的接着盯，状态事件和每 5 秒检查一次，口径同 `--settled`。终态（完成、失败、中止、空闲无新轮、会话不见了）用 `notice` 同一条路给通知对象送一次；送前先写 `delivering`，重启后见到它标 `failed` 不重送；送失败最多试 3 次。等回答时按提问编号各送一次提醒，不算终态。登记失败不影响已发出的消息，回执写 `notify.error`。完成的记录留 7 天。同一目标、同一通知对象只留一条在等的监听：再登记时沿用它（回执 `reused`），插件启动读回多条时只留最早一条、其余标 `merged`（2026-11-06 主控每次插话都带 `--notify`，长工做完时一下收到 9 条）。跨机器的本机观察进程同样按远端机器、目标、发起会话沿用活着的那个。
跨机器（`-H 机器` 加 `--notify self`）不经插件：共享目标入口（可选共享库 `agentkit/remote/done_watch.py`）去掉 `--notify` 发到远端，拿到回执后在发起机器起后台观察进程，反复跑远端 `wait --settled`，真做完后 `--local notice` 发起会话；做法照抄跨机器重启通知。派单前握手要求远端入口声明 `settled-wait`；`chat` 与非会话发起者在发送前拒绝。
`wait` 返回成功还要求最后一轮结束原因是 `completed`；`error`、`aborted` 和其他未成功结束原因都非零。返回「已经结束」要同时满足：会话不在跑、没有排队消息、`--since` 之后出现了新的 `turn/end`。
会话空闲、没有排队、`--since` 之后也没有新记录时立即返回「没有新内容」（退出码 11），不空等到超时：
宿主收下消息时是同步入队并把会话置为在跑（`agent.followup` → `wakeDriver`，2026-10-01 核对 0.2.0-rc.2），
不存在「消息发了、会话看起来还空闲」的空档。`--since` 之后有新记录却没有一轮结束（例如只改了模型），再观察 3 秒确认不会开跑。
超时（124）的文案写真实状态：在跑，或空闲但还有排队消息。
会话停下来在等用户回答时返回「在等你回答」（退出码 10），不算跑完。提问有两种来源，都要认：

- **阻塞式**（`ask_user_question` 默认的 legacy 模式）：问题只沿 `user-questions/request` 事件链转给浏览器，**不进会话投影**，
  从会话列表完全看不到（2026-09-30 用 Codex 按 skill 实测发现：wait 一直等、answer 报没有问题）。所以插件在这条链上
  `prepend` 挂一个监听（`src/questions.ts`）：记进待答表，照常交给下一环（浏览器卡片），同时和 `dsh-control answer` 赛跑，
  谁先答用谁的。远程先答时把请求上的 `signal` 就地换成会 abort 的那个（waterfall 的下一环拿的是同一个请求对象），
  浏览器卡片和宿主转发层据此撤回。
  网页和桌面窗口全关时，宿主没有转发那一环，下一环当场报 `NO_PROVIDER`，远程回答来不及赢。这时监听不跟着失败，
  再等 `questionGraceMs`（默认 10 分钟），期间会话照常显示「在等你回答」、`answer` 照常可答，并直接用 `terminal-notifier`
  弹一条系统通知（桌面通知的接收方就是窗口，窗口全关时用不了；通知记在「terminal-notifier」名下）。不用 `osascript`：它的通知记在「脚本编辑器」名下，用户要求不再出现这个来源。
  terminal-notifier 需要另装；没装时只记一条警告，等回答照常进行。到点没人答，原样抛出那个 `NO_PROVIDER`，模型看到的和以前一样。
  局限：等的期间再打开窗口，网页不会补弹卡片，只能用 `answer` 回答。
- **限时式**（timed 模式超时后转为 `continued`）：在 `userQuestions` 投影里，回答走 `userQuestions/answer` 接口。

`sessions()` 把待答表并进会话摘要，状态、列表、wait 的判断都用同一份。
一次请求最多挂 `waitSliceMs`（默认 30 秒），期间监听 `agent/status` 事件，会话一变空闲就立即复查。
截止时间用真实时钟，不用可注入的 `now()`（测试里固定 `now()` 曾让等待永不结束）。

### 模型：两档，只挑模型

两档和打分规则来自 模型额度服务（设置「模型与额度」一页，和每晚复盘、记忆提炼、压缩写摘要共用 `$DSH_HOME/preferences.json` 的 `modelTiers` 段）。
本插件每次挑模型时现读档位和这台机器上的暂停记录，命令行的档位名照旧：

- `normal`（默认）= 主力档；未安装 模型额度服务 时配置 `tiers.normal` 的 `provider/model` 列表。
- `fast`（很简单的活）= 轻量档；未安装 模型额度服务 时配置 `tiers.fast` 的 `provider/model` 列表。
- 额度规则优先使用共享档位文件；无共享档位时按本插件列表顺序选择，缺少额度信息会给警告。`quotaFromModelPrefix` 默认空，只有显式配置的 provider 才按模型 id 第一段认额度来源。
- **推理等级**：指定 `--effort` 时按模型目录校验并传入；只指定等级时保持当前模型。未指定时由 模型额度服务 按模型上次的等级带上。
  例外是宿主会清等级的两种情况：会话已经在用目标模型时不再发选择（同模型不带等级会被清成模型自带默认，Sol 是 low）；`new` 的目标正好是全局默认模型时，带上默认里的等级（新会话没有已选模型，必须显式保留默认等级）。
- **不算你选的**：装了 模型额度服务 时换模型走它的 `modelSelectAutomatic` 服务，dsh-control 换的模型不会变成新建会话「上一次选的」；没装就走 `session/selectModel`。
- `send` / `chat` 的模型选项复用 `model` 的保护，目标相同时直接保留；`new` 独立初始化。`chat` 全部等待选项写前校验，发送后任何等待结果保留 `receipt`（sent、requestId、sessionId、since），不能因为等待失败重复发送。未知选项和多余非文本参数写前拒绝。
- **已开始的会话不换模型**（换一次缓存全丢）：`dsh-control model` 对跑过至少一轮的会话默认拒绝（退出码 2，`model-change-refused`），只有当前模型看的窗口已用光才放行；`--force` 强行。
- `new` 先挑模型再建会话：档位没有可用模型就直接失败，不留下用错模型的空会话。输出的起点 seq 是建好会话后日志里的最新 seq，直接用于 `wait`。

额度查不到的那家（没登录、凭据失效），`quota` / `models` / `pick` 会附上 模型额度服务 报告里的修复提示和 `dsh-control quota --refresh`。

算法在 `src/models.ts`（纯计算，有测试；规则和 模型额度服务 的 `src/tiers/shared/tiers.ts` 同一套，插件之间不能互相导入代码所以留一份计算）：
不在这台机器的模型列表里（没登录、没配钥匙、内网不通）、这台机器上最近调用失败还在暂停期、窗口已用光或剩余低于保留线（默认 10）→ 不可用；
额度查不到、少一个窗口 → 只警告，照样可选（查额度和发请求是两回事）。
可用的按档里的顺序挑，额度紧的往后排（用户 2026-10-12 定：「除非很少，否则按优先级来挑」）；额度紧 = 某个窗口照现在的速度撑不到重置且剩余不到一半。几个都紧时「剩余 − 基准线」加权平均大的先用。整档不可用时不跨档，返回最早重置时间，由 agent 问用户。

额度来自 模型额度服务 已注册在本机网页端口上的 `/模型额度服务/usage/report`（同一份两分钟缓存，不多打各家接口），端口从 `ctx.webServer.port` 读。
模型额度服务 未安装时使用本插件的 `tiers.normal` 和 `tiers.fast`。两处都未配置时明确给出两种配置办法。共享档位文件写错时报告错误，不偷偷绕过。

### 安全开关（配置，即时生效）

| 字段 | 默认 | 含义 |
|---|---|---|
| `readOnly` | false | 只读模式，写命令一律拒绝 |
| `denyNamespaces` | credentials, terminal, dynamicCordisRunner, account | 远程禁止调用的接口命名空间 |
| `waitSliceMs` | 30000 | 一次 wait 请求最长挂多久 |
| `questionGraceMs` | 600000 | 窗口全关时提问再等多久让远程回答；0 = 照 DSH 原样当场失败 |

`api call` 判断「写」按方法名（`src/service.ts` 的 `READ_METHODS`）：不在只读名单里的都算写。

## 接入与配置

- profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-control`。不要再手写 insert。
- 条目 id 和设置命名空间都是 `dsh-control`；没有配置卡片，用 `dsh-control config dsh-control --set '{...}'`
  或直接写 profile 补丁 `- id: dsh-control` + `config:`。
- 本机命令需 Python 3 和 Node。将 `bin/dsh-control` 放入 PATH，将 `skills/dsh-control` 和 `skills/dsh-supervise` 暴露给 agent。只有跨机器或目标管理才加载可选 `agentkit/remote` 共享库；可用 `DSH_CONTROL_SHARED_ROOT` 指定安装目录。缺远程支持时明确失败，不退回本机。
- `lib/` 不进版本库：新机器先 `pnpm install && CI=true pnpm run check` 构建，`dsh-control` 才能跑。
- Hermes：**公司电脑不装 Hermes**（安全策略会拦），接入步骤在 `skills/dsh-control/HERMES.md`，回家在自己电脑上照做。

## 开发与验证

```bash
CI=true pnpm run check   # 类型检查 + 构建 + 测试（模型挑选、会话整理、服务命令、真 socket + 真命令行的退出码）
```

- 改 `bundles` 列表会被 DSH 热重载（加上插件就挂上，不用重启）。**但改插件代码不会**：Node 的模块缓存保留旧代码，
  摘掉再加回组合包也不重读文件（2026-09-30 实测）。改完代码先跑内部 `tools.doctor` 或外部 `dsh-control doctor`，通过后用 `dsh-control restart --detach`。改 profile 挂载和补丁放进同一条命令的 `--before`，在会话都中止后才写。
- `dsh-control plugin disable|remove dsh-control` 会关掉通信口本身：请求在回包前就断了（命令行报 `socket hang up`），
  之后远程连不上。所以要 `--force` 才执行（2026-09-30 实测过一次，是手改 profile 加回来的）。
- 命令行（`lib/dsh-control.js`）每次调用都是新进程，改完构建就生效。
- `dsh-control doctor` 总是先查离线层；DSH 正在运行时，再查通信口并实际调用已注册的 doctor 工具。任一层失败都返回非零，列出失败原因和修复办法。默认不调用模型，`--full` 才请求一次模型。start/restart 离线检查失败就拒绝启动，只自动把凭据权限修到精确 `600`；启动环境移除 `ELECTRON_RUN_AS_NODE`。
- 检查报告和失败日志可能很大。命令行要用 `process.exitCode` 等待输出写完，不能直接 `process.exit()` 截断 JSON；读取子进程文本流用 `setEncoding("utf8")`，避免中文被分片读坏。`test/doctor.test.ts` 的大报告样例必须保留。
- 真实验收（2026-09-30，DSH 0.2.0-rc.2）：`health`、`workspaces`、`sessions`、`status`、`quota`、`models`、`pick`、
  `new --tier fast`（在 `/tmp/dsh-control-verify` 开会话，自动选 opencode；绝对路径不会加进工作区列表）、`wait`、`chat`、`last`、`read`、
  `model` 拒绝换、`cancel` 中止正在跑的会话、`api list|describe`、禁用命名空间被拒、`config`、`sessions --cwd`。
  2026-10-09 起这套串成了 `scripts/acceptance.sh`（只读命令 + 一个 fast 档一次性会话的收发），实测通过。
  外部 agent 按 skill 实测：Claude Code（列在跑会话、new + wait、说明两档选择理由）；Codex（提问流程：wait 退出码 10、
  `answer --select 蓝`、再 wait 拿到「你选了蓝」）。

## 以后（MVP 没做）

- 主动推送：会话跑完、出错、卡在提问时，往 Hermes webhook 发带签名的通知（Hermes 侧配置示意见 `skills/dsh-control/HERMES.md`）。
- 远程批准操作（审批请求目前只有界面能答）。
- 远程发图片、文件。

## 移除

从 profile 的 `dependencies` 和 `dsh.profile.bundles` 去掉 `dsh-control`，在 profile 目录 `pnpm install`；
移除本插件的命令和技能入口；确认不再需要历史回执后再处理 `$DSH_HOME/dsh-control/`。
