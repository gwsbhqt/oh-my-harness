[English](README.md) | [简体中文](README.zh-CN.md)

# oh-my-harness

**Add-ons for the AI assistant in DeepSeek Harness: let it write programs to get work done, split work with other assistants, operate the browser and the Mac, and keep working for hours without drowning in its own chat history.**

[![CI](https://github.com/gwsbhqt/oh-my-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/gwsbhqt/oh-my-harness/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What this is

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) is an AI assistant app that runs on your Mac: you open a session, say what you need, and it calls tools to do the work.

This repository is **not a standalone app**. It is 11 components that add abilities to DSH; install only the ones you need. There are two kinds:

- **Plugins** load into DSH itself and change how it behaves. The 8 root folders that start with `dsh-` are plugins.
- **Tools** are separate programs the assistant can call. The 3 tools live under `skills/` and also work on their own from a terminal.

An independent community project, **not affiliated with or endorsed by DeepSeek**.

## Components

Click a name to open that component's own README with setup, configuration, and limits. "Guide" links to a task-oriented walkthrough.

**Let the assistant write programs**

| Component | What it does | Use it when |
| --- | --- | --- |
| [dsh-python-repl](dsh-python-repl/README.md) | Lets the assistant do its work in Python. One step can call many tools; large data stays in the program and only the checked conclusion goes into the chat. | You process big logs or tables, or one job needs many tool calls in a row. [Guide](docs/dsh-python-repl.md) |

**Manage and coordinate**

| Component | What it does | Use it when |
| --- | --- | --- |
| [dsh-control](dsh-control/README.md) | Remote-controls a running DSH: open sessions, hand out tasks, wait until they are really done, send notifications, restart. | One assistant acts as a lead and other sessions do the work. [Guide](docs/dsh-control.md) |
| [dsh-monitor](dsh-monitor/README.md) | Watches a long-running command and wakes the assistant with each new line it prints. | You wait on a build, a log, or a file, and don't want the assistant to keep checking. [Guide](docs/dsh-monitor.md) |
| [dsh-output-guard](dsh-output-guard/README.md) | Stops the model when it starts repeating itself, printing blank lines, or ending without an answer; can retry once automatically. | Long runs sometimes produce runaway output. [Guide](docs/dsh-output-guard.md) |

**Operate the computer**

| Component | What it does | Use it when |
| --- | --- | --- |
| [browser-control](skills/browser-control/README.md) | Operates chosen pages in Chrome or Arc: read, click, type, screenshot. Each task gets its own window and re-reads the page after acting. | The assistant should do something on a website for you. [Guide](docs/browser-control.md) |
| [computer-control](skills/computer-control/README.md) | Operates ordinary Mac app windows: read the interface, click, type, screenshot. Keystrokes go only to the chosen window. | The target is a desktop app, not a web page. [Guide](docs/computer-control.md) |
| [remote-host](skills/remote-host/README.md) | Runs commands, copies files, and manages background jobs on another machine over SSH. If the other side lacks a tool, it fails instead of quietly running locally. | The work happens on another computer or server. [Guide](docs/remote-host.md) |

The three tools share a small library, [`skills/_shared`](skills/_shared/README.md), that handles connections and target machines. It is not used on its own.

**Keep long sessions manageable**

| Component | What it does | Use it when |
| --- | --- | --- |
| [dsh-compaction-bound](dsh-compaction-bound/README.md) | When the chat history is compacted, your own messages are copied word for word instead of being paraphrased by the model, and the result has a fixed size limit. | A session needs to keep going for hours. [Guide](docs/dsh-compaction-bound.md) |
| [dsh-message-tidy](dsh-message-tidy/README.md) | Cleans up notices DSH adds to the chat: marks them as system notices rather than your words, drops duplicates, gives background jobs readable names, and sends only the changed part of an updated instruction file. | System notices pile up and clutter the chat. [Guide](docs/dsh-message-tidy.md) |
| [dsh-image-cap](dsh-image-cap/README.md) | Limits the size and number of images sent to the model. | Screenshot-heavy tasks spend too much context on images. [Guide](docs/dsh-image-cap.md) |
| [dsh-history-cap](dsh-history-cap/README.md) | Loads a long session's history in pages when you open it. Affects only the app window, not what the model sees. | Long sessions open slowly in the app. [Guide](docs/dsh-history-cap.md) |

**Also in the repository:** [design articles](docs/design/python-data-locality.md) explain why each part works the way it does; [benchmarks](benchmarks/README.md) reproduce the numbers on this page; `tooling/` holds the shared plugin build tools; [llms.txt](llms.txt) is an entry point for AI assistants.

## How they work together

```text
You ──task──▶ the assistant in DSH
                  │
                  ├─ writes Python to do the work (dsh-python-repl)
                  │     ├─ calls DSH's built-in tools
                  │     ├─ operates web pages, desktop apps, remote machines (3 tools)
                  │     └─ keeps large data in the program, returns only conclusions
                  │
                  ├─ hands tasks to other sessions and waits for them (dsh-control)
                  ├─ wakes up when a background event arrives (dsh-monitor)
                  └─ stays within limits however long the chat gets (4 context plugins + dsh-output-guard)
```

## See it work

These are real recordings using fictional data and local example pages. No accounts are signed in.

**One log, two ways to answer.** Left: all 10,000 log records go to the model. Right: Python computes first and returns only the conclusion.

![Terminal recording of the full fictional log compared with filtering inside the DSH kernel](docs/assets/python-data-locality.gif)

**A lead hands out work; a worker does it.** The lead dispatches and stops; when the worker finishes, the lead wakes up, recomputes the result, and accepts it.

![Real session excerpt: lead dispatches, worker executes, lead verifies](docs/assets/controller-worker.gif)

**Operate a browser.** Fill in and tick a local example page, re-reading the page after each step.

![Browser control filling a fictional checklist and verifying the final page state](docs/assets/browser-control.gif)

**Operate a Mac desktop app.** This recording is being redone and will appear here.

**A background event wakes a session.** When a file is written, the idle session wakes, checks the content, and stops listening.

![A real event wakes an idle session, which checks the example data](docs/assets/monitor.gif)

**Long output shows only the head and tail**, while the full text stays in Python. **Remote receipt:** a read-only SSH command whose result was checked independently.

<p>
<img src="docs/assets/bounded-display.png" alt="The chat shows head and tail; the Python value and saved full text remain checkable" width="49%">
<img src="docs/assets/remote-host.png" alt="Receipt of a read-only SSH operation with an independently checked digest" width="49%">
</p>

Recording inputs and acceptance checks are in the [asset list](docs/assets/README.md).

## Why this exists

| Without it | With it |
| --- | --- |
| A tool returns a huge log and all of it lands in the chat: expensive and easy to misread. | The data stays in Python; only the computed conclusion comes back. |
| An expensive model watches every step of a long job. | The expensive model leads and reviews; a cheaper model does the work. |
| Outside scripts cannot reach a running DSH. | A command line, Python, and MCP (a common protocol for connecting tools) all control the same DSH. |
| Compaction lets the model paraphrase, or change, what you said. | Your words are copied as written, plus an index with a size limit. |
| Several assistants fight over one browser tab or desktop window. | Each task sticks to its own window and never clicks into another's. |
| A command may quietly run locally when the remote machine lacks a tool. | The remote side is checked first; a missing tool is an error. |

## Engineering highlights

- **Tool instructions on demand.** Frequently used tools get full instructions; the rest get a one-line summary until needed, so each turn sends less boilerplate. [Prompt assembly](dsh-python-repl/src/index.ts).
- **Data survives between steps and restarts.** A variable computed in one step is used directly in the next. After DSH restarts, savable data comes back and anything lost is reported to the assistant. [Session lifecycle](dsh-python-repl/src/session.ts).
- **"Done" means really done.** Instead of trusting a reply that says "finished", it checks that the session has truly stopped: no running turn, no queued message, no background job, stable for a while. Interrupted sessions resume after a restart. [Completion](dsh-control/src/service.ts) · [Recovery](dsh-control/src/cli/core.ts).
- **Your words skip the model.** Compaction copies your messages into an appendix by source. When space runs out, older ones become a "which turn said what" index, and the oldest ranges merge first. [Appendix implementation](dsh-compaction-bound/src/summary.ts).
- **Every action has a definite target.** Browser tasks get their own windows. Desktop actions remember the exact app and window, and keystrokes go only there. [Browser targets](skills/browser-control/src/browser_control/engine.py) · [Desktop routing](skills/computer-control/bin/computer-control.swift).
- **Uncertain results are reported as uncertain.** A remote machine missing a tool is rejected before running. A browser action whose reply is lost is reported as "outcome unknown" and is not clicked again. [Remote preflight](skills/_shared/agentkit/remote/target.py) · [Browser RPC](skills/browser-control/src/browser_control/client.py).

## A measured example

Both paths read the same **10,000 fictional JSONL records** to count errors by service and identify samples.

| Returned payload | UTF-16 code units | Estimated tokens |
| --- | ---: | ---: |
| Entire log | 1,976,098 | 494,025 |
| Local Python aggregation and identified samples | 345 | 87 |

Estimates use **ceil(UTF-16 code units / 4)** on returned payload text, not a model tokenizer. See the [method, exclusions, and compaction results](benchmarks/README.md) and [recorded output](benchmarks/results.json).

## Start with one plugin

Use DeepSeek Harness on macOS with a tool-capable model. Follow the [kernel README](dsh-python-repl/README.md) for Node.js, pnpm, uv, and Python requirements.

### 1. Build from source

Plugin builds use adjacent `tooling/`; keep the checkout intact.

```sh
git clone https://github.com/gwsbhqt/oh-my-harness.git
cd oh-my-harness
pnpm --dir dsh-python-repl install --frozen-lockfile
pnpm --dir dsh-python-repl run check
```

### 2. Link the bundle into your DSH profile

Merge these entries into the profile manifest. Set the checkout link **relative to that profile**.

```json
{
  "dependencies": {
    "dsh-python-repl": "link:../../src/oh-my-harness/dsh-python-repl"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-python-repl"] }
  }
}
```

Install in that profile with DSH's pnpm, run startup checks, then restart DSH. Follow the [bundle setup and removal guide](dsh-python-repl/README.md).

### 3. Verify a useful result

From the checkout, create the exact fictional fixture and reference answer:

```sh
python3 benchmarks/run.py --export-log example-log.jsonl --export-conclusion example-answer.json
```

Open a DSH session in the checkout and ask:

> Read the generated example log into a Python variable. Keep the complete data in the kernel. Compute the same counts and identified samples as the benchmark, and compare the result with the exported reference answer. Return the comparison and necessary evidence, not the entire log. In the next cell, reuse the retained data without reading it again.

Check the comparison and reuse the same variable in the next cell.

## Add the control surfaces you need

The 3 computer-operating tools live under `skills/`. Install dsh-python-repl first, then register that folder as a trusted skill directory in its configuration so the assistant can call them. Each tool's README has the steps; see [Components](#components).

## What DSH provides and what this adds

```mermaid
flowchart TD
    H["DeepSeek Harness: sessions, models, tools, policies"] --> P["Python runtime plugin"]
    H --> C["Control, context and stream plugins"]
    P --> K["Per-session Python kernel"]
    K --> T["Harness tool bridge"]
    K --> S["Trusted Python skills"]
    S --> B["Browser: CDP"]
    S --> D["macOS: Accessibility and input"]
    S --> R["Remote host: OpenSSH"]
    T --> V["Complete result values"]
    V --> K
    K --> E["Selected evidence in the conversation"]
    C --> H
```

| Responsibility | Host supplies | This repository adds |
| --- | --- | --- |
| Agent execution | Sessions, models, tools, jobs, policies | Extensions, not a new model service. |
| Code | TypeScript programmatic tool calling | Python backend, bridge, skill loading, snapshots. |
| Compaction | Triggers, basic engine, checkpoints | Retention defaults, bounded instructions, exact-user-text appendix. |
| Control | Internal typed services | Local endpoint, CLI/Python/MCP, receipts, settled observation. |
| Devices | Execution and tool-policy context | Skills using CDP, Accessibility, and SSH permissions. |
| Output/events | Jobs, rendering, spill storage, delivery | Display budgets, stream checks, producer delivery. |

## Compare by the problem you have

Choose by the workflow you need. Scope below comes from each project's documentation.

| Option and source | Published scope | When it may be a better fit |
| --- | --- | --- |
| [browser-use][browser-use] | Browser agent with model-written Python, a persistent REPL, and CDP. | Browser-focused agent/library or hosted browsers without DSH. |
| [browser-harness][browser-harness] | Real-browser CDP access for existing agents, through CLI/skill or MCP. | Add browser access to your current coding agent. |
| [cua][cua] | Desktop CLI, MCP, SDKs, and virtual-desktop offerings. | Its desktop/VM ecosystem or platform matrix fits your target. |
| [OmO][omo] | Coding-agent system with multi-model orchestration and memory workflow. | Adopt its integrated workflow for your coding agent. |
| Direct MCP tools: [integration examples][browser-harness] · [protocol architecture][mcp] | Client/server interface for tools and other capabilities. | Existing clients and servers supply your required tools, state, and permissions. |

Python plus CDP is shared ground. This collection adds DSH runtime control and context helpers. `dsh-control` also exposes MCP; each client decides how results enter its transcript.

## Design choices worth inspecting

- [Python data locality](docs/design/python-data-locality.md).
- [Compaction generations](docs/design/three-generations-of-compaction.md).
- [Controller and worker](docs/design/controller-worker.md).
- [Task boundaries](docs/design/task-isolation.md).
- [Output boundaries](docs/design/output-guard.md).

## Security and limits

**The Python kernel is trusted code, not a sandbox.** It can access files, networks, and processes independently of the Harness tool bridge. Configured skills execute Python during import. Host tool approval does not revoke Python's operating-system access.

Browser attachment may use an authenticated profile. Task windows share that profile's account state; debugging access must not be exposed to an untrusted network. Desktop control requires macOS permissions and can affect real windows. Targeted input reduces interference but cannot eliminate focus races. SSH uses the destination account's real permissions, not a simulated remote environment. A timeout does not undo an external action.

The control endpoint is local to the system account; do not proxy it publicly. Its read-only mode and namespace restrictions cover that interface, not arbitrary Python.

The Python bundle replaces TypeScript PTC and disables dependent workflow entries. Startup may download dependencies. Snapshots restore supported values, not live connections or processes. A short display does not prove source completeness. Contract tests check interfaces; live sites and desktops need separate verification.

Read [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for verification. Keep credentials, authenticated screenshots, and real session logs out of issues.

## When something goes wrong

First find which step actually failed: was the plugin built, did the assistant find the tool, is the target page or window still there, was the message really delivered? Confirm you have complete data before counting anything. Each component's README explains recovery.

Use the [bug form](.github/ISSUE_TEMPLATE/bug.yml) with fictional inputs and actual check results; report private findings through [security reporting](SECURITY.md).

## Contributing, license, and attribution

For small, evidenced changes, start with [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [agent guidance](AGENTS.md). Contributors own their generated changes and actions.

Code is [MIT licensed](LICENSE); third-party notices remain, including the [Prime REPL license](dsh-python-repl/vendor/prime/LICENSE) and [provenance](dsh-python-repl/vendor/PROVENANCE.md). Thanks to DeepSeek Harness and upstream authors for the host engine and Python orchestration foundations.

[browser-use]: https://github.com/browser-use/browser-use
[browser-harness]: https://github.com/browser-use/browser-harness
[cua]: https://github.com/trycua/cua
[omo]: https://github.com/code-yeongyu/oh-my-opencode
[mcp]: https://modelcontextprotocol.io/docs/learn/architecture