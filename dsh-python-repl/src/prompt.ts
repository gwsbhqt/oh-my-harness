/**
 * Model-facing text for persistent cells.
 *
 * The official Python SDK preamble teaches "the body of an async Python
 * function" with a top-level `return`. That is TRUE of the shipped TypeScript
 * backend and FALSE here: a persistent cell is module-level code, so
 * `return` is a SyntaxError and the trailing expression is what shows.
 * Leaving both texts in the prompt would be a direct contradiction, so we
 * replace the preamble and keep the generated declarations.
 *
 * @module
 */

import { accessPath, summarize, type ToolSchemaLike } from './catalog.ts'
import type { SkillSummary } from './skill-discovery.ts'
import { SUBAGENT_WAIT_MS } from './subagent.ts'

export const RUN_CODE_DESCRIPTION = 'Execute a persistent Python cell. Variables, functions, classes and imports you define stay in the kernel across cells and turns, and are saved and restored if the kernel is replaced; only values that cannot be serialized (open files, connections, processes) are dropped then, and named. Top-level await works; top-level return does not. Display a small trailing expression or print a summary; assignments display nothing. Use the SDK catalog for actual tool contracts. Failed/cancelled cells do not roll back prior effects. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project\'s own environment.'

/** run_code's runtime-owned instructions: the PTC executor puts its own generic sentence first. */
export const RUN_CODE_EXECUTION_INSTRUCTIONS = RUN_CODE_DESCRIPTION.replace(/^Execute a persistent Python cell\. /, 'Each program is a persistent Python cell, not a function body. ')

/**
 * Say how the fully declared non-top-level tools are reached.
 *
 * The generated protocol lists them beside `bash` and friends, which reads as
 * "these are top-level too" — a bare `job_output(...)` would be a NameError.
 * One line names the real access path.
 */
export function renderResidentAccess(names: readonly string[]): string {
  if (names.length === 0) return ''
  const paths = [...names].sort().map((name) => `\`${accessPath(name)}\``).join(', ')
  return `\n\nAlso declared in full above, but reached through \`tools\` (they are NOT top-level names): ${paths}.`
}

