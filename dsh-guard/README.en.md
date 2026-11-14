[中文](README.md) | English

# dsh-guard

[← oh-my-harness](../README.en.md#components) · [Tutorial](../docs/dsh-output-guard.en.md)

**In short:** Stop runaway model output and retry once, and let the model manage its own goal and know when to wrap up.

Two guard rails for DeepSeek Harness (DSH), loaded as two independent entries:

- **Output guard** (entry `output-guard`): stops runaway model output — repeated text, long blank runs, oversized tool arguments, and replies that finish without an answer or usable tool call — and retries the failed step once with a corrective notice. Covers the main agent and subagents; non-agent model requests pass through unchanged.
- **Goal guard** (entry `goal-guard`): lets the model pause, edit, and complete its own goal, and tells it when to wrap up. When the model cannot call any tool, it counts stalled continuation rounds from the session record and stops the goal when needed.

## Requirements and installation

Use a compatible DSH installation providing the LLM, agent, tools, and systemPrompt services. Development dependencies target DSH 0.2.2-rc.1. Node.js `^22.19.0 || >=24.0.0` and pnpm are required. This is a host plugin with no separate UI or external service.

Keep the containing repository's shared `tooling/` directory alongside this plugin. This source directory is not a standalone build project. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Add a linked dependency and bundle to your DSH profile's package manifest, merging with its existing entries:

```json
{
  "dependencies": {
    "dsh-guard": "link:../../path/to/oh-my-harness/dsh-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-guard"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by your DSH installation, then restart DSH. The bundle registers the `output-guard` and `goal-guard` entries; do not insert duplicates. Validate the profile before restarting if your installation provides a startup checker.

## What the output guard checks

- Repeated cycles in reasoning and answer text. Comparison ignores whitespace and common Markdown emphasis characters; numeric and punctuation-only structures are excluded. Tool arguments are exempt from repetition detection so ordinary code does not trip it.
- Excessive consecutive whitespace in reasoning, text, or tool arguments. JSON whitespace escapes in tool arguments count toward this limit.
- Total argument length per tool call. Separate calls have separate counters.
- A normal or token-limited finish without answer text or a usable tool call. A tool call discarded at the token limit does not count as a usable result.

When a limit is reached, the plugin closes the upstream stream and reports a failed attempt. With `autoRetry` enabled, it writes a notice identified as `dsh-guard` and retries once per agent, turn, and step. It does not feed the runaway content back as a prompt. A second failure follows the host's normal error handling. The plugin does not switch models or modify the permanent system prompt.

## What the goal guard does

- Shadows the host `update_goal` at each agent's own tool layer: `pause` becomes a resumable stop the model can lift (recorded as blocked) instead of a dead end; in "continue / finish" notification rounds where the host grants no authority, the root session calls the goal service directly for `edit`, `complete`, `blocked`, and `resume`; a pause the user set by hand is not resumed, and subagents are left alone.
- Adds wrap-up guidance in sessions that have a goal tool: when to complete, pause, or edit the objective, instead of treating "waiting on someone else" as useful remaining work.
- Counts stalled continuation rounds from the session record: after several rounds without a single successful tool call, it stops the goal for the model.

## Configuration

Override each entry in your DSH profile patch (the namespace is the entry id):

```yaml
- id: output-guard
  config:
    enabled: true
    autoRetry: true
    maxBlankRun: 2000
    maxToolArgsChars: 50000
- id: goal-guard
  config:
    enabled: true
    modelControl: true
    wrapUpGuidance: true
    stallRounds: 3
```

All settings are volatile and are read for new requests or the next step.

**Output guard**

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

**Goal guard**

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch: off turns off wrap-up guidance, the tool wrapper, and the stall brake together; stalled rounds are not counted while off and counting restarts from zero when re-enabled. |
| `modelControl` | `true` | Turn a model pause into a resumable stop; fill in edit / complete / blocked / resume when the host gives no authority (user-set pauses excepted). Off restores host behaviour. |
| `wrapUpGuidance` | `true` | Add wrap-up guidance to sessions that have a goal tool. |
| `stallRounds` | `3` | Stop the goal after this many consecutive continuation rounds without a successful tool call; `0` disables it. |

Use `enabled: false` to bypass the output guard; `enabled: false` on `goal-guard` turns off its wrap-up guidance, tool wrapper, and stall brake together (no counting while off, restarting from zero on re-enable). Override `disabled: true` on the corresponding `id` to disable that entry.

## Development and tests

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Tests use synthetic text, tool payloads, and fake hosts to check repetition boundaries, stream fragmentation, upstream cancellation, whitespace, argument limits, pass-through, the one-retry limit, goal pause and fill-in, wrap-up guidance, and stall counting. A real DSH Session test verifies that failed attempts stay out of derived conversation history and the corrective notice is included. These tests do not call a model or establish live provider behavior.

## License

MIT. See [LICENSE](LICENSE).
