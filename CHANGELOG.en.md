[中文](CHANGELOG.md) | English

# Changelog

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