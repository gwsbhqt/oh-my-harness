[中文](task-isolation.md) | English

# Task isolation is a set of boundaries, not a second desktop

A fictional worker is checking a page at `https://example.com` while another worker edits a different page in the same browser. Both need the existing login. Meanwhile, a person is using the computer. Giving each worker a different conversation is necessary, but insufficient: the conversations can still reach the same browser profile (a host configuration), native window, account, and remote files.

Before acting, identify the machine or browser receiving the operation, the selected tab or native window, and the resources this task can clean up. Publishing, deletion, and account changes each require authorization.

This article describes source-backed behavior, not a new live acceptance run. The [browser README](../../skills/browser-use/README.en.md), [desktop README](../../skills/computer-use/README.en.md), and [remote README](../../skills/remote-host/README.en.md) define the supported platforms and prerequisites.

## What the host provides, and what these skills add

DSH provides conversations, tools, and a session identifier. The desktop skill uses a task scope to track native app ownership. The browser skill asks callers to choose a browser connection and pass the target tab ID with each page or debugging call. macOS manages native windows and input permissions, and OpenSSH handles remote authentication and transport.

## Keep the ID of each task’s tab

Two tasks opening the same URL can each keep the `tabId` returned by `tab_open`. Use that task’s connection and ID to inspect a page, click a control, or read network requests. For an existing tab, `tabs_list()` returns entries with an `id` field. A conversation branch that needs its own tab can open one and keep the result. Recheck the target after a reconnect. Titles, URLs and the visible page may be identical. [Browser examples](../browser-use.en.md)

## Separate tabs can share an account

Cra uses its official MCP for page actions. Chrome connects to the specified instance with debugging enabled. Both can debug a selected tab through Google’s Chrome DevTools MCP. When you need separate login state, prepare a browser instance with a separate profile and connect to it. Two tabs in the same profile can share an account and site settings. Signing out in one may affect the other.

Track the tabs the task opens and close each one explicitly with `tab_close(tabId=...)`. Exiting Python’s `async with` ends the tool connection. Leave borrowed tabs open for their original users. [Browser connection and cleanup](../../skills/browser-use/src/browser_use/browser.py)

## Native windows cannot become independent desktops

The desktop tool has a different problem. Some actions address Accessibility elements directly; others depend on event delivery and focus. There is still a single real foreground, and a person can change it between checks.

A stable window reference includes its window identifier, process identifier, process start time, and application identity. The [Swift executor](../../skills/computer-use/bin/computer-use.swift) checks that the original process generation and exact window remain valid. It refuses to substitute a similar title or position. Element checks also verify membership in the bound window.

For non-browser applications, the tool records task ownership and a changing lease. Handoff and release invalidate older credentials. Browser applications instead use task windows and short operation locks, allowing different windows to cooperate without claiming the whole shared browser. Keyboard, paste, menu, and event-based mouse operations use a shared desktop-input lock. Browser input also checks the foreground application, exact focus window, and focused element where relevant.

These measures reduce races between cooperating callers. They cannot stop a person or another same-account program from changing focus immediately after a check. Long input rechecks focus and stops when it changes. If input may already have been sent, the result is unknown. The [desktop rules](../../skills/computer-use/references/common.md) state this residual race explicitly; [handle contract tests](../../skills/computer-use/tests/test_contract.py) check rejection of another task, another window, and an outdated lease.

Accessibility and Screen Recording permissions belong to the actual process on the destination. A successful version probe proves neither permission nor application control. Selected targeted input also uses private macOS interfaces, so operating-system changes can break it. Unsupported targeted actions fail instead of silently switching to global input. System identity confirmation and sensitive application restrictions are additional boundaries, not things a task name can bypass.

## Remote means a real destination

Computer-use, remote-host, and dsh-use share the [target resolver](../../skills/_shared/agentkit/remote/target.py) and [SSH transport](../../skills/_shared/agentkit/remote/ssh.py). Each keeps its own default machine. An explicit destination wins for that call, and bound desktop objects retain their original destination. Unknown aliases, invalid selection state, missing remote tools, and connection failures raise errors. Remote-host requires a remote destination.

Remote payloads use the system SSH client and its configured authentication. Desktop and session-control commands forwarded over SSH check the destination’s capabilities. Browser-use selects its browser and debugging endpoint separately. To inspect a native dialog on another machine, select that machine and the exact window in computer-use. [Shared transport rules](../../skills/remote-host/references/transport.md)

SSH does not sandbox the payload. It runs with the authenticated account's real access. Two workers using that account can still edit the same file. The [copy and verification rules](../../skills/remote-host/references/copy-verify.md) describe staging before placement and content checks. Conditional file replacement can compare an expected SHA-256 to detect intervening edits. Transport success establishes delivery, while content and service checks establish the requested result.

## Observe after an uncertain action

An operation can complete before its caller times out. After an uncertain click, input, or remote mutation, inspect the original target. Reading the same tab again can reveal that a submission already added the requested row. If you cannot identify the original target, resolve its identity before acting.

A useful review asks whether the expected page changed, whether only the intended window disappeared, whether transferred bytes match, and whether the final service responds. A clean subprocess exit alone cannot answer those questions.

## Evidence and measurement

The archived two-tab experiment used two copies of the same fictional checklist and read both counters. The original steps and capture are preserved. [Archived capture and steps](../browser-use.en.md#two-tabs) · [Archived task isolation and tests](https://github.com/gwsbhqt/oh-my-harness/blob/archive/browser-use-before-mcp/docs/design/task-isolation.en.md)

To check the current version, open a sample page twice and save the two `tabId` values. Change one page, read both pages back, and close the tabs created by the task using their IDs. Record the browser version, selected instance, both readings and the tabs actually closed. Native focus behavior and SSH permissions need checks in their respective environments.

The publication's reproducible measurements belong in [benchmark results](../../benchmarks/results.json). No timing, throughput, or savings figure is inferred here. The strongest supported conclusion is narrower: explicit identities and conservative failure rules make accidental cross-task actions easier to detect, while shared accounts, desktop focus, and real remote permissions remain shared state.