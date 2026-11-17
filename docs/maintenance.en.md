[中文](maintenance.md) | English

# Keeping the project maintainable

[← Documentation](README.en.md) · [Contributing](../CONTRIBUTING.en.md)

End each maintenance pass with a reproducible problem and an inspectable result. The home page helps people find an entry point; component docs help them use it; tests and design articles help the next contributor change it safely.

## Match checks to changes

| Change | Required verification |
| --- | --- |
| Docs, links, public metadata | `pnpm run check:public`; inspect rendered output for visual changes. |
| A DSH plugin | Its `pnpm run check`; add isolated startup and live UI acceptance when host loading changes. |
| A Python skill | Tests in its own development environment; verify entry points, packaging, and actual operations separately. |
| `tooling/` or `skills/_shared/` | Shared tests plus the consumers actually affected. |
| Measurements or measured source | `python3 benchmarks/run.py --check benchmarks/results.json`; explain changed inputs, estimates, and source hashes. |
| Demo media | Verify real actions, review extracted frames, and inspect identity information and metadata. Diagrams must not stand in for recordings. |

`check:public` runs before component dependencies are installed. It checks documentation links, release manifests, licensing, and explicit sensitive-content patterns. It does not replace human privacy review or establish that a website or desktop operation succeeded.

## Contribution priorities

These are contribution directions, not delivery-date commitments.

| Direction | What completion looks like |
| --- | --- |
| Reproduce the first installation | Install one plugin in a clean environment using the guide; record supported versions, failures, and acceptance results. |
| Make demos easier to update | Keep fictional input, recording steps, and outcome checks for each demo so another contributor can repeat it. |
| Add explicit compatibility evidence | Separate portable tests from live platform acceptance; expand support only from observed results. |
| Extract more reusable skills | Separate dependencies and permissions, preserve licensing, then build, test, and verify independently before migration. |
| Detect DSH upgrade changes earlier | Update contract tests from actual upstream interfaces; verify loading, cancellation, receipts, and recovery. |

Prioritize reproducible user failures and first-use blockers. Explain why the current layout is insufficient before changing it. A new service, abstraction, or dependency needs a concrete benefit.

## Before a release

1. Review a focused diff. Keep Chinese and English entry points aligned, and run public examples without private configuration.
2. Complete relevant checks and report live acceptance separately from unverified behavior. Media and numbers need traceable sources.
3. Check the worktree, package contents, commit identity, and relevant history. Removing a sensitive value from the current file does not erase it from history.
4. Update the [changelog](../CHANGELOG.en.md) with observable changes, compatibility impact, and migration steps.
5. Review the actual release contents before tagging. A version heading or queued workflow does not establish a release.

Use [private reports](../SECURITY.en.md) for security findings. Keep private audit vocabulary and real findings outside the repository; commit only general prevention rules and fictional regression fixtures.
