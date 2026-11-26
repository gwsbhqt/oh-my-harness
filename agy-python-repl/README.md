# agy-python-repl

Use a persistent Python session in Antigravity for data analysis, batch reads, calculations, and Python skills. The workbench shares `python-repl-core` and the vendored Prime kernel with `dsh-python-repl`.

## Features

- **Stateful Python kernels (`run_code`)**: top-level `await`, variables and functions preserved across cells, named kernels (`default` or custom names).
- **Output previews**: long stdout, stderr and result previews include paths to the captured text under `PLUGIN_DATA`. Python objects stay available in the kernel. The result file contains the displayed representation.
- **Python skills (`skills.*`)**: discovers trusted skills under `~/.agents/skills` and `<repo>/.agents/skills`. The bundle includes [`agy-use`](skills/agy-use/SKILL.md) for inspecting the installed CLI and plugins, and running a task in a selected workspace.
- **Snapshot persistence (`kernel_state`)**: save and restore serializable Python variables across restarts. A failed or partial restore protects the previous snapshot and reports what happened.
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

Open a new conversation in the project you want to analyze. `run_code` is available from the first turn. Antigravity handles permission requests for the Python tool. In headless mode, inspect `result.denied_actions` and the tool events when a run returns an empty answer. The CLI can exit successfully after a tool was denied. [Headless mode](https://antigravity.google/docs/cli/headless/) · [Permissions](https://antigravity.google/docs/permissions/)

## Testing

```sh
cd agy-python-repl
uv run --frozen --python 3.14 python -m unittest discover -s tests -v
uv run --frozen --python 3.14 python -m unittest discover -s skills/agy-use/tests -v
```
