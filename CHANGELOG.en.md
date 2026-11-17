[中文](CHANGELOG.md) | English

# Changelog

## Unreleased

- Focus the home page on main capabilities and entry points. Add paired documentation navigation, getting-started, architecture, configuration-boundary, and maintenance guides, with desktop and mobile overview diagrams.
- Add `shot-sheet` for screenshot contact sheets, GIF and video frame extraction, before/after comparisons, and annotations, with independent packaging and fictional-media checks.
- Add a public-content check that needs no component dependency installation, covering documentation links, licensing, release boundaries, and general sensitive-content patterns. Discover plugins automatically in CI.
- Use neutral maintenance guidance and synthetic regression inputs while retaining technical constraints and original failure shapes.
- Clarify the boundary between session control and optional model quota integrations.
- Correct Bash output completeness: preserve upstream gaps and shared log paths, and report background results as unknown when completeness cannot be proven.
- Exclude Python caches from the session-control package and verify the actual package file list in a regression test.
- Fix the platform boundary in Linux CI: always run rebuild checks and explicitly skip only the actual desktop-app startup check when its required environment is unavailable.

## 0.1.0

### Added

- Persistent Python execution for DeepSeek Harness with a host tool bridge, namespace inspection, supported-state snapshots, and trusted Python skills.
- Running-instance control through CLI (command-line interface), Python, and MCP (Model Context Protocol for tool integration) entry points, plus a controller/worker supervision skill with receipts and state-based observation.
- Browser control over CDP, native macOS interaction, and SSH (Secure Shell for remote connections) remote operations with explicit target selection and cooperative ownership.
- Producer-driven session monitoring and separate checks for repeated, blank, oversized, or falsely completed model streams.
- Context helpers for bounded compaction and exact-user-text indexing, message tidying, image limits, and UI history pagination.
- Component usage guides, design articles, and deterministic offline measurements using fictional data and an explicit character estimator.
- Community contribution, conduct, and security-reporting documents, with preserved upstream license and provenance notices.

### Scope

oh-my-harness is an independent extension collection for DeepSeek Harness. Platform support varies by component. Python cells run with the current process permissions. Offline measurements estimate the text payload of fictional fixtures.