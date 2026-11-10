# Task isolation is a set of boundaries, not a second desktop

A fictional worker is checking a page at `https://example.com` while another worker edits a different page in the same browser. Both need the existing login. Meanwhile, a person is using the computer. Giving each worker a different conversation is necessary, but insufficient: the conversations can still reach the same browser profile, native window, account, and remote files.

The design therefore separates several questions. Which machine receives the operation? Which task owns the browser binding? Which exact page or native window is addressed? What may be cleaned up afterward? None of these identifiers grants permission to publish, delete, or change an account. The implementation provides cooperation boundaries; authorization and verification remain separate responsibilities.

This article describes source-backed behavior, not a new live acceptance run. The [browser README](../../skills/browser-control/README.md), [desktop README](../../skills/computer-control/README.md), and [remote README](../../skills/remote-host/README.md) define the supported platforms and prerequisites.

## What the host provides, and what these skills add

DSH provides conversations, execution tools, and a session identifier available to their environment. The browser and desktop skills use that identifier as a default task scope. They add resource selection, ownership records, stable handles, remote routing, and rules for uncertain outcomes. These are Python packages and a native desktop executor, not a plugin-created operating-system sandbox.

The browser itself provides Chrome DevTools Protocol connections. macOS provides Accessibility, window information, input facilities, and permission enforcement. OpenSSH provides authentication and transport. The skills compose these existing facilities. A separate DSH conversation, a Git branch, or a worktree does not create a private browser account or desktop.

## Browser sessions separate responsibility

Browser task scope follows an explicit precedence: a supplied scope, then `BROWSER_CONTROL_CONTEXT_ID`, then `DSH_SESSION_ID`. An explicit browser session overrides automatic session selection. Without a task environment, the Python interface can use a process-specific default; ordinary CLI resource actions require a scope or session. This prevents unrelated command invocations from silently sharing a global task.

[contexts.py](../../skills/browser-control/src/browser_control/contexts.py) stores a stable automatic session for a scope. Selection changes do not inspect or release browser resources. [The context tests](../../skills/browser-control/tests/test_contexts.py) assert precedence, stable reuse, independent tasks, concurrent processes, and refusal of unsafe or corrupt metadata. The store uses locking and replacement checks rather than assuming that only one agent process exists.

For a conversation branch, the practical rule is to use a distinct task scope and retain its own returned objects. This follows from identity-based selection; there is no Git-branch detector. Explicitly reusing the same scope or session intentionally shares responsibility. Copying a conversation's prose does not establish a safe transfer of live browser objects. A branch should obtain its own binding or follow an explicit handoff, rather than paste a stale target identifier and assume ownership.

A Page fixes the machine, browser session, browser, and exact target identifier. Changing a remembered machine later does not redirect an existing Page. [Routing contract tests](../../skills/browser-control/tests/test_routing_contract.py) exercise this property and make an explicit remote failure raise without contacting the local socket. A title, URL fragment, list position, or currently active tab is not a substitute for an actual returned target identifier.

## A private task window still shares account state

The normal cooperative mode creates a task window in an authorized browser instance. Workers can operate different pages through background CDP input without moving the real pointer or switching the visible tab for each action. However, the window uses the same profile and login. Signing out or changing a site setting can affect other windows. Newly creating a window can itself bring that window forward; the [operating rules](../../skills/browser-control/references/common.md) explicitly record this limitation.

Chrome also supports an isolated profile and a cloned profile. A clone belongs to the task and does not write changes back into the source profile. Arc supports attachment rather than those launch modes. Choosing a separate profile trades convenient existing login state for stronger storage separation. Choosing a clone copies potentially sensitive authenticated state. These are available design choices, not comparative experiments demonstrating a universal best mode.

Cleanup distinguishes pages the task created from pages it borrowed. Release closes owned pages and removes bindings to borrowed ones; closing a borrowed page needs explicit authorization. The [resource ledger](../../skills/browser-control/src/browser_control/resources.py) records minimal ownership metadata scoped to the browser's actual instance UUID. It does not restore an action binding from a URL or treat a reused debugging port as the same browser. Disconnect and release have different meanings: stopping a connection does not necessarily surrender its resources.

## Native windows cannot become independent desktops

