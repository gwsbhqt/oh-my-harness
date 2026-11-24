# python-repl-core

Shared Python core for persistent Prime REPL kernel hosts (`dsh-python-repl`, `agy-python-repl`).

Provides:
- `python_repl_core.kernel_client`: Async stdio JSONL client (protocol 3) for `vendor/prime/rlm/repl.py`.
- `python_repl_core.preview`: Bounded, read-only object previewer.
- `python_repl_core.output_budget`: Head/tail output truncation with overflow file spill.
- `python_repl_core.skill_discovery` & `skills_runtime`: Trusted Python skill discovery and `skills.*` namespace loader.
- `python_repl_core.compat.rlm`: Minimal `bash` and `factory` shims for `rlm.repl`.
