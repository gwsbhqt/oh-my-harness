# agy-python-repl

Use a persistent Python session in Antigravity for data analysis, batch reads, calculations, and Python skills. The workbench shares `python-repl-core` and the vendored Prime kernel with `dsh-python-repl`.

## Features

- **Stateful Python kernels (`run_code`)** support top-level `await` and preserve variables and functions across cells. Kernel names retain spaces, case, and Unicode across restarts. One server at a time can run or change a given kernel. If another server has it open, close that session or choose a different kernel name. The kernel list and overview remain available. After an upgrade, close sessions running an older plugin version before resuming the same kernel. Use the name shown in the kernel list to reopen an older snapshot. Older snapshots only record their disk spelling.
- **Output previews**: long stdout, stderr and result previews include paths to the captured text under `PLUGIN_DATA`. Python objects stay available in the kernel. The result file contains the displayed representation.
- **Python skills (`skills.*`)**: discovers trusted skills under `~/.agents/skills` and `<repo>/.agents/skills`. The bundle includes [`agy-use`](skills/agy-use/SKILL.md) for inspecting the installed CLI and plugins, and running a task in a selected workspace.
- **Snapshot persistence (`kernel_state`)**: save and restore serializable Python variables across restarts, including single-underscore names. A list referenced by two names or by a dictionary remains one list after recovery. When a variable cannot be saved, the cell reports the number skipped and sample names. The latest snapshot manifest lists every skipped name and its reason. Each save publishes the values and the list of skipped names together. If saving stops before publication, the previous snapshot remains available. If the service exits before replying, reopen the kernel to check the saved state. A failed or partial restore protects the previous snapshot and reports what happened. To back up or move saved kernels, copy the entire `PLUGIN_DATA/snapshots` directory, including its hidden directories.
- **Kernel Inspector (`aux_pane` UI)**: Antigravity MCP App side-pane view for inspecting live variables and cell history.

## Requirements

- The launcher uses [uv](https://docs.astral.sh/uv/) to provision Python 3.14 and the locked kernel dependencies. It stores the environment in the plugin data directory.

## Install

From this repository, build a standalone copy for Antigravity. The bundle includes the shared kernel, the skill and the plugin’s rules and hooks.

```sh
bundle_dir="$(mktemp -d)"
sh agy-python-repl/scripts/bundle.sh "$bundle_dir"
agy plugin validate "$bundle_dir" --strict
agy plugin install "$bundle_dir"
agy plugin list --json
```

New conversations receive the Python workbench hint on their first turn. In an existing conversation, use `run_code` once it appears in that conversation’s tool list. To continue a CLI conversation with its saved variables, pass its original ID as `conversation_id` to `skills.agy_use.run` and use the same workspace. Antigravity handles permission requests for the Python tool. In headless mode, inspect `result.denied_actions` and the tool events when a run returns an empty answer. The CLI can exit successfully after a tool was denied. [Headless mode](https://antigravity.google/docs/cli/headless/) · [Permissions](https://antigravity.google/docs/permissions/)

## Testing

```sh
cd agy-python-repl
uv run --frozen --python 3.14 python -m unittest discover -s tests -v
uv run --frozen --python 3.14 python -m unittest discover -s skills/agy-use/tests -v
```
