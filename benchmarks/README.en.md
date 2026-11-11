[中文](README.md) | English

# Reproducible text-volume measurements

These measurements use only fictional data and local code. They make no model, API (application programming interface), browser, or network requests. They measure the amount of text returned to a conversation and the current compaction appendix implementation. They do not measure answer quality, latency, provider billing, cache hits, or a live DSH session.

## Run both measurements

Requirements: Python 3.10 or newer, and Node.js 22.18 or newer with TypeScript stripping. No third-party packages, model keys, or plugin installation are needed. Run from the repository root:

```sh
python3 benchmarks/run.py --output benchmarks/results.json
```

The root is inferred from the script location. For an unpublished staging copy, point `--source-root` at a source checkout containing `dsh-compaction-bound`. This is read-only; the report contains repository-relative source names and SHA-256 hashes, never the checkout location.

To verify an existing result without overwriting it:

```sh
python3 benchmarks/run.py --check benchmarks/results.json
```

A mismatch exits nonzero, including a source-hash mismatch. Review changes before regenerating the reference. The checked-in [results.json](results.json) is an actual output of this command family, not a hand-entered table. There are no timestamps or machine identifiers, so repeated runs over the same source and fixture produce identical results.

## 1. Return the log, or keep it local and return the answer

[run.py](run.py) deterministically generates 10,000 JSONL records by default. Each record has a sequence number, a fictional service, a status, a latency, and repeated example diagnostic text. There is no imported user log. To inspect the exact fixture and conclusion:

```sh
python3 benchmarks/run.py --export-log example-log.jsonl --export-conclusion example-answer.json
```

The generator is the fixture specification; large raw logs are deliberately not committed. The report includes the raw log hash. `--rows` accepts 1 through 100000 and changes only the locality workload.

Both paths read the same complete log. The baseline returns the entire JSONL text. The local path parses it in a Python variable, counts errors per service and slow rows, finds the maximum latency, and returns that result with three example error records identified by sequence number. It checks record completeness, an independent expected error count, the service-count total, and a sample lookup into the original data before reporting any sizes.

The estimator is **ceil(UTF-16 code units / 4)**, applied separately to each returned text. UTF-8 byte counts are reported separately. This is a fixed character heuristic, not a tokenizer for any provider. It will be inaccurate for some languages, symbol-heavy data, and image inputs. The text reduction is a property of this selected query and synthetic verbose fixture, not a general percentage for the plugin. A task requiring every log line would need to return or inspect more data.

The [results.json](results.json) fields `locality.raw` and `locality.filtered` are the two comparable payloads. `locality.result` is the exact answer behind the filtered size; the optional exported conclusion is its canonical JSON serialization. Prompt text, Python code, tool definitions, intermediate reasoning, provider wrappers, output tokens, and cache pricing are excluded from both sides. The script demonstrates the data-flow principle using standard Python; it does not claim to benchmark DSH transport or kernel recovery.

## 2. Compaction retention and appendix budgets

The Python entry reads numeric defaults from [the real plugin schema](../dsh-compaction-bound/src/index.ts), then invokes [compaction-budget.mjs](compaction-budget.mjs). That worker imports `boundItems`, `itemLine`, `attachmentText`, and `parseAttachment` directly from [the production implementation](../dsh-compaction-bound/src/summary.ts). It does not maintain a second implementation of the bounding algorithm. Failure to find the source, parse a default, import TypeScript, or satisfy an invariant exits nonzero.

The fixtures cover short history, increasingly long history, a single message larger than the verbatim budget, and text with quotes, newlines, and supplementary Unicode characters. Every run verifies that serialized verbatim lines fit `userMessageChars`, serialized index and range lines fit `userIndexChars`, every original item remains represented by a full item, index item, or range count, and the appendix parses back to the bounded items. All fixture turns, timestamps, and session identifiers are fictional.

`verbatim_line_utf16_units` and `index_line_utf16_units` include each JSON line and its newline. `framing_utf16_units` measures the remaining headings, tags, and history-reader notes. Those notes sit outside the two item budgets. `appendix_estimated_tokens` uses the same character estimator as the log measurement. `unbounded_appendix_utf16_units` is a control made with the same production renderer and all original fixture messages, without bounding.

The retention setting `retainTokens` is already expressed in the host's approximate text-token units. The script reports a conditional illustration:

```text
ceil((retainTokens * 4 + summaryChars + measured_appendix_utf16_units) / 4)
```

This is a **text target under stated assumptions**, not a strict maximum for the next request. It assumes the retained recent history matches the host estimate and the model summary fits its target. The host may retain an indivisible message across a boundary. The plugin keeps an oversized summary if its single shortening attempt fails validation. System instructions, tools, images, protocol encoding, and arbitrary-length custom `historyReaderHint` values are outside this illustration. The measured fixture uses the generic default reader note and a fixed-length fictional session ID.

For that reason the report never turns the combined target into a claim about actual model tokens, attention quality, throughput, or money. To measure those, collect complete final requests and provider usage under a separately specified protocol and model, with permission to handle the data. This offline benchmark does not do that.

## Reading the results with the design documents

- [Data locality](../docs/design/python-data-locality.en.md) explains why data can stay in a kernel variable.
- [Three generations of compaction](../docs/design/three-generations-of-compaction.en.md) explains the current safety and observability choices.
- [Output guard](../docs/design/output-guard.en.md) separates display budgets from protection against a runaway model stream.

When quoting a number, link the relevant report field and keep its estimator, workload, and exclusions next to the claim. Re-run after changing the source defaults or appendix format.