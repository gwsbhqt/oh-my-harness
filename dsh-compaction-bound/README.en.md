[中文](README.md) | English

# dsh-compaction-bound

[← oh-my-harness](../README.en.md#components) · [Tutorial](../docs/dsh-compaction-bound.en.md)

**In short:** When the chat history is compacted, your own messages are copied word for word instead of being paraphrased by the model, and the result has a fixed size limit.

Bound the amount of recent text and summary text retained by DSH's built-in context compaction. This plugin augments the official `@deepseek-ai/dsh-compaction-basic` engine; it does not replace its compaction trigger, model context window, or maximum reply size.

## Requirements and installation

Requires a compatible DeepSeek Harness (DSH) installation with the preset registry, LLM runtime, session query service, and official basic compaction engine, Node.js `^22.19.0 || >=24.0.0`, and pnpm. The package manifest records the tested host dependencies; the current tests use DSH 0.2.2-rc.1. Keep the shared `tooling/` directory alongside this plugin in the containing repository. This source directory is not a standalone build project.

From this plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Merge a linked dependency and bundle into your DSH profile's package manifest:

```json
{
  "dependencies": {
    "dsh-compaction-bound": "link:../../path/to/oh-my-harness/dsh-compaction-bound"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-compaction-bound"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by DSH, validate the profile if a startup checker is available, and restart DSH. The bundle registers its entry; do not insert a duplicate entry.

## Behavior and limits

The plugin adds a fixed `retainTokens` value to basic compaction entries in registered presets only when neither `retainTokens` nor `retainRatio` is already explicit. It preserves other preset settings. Remounted presets affect new sessions and sessions restored after a DSH restart; already running sessions can remain bound to their previous preset generation.

For a recognized compaction request, the plugin replaces only the final compaction instruction with a bounded, sectioned summary instruction. After a successful summary, it attaches a separate appendix built directly from user-authored text and earlier recognized checkpoint appendices. It does not ask the model to paraphrase or select those quotes. Non-text attachments and text from notifications, tool results, or assistant replies are not treated as user-authored messages.

The appendix has two independent budgets. It keeps the newest user text verbatim within `userMessageChars`, then records older items as an index containing the turn, time, character count, and a short prefix. If the index exceeds `userIndexChars`, its oldest entries merge into turn ranges. Session logs retain the original messages, but this plugin does not expose history-reading tools. Reading indexed text requires a reader supplied separately by the host. The default appendix states that limitation and does not claim an unavailable tool exists. If your host exposes a reader, configure `historyReaderHint` to name its actual tool and calling convention; setting a hint does not install or validate a reader.

`summaryChars` applies only to the model-written summary, not the appendix. If the summary is too long, the plugin makes at most one additional model request to shorten that summary alone. It accepts the result only if it fits, preserves all required section headings in order, and leaves **Active User Requirements** unchanged. If the attempt fails or fails validation, it keeps the original summary and records `over-kept`; this setting is not a hard output guarantee. An unfinished or failed initial summary follows the host's failure path without appending user text.

When a compaction request itself would exceed the summarizing model's context window, the plugin fits that one request into the window instead of letting compaction fail. This happens when a session has already grown past the window registered for the model: the host replays the whole span being compacted, so the summary request overflows too. That can be a provider rejection, or pi-ai reporting `CONTEXT_WINDOW_EXCEEDED` because the reported input exceeds the registered window. If the request ends with `CONTEXT_WINDOW_EXCEEDED`, the plugin discards that attempt and sends a fitted copy, at most twice. It first shortens the oldest long tool results to a head and tail excerpt. If that is not enough, it leaves out the oldest messages, cutting only before a user message and never separating a tool call from its result. The system prompt, any earlier checkpoint, and the final instruction stay. A note tells the model that earlier messages were left out. The size target comes from the input tokens the provider reported for the failed attempt; without a report, the plugin halves the request. It remembers the characters-per-token ratio per model and fits later oversized compaction requests before sending them. Only the request is changed; the session log is untouched, and user messages left out of the request are still attached verbatim. Requests that fit are sent unchanged. The model-written summary covers only what was sent, so detail from omitted messages can be lost. The plugin cannot fix a model whose registered context window or default output limit is wrong; that configuration also decides when the host compacts.

If the host registry structure or compaction instruction changes, the affected hook warns and leaves the host behavior intact. Tests check these host contracts. Retention uses the host's estimate of one token per four characters, not a model tokenizer; no fixed real token saving or cost reduction is promised.

## Configuration

Override the existing bundle entry in your profile patch:

```yaml
- id: compaction-bound
  config:
    retainTokens: 12000
    boundSummary: true
    summaryChars: 12000
    userMessageChars: 8000
    userIndexChars: 2000
    historyReaderHint: ''
    fitWindow: true
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `retainTokens` | `12000` | Estimated recent-text tokens retained by basic compaction; minimum 1000. Changing it remounts presets; restart DSH for restored sessions to use the new generation. |
| `boundSummary` | `true` | Rewrite recognized compaction instructions and attach the user-text appendix. False uses the host's original summary flow. |
| `summaryChars` | `12000` | Character target for the model summary; minimum 2000, excluding the appendix. Oversize handling is bounded to one shortening attempt. |
| `userMessageChars` | `8000` | Serialized-line budget for verbatim user messages; minimum 1000. |
| `userIndexChars` | `2000` | Serialized-line budget for older-message index entries; minimum 300. |
| `historyReaderHint` | `''` | Optional replacement for the session-history reader sentence. Every `{sessionId}` is replaced literally with the current session ID; the turn-range sentence is still appended. Empty uses the generic host-reader wording. No sentence is emitted when the session ID is unknown. |
| `fitWindow` | `true` | Fit a compaction request that exceeds the model's context window and resend it, at most twice. False sends the host's request as is. Works independently of `boundSummary`. |

All settings except `retainTokens` are volatile and read for new compaction requests. To disable the entire entry, set `disabled: true` on `id: compaction-bound`. Turning off `boundSummary` alone does not remove the retention adjustment.

The plugin writes `$DSH_HOME/plugins/compaction-bound/status.json` (using DSH's default home when the variable is absent). It records mounted retention settings and the most recent 20 summary reports, including appendix counts and `within`, `condensed`, `over-kept`, or `failed` outcomes. A report whose request had to be fitted also has `fit`: the registered window, the input budget, how many attempts overflowed, how the size target was chosen (`reported-usage`, `learned-ratio`, `halve`, or `estimate`), shortened tool results, omitted messages, and the final outcome. These are operational diagnostics, not a billing report.

## Development and verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Tests cover preset retention, request rewriting, appendix bounds and source selection, existing checkpoint formats, shortening validation, cancellation, persistent status, and fitting oversized compaction requests. The host-chain test runs three compactions using real host session storage and the official engine with a synthetic model adapter. Overflow tests give that adapter a small registered window and reproduce both failure shapes: pi-ai's overflow report after a completed reply, and a provider rejection with no reply. It verifies original messages remain retrievable from session events; it does not call a live model or prove provider-specific token savings.

## License

MIT. See [LICENSE](LICENSE).