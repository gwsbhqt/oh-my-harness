# 参数与回执

## 架构与运行条件

`agy-use` 默认控制正在运行的 **Antigravity App**，依赖随 `agy-python-repl` 插件提供的官方 Sidecar（`sidecars/app-bridge/sidecar.json`）。

- Sidecar 由 Antigravity App 启动并注入 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_APP_DATA_DIR` 和 `agentapi` 入口；CSRF 令牌只保留在 Sidecar 进程内存中，不写入磁盘，也不通过套接字返回。
- 外部进程（如终端、其他代理或 `agy-python-repl` 内核）仅连接当前本机账户可访问的 Unix 套接字：优先读取 `AGY_USE_SOCKET`（或 `--socket` / `socket_path`），未指定时使用 `${XDG_STATE_HOME:-~/.local/state}/agy-use/bridge.sock`（目录权限 `0700`，套接字与元数据 `0600`）。
- 只有 **CLI 独立入口**（`cli_*` / `cli-*`）直接调用本地 `agy` 可执行文件（`PATH` 或 `~/.local/bin/agy`）。Antigravity App 与 `agy` CLI 的会话彼此隔离。

## Antigravity App 函数与命令

所有 Python 函数均为异步函数，使用 `await skills.agy_use.<函数>(...)`。`timeout` 单位均为秒，`wait`、`new`、`send` 支持 `timeout=0` 表示一直等待到本轮结束；其余操作要求有限正数秒。

| Python 函数 | CLI 子命令 | 底层官方入口 |
| --- | --- | --- |
| `health(*, socket_path=None, timeout=10)` | `health [--socket PATH] [--timeout 秒]` | Sidecar `ConversationService/ListConversations` + `agentapi` 检查 |
| `sessions(*, query=None, project_id=None, tags=None, include_archived=False, limit=20, ...)` | `sessions [--query 词] [--project-id ID] [--tag T] [--include-archived] [--limit N]` | `ConversationService/ListConversations`（按需自动翻页） |
| `get(conversation_id, *, include_archived=True, include_metadata=True, ...)` | `get 会话编号 [--active-only] [--no-metadata]` | `ConversationService/GetConversation` + `agentapi get-conversation-metadata` + 本地 `transcript.jsonl` 摘要 |
| `new(prompt="", *, project_id=None, environment_id=None, title=None, model=None, tags=None, wait=False, timeout=120, poll_interval=0.5, ...)` | `new [提示] [--project-id ID] [--title 标题] [--model 模型] [--tag T] [--wait] [--timeout 秒]` | `ConversationService/CreateConversation`，可选轮询等待完成 |
| `send(conversation_id, prompt, *, title=None, wait=False, timeout=120, poll_interval=0.5, ...)` | `send 会话编号 提示 [--title 标题] [--wait] [--timeout 秒]` | 先 `GetConversation` 确认目标存在，再调用 `agentapi send-message` |
| `wait(conversation_id, *, since_step=None, since_time=None, expected_prompt=None, timeout=120, poll_interval=0.5, ...)` | `wait 会话编号 [--since-step N] [--since-time ISO] [--expected-prompt 正文] [--timeout 秒]` | 轮询 `GetConversation` 与 `transcript.jsonl`（含截断回落 `transcript_full.jsonl`） |
| `read(conversation_id, *, from_step=0, limit=50, full=False, ...)` | `read 会话编号 [--from-step N] [--limit N] [--full]` | 读取本地 `transcript.jsonl`（或 `transcript_full.jsonl`）与 `GetConversation` |
| `last(conversation_id, *, chars=4000, ...)` | `last 会话编号 [--chars N]` | 提取最近一条 `PLANNER_RESPONSE` |
| `rename(conversation_id, title, ...)` | `rename 会话编号 新标题` | `ConversationService/UpdateConversation` |
| `archive(conversation_id, *, archived=True, ...)` | `archive 会话编号 [--unarchive]` | `ConversationService/UpdateConversation` |
| `update(conversation_id, *, title=None, archived=None, pinned=None, starred=None, tags=None, group_id=None, ...)` | `update 会话编号 [属性选项...]` | `ConversationService/UpdateConversation` |
| `delete(conversation_id, ...)` | `delete 会话编号` | `ConversationService/DeleteConversation` |

### 目标定位与送达核实约定

- **精确目标**：`get`、`send`、`wait`、`read`、`last`、`rename`、`archive`、`update`、`delete` 传入完整 UUID 时直接通过 `GetConversation` 核对；传入至少 4 个字符的不完整前缀时执行列表扫描，若匹配到 0 个返回 `target-not-found`，匹配到多个返回 `ambiguous-target`，若 `next_page_token` 非空（扫描未完成）则一律拒绝判唯并返回 `incomplete-prefix-scan`，绝不自动猜测。
- **先验后发**：`agentapi send-message` 在某些不存在的会话编号上可能仍退出 0，因此 Sidecar 会在调用 `agentapi send-message` 前先向 `ConversationService/GetConversation` 确认目标存在。
- **防重发与不确定投递**：`send` 在发送前记录 `baseline`（`last_step_index`、`total_steps`、`update_time`、`run_state`）。返回字段 `sent` 为 `True` 表示 `agentapi` 退出 0，`False` 表示未发起或明确失败，`None` 且 `uncertain=True` 表示写入套接字后超时或断连、投递结果未知。超时、断连或取消后不要自动重发，应先用 `read`/`last` 核对同一 `conversation_id` 的转录变化。
- **严格完成判定**：`send(..., wait=True)`（或带 `expected_prompt` 的 `wait`）只有在目标会话回到 `RUN_STATE_IDLE`、在 `since_step` 之后唯一出现包含本次正文的 App 收件步骤、且其后（下一条输入之前）存在非空的最终 `PLANNER_RESPONSE`（不含 `tool_calls`）时才判成功。中途工具调用、其他无关输入、旧轮结束、单独返回空闲、空回复（`empty-response`）、取消无最终答复（`cancelled-without-response`）以及同正文并发重复收件（`ambiguous-reply`）均不判成功，并保留回执绝不重发。若 `transcript.jsonl` 步骤含 `truncated_fields`，客户端自动读取 `transcript_full.jsonl` 校验完整正文与回复。

### 退出码（App 入口）

- `0`：成功（`ok: true`）。
- `2`：参数校验失败、`ValueError`/`OSError`、`invalid-argument`、`target-not-found`、`ambiguous-target` 或 `incomplete-prefix-scan`。
- `69`：`sidecar-unavailable` 或 `ls-unreachable`（Sidecar 未运行或宿主语言服务不可达）。
- `124`：本地等待超时（`timed_out: true`）。
- `130`：键盘中断或任务取消（已取得的取消回执保留在 `cancelled.receipt` 并输出到 stdout）。
- `1`：其他运行时错误。

## `agy` CLI 独立入口

以下入口只调用本机 `agy` CLI，与桌面 App 会话完全独立：

| Python 函数 | CLI 子命令 | 底层命令 |
| --- | --- | --- |
| `cli_status(*, timeout=10)` | `cli-status [--timeout 秒]` | `agy --version` |
| `cli_models(*, timeout=30)` | `cli-models [--timeout 秒]` | `agy models` |
| `cli_plugins(*, timeout=30)` | `cli-plugins [--timeout 秒]` | `agy plugin list --json` |
| `cli_validate_plugin(path, *, strict=False, timeout=30)` | `cli-validate-plugin 路径 [--strict]` | `agy plugin validate 路径 --json` |
| `cli_install_plugin(path, *, timeout=60)` | `cli-install-plugin 插件目录` | `agy plugin install 插件目录` |
| `cli_run(prompt, workspace, *, conversation_id=None, model=None, allow_repl=False, timeout=120)` | `cli-run --workspace 目录 [--conversation-id ID] [--model 模型] [--allow-repl] [--timeout 秒] 提示` | `agy --output-format=stream-json --print-timeout=... --print=...` |

`cli_run` 默认以 `120` 秒超时运行，`timeout=0` 持续等待本轮自然结束；允许工作台 Python 时传入 `--allow-repl`。即使 `agy` 进程退出码为 0，若 `result.denied_actions` 非空、`result.status != "SUCCESS"`、`result.response` 为空或续接编号不一致，仍标记 `ok=False`。
