# Python REPL

For a review or investigation spanning source files, documentation or implementations, start with the persistent `run_code` tool. Complete any required native `read_file` of a skill's `SKILL.md` or `rg` search for candidate paths, then read the files relevant to the requested scope together in the first Python cell. Keep their paths and text in a mapping such as `sources = {p: p.read_text() for p in paths}`. Compare implementations and answer follow-up questions from that mapping. To cite a line, iterate over `enumerate(sources[path].splitlines(), 1)`. Read a file again when it has changed, the first read was incomplete, or a native edit requires its own read.

Use `run_code` first for data analysis, other batch reads, iterative calculations and trusted Python skills. Open the authorized inputs in the first cell. Keep the records in a variable and return the requested counts, examples or conclusions. `pathlib`, `json` and `csv` can read and aggregate workspace files directly.

The first cell already has `json`, `os`, `re`, `sys`, `time`, `Path`, `Counter`, `defaultdict`, `timedelta` and `timezone`. Import other modules as needed, for example `import csv`.

## Calling the REPL

- Call the Python REPL server's advertised `run_code` directly when it appears in the tool list.
- If AGY defers the tool, use the MCP catalog it supplies. Read the advertised schema if needed, then use `call_mcp_tool` with that `ServerName`, `ToolName` set to `run_code`, and `Arguments` containing `code`. The installed plugin's server name is `agy-python-repl_agy-python-repl`.
- Use the default kernel for the conversation. The plugin supplies the conversation and workspace. Assign values to keep them across cells. A trailing non-`None` expression puts a text preview in `result` and keeps the object in `_`. Assignments and `print()` leave `_` available for the next cell. `repl.preview(value)` shows a bounded sample.
- For a missing analysis library, use `await repl.install("openpyxl")` and import it in the same kernel. Compatible packages stay in the plugin environment across restarts. If an upgrade lists `stale` modules, call `kernel_state` with `action="restart"` for the current kernel. Continue after `status="ok"` and check the `restored` names. If the restart fails, inspect `error` and any `skipped` or `failed` entries. `original_kept=true` means your previous kernel is still available. If a skill import reports a missing trusted dependency, install it and call `await skills.retry("skill-name")` in the same kernel. If the reported problem is an invalid instructions file, fix that file and reopen the workbench or use a new kernel name to discover the change.
- If a partial restore pauses saving, use `await repl.save_copy("variable")` for work you need to keep. In the same conversation and kernel, use `await repl.list_copies()` and `await repl.read_copy(copy_id)` to retrieve it.
- Top-level `await` works. Use `await skills.list()` and `await skills.describe("name")` to discover Python skills. Call the documented entry point for actions the user authorized. Use the bundled `agy_use` skill for desktop conversations. Use `kernel_state` with `action="reset"` only when the user wants to clear the kernel and delete its saved snapshot.

## Working with Antigravity

Use native tools for a single source lookup, viewing images and edits that need the editor's diff. Run project tests, builds and Git commands in the project's own environment with `run_command`. Keep tool approvals, browser UI and subagent delegation in their native flows. If a tool needs approval, follow the host's prompt or report that the current session cannot obtain it.
