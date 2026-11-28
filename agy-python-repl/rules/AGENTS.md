# Python REPL

Continue each `run_code` cell in this conversation's live Python namespace. Use the workbench for operations it can perform, including reading and searching files, testing, building, and analyzing data. Batch independent work in one cell. Use host-native tools when the task needs an editor diff, interactive terminal or approval, browser or media surface, agent delegation, or a managed background job.

## Continue with the state you have

- Bind a project root once when you need one. Once `repo` exists, pass `repo / "tests"` or `repo / "config.json"` directly to the file helpers. They accept `Path` objects. The default working directory follows the conversation. Supply `cwd` on `run_code` only to change directories.
- Keep the complete tool result, parsed data and useful functions in variables. Use the same object for a follow-up unless the source changed. If unsure whether a specific name survived, use `"repo" in globals()` or `repl.vars("repo")`. Check a restore notice for any names that were lost.
- Define repeated work once. A function keeps temporary variables local and can return data for later cells. `await repl.helpers("test")` displays matching signatures and returns an indexable list. For a helper named `_probe`, search with `await repl.helpers("_probe")`.
- `read`, `write`, `edit`, `bash`, `glob`, `grep`, `asyncio` and `ToolCallError` are ready in the first cell. So are `Path`, `json`, `os`, `re`, `sys`, `time`, `Counter`, `defaultdict`, `timedelta` and `timezone`.

## Display what answers the question

- Assignments stay quiet. A final expression displays a single value or a readable tool result and saves its value in `_`. Top-level `await` works.
- When the requested answer has several named values, use one `print` per value. Give each line a short label in the user's language. Keep the underlying objects in variables for follow-up. Finish any checks that determine the answer in the same cell, before printing. Once those lines are displayed, answer from them. A new cell is useful if a check actually found a discrepancy. A request for total, passed and failed gets three lines.

  ```python
  print("Total", len(latest))
  print("Passed", counts["pass"])
  print("Failed", counts["fail"])
  ```

- For a count or comparison, read the inputs, compute the aggregate and display the requested fields in one cell when the input shape is known. Keep open files and iterators local to the helper and save the materialized records for follow-up. Inspect column names if the layout is unknown. Report a discrepancy only if it affects the answer.
- `repl.preview(value)` displays a bounded view of an in-memory value. Keep the returned dict to check `truncated` and `reasons` later. Previewing an iterator leaves its items available.
- For a source lookup, start in the relevant directory. For example, `paths = await glob("src/**/*.py", repo)` searches the `src` tree inside `repo`. Use the saved matches to read the few lines that answer the question. Save `section = await read(path, offset=line, limit=4)` and display `section`. When more context is needed, read only the missing lines.
- For tests, keep the `bash` result and check `exitCode`. Show `ok` on success. On failure, give the failing cases and actual errors from the captured output. If the runner stopped before it collected tests, show that startup error. Use complete data to count failures or conclude that a search found nothing. You can inspect the saved result again for details.
- The six helpers return ordinary structured data with compact displays. Read results have `.lines` and `.text`, command results have `.exitCode`, `.stdout.text` and `.stderr.text`, searches have `.matches`, and file listings have `.paths`. For repeated project commands, reuse one function with `workdir=repo`. Pass only the environment overrides the command needs, for example `env={"VIRTUAL_ENV": None}` to omit one inherited setting. Parallelize independent reads or commands with `asyncio.gather`. Use the host's managed task facility when a command must keep running after its cell.

## Start and recover

- Use `run_code` directly when advertised. For a deferred tool, use the listed `ServerName` and `ToolName="run_code"` in `call_mcp_tool`. A conversation gets its own kernel. Session selection happens outside the code arguments.
- `await skills.list()` and `await skills.describe("name")` find Python skills. Install a missing analysis library with `await repl.install("openpyxl")`. Run project commands in their own environment. When an upgraded module is listed as stale, use `kernel_state(action="restart")` and inspect the restoration result. `await skills.retry("name")` retries a failed skill import after its dependency is available.
- A partial restore protects the original snapshot. Save selected work with `await repl.save_copy("name")` and retrieve it with `await repl.list_copies()` and `await repl.read_copy(copy_id)`. Reset the kernel and remove its saved state only when the user asks.
