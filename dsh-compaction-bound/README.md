# dsh-compaction-bound

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
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `retainTokens` | `12000` | Estimated recent-text tokens retained by basic compaction; minimum 1000. Changing it remounts presets; restart DSH for restored sessions to use the new generation. |
| `boundSummary` | `true` | Rewrite recognized compaction instructions and attach the user-text appendix. False uses the host's original summary flow. |
| `summaryChars` | `12000` | Character target for the model summary; minimum 2000, excluding the appendix. Oversize handling is bounded to one shortening attempt. |
| `userMessageChars` | `8000` | Serialized-line budget for verbatim user messages; minimum 1000. |
| `userIndexChars` | `2000` | Serialized-line budget for older-message index entries; minimum 300. |
| `historyReaderHint` | `''` | Optional replacement for the session-history reader sentence. Every `{sessionId}` is replaced literally with the current session ID; the turn-range sentence is still appended. Empty uses the generic host-reader wording. No sentence is emitted when the session ID is unknown. |

All settings except `retainTokens` are volatile and read for new compaction requests. To disable the entire entry, set `disabled: true` on `id: compaction-bound`. Turning off `boundSummary` alone does not remove the retention adjustment.

The plugin writes `$DSH_HOME/plugins/compaction-bound/status.json` (using DSH's default home when the variable is absent). It records mounted retention settings and the most recent 20 summary reports, including appendix counts and `within`, `condensed`, `over-kept`, or `failed` outcomes. These are operational diagnostics, not a billing report.

## Development and verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Tests cover preset retention, request rewriting, appendix bounds and source selection, existing checkpoint formats, shortening validation, cancellation, and persistent status. The host-chain test runs three compactions using real host session storage and the official engine with a synthetic model adapter. It verifies original messages remain retrievable from session events; it does not call a live model or prove provider-specific token savings.

## License

MIT. See [LICENSE](LICENSE).
