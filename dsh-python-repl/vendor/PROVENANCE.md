# vendor 来源清单

## 上游

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/PrimeIntellect-ai/prime-agent |
| 跟踪的 tag | `v0.10.3` |
| **锁定的 commit** | **`efb25e2be62507f8a13a157545d031da213abac9`** |
| 仓库内路径 | `prime-agent-runtime/src/rlm/` |
| 对应发布 | Prime Agent Rust 版 0.10.3（安装包自带 `share/prime-agent/prime-agent-runtime/`） |
| 许可证 | MIT（见 `prime/LICENSE`） |
| 取用日期 | 2026-10-30（v0.10.2 首次取用）；2026-11-14 核对并推进跟踪基线到 v0.10.3 |

**以 commit 为准，不以 tag 为准**：tag 可以被移动，commit 不会。核对时用下面的固定链接，不要用 `main`。

文件取自上述 commit 的 Git 对象，已逐字节核对；本次升级修复快照恢复写入句柄时重新打开并清空文件的问题。

2026-11-14 核对 v0.10.3：内核 `repl.py`、`repl.md` 与 `LICENSE` 同 v0.10.2 逐字节一致，三个哈希均未变；仅把跟踪基线从 v0.10.2 推进到 v0.10.3，`vendor/prime/` 内容未做任何改动。

### 精确定位（点开即是我们 vendor 的那个版本）