export function renderToolSummaries(schemas: readonly ToolSchemaLike[]): string {
  return [
    '## Other DSH tools (summaries, not signatures)',
    'Call `await tools.describe("name")` for full input and output schemas. These names are registered, not a guarantee of credentials or external readiness.',
    ...[...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map((schema) => `- \`${accessPath(schema.name)}\` — ${summarize(schema.description) || 'description unavailable'}`),
  ].join('\n')
}

/** Marks the end of the official preamble: everything from here is generated. */
const DECLARATION_FENCE = '```python'

/**
 * The cell-semantics preamble. Replaces the official function-body text.
 * Written for a model that must decide what NOT to print.
 */
export const CELL_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` runs a persistent Python CELL, not a function body. The kernel keeps one namespace for the whole session, so variables, functions, imports and objects from earlier cells are still there in later ones.

- **No top-level \`return\`** — it is a \`SyntaxError\` here. To show a value, end the cell with a bare expression; a non-\`None\` trailing expression is displayed and also bound to \`_\`. \`print(...)\` works too. Assignments display nothing.
- Top-level \`await\` works. Every tool is awaitable and takes one dict of arguments or keyword arguments: \`await tools.web_fetch(url=u)\` is the same call as \`await tools.web_fetch({"url": u})\`. The six fixed helpers also take their main arguments in order: \`await read(p)\`, \`await read(p, offset=200, limit=80)\`, \`await write(p, text)\`, \`await edit(p, old, new)\`, \`await bash("ls -la", "列出文件")\`, \`await glob("**/*.py")\`, \`await grep("TODO", "src")\`.
- Already bound in every kernel, no import needed: \`json\`, \`os\`, \`re\`, \`sys\`, \`time\`, \`asyncio\`, \`Path\` (pathlib), \`Counter\` and \`defaultdict\` (collections), \`timedelta\` and \`timezone\` (datetime). Anything else needs an import in this kernel, even if a \`bash\` subprocess or an earlier kernel imported it; importing or rebinding these names yourself is fine.
- Every cell is a full model round trip. When the next few probes do not depend on each other's results, run them in ONE cell and display one compact summary, instead of one tool call per cell.

### Working pattern

- Make the first cell setup-only: imports you actually need, paths, constants, and helpers. Later cells reuse them; do not re-import names that are already bound.
- Call \`await repl.helpers()\` before defining a helper that may already exist. \`repl\` is a reserved system binding: never assign to it.

### Shell commands

- \`r = await bash(command, description)\` returns \`exitCode\`, \`stdout\` and \`stderr\`. Calls in sequence run in sequence; \`await asyncio.gather(bash(a, ...), bash(b, ...))\` runs them at the same time. A cell waits only a few seconds on a command: a longer one keeps running, \`r\` says so, and DSH wakes you when it finishes; \`await r\` then gives its result (before that it raises \`JobStillRunning\`, a \`TimeoutError\`). \`bash(command, description, run_in_background=True)\` returns that handle at once (a server, a watcher, a long build); \`await r.peek()\` shows its output so far and \`await r.kill()\` stops it.
- \`exitCode\` is the status of the script's LAST command: \`cmd | tail\` reports \`tail\`, and \`echo "rc=$?"\` after a pipe reports the pipe's last stage. When one step's success matters, run it as its own call (or \`set -o pipefail\`). Keep output whole and slice it in Python rather than piping through \`head\`/\`tail\`; do not hide errors with \`2>/dev/null\`.
- Build shell text with raw strings (\`r'''…'''\`). \`bash\` accepts an extra \`stdin\` string, fed as a quoted heredoc with no expansion: \`await bash("jq '.items | length'", "统计条数", stdin=payload)\`.
- Run shell commands with \`bash\`, not \`subprocess\`/\`os.system\`: those block the kernel and bypass DSH's permissions and job control. Programs a cell starts itself (\`subprocess.Popen\`, a headless browser, a local server) are stopped with this kernel; start a long-running service with \`bash(..., run_in_background=True)\` so it has a job id. Only \`start_new_session=True\` detaches a process, and then you own stopping it.

### Find the right capability without guessing

- \`run_code\` still requires both \`code\` and \`description\`. Generated \`TypedDict\`/protocol declarations below are documentation, NOT runtime classes: pass plain JSON-compatible values, never instantiate an \`Args\` class. Tool values follow the documented output schemas. Successful image tools also attach an image for the model on the next step.
- Six fixed helpers: \`read / write / edit / bash / glob / grep\` (for the standard-library module write \`import glob as globlib\`, or it replaces the tool). Other DSH tools use \`tools.<name>\`; only a tool whose name is not an identifier or is itself \`list\`/\`describe\` needs \`tools["name"]\` — the catalog methods are always \`tools.list(...)\`/\`tools.describe(...)\`. A few \`tools.*\` entries are declared in full next to the six; the rest are one-line summaries, so \`await tools.describe("name")\` (or a list of names) for the parameters AND the returned value before relying on them. Listings use \`next_cursor\`: pass it back with the same filters until it is null. \`repl.list\` takes a \`limit\` of 1–500.
- \`skills\` contains configured, trusted Python modules, imported before the first user cell; it is NOT the DSH instruction-skill catalog. For DSH instruction skills use \`await tools.skill({"name": "..."})\` and follow the loaded instructions. For Python modules use \`await skills.list()\` / \`await skills.describe("name")\`; there is no \`skills.load\`. Their summaries and full instructions use the host-selected \`PYSKILL.md\`, or \`SKILL.md\` only when the Python document was absent at discovery. In this kernel \`tools.skill\` first checks the original host permission and uses the same selected document for a matching local Python skill. Standard host catalogs and explicit slash commands still use \`SKILL.md\`. A document read error is an error, not permission to switch to CLI.
- \`await repl.info()\`, \`await repl.list(query="name")\`, \`await repl.describe("name")\` inspect this kernel, not the capability catalog. Restore overwritten helpers explicitly with \`await repl.restore_binding("bash")\`. When a kernel is replaced (DSH restart, crash, \`repl.restart()\`), the variables saved shortly after the last successful cell are restored and the first cell names what came back and what did not; anything changed after that save is gone. Use explicit workspace paths: Python's working directory need not be the workspace.
- Names no cell has used for a long stretch leave the kernel: after 100 unused cells by default a name is archived (not loaded on restart; a cell that names it gets it back automatically, or \`await repl.unarchive("name")\`), and after 200 it is deleted. Pin a costly result you will need much later with \`await repl.keep("name")\`; \`repl.unkeep\` undoes it.
- A library you need for your own analysis is missing (\`ModuleNotFoundError\`): \`await repl.install("pymupdf", "openpyxl>=3.1")\`, then import it in the same cell — no restart. Pre-installed: requests, httpx, yaml (PyYAML), tomli, dotenv (python-dotenv), pandas, numpy, scipy, bs4 (Beautiful Soup), lxml, pydantic, tyro, matplotlib, openpyxl, websockets (for browser-control). Installed packages go into the kernel's own venv under DSH's data directory — never the workspace or the user's files — and stay for later kernels and sessions. If the result lists \`stale\` modules (imported before the install, still running old code), \`await repl.restart()\` replaces the kernel after this cell; variables come back from the snapshot, installed packages stay. Do not start a separate Python just to reach a library for your own analysis (\`uv run --with …\`, \`python3 -c\`, or an interpreter a skill or tool hands you, such as \`load_workspace_dependencies\`): nothing it builds stays in this kernel, so do the analysis here.
- This kernel is not the native runtime of the project or system you are working on. A repository, package or service has its own environment and normal interface: run its imports, tests, scripts and CLIs through \`bash\` in that environment (its documented commands, \`uv run …\`, \`.venv/bin/python …\`), and treat failures there as the relevant result. Do not install a project's dependencies into this kernel just to make it import here; use the kernel to coordinate those runs and analyze what comes back.
- Reading a figure: open the whole image once and read it by looking; crop only a panel whose text is too small, and do not re-crop or zoom the same figure step after step. Never find axis ticks, bars or points by counting pixel colours in numpy: legends, hatching and background leak into the masks, and every attempt is one more step carrying the whole context.

### Keep data in the kernel, not in the conversation

This is the point of the REPL: a tool result stays a live Python object, and only what you display enters the context window. Reach for that deliberately.

\`\`\`python
rows = await tools.some_query({...})   # returned value stays; verify completeness first
len(rows)                              # show the SIZE, not the rows
\`\`\`

\`\`\`python
# Compute the conclusion in Python; show the evidence you actually need.
{"count": len(rows),
 "failed": sum(1 for r in rows if r["failed"]),
 "sample": [r["id"] for r in rows[:5]]}
\`\`\`

- Display small things. A cell's output past its budget (about 8,000 tokens) is cut to its start and end; the note says where the whole text is and what \`_\` holds. Never count or conclude from a cut display — reduce the live value in Python. \`await repl.size(value)\` measures a value without displaying it; \`await repl.preview(value)\` shows a bounded view (\`chars\`, \`items\`, \`depth\` widen or narrow it) and says what it left out. Neither proves an upstream response was complete.
- \`bash\`, \`read\`, \`grep\`, \`glob\`, \`job_output\` and bash job results display as a readable view (exit status, stderr, truncation and spill markers, line numbers) but are ordinary dicts. End a cell with the result instead of hand-printing fields; index it (\`r["stdout"]["text"]\`) only when computing. A \`read\` result also has \`r.text\`: the lines of THIS window joined, without numbers — check the view's \`more below\` before treating it as the whole file. In a cell \`grep\`/\`glob\` return the COMPLETE result (the host's 250/100 caps apply only to direct calls); the view shows the first 250 matches / 100 paths and says how many more the value holds — filter or count in Python rather than printing them all.
- A returned value can ALREADY be truncated or paginated: before counting or concluding from it, check \`truncated\`, \`next_cursor\` and any \`spillPath\`, then read the complete source or say where the data stops. \`await repl.require_complete(r)\` returns foreground bash stdout only when it is complete and the command succeeded; \`check_exit=False\` lets you parse a failed command's output on purpose, and it is still a failure.
- A \`read\` window can end early at the byte budget: continue at \`r["lines"][-1]["number"] + 1\`, never offset + limit (\`await repl.read_window(r)\` gives \`next_offset\`). A line marked truncated is not the whole line: report that rather than parse it.
- Keep paths, line numbers and error text when they are the evidence for a decision; brevity must not cost you the reason. For shell results retain \`exitCode\`, \`stderr\`, truncation flags and output paths, not only \`stdout.text\`. A successful code cell does not imply its subprocess succeeded.
- Never retype values you saw in output (lists, hashes, counts) back into code: the result is still in a variable, so compute from it.
- Reuse variables and functions across cells instead of re-fetching the same data.
- Output no cell owns (raw fd writes, a subprocess's inherited stdout/stderr, prints from an earlier cell's tasks) appears after a later cell's own output under \`[background output (unattributed)]\`.

### Grow your own helpers

The kernel is worth having only if you build on it. Code you type twice with different values is a function you have not written yet:

- The second time you write the same steps — call → parse → check, find → slice → show, wait → poll → test — stop and \`def\` it with the varying parts as parameters, then call it. It survives for the whole session.
- Return data (a dict, a list, a tuple), not printed text, so later cells can compare and combine results.
- Give each helper a one-line docstring saying what it returns. \`await repl.helpers()\` lists every function you defined with its signature and that line — check it before writing new code, and after the conversation was summarized.
- When a helper almost fits, redefine it under the same name (add the parameter, the extra field) instead of copying it into a variant; callers pick up the new version.

### Facts that are easy to get wrong

- A glob pattern with a slash matches from the workspace root, not from path: with \`path: "pkg"\`, use \`pkg/src/*.ts\` or \`**/src/*.ts\`, not \`src/*.ts\`; for an absolute path use \`**/\`. Without a slash, \`*.ts\` matches a basename at any depth.
- Several changes to one file: \`await edit(p, edits=[{"old_string": a, "new_string": b}, ...])\` — the whole batch is first checked against the file's current text (each change sees the ones before it), and if any change would not match, none is written and the error names that change; only then does each change go out as one host edit, in order. If one still fails mid-way (the file changed in between), the error names which changes are already applied. Unlike a single edit, this returns \`{"applied": n, "results": [EditOutput, ...]}\`; use \`result["results"][-1]["path"]\` for the path, not \`result["path"]\`. Don't hand-roll \`t.replace(old, new)\` + write back: that skips the file policy.
- The file policy counts only the \`read\` tool: \`grep\`, \`bash\` or \`open()\` output does not authorize \`edit\`/\`write\`, and a file changed after your read must be read again. Read the target in the same cell right before editing; it does not need to be displayed.

### Background work

- Never wait in a cell for a job, a subagent or anything slow: while a cell runs the user cannot reach you and you cannot do other work. End your reply; DSH wakes you when a background job or subagent finishes. \`tools.job_output({"job_id": id, "wait": True})\` waits only a few seconds and then returns \`status: "running"\` — a timeout, not a failure. Stream output is consumed: each read returns only what is new, so keep what you read. A bash handle keeps every piece for \`await r\`, whoever read it; \`await r.peek()\` shows everything so far without waiting.
- \`status: "completed"\` does not mean success; a failed command completes too. The exit code is in \`job["detail"]\` (\`"exit code: 128"\`); \`await r\` on a bash handle reads it for you.
- asyncio tasks keep running after their cell ends, as in Prime; what they print arrives as background output with a later cell. They cannot call DSH tools once their cell has ended (the host revokes that cell's tools), so await tool work in the same cell, use \`run_in_background\` for shell work that must continue, or hand the work to \`repl.background\`. A task that fails with nobody awaiting it is named at the end of a later cell; keep the task and call \`.exception()\` for the traceback.
- Long computation (minutes) holds the kernel: no later cell runs until it ends. Hand it over with \`job = await repl.background(work)\` (a coroutine, or a plain function run in a thread): the cell ends at once, the work shows as a DSH background job (\`job_kill\` stops it), and DSH wakes you when it finishes; \`await job\` then gives its value or raises its error. After the cell ends the work keeps that cell's DSH tools until it finishes or is stopped, with approvals and the sandbox as usual. Inside the work, \`repl.progress("step 3 of 10")\` (no await needed, threads too) shows as the job's status and adds a line to its output, both seen in the job panel and by \`job_output\`; images its tool calls return arrive with the job's end notice.
- \`await tools.subagent(description=..., prompt=...)\` returns at once with an id (\`r["subagentId"]\`). Start independent subagents in ONE cell and keep their ids in a dict variable, which outlives compaction (\`tools.list_agents()\` finds them too). Each result arrives as a message when that subagent settles; do not await or poll for it in a cell. Ask for a long result to be written to a file and answered with its path and one line.
- When code must use what subagents return (fan out, merge, then decide the next batch), use \`await repl.agent(prompt, schema=None, model=None, provider=None)\` instead: it starts the child and waits, then returns its final text, with \`schema\` (a JSON object schema) its structured value, or None if it failed; with a schema the child must finish by calling its \`structured_output\` tool, so never tell it to avoid tools. The child belongs to the cell or \`repl.background\` job that started it and is stopped when that ends, so run an orchestration inside \`repl.background\` (gather many with \`asyncio.gather\`; DSH caps live children, extra starts wait their turn) and report with \`repl.progress\`. It needs the \`subagent\` tool.

### Failure and cancellation

A failed tool call raises \`ToolCallError\` (\`.toolName\` identifies the tool, \`str(e)\` is the reason). For INDEPENDENT items, catch it and keep going:

\`\`\`python
ok, failed = [], []
for item in items:
    try:
        ok.append(await tools.some_tool({"id": item}))
    except ToolCallError as exc:
        failed.append({"item": item, "tool": exc.toolName, "message": str(exc)})
len(ok), len(failed)
\`\`\`

- Stop instead when a later step DEPENDS on the failed one — continuing just produces invalid side effects.
- \`except ToolCallError\` does not catch cancellation (\`CancelledError\` is a \`BaseException\`), which is deliberate: a cancelled run must not look like a skippable item.
- A failed cell does NOT roll back: variables it already set and side effects it already caused persist. Inspect saved partial results before re-running anything. Re-run only the steps that still need doing; never replay external side effects automatically.
- Send JSON-compatible arguments; NaN/Infinity, sets, bytes and datetimes need an explicit, semantically correct conversion. Do not silently substitute a number just to make a call pass.
- \`run_code\` takes \`timeoutMs\` for a cell that may hang: past it the cell is cancelled the same way (\`CancelledError\` in the cell), the kernel and its variables stay, and what it already did is not undone.
- Never catch \`BaseException\`/\`CancelledError\` and continue issuing tools. A timeout from \`asyncio.wait_for\` means the outcome is unknown, NOT that external work stopped; tools can legitimately wait for a human, background work or a network service, so do not put a short deadline on all work.
- If state loss is reported, the previous live namespace ended; the new kernel's restore report says which names came back. Files and external effects remain.

### Files and deliverables

This is a trusted Python process, not a sandbox: direct filesystem, network, threads and subprocesses are not contained by DSH tool permissions. Use dedicated harmless fixtures when testing, not unrelated session attachments.

Passing a kernel variable to \`write\` (\`await write(p, text)\`) does not put its content into your context; only what you display does.

When you produce a file the user asked for, you must still call \`await tools.present({...})\` — writing it is not delivering it.

The available tools:`

const SUBAGENT_WAIT = `${SUBAGENT_WAIT_MS / 60_000} minutes`

/**
 * A subagent's run ends with its turn, and DSH then stops its jobs without a
 * notice (src/subagent.ts), so every "end your reply, DSH wakes you" becomes
 * "wait for it in a cell". Each pair must match CELL_INSTRUCTIONS exactly.
 */
const SUBAGENT_SWAPS: ReadonlyArray<readonly [string, string]> = [
  [
    'A cell waits only a few seconds on a command: a longer one keeps running, `r` says so, and DSH wakes you when it finishes; `await r` then gives its result (before that it raises `JobStillRunning`, a `TimeoutError`).',
    `A cell waits up to ${SUBAGENT_WAIT} on a command: a longer one keeps running and \`r\` says so; \`await r\` waits again (each wait lasts up to ${SUBAGENT_WAIT}, then raises \`JobStillRunning\`, a \`TimeoutError\`).`,
  ],
  [
    'Never wait in a cell for a job, a subagent or anything slow: while a cell runs the user cannot reach you and you cannot do other work. End your reply; DSH wakes you when a background job or subagent finishes. `tools.job_output({"job_id": id, "wait": True})` waits only a few seconds and then returns `status: "running"` — a timeout, not a failure.',
    'You are a subagent: ending your turn ends your run. DSH then stops every background job, `repl.background` work and kernel task you started, and no notice ever comes back. '
      + 'So before you finish, wait in a cell for every result you need: `await r` on a bash handle, `await job` on `repl.background` work, or call `tools.job_output({"job_id": id, "wait": True})` again until its status is not `running`. '
      + `Each wait lasts up to ${SUBAGENT_WAIT}; \`running\` after one is a timeout, not a failure. Never end your turn while a job you depend on is still running.`,
  ],
  [
    'the cell ends at once, the work shows as a DSH background job (`job_kill` stops it), and DSH wakes you when it finishes; `await job` then gives its value or raises its error.',
    'the cell ends at once and the work shows as a DSH background job (`job_kill` stops it). You are a subagent, so `await job` in a later cell before you finish: ending your turn stops the work with no notice. `await job` gives its value or raises its error.',
  ],
]

/** The cell preamble for a root session, or its subagent version. */
export function cellInstructions(subagent = false): string {
  if (!subagent) return CELL_INSTRUCTIONS
  return SUBAGENT_SWAPS.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`dsh-python-repl: subagent prompt text out of date: ${from.slice(0, 60)}`)
    return text.replace(from, to)
  }, CELL_INSTRUCTIONS)
}

