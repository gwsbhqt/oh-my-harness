# agy-python-repl

Persistent Prime Python REPL workbench plugin for Antigravity, sharing `python-repl-core` and the vendored Prime kernel with `dsh-python-repl`.

## Features

- **Stateful Python kernels (`run_code`)**: top-level `await`, variables and functions preserved across cells, named kernels (`default` or custom names).
- **Data locality (`output_budget` + `repl.preview`)**: large outputs are bounded to head/tail previews while full text spills to `PLUGIN_DATA` and raw objects remain in memory.
- **Trusted Python skills (`skills.*`)**: auto-discovers skills with `src/<import_name>/` under `~/.agents/skills` and `<repo>/.agents/skills`.
- **Snapshot persistence (`kernel_state`)**: save and restore serializable kernel namespaces via `dill`.
- **Kernel Inspector (`aux_pane` UI)**: Antigravity MCP App side-pane view for inspecting live variables and cell history.

## Requirements

- Python `>=3.11,<3.15` (3.14 recommended for `dill` snapshot compatibility)
- [uv](https://docs.astral.sh/uv/)

## Testing

```sh
cd agy-python-repl
uv run --python 3.14 --with pytest python -m unittest discover -s tests -p 'test_*.py' -v
```
