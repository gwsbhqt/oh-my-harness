# dsh-message-tidy

[← oh-my-harness](../README.md#components) · [中文首页](../README.zh-CN.md#由哪几块组成)

Tidy messages that DSH adds to an agent's model context. Four independently switchable features identify plugin notices, remove identical notices within a step, give background jobs useful labels, and send small instruction-file updates as diffs.

## Requirements and installation

Requires a compatible DeepSeek Harness (DSH) installation with the agent lifecycle, tool result, and session event hooks, Node.js `^22.19.0 || >=24.0.0`, and pnpm. The package manifest records the tested host dependencies; the current tests use DSH 0.2.2-rc.1. Keep the shared `tooling/` directory alongside this plugin in the containing repository. This source directory is not a standalone build project.

From this plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Merge a linked dependency and bundle into your DSH profile's package manifest:

```json
{
  "dependencies": {
    "dsh-message-tidy": "link:../../path/to/oh-my-harness/dsh-message-tidy"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-message-tidy"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by DSH, validate the profile if a startup checker is available, and restart DSH. The bundle registers its entry; do not insert a duplicate entry.

## Behavior and relationship to DSH

DSH supplies the messages and their source metadata. This plugin wraps the outer `agent/pre-step` hook so it can see messages added by inner hooks, and preserves their source objects for host bookkeeping.

- **Notice labels:** wrap the first text block of selected plugin notices with a system-reminder marker identifying the source and stating that the user did not write it. Already wrapped text stays intact. This does not grant permissions or reinterpret the notice as a user request.
- **Notice deduplication:** within one step, keep only the first notice whose role, full source, and full content exactly match. Repeated user or assistant messages remain. This is not semantic deduplication and does not undo a wake-up already scheduled by the host.
- **Job labels:** remember a successful background or promoted Bash result's job ID and nonempty description, then use it in the completion notice and summary. Unknown jobs keep the original notice. Parentheses inside commands and appended output retain their boundaries.
- **Instruction diffs:** compare an updated instruction file with the last version actually committed to that agent's session. Send a unified diff only when it is small enough and both versions are complete. Missing baselines, budget truncation, large diffs, or excessive comparison sizes use full text. Failed or cancelled uncommitted steps do not advance the baseline. State is per agent and is released with it.

The instruction parser depends on host message headings. Unrecognized messages pass through. Optional compatibility with pinned-instruction markers uses a shared marker and an in-process map; the pinning plugin is not required or imported. Host repeat-reminder exclusions remain host configuration, which this plugin does not change.

## Configuration

Override the existing entry in your profile patch, or use its settings card in the DSH Web UI:

```yaml
- id: message-tidy
  config:
    noticeSources: ['*']
    noticeDedupe: true
    instructionsDiff: true
```

All fields are volatile. The shipped bundle explicitly selects two notice sources even though the schema default is `['*']`. A profile override takes precedence.

| Setting | Schema default | Shipped bundle value | Meaning |
| --- | --- | --- | --- |
| `noticeLabel` | `true` | `true` | Label selected plugin notices. |
| `noticeSources` | `['*']` | `['repeat-tool-reminder', 'tool-jobs']` | Notice source kinds to label; `*` selects all plugin notices. |
| `noticeDedupe` | `true` | `true` | Remove identical notices within one step. |
| `jobLabel` | `true` | `true` | Use recorded descriptions in completion notices. |
| `jobLabelMaxChars` | `120` | `120` | Maximum label length, minimum 8; long labels end with an ellipsis. |
| `instructionsDiff` | `true` | `true` | Send small instruction changes as diffs; disabling clears the cache. |
| `maxDiffRatio` | `0.5` | `0.5` | Maximum diff-to-full-text ratio, from 0 to 1. Larger diffs use full text. |
| `contextLines` | `2` | `2` | Context lines around each changed region. |

To disable the entire entry, set `disabled: true` on `id: message-tidy`. Code changes require rebuilding and restarting DSH. Volatile settings apply to subsequent processing without remounting.

## Development and verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Synthetic fixtures cover source preservation, immutable objects, duplicate notices, job labels, instruction diffs, committed baselines, failed steps, budget omissions, and optional pinned-instruction interoperability. A host repeat-reminder contract test reads a desktop archive from `DSH_APP_ASAR` or the standard macOS installation path and skips if absent. It verifies host source exclusions with test callbacks; it does not configure running sessions or prove GUI delivery.

Remove each feature when the host supplies equivalent behavior. These tests do not establish a fixed token saving for a live provider.

## License

MIT. See [LICENSE](LICENSE).
