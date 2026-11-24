# Python REPL Workbench (`agy-python-repl`)

You have a per-session persistent Python REPL (`run_code` and `kernel_state`) backed by a stateful Prime kernel. Variables, imports, and functions persist across `run_code` calls and automatically survive restarts via snapshots.

## When to Use `run_code` vs. Native Tools

| Task | Use | Why |
| :--- | :--- | :--- |
| Ad-hoc Python execution or scripting | **`run_code`** | **NEVER** use `run_command` with `python -c` or `/tmp` scripts for analysis; keep state in the kernel. |
| Large files, logs, JSON, CSV, or API data | **`run_code`** | Load raw data into Python variables and print only concise summaries/evidence into chat. |
| Multi-step computation or iterative probing | **`run_code`** | Reuse intermediate variables and helper functions across cells without recomputing. |
| Orchestrating Python skills (`skills.*`) | **`run_code`** | Call `await skills.list()` / `skills.describe("<name>")` and compose them directly in Python. |
| Editing project source files | `edit_file` / `write_file` | Preserves IDE diff tracking and file-level editing semantics. |
| Running project tests, builds, or git | `run_command` | Runs in the project's own environment and toolchain. |
| Web UI interaction or subagent delegation | `browser` / `invoke_subagent` | Native Antigravity orchestration and permissions. |

## Kernel Conventions

- **Top-level `await` works**: write `await ...` directly without `asyncio.run()`.
- **Return values**: trailing expressions return their value; plain assignments do not.
- **Large outputs**: outputs are bounded with head/tail previews and full text spills to disk (`overflow_files`). Use `repl.preview(obj)` to inspect large in-memory structures safely.
- **Trusted Python skills**: do not `pip install` project dependencies into the kernel; call `await skills.list()` first and read `await skills.describe("<import_name>")` before using an unfamiliar skill.
- **Lifecycle**: `kernel_state` supports `list`, `vars`, `snapshot`, `restore`, and `reset` (which clears both live memory and the saved snapshot).
