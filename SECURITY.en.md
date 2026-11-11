[中文](SECURITY.md) | English

# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/gwsbhqt/oh-my-harness/security/advisories/new). Describe the affected component and source revision, prerequisites, a minimal fictional reproduction, expected and observed behavior, and the security impact. Include only the evidence necessary to reproduce the issue; remove credentials, account data, authenticated screenshots, session logs, and private endpoints.

If private reporting is unavailable, do not publish exploit details or sensitive data in an issue. A neutral issue can ask maintainers to enable the private channel without describing the vulnerability. Availability depends on the repository settings. There is no promised response or fix deadline.

For ordinary defects, use the [bug form](.github/ISSUE_TEMPLATE/bug.yml). Community conduct is covered by the [Code of Conduct](CODE_OF_CONDUCT.en.md); a vulnerability report is not a general private-messaging channel.

## Trust boundaries

- **Host and model:** DeepSeek Harness supplies model execution, sessions, tool policy, and jobs. These extensions do not make arbitrary model output trustworthy. Check each plugin's actual compatibility before loading it.
- **Python:** the kernel executes trusted code with its operating-system account's access to files, networks, threads, and processes. It is not a sandbox. Harness tool approvals govern bridged tool calls; they do not contain direct Python operations. Skill discovery can execute package code during import.
- **Browser:** attaching to a browser may expose authenticated account state. Cooperative task windows and ownership metadata do not isolate cookies or authorize account actions. Keep debugging access local or behind an explicitly secured transport.
- **Desktop:** macOS Accessibility and input permissions affect real applications. Exact handles and targeted input reduce mistakes but cannot remove shared-focus races or protect every unrelated window.
- **Remote host:** SSH (Secure Shell for remote connections) uses the destination account and configured keys. Commands, file changes, and services are real. An explicit remote failure must not silently become a local operation. A timeout or dropped connection does not prove an action was rolled back.
- **Control interface:** the local endpoint is intended for the same system account. Do not expose or proxy it to an untrusted network. Read-only mode and namespace restrictions limit that interface, not the entire host or Python process. An accepted request is not proof of its eventual result.
- **Stored state and output:** snapshots, saved full output, command diagnostics, and host session records may contain data that was not displayed. Review access, retention, and any exported artifact. A small conversation display does not mean the underlying value is small or non-sensitive.
- **Context and stream helpers:** compaction can index old wording rather than show it. A host reader must actually recover that wording when needed. Output guards detect selected invalid patterns; they cannot prove semantic correctness or defeat all malicious inputs. A monitor is not a durable event queue.

## Supported scope

Please reproduce against the current source and state the exact component. Platform support and dependencies are component-specific; desktop integration is currently validated on macOS. Pure contract tests or successful CI do not validate an authenticated website, a remote service, or a live desktop.

No dependency, credential, permission, or network-boundary change should be presented as harmless merely because it fixes an installation problem. Review the complete path to the final consumer, verify the intended result, and keep failures observable.

## Safe testing

Use dedicated fictional data, local examples, and destinations you are authorized to access. Do not probe someone else's account, infrastructure, or credentials to demonstrate a report. Avoid production state and automatic retries of operations with unknown outcomes. Maintain enough evidence to distinguish "accepted", "running", "failed", and "verified".