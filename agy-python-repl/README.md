# agy-python-repl

Use a persistent Python session in Antigravity to review related source files and documents, analyze data, compare results across turns, and run Python skills. The workbench shares `python-repl-core` and the vendored Prime kernel with `dsh-python-repl`.

## Features

- **Stateful Python kernels (`run_code`)** support top-level `await` and preserve variables and functions across cells. Kernel names retain spaces, case, and Unicode across restarts. One server at a time can run or change a given kernel. If another server has it open, close that session or choose a different kernel name. The kernel list and overview remain available. After an upgrade, close sessions running an older plugin version before resuming the same kernel. Use the name shown in the kernel list to reopen an older snapshot. Older snapshots only record their disk spelling.
- **Output previews**: long stdout, stderr and result previews include paths to the captured text under `PLUGIN_DATA`. Python objects stay available in the kernel. The result file contains the displayed representation.
- **Analysis libraries (`repl.install`)** install on request into the plugin's Python environment. For example, `await repl.install("openpyxl")` makes the library available to import in the same cell and in later sessions using the same plugin data. uv keeps the versions pinned for the workbench and reports a conflict when a library requires a different version. Use `upgrade=True` for an upgrade. If the result lists `stale` modules, call `kernel_state` with `action="restart"` for the current kernel to load the updated library. When a trusted skill fails to import, install its trusted dependency explicitly, then call `await skills.retry("skill-name")` with its published name to retry in the current kernel with your variables.
From this repository, build a standalone copy for Antigravity. The bundle includes the shared kernel, the skill, the rules and hooks, and the desktop sidecar.
- **Snapshot persistence (`kernel_state`)**: save and restore serializable Python variables across restarts, including single-underscore names. A list referenced by two names or by a dictionary remains one list after recovery. New snapshots also keep a named openpyxl workbook, worksheet and cell connected. After a restart or a recovery copy containing all three, edits through the cell appear in the workbook. If recovery reports a ZIP archive backed by a closed file, reopen its source file to continue reading. When a variable cannot be saved, the cell reports the number skipped and sample names. The latest snapshot manifest lists every skipped name and its reason. Each save publishes the values and the list of skipped names together. If saving stops before publication, the previous snapshot remains available. If the service exits before replying, start the workbench MCP server again and return to the same conversation and kernel name to check the saved state. A failed or partial restore protects the previous snapshot and reports what happened. To back up or move saved kernels and explicit recovery copies, include `PLUGIN_DATA/snapshots` and `PLUGIN_DATA/recovery` with their hidden directories.
- **Kernel Inspector** shows live variables and cell history in Antigravity’s side pane. Choose **Restart** on the active kernel to save its variables and open them in a fresh Python process. The tool and panel report success after the new process restores them. If a value cannot be saved or restored, the original process stays available and the response identifies the affected variable. **Reset** clears the kernel and deletes its saved snapshot.

Package installation reads your user-level `uv.toml` or the file selected by `UV_CONFIG_FILE`. You can use a private index or local wheel directory from that file. If the file sets `[pip].target`, select a configuration that contains your package sources and leaves the install location to the workbench.

## Keep selected variables after a partial restore

To keep new work while the previous snapshot is protected, run `saved = await repl.save_copy("rows", "summary")` in the active kernel. Check `saved["saved"]` and `saved["skipped"]`. A successful copy has a `copy_id`.

When you return to the same conversation and kernel, `await repl.list_copies()` lists its copies. Read one with `copy = await repl.read_copy(copy_id)`. Its `values` dictionary holds the objects you can use. The `failed` and `skipped` lists explain which names could not be restored or saved.

## Requirements

- The launcher uses [uv](https://docs.astral.sh/uv/) to provision Python 3.14 and the locked kernel dependencies. It stores the environment in the plugin data directory.

## Install

### From a pre-built bundle

Open a terminal in the unpacked bundle directory that contains `plugin.json`.

```sh
agy plugin validate . --strict &&
agy plugin install . &&
agy plugin list --json
```

### From the source checkout

From the repository root, build and install a standalone copy for Antigravity. The bundle includes the shared kernel, the skill and the plugin’s rules and hooks.

```sh
bundle_dir="$(mktemp -d)" &&
sh agy-python-repl/scripts/bundle.sh "$bundle_dir" &&
agy plugin validate "$bundle_dir" --strict &&
agy plugin install "$bundle_dir" &&
agy plugin list --json
```

Open a new Antigravity desktop conversation and ask for two workbench calls. In the first, set `samples = [3, 5, 8]` and run `len(samples)`. In the second, run only `sum(samples)`. Open the two `run_code` results in that conversation. They should show `status="ok"` with `result="3"` and `result="16"`.

The workbench gives each conversation guidance on choosing tools. During a review, load related files together in `run_code` and reuse their contents for follow-up questions. Use native tools for a single lookup, edits, images, Git and project commands. An existing conversation can receive updated guidance on its next model invocation once Antigravity has loaded the new hooks. When a snapshot is being saved, the first Python cell waits for it.

See the [agy-use skill](skills/agy-use/SKILL.md) to send messages to an existing desktop conversation and read its replies. Antigravity handles Python tool permissions. For a headless CLI run with an empty answer, inspect `result.denied_actions` and the tool events. The CLI can exit successfully after a tool was denied. [Headless mode](https://antigravity.google/docs/cli/headless/) · [Permissions](https://antigravity.google/docs/permissions/)

Enable `agy-python-repl/app-bridge` in Antigravity’s Sidecars settings for desktop control. Its default Unix socket lives under the current user’s state directory. For a custom `AGY_USE_SOCKET`, choose a directory owned by and writable only by that user. [Sidecar configuration](https://antigravity.google/docs/sidecars.md)

After binding its socket, the bridge watches its direct launching parent and shuts down normally if that parent disappears, allowing the configured restart policy to start a replacement. Client disconnects and duplicate starts do not interrupt a healthy bridge. A bridge already parented to PID 1 at startup, or owned by a long-lived supervisor, must be terminated normally by that supervisor.

For cross-host handoffs from Antigravity to DSH with a single settled completion notice back to the originating Antigravity conversation, pass `--notify self` in Antigravity shell commands (`ANTIGRAVITY_CONVERSATION_ID`) or `notify="agy:<conversation_id>"` in Python REPL (`skills.dsh_use.send` / `new`), which sends a minimal status-only notice via `agy-use send --wait-receipt` over `bridge.sock` without reading secrets or renaming the target conversation.

## Testing

```sh
cd agy-python-repl
uv run --frozen --python 3.14 python -m unittest discover -s tests -v
uv run --frozen --python 3.14 python -m unittest discover -s skills/agy-use/tests -v
```
