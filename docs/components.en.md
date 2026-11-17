[中文](components.md) | English

# Find a component by problem

[← Home](../README.en.md) · [Documentation](README.en.md) · [Installation](getting-started.en.md)

Plugins load into DSH. Skills expose operations an agent can call. Each component owns its installation steps, platform requirements, and limits. Source builds need the adjacent shared directories; see the [repository layout](architecture.en.md#why-the-directories-look-this-way).

## Execution and coordination

| Component | What it solves | Read next |
| --- | --- | --- |
| [dsh-python-repl](../dsh-python-repl/README.en.md) | Call tools in a persistent Python process and keep results, functions, and recoverable state. | [Guide](dsh-python-repl.en.md) · [Design](design/python-data-locality.en.md) |
| [dsh-use](../dsh-use/README.en.md) | Reach a running DSH through CLI, Python, or MCP; dispatch work, keep receipts, wait for results, and notify. | [Guide](dsh-use.en.md) · [Supervision skill](../dsh-use/skills/dsh-supervise/SKILL.md) |
| [dsh-monitor](../dsh-monitor/README.en.md) | Deliver events from background commands and wake an agent when something changes. | [Guide](dsh-monitor.en.md) |
| [dsh-guard](../dsh-guard/README.en.md) | Detect repetitive or empty output, bound retries, and help long-running goals stop spinning. | [Guide](dsh-output-guard.en.md) |

## Computer operations

| Skill | Target and capability | Read next |
| --- | --- | --- |
| [browser-use](../skills/browser-use/README.en.md) | A specific Chrome or Arc page: observe, click, type, capture, and read back. | [Guide](browser-use.en.md) |
| [computer-use](../skills/computer-use/README.en.md) | Native macOS apps and windows: inspect, target input, capture, and verify. | [Guide](computer-use.en.md) |
| [remote-host](../skills/remote-host/README.en.md) | Execute, transfer, and verify over SSH on an explicitly selected host. | [Guide](remote-host.en.md) |

They share transport and target handling in [`skills/_shared`](../skills/_shared/README.en.md). This repository's browser-use skill is maintained separately from the [browser-use project](https://github.com/browser-use/browser-use).

## Review and demos

| Tool | What it does | Usage |
| --- | --- | --- |
| [shot-sheet](../skills/shot-sheet/README.en.md) | Build screenshot contact sheets, sample GIFs or videos, compare before and after, and annotate images. | [Python and CLI examples](../skills/shot-sheet/README.en.md#common-operations) |

## Context and retrieval

| Component | When to use it |
| --- | --- |
| [dsh-compaction-bound](../dsh-compaction-bound/README.en.md) | Compact long conversations while retaining exact user text and a bounded index. |
| [dsh-message-tidy](../dsh-message-tidy/README.en.md) | Reduce repeated injected notices and make their source clear. |
| [dsh-image-cap](../dsh-image-cap/README.en.md) | Limit the dimensions and number of images sent to the model. |
| [dsh-history-cap](../dsh-history-cap/README.en.md) | Load long conversations in UI pages. This does not reduce model context. |
| [dsh-session-link](../dsh-session-link/README.en.md) | Read another session's overview, turn, or search results on demand. |
| [dsh-grep-scope](../dsh-grep-scope/README.en.md) | Include hidden and ignored files in a search and expose unreadable scope. |
| [dsh-prompt-prefix](../dsh-prompt-prefix/README.en.md) | Keep instructions, skill catalogs, and memory profiles in a stable order for prefix-cache reuse. |

## Interface and runtime maintenance

| Component | When to use it |
| --- | --- |
| [dsh-runtime](../dsh-runtime/README.en.md) | Restore the login environment for desktop launches and preserve symlinks when saving configuration. |
| [dsh-doctor](../dsh-doctor/README.en.md) | Check profiles, dependencies, build artifacts, and isolated startup before restarting. |
| [dsh-settings](../dsh-settings/README.en.md) | Edit mode preferences, skills, and quick replies with consistent draft and save controls. |
| [dsh-session-tidy](../dsh-session-tidy/README.en.md) | Archive finished workspace sessions in bulk and retain a way to restore them. |
| [dsh-session-ui](../dsh-session-ui/README.en.md) | See active work, current blockers, session statistics, and clickable real file paths. |

## Study and maintenance

[Architecture and source map](architecture.en.md) · [Design articles](README.en.md#read-by-scenario) · [Reproducible measurements](../benchmarks/README.en.md) · [Using dotfiles](dotfiles.en.md) · [Maintenance roadmap](maintenance.en.md)
