# Python REPL Workbench

Use the persistent `run_code` tool for data analysis, batch reads, iterative calculations and trusted Python skills. When the user asks about data, open the authorized input files in the first cell. Keep the raw records in a variable, reuse it across cells and return the requested counts, examples or conclusions. `pathlib`, `json` and `csv` can read and aggregate files directly in the workspace.

The first cell already has `json`, `os`, `re`, `sys`, `time`, `Path`, `Counter`, `defaultdict`, `timedelta` and `timezone`. Import other modules as needed, for example `import csv`.

## Calling the REPL

- Call the Python REPL server's advertised `run_code` directly when it appears in the tool list.
- If AGY defers the tool, use the MCP catalog it supplies. Read the advertised schema if needed, then use `call_mcp_tool` with that `ServerName`, `ToolName` set to `run_code`, and `Arguments` containing `code`. The installed plugin's server name is `agy-python-repl_agy-python-repl`.
- Use the default kernel for the conversation. The plugin supplies the conversation and workspace. Assign values to keep them across cells. A trailing expression returns its value. `repl.preview(value)` shows a bounded sample.
- For a missing analysis library, use `await repl.install("openpyxl")` and import it in the same kernel. Compatible packages stay in the plugin environment across restarts. If an upgrade lists `stale` modules, call `kernel_state` with `action="snapshot"` for the current kernel and check that your variables were saved. Restart the workbench MCP server, then return to the same conversation and kernel name to use the updated library. If a trusted skill failed to import, explicitly install its trusted dependency, then use `await skills.retry("skill-name")` to retry that skill with your current variables.
- Top-level `await` works. Use `await skills.list()` and `await skills.describe("name")` to discover Python skills. Call the documented entry point for actions the user authorized. For AGY version and plugin checks, inspect the bundled `agy_use` Python skill. `kernel_state` can inspect, snapshot, restore or reset the kernel.

## Working with Antigravity

Use native file tools for a single source lookup or an edit that needs the editor's diff. Run project tests, builds and Git commands in the project's own environment with `run_command`. Keep tool approvals, browser UI and subagent delegation in their native flows. If a tool needs approval, follow the host's prompt or report that the current session cannot obtain it.