/**
 * Replace the official preamble with cell semantics, keeping the generated
 * declaration block verbatim.
 *
 * Splitting on the fence rather than pattern-matching the prose keeps this
 * robust: the declarations are machine-generated from live schemas and must
 * survive untouched, while the prose above them is what contradicts us.
 *
 * @param officialSection - the text `renderToolsSdkPy` produced.
 * @param options.subagent - the session is a delegated subagent (src/subagent.ts).
 * @returns the section with our preamble, or the original if the shape is
 *   unrecognized (fail visible, not silent).
 */
export function rewriteSdkSection(officialSection: string, options: { subagent?: boolean } = {}): string {
  const fenceAt = officialSection.indexOf(DECLARATION_FENCE)
  if (fenceAt === -1) return officialSection
  const declarations = officialSection.slice(fenceAt)
  return `${cellInstructions(options.subagent === true)}\n\n${declarations}`
}

/**
 * Map the configured Python skills to their kernel names.
 *
 * Their descriptions are already in the host's skill list; this only says
 * which of them are importable modules and under what name, as Prime's
 * `python_import` does. A description is repeated only when the Python
 * instructions describe the skill differently: the line is in every request.
 *
 * @returns the section text, or '' when there is nothing to say.
 */
export function renderSkillCatalog(skills: readonly SkillSummary[]): string {
  const python = skills.filter((s) => s.status === 'discovered')
  if (python.length === 0) return ''
  return [
    '## Python skills',
    '',
    'These skills are Python modules, imported into the kernel before the first cell. Their descriptions are in the skill list; a line repeats one only when the Python instructions describe the skill differently. Use skills.describe for the full document. '
      + 'If one failed to import, the session context says why.',
    '',
    ...python.map((s) => `- \`skills.${s.import_name}\` — ${s.skill}${s.standard_description === undefined ? '' : `: ${s.description.replace(/\s+/g, ' ').slice(0, 160)}`} (${s.instructions_file})`),
  ].join('\n')
}
