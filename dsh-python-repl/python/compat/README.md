# compat — 我们为 vendor 内核写的兼容层

**这个目录里的东西全部是我们自己的。** 隔壁 `vendor/prime/` 里的东西全部是上游的，一个字节都不改。

归属靠**目录**区分，不靠一份"哪个文件是谁的"清单——那种清单下次 bump 版本就会漏。

## 它怎么和 vendor 拼在一起

`rlm` 是一个 **Python 命名空间包**（PEP 420）：两个目录下都有 `rlm/`，且**都不含 `__init__.py`**，于是解释器把它们合并成同一个包。

```
PYTHONPATH = <vendor/prime> : <python/compat>

vendor/prime/rlm/repl.py      →  rlm.repl    （上游，只读）
python/compat/rlm/bash.py →  rlm.bash    （我们的）
```

`import rlm.repl` 拿到上游那份，`from .bash import ...` 落到我们这份。上游文件因此完全不需要改。

顺序有意义：vendor 在前，所以同名文件永远是上游的赢——我们不可能意外遮蔽掉上游模块。

## 为什么不用上游的 `bash.py`

上游 `rlm/bash.py` 约 48KB，实现 Prime 自己的 bash 能力（BashHandle、进程组、Windows job object、关机日志）。不 vendor 它有两个理由：

1. **bash 归 DSH 管。** 把 Prime 原生 bash 装进内核，等于在里面放了第二个不受管的命令执行器，绕开 DSH 的权限闸门——设计明令禁止（技术方案 §8.2、§8.3）。
2. **`repl.py` 只需要两个钩子**：`_kill_live_handles()` 在退出和 owner watchdog 中清理本内核未脱离的进程组；`_rehydrate_persistent_shells()` 在启动时调用。

本部署不创建 Prime 持久终端，恢复钩子返回 None；DSH 后台任务仍由宿主管理。清理钩子只在宿主明确标记本内核拥有进程组时发送 SIGTERM。

## 绊线

`bash.py` **故意只导出 `_kill_live_handles` 和 `_rehydrate_persistent_shells`**，不提供 `bash()`、`BashHandle` 或任何其他上游公开名。

将来升级 vendor 后，如果 `repl.py` 开始 import 别的符号，内核启动会直接 `ImportError` 炸出来，而不是悄悄降级。这是设计好的行为，不是缺陷。

## 别在这里放业务代码

这个目录只装"为了让上游内核跑起来所必需的最小兼容垫片"。我们自己的运行时代码（桥、技能加载、REPL 感知）在上一层 `python/` 里，那些不属于 `rlm` 命名空间。
