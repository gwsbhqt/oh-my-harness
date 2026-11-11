# dsh-output-guard

[← oh-my-harness](../README.md#components) · [中文首页](../README.zh-CN.md#由哪几块组成)

Stop runaway model output in DeepSeek Harness (DSH), and optionally retry the failed step once with a corrective notice. The plugin protects the main agent and subagents from repeated text, long blank runs, oversized tool arguments, and replies that finish without an answer or tool call.

## Requirements and installation

Use a compatible DSH installation providing the LLM and agent services. Development dependencies target DSH 0.2.2-rc.1. Node.js `^22.19.0 || >=24.0.0` and pnpm are required. This is a host plugin with no separate UI or external service.

Keep the containing repository's shared `tooling/` directory alongside this plugin. This source directory is not a standalone build project. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Add a linked dependency and bundle to your DSH profile's package manifest, merging with its existing entries:

```json
{
  "dependencies": {
    "dsh-output-guard": "link:../../path/to/oh-my-harness/dsh-output-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-output-guard"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by your DSH installation, then restart DSH. The bundle registers `output-guard`; do not insert a duplicate entry. Validate the profile before restarting if your installation provides a startup checker.

## What it checks

- Repeated cycles in reasoning and answer text. Comparison ignores whitespace and common Markdown emphasis characters. Numeric and punctuation-only structures are excluded. Tool arguments are exempt from repetition detection so ordinary code does not trip it.
- Excessive consecutive whitespace in reasoning, text, or tool arguments. JSON whitespace escapes in tool arguments count toward this limit.
- Total argument length per tool call. Separate calls have separate counters.
- A normal or token-limited finish without answer text or a usable tool call. A tool call discarded at the token limit does not count as a usable result.

When a limit is reached, the plugin closes the upstream stream and reports a failed attempt. With `autoRetry` enabled, it writes a notice identified as `output-guard` and retries once per agent, turn, and step. It does not feed the runaway content back as a prompt. A second failure follows the host's normal error handling. The plugin does not switch models or modify the permanent system prompt. Non-agent model requests pass through unchanged.

This is a stream heuristic, not a guarantee that an answer is correct or that every loop will be detected. Adjust thresholds for legitimate repetitive output or large tool payloads.

## Configuration

Override the bundle entry in your DSH profile patch:

```yaml
- id: output-guard
  config:
    enabled: true
    autoRetry: true
    maxBlankRun: 2000
    maxToolArgsChars: 50000
```

All settings are volatile and are read for new requests.

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable stream checks and corrective retry handling. |
| `reasoningOnlyGuard` | `true` | Reject a finish with no answer or usable tool call. |
| `autoRetry` | `true` | Retry a guarded failure at most once per step. |
| `repeatCount` | `8` | Minimum consecutive repeats of a text cycle. |
| `minCycleChars` | `4` | Minimum normalized cycle length. |
| `maxCycleChars` | `160` | Maximum normalized cycle length. |
| `minRepeatedChars` | `64` | Minimum characters covered by the repeated segment itself. |
| `windowChars` | `1000` | Recent normalized characters inspected for repetition. |
| `maxBlankRun` | `2000` | Maximum consecutive whitespace run. |
| `maxToolArgsChars` | `50000` | Maximum argument characters per tool call. |

Use `enabled: false` to bypass the guard, or override `id: output-guard` with `disabled: true` to disable the plugin entry.

## Development and tests

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Tests use synthetic text and tool payloads to check repetition boundaries, stream fragmentation, upstream cancellation, whitespace, argument limits, pass-through behavior, and the one-retry limit. A real DSH Session test verifies that failed attempts stay out of derived conversation history and the corrective notice is included. These tests do not call a model or establish live provider behavior.

## License

MIT. See [LICENSE](LICENSE).
