[中文](dsh-python-repl.md) | English

# Use persistent Python cells

`dsh-python-repl` gives each DSH session a Python interpreter that stays alive between `run_code` calls. Use it when a task needs several tool calls, reusable analysis, or data that would otherwise be printed repeatedly into the conversation. Variables and functions remain available in later cells, and top-level `await` lets Python coordinate asynchronous work.

## Work with values, then show evidence

Start with a small cell that defines the data or collects a tool result. Keep the full result in a variable and display only the evidence needed for the next decision. This fictional example uses only in-memory data:

```python
records = [
    {"item": "sample-a", "passed": True},
    {"item": "sample-b", "passed": False},
]
failed = [record for record in records if not record["passed"]]
{"total": len(records), "failed": len(failed)}
```

A later cell can inspect `failed` without recreating `records`. A final expression produces a result; an assignment alone does not. For larger objects, `await repl.preview(records)` provides a bounded view. A preview is not proof that an upstream response was complete. Check pagination, truncation, and command exit status before counting or drawing conclusions. `await repl.require_complete(result)` can validate a foreground Bash result; it cannot certify arbitrary file reads or paginated responses.

Harness tools are available through `tools`. The six fixed helpers are `read`, `write`, `edit`, `bash`, `glob`, and `grep`. Trusted Python skills appear under `skills`; use `await skills.list()` and the relevant `await skills.describe(...)` before calling an unfamiliar skill. Skill discovery and successful import are separate states, so check the startup report for unavailable imports.

## Confirm progress and recovery

The kernel tab exposes names and execution history. Confirm persistence by inspecting a value in a subsequent cell. After a kernel or Harness restart, read the restoration report before continuing: serializable values may return, while open connections, processes, and running tasks do not return as live resources. Reconcile unfinished external actions before retrying them.

Use `repl.background` for Python work that must continue after a cell ends. Collect its eventual result and inspect failures. Services that must survive a kernel belong in managed Harness background jobs. The interpreter is an analysis environment; run a project's tests and scripts through that project's own environment rather than installing its dependencies into the kernel.

## Understand the trust boundary

This is trusted host Python, not a sandbox. Python code and imported skills can access files, networks, and processes directly. Harness tool calls retain their approval and policy checks; those checks do not isolate arbitrary Python. Only configure skill directories whose code you trust.

Cancellation does not undo completed external effects. Threads or detached processes may continue, and a timeout does not establish whether a remote action finished. Inspect saved results before resuming.

The implementation is supported and tested on macOS only. It replaces the TypeScript code runtime and disables the workflows that require that runtime. See the [plugin README](../dsh-python-repl/README.en.md) for requirements, installation, all settings, and snapshot behavior. [Python data locality](design/python-data-locality.en.md) explains why retaining values and limiting display matters.