| vendor 里的文件 | 上游固定链接（commit 锁定） |
|---|---|
| `prime/rlm/repl.py` | [blob](https://github.com/PrimeIntellect-ai/prime-agent/blob/efb25e2be62507f8a13a157545d031da213abac9/prime-agent-runtime/src/rlm/repl.py) · [raw](https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/efb25e2be62507f8a13a157545d031da213abac9/prime-agent-runtime/src/rlm/repl.py) |
| `prime/rlm/repl.md` | [blob](https://github.com/PrimeIntellect-ai/prime-agent/blob/efb25e2be62507f8a13a157545d031da213abac9/prime-agent-runtime/src/rlm/repl.md) · [raw](https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/efb25e2be62507f8a13a157545d031da213abac9/prime-agent-runtime/src/rlm/repl.md) |
| `prime/LICENSE` | [blob](https://github.com/PrimeIntellect-ai/prime-agent/blob/efb25e2be62507f8a13a157545d031da213abac9/LICENSE) · [raw](https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/efb25e2be62507f8a13a157545d031da213abac9/LICENSE) |
| 整个源目录 | [prime-agent-runtime/src/rlm/](https://github.com/PrimeIntellect-ai/prime-agent/tree/efb25e2be62507f8a13a157545d031da213abac9/prime-agent-runtime/src/rlm) |

## 文件与哈希

sha256，与上述 commit 的内容逐字节一致（已实际下载核对，不是抄的）。

| 文件 | sha256 |
|---|---|
| `prime/rlm/repl.py` | `e61d4801f1b53290eb318fee557419de8b3d19e8b2cc691e3da2be4d8480b700` |
| `prime/rlm/repl.md` | `1c8804c14d2309a8711810df7e73602aa1cb704399f388113a0cebd26f4026c3` |
| `prime/LICENSE` | `e0d1bf8d137e6d56e98ee968402b0b7f324c5c85ea505e4fd7b6b78615bc4e7a` |

`repl.md` 是上游的协议文档，随源码一起保留，便于核对 wire 格式。

### 自己核对，别信这份文档

在插件根目录跑：

```bash
BASE=https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/efb25e2be62507f8a13a157545d031da213abac9
for f in repl.py repl.md; do
  remote=$(curl -sL "$BASE/prime-agent-runtime/src/rlm/$f" | shasum -a 256 | cut -d' ' -f1)
  local=$(shasum -a 256 "vendor/prime/rlm/$f" | cut -d' ' -f1)
  [ "$remote" = "$local" ] && echo "OK   $f" || echo "DIFF $f  remote=$remote local=$local"
done
remote=$(curl -sL "$BASE/LICENSE" | shasum -a 256 | cut -d' ' -f1)
local=$(shasum -a 256 vendor/prime/LICENSE | cut -d' ' -f1)
[ "$remote" = "$local" ] && echo "OK   LICENSE" || echo "DIFF LICENSE"
```

`test/python/test_vendor_integration.py` 离线跑同样的校验（对照上表哈希），所以日常开发不需要联网。

## 取用范围：只有内核，没有 Prime 宿主

上游 `rlm/` 包有 10 个 Python 文件（repl / bash / factory / harness / mcp / mcp_base / skill / _winjob / __init__ 等，合计约 500KB），外加 `machines/` 目录。本项目**只 vendor `repl.py`**。

上游的 `__init__.py` 会导入 bash 和 harness、装配 `bash`/`mcp`/`rlm.spawn` 等原生能力；本部署一个都不要——这些能力由 DSH 提供。所以**两边都不放 `__init__.py`**：既避免了照抄上游那份（会凭空多出一条绕开 DSH 权限闸门的原生 bash 通路），也正是命名空间包成立的前提。

未取用且明确不需要的：`bash.py`、`factory.py`、`harness.py`、`mcp.py`、`mcp_base.py`、`skill.py`、`_winjob.py`、`machines/`。

`repl.py` 在文件开头 `from .factory import schedule_activity`，用来响应宿主的 `factory_activity` 请求（Prime 的「工厂」功能）。DSH 没有这个功能，也从不发这个请求，所以同样用 `python/compat/rlm/factory.py` 垫一个最小模块：只提供 `repl.py` 读取的三个名字，允许的动作清单为空，真有这种请求到达时内核按「未知动作」拒绝。`repl.py` 在处理 `bash_activity`、`mcp_status` 请求时才延迟导入 `rlm.bash.activity_request` 和 `rlm.mcp`，DSH 不发这两种请求，不垫。

## 补丁：没有。这个目录里只有上游文件

`vendor/prime/` **整个目录都是上游的**，一个字节没改。不需要"哪个文件是我们的"这种说明——归属由目录决定：

```
vendor/prime/          ← 全部是上游 prime-agent 0.10.3 的东西，只读
python/compat/     ← 全部是我们自己的东西
```

按文件列例外的写法会腐烂：下次 bump 版本多出一个文件，说明就悄悄过期了。所以改成一个目录一个归属。

`test/python/test_vendor_integration.py` 每次跑测试都会：① 用本文件记录的哈希校验上游文件没被改；② 断言 `vendor/prime/rlm/` 里**除了 `repl.md` 和 `repl.py` 什么都没有**。

### `repl.py` 依赖 `bash.py`，怎么做到不改它

`repl.py` 导入 `_kill_live_handles` 和 `_rehydrate_persistent_shells`。前者清理本内核进程组，后者在 DSH 中无需恢复 Prime 终端。我们不 vendor 上游的 `bash.py`（它会把整个 Prime bash/_winjob 栈拖进来，还会让内核里能 import 到一条绕开 DSH 权限闸门的原生 bash 通路）。

解法是 **PEP 420 命名空间包**：两个目录下各有一个 `rlm/`，**都不含 `__init__.py`**，解释器把它们合并成同一个包。

```
PYTHONPATH = vendor/prime : python/compat : python

vendor/prime/rlm/repl.py        →  rlm.repl   （上游）
python/compat/rlm/bash.py   →  rlm.bash   （我们的）
```

于是 `import rlm.repl` 拿到上游那份，它内部的 `from .bash import ...` 落到我们那份。**上游文件完全不用动。**

顺序有意义：`vendor/prime` 排在最前，所以我们的文件永远不可能遮蔽掉同名的上游模块。测试里有一条专门钉这件事。

细节见 `python/compat/README.md`。

### 验证

`python3 -m rlm.repl` 在没有 `prime-agent` 的环境里能启动、完成 protocol 3 握手、跨格保留变量、干净退出。`test/python/test_vendor_integration.py` 含真子进程协议往返。

## 运行环境约束

上游 `prime-agent-runtime/pyproject.toml` 声明 `requires-python = ">=3.11"`，本项目照用。默认用 uv 管理的 3.14：快照依赖的 `dill` 0.4.1 在 3.15 上存不了函数和类。

## 运行时改动上游模块的地方

vendor 文件不改，但 DSH 在运行时改了上游模块里的这几样，升级后要确认它们还在、含义没变（`test/python/test_vendor_integration.py` 校验这些接口）：

- `rlm.repl._ALWAYS_SKIP`、`rlm.repl._RESTORE_SKIP`：`python/bootstrap.py` 把 DSH 的系统名字加进去，快照不存、恢复不回填。
- `rlm.repl._error_event`：`python/dsh_kernel.py` 包裹，给 NameError 加提示。
- `rlm.repl.host_request`、`rlm.repl._current_cell`：工具桥按原调用和代码格身份请求 DSH。
- `rlm.repl._send`、`rlm.repl._compile_cell`、`rlm.repl._handle_list_names`：`python/panel_state.py` 记录源码并返回对象面板状态。

## 升级策略

**默认冻结，不主动跟随上游版本。** 只有出现明确 bug、安全问题或确实需要的新能力，才做受控升级。

### 升级怎么做

1. 选定新的 tag，**解析成 commit**：`git rev-list -n 1 <tag>`。tag 会移动，记 commit。
2. 先看 diff，别直接覆盖：
   ```bash
   git diff efb25e2be62507f8a13a157545d031da213abac9..<新commit> -- prime-agent-runtime/src/rlm/repl.py
   ```
   重点看三处：wire 协议（`repl.md` 的 protocol 版本、事件字段）、`_current_cell` 还在不在（我们的按格归属靠它）、`from .bash import` 那行有没有改成 import 别的符号。
   `repl.md` 不一定列全请求类型（0.10.3 的 `factory_activity` 只出现在 `repl.py`），要对照 `repl.py` 里 `_REQUIRED_FIELDS` 和文件开头的 `from . import`。
3. 覆盖 `vendor/prime/rlm/` 下的文件，**只覆盖，不编辑**。
4. 更新本文件：commit、所有固定链接、三个哈希。
5. 跑 `pnpm run check`。`test/python/test_vendor_integration.py` 会立刻告诉你哈希对不对、vendor 目录有没有混进我们的文件、`rlm.repl` 的契约还成不成立。
6. 如果 `repl.py` 开始 import `rlm.bash` 里没有的符号，内核启动会 `ImportError` —— 这是故意的绊线，按需在 `python/compat/rlm/bash.py` 里补，**仍然不许改 vendor**。
