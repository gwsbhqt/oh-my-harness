# Working on oh-my-harness

Follow the user's task, the host's permissions, and more specific component instructions. Keep changes within the authorized scope. Ability to reach a browser, desktop, network, or control endpoint is not authorization to act there.

## Locate the real owner

- Root `dsh-*` directories contain independent DSH plugins. `tooling/` contains their shared build and contract utilities.
- `skills/browser-control`, `skills/computer-control`, and `skills/remote-host` contain the operating tools; `skills/_shared` owns common transport and target handling.
- Start with the relevant README and source call path. Use [docs](README.en.md#components) for scenarios and [design articles](docs/design/python-data-locality.md) for reasoning, not as substitutes for current code.
- Keep source imports, tests, package metadata, and documentation inside the released boundary. Never introduce an implicit dependency on a local personal configuration or an unpublished plugin.

## Execute with evidence

Read an existing file before changing it. Preserve unrelated work, staging, branches, and configuration. Prefer a focused edit over replacing a whole manifest or adding another abstraction. Reuse the owning component's environment, package manager, and existing helpers.

When a request may already have changed external state, inspect its receipt and actual destination before deciding to repeat it. A timeout, missing reply, or command acceptance does not establish success or rollback. Do not silently substitute another page, window, machine, or account when the requested target fails.

Keep complete result values available for computation and show only evidence needed for the next decision. Check upstream completeness, pagination, and errors before counting. A bounded display is not a complete source. Save or retrieve full output only when the task needs it.

Track background work that you start. Use the existing completion mechanism; do not duplicate a monitored producer with model polling. Waiting for another actor is not useful remaining work. Do not report a queued request or an active job as completed.

## Verify the actual boundary

Follow [CONTRIBUTING.md](CONTRIBUTING.md) and the component's check commands. Tests for a defect should preserve the original failure shape. Cover data, permissions, protocol, cancellation, and startup boundaries where affected. For a reversible text-only edit, do not add a test that merely repeats the implementation.

Distinguish source inspection, synthetic tests, integration fixtures, and live verification. A green contract test does not prove a website, desktop action, deployment, or remote service succeeded. Verify the final consumer or say what remains unverified.

A plugin or configuration change may need startup checks and a controlled restart. Do not restart, install, alter permissions, publish, or change repository visibility without the task's authority. Do not modify a working private environment just to make an example run.

## Protect public artifacts

Use fictional examples and dedicated fixtures. Exclude personal identity, accounts, private paths, machine/network details, credentials, authenticated screenshots, and real session logs. Keep any private review vocabulary outside the repository. Preserve third-party notices and provenance.

Do not add unsupported compatibility promises, exact model-token claims, billing claims, or fabricated demo evidence. Explain measurement assumptions and link reproducible outputs. Documentation should describe the released behavior, not an internal task diary.

## Finish clearly

Explain the user-visible result, why it changed, what was actually tested, and remaining limits. Record external handoff steps without presenting them as finished. Generated code and documents remain the contributor's responsibility. Use the pull request template when submitting a change; commit or push only when authorized.