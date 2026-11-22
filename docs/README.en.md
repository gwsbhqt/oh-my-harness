[中文](README.md) | English

# Documentation

[← Project home](../README.en.md)

Start with a problem. Component READMEs own installation, options, and limits. Guides walk through an operation. Design articles explain the tradeoffs.

| Your goal | Start here |
| --- | --- |
| Install one component for the first time | [Start with one plugin](getting-started.en.md) |
| Find a component for a specific problem | [Component catalog](components.en.md) |
| Study how an agent keeps working | [Architecture and source map](architecture.en.md) |
| Connect your own configuration setup | [Using dotfiles](dotfiles.en.md) |
| Contribute, fix, or maintain | [Contributing](../CONTRIBUTING.en.md) · [Maintenance roadmap](maintenance.en.md) |

## Read by scenario

| Scenario | Guide | Design |
| --- | --- | --- |
| Keep large results in Python and analyze them again | [Persistent kernel](dsh-python-repl.en.md) | [DSH tool calls and Prime’s persistent kernel](design/python-data-locality.en.md) |
| Let one session dispatch work to another | [Control a running DSH](dsh-use.en.md) | [Receipts, state, and acceptance](design/controller-worker.en.md) |
| Wake an agent when a background source changes | [Monitoring](dsh-monitor.en.md) | [Output and event boundaries](design/output-guard.en.md) |
| Preserve user requirements through compaction | [Bounded compaction](dsh-compaction-bound.en.md) | [Three generations of compaction](design/three-generations-of-compaction.en.md) |
| Give an existing agent control of a page or Mac window | [Browser](browser-use.en.md) · [Desktop](computer-use.en.md) | [Choosing a browser tool](design/browser-control.en.md) · [Choosing a desktop tool](design/desktop-control.en.md) |
| Share a device across tasks or reach a remote machine | [SSH](remote-host.en.md) | [Task and target isolation](design/task-isolation.en.md) |

More guides: [message tidy](dsh-message-tidy.en.md) · [image budgets](dsh-image-cap.en.md) · [history pagination](dsh-history-cap.en.md) · [output guards](dsh-output-guard.en.md).

## Demos and evidence

Use [shot-sheet](../skills/shot-sheet/README.en.md) to review screenshots or video frames together and compare results.

The component guides include recordings of [Python](../dsh-python-repl/README.en.md#see-it-work), [session coordination](../dsh-use/README.en.md#see-it-work), [event wakeup](../dsh-monitor/README.en.md#see-it-work), [desktop actions](../skills/computer-use/README.en.md#see-it-work), and [remote hosts](../skills/remote-host/README.en.md#see-it-work). The [archived browser demo](browser-use.en.md#two-tabs) links the original reproduction steps.

Demos use fictional inputs. The [media guide](assets/README.en.md) distinguishes recorded results from concept diagrams. The [measurement guide](../benchmarks/README.en.md) lists reproduction commands, estimation methods, and exclusions. Unit tests, integration fixtures, and real external actions are reported separately.

[llms.txt](../llms.txt) provides an agent-oriented index. Report security issues [privately](../SECURITY.en.md).