The desktop tool has a different problem. Some actions address Accessibility elements directly; others depend on event delivery and focus. There is still a single real foreground, and a person can change it between checks.

A stable window reference includes its window identifier, process identifier, process start time, and application identity. The [Swift executor](../../skills/computer-control/bin/computer-control.swift) checks that the original process generation and exact window remain valid. It refuses to substitute a similar title or position. Element checks also verify membership in the bound window.

For non-browser applications, the tool records task ownership and a changing lease. Handoff and release invalidate older credentials. Browser applications instead use task windows and short operation locks, allowing different windows to cooperate without claiming the whole shared browser. Keyboard, paste, menu, and event-based mouse operations use a shared desktop-input lock. Browser input also checks the foreground application, exact focus window, and focused element where relevant.

These measures reduce races between cooperating callers. They cannot stop a person or another same-account program from changing focus immediately after a check. Long input rechecks focus and stops when it changes. If input may already have been sent, the result is unknown. The [desktop rules](../../skills/computer-control/references/common.md) state this residual race explicitly; [handle contract tests](../../skills/computer-control/tests/test_contract.py) check rejection of another task, another window, and an outdated lease.

Accessibility and Screen Recording permissions belong to the actual process on the destination. A successful version probe proves neither permission nor application control. Selected targeted input also uses private macOS interfaces, so operating-system changes can break it. Unsupported targeted actions fail instead of silently switching to global input. System identity confirmation and sensitive application restrictions are additional boundaries, not things a task name can bypass.

## Remote means a real destination

The shared [target resolver](../../skills/_shared/agentkit/remote/target.py) and [SSH transport](../../skills/_shared/agentkit/remote/ssh.py) underpin remote selection. Each tool keeps its own remembered destination. An explicit destination wins for that call; bound objects retain the destination already selected. Unknown aliases, broken selection state, missing remote tools, and connection failures cause errors. `remote-host` rejects local execution rather than interpreting a missing destination as this computer.

Remote payloads use the system SSH client and its configured authentication. Browser calls send structured requests over SSH to the target's local browser service; they do not expose the debugging port to the caller. Capability checks precede supported remote actions, and requests explicitly select local execution on the destination to avoid recursive routing. Installation remains an explicit prerequisite. These constraints are documented in the [shared transport rules](../../skills/remote-host/references/transport.md).

SSH does not sandbox the payload. It runs with the authenticated account's real access. Two workers using that account can still edit the same file. The [copy and verification rules](../../skills/remote-host/references/copy-verify.md) describe staging before placement and content checks. Conditional file replacement can compare an expected SHA-256 to detect intervening edits. Transport success establishes delivery, while content and service checks establish the requested result.

## Observe after an uncertain action

A timeout does not undo an operation. After an uncertain click, input, or remote mutation, the next step is observation on the original target. Repeating a submission can duplicate an external effect. Browser recovery likewise re-establishes an eligible original binding; it does not replay the interrupted click. Browser-instance changes, missing pages, or unsupported customized bindings can make recovery refuse.

A useful review asks whether the expected page changed, whether only the intended window disappeared, whether transferred bytes match, and whether the final service responds. A clean subprocess exit alone cannot answer those questions.

## Evidence and measurement

The checked-in tests provide reproducible contract evidence, with fixtures rather than a claim about a user's live desktop or SSH destination. From the public repository root, the targeted browser checks can be run with:

```sh
uv run --project skills/browser-control --extra test python -m unittest discover -s skills/browser-control/tests -p 'test_contexts.py' -q
uv run --project skills/browser-control --extra test python -m unittest discover -s skills/browser-control/tests -p 'test_routing_contract.py' -q
```

For a controlled live evaluation, use a disposable example page and two fictional task scopes. Record wrong-target refusals, unexpected focus changes, operations with unknown outcomes, and resources remaining after release. Compare shared-window and separate-profile configurations under the same actions. Include browser and operating-system versions, permissions, and whether a human changed focus. A fixture refusal rate is not a live isolation guarantee.

The publication's reproducible measurements belong in [benchmark results](../../benchmarks/results.json). No timing, throughput, or savings figure is inferred here. The strongest supported conclusion is narrower: explicit identities and conservative failure rules make accidental cross-task actions easier to detect, while shared accounts, desktop focus, and real remote permissions remain shared state.