[中文](dsh-output-guard.md) | English

# Recover from runaway model output

`dsh-guard` watches agent output while it streams. It can stop repeated text, excessive blank runs, oversized tool arguments, and replies that finish without an answer or usable tool call. Use it to keep a malformed response from consuming the rest of a step and being mistaken for useful progress. It covers the main agent and subagents; non-agent model requests pass through unchanged.

## What happens during a guarded step

The plugin runs automatically once installed and enabled. There is no separate command to wrap around each request. For example, imagine an agent repeats the same explanatory sentence instead of moving on to its next action. When the repetition meets the configured limits, the guard closes the upstream stream and reports a failed attempt.

With automatic retry enabled, it writes a corrective notice identified as `output-guard` and retries that agent's step once. The runaway content is not fed back as a prompt. If the next attempt also fails, normal host error handling takes over. The plugin does not switch models or change the permanent system prompt.

This retry is bounded per agent, turn, and step. It is not a general retry mechanism for failed tools, services, or business operations. After a guarded failure, inspect any actions already completed before deciding whether more work should run.

## Know which patterns are checked

Repetition detection applies to reasoning and answer text. It normalizes whitespace and common Markdown emphasis characters before comparison. Numeric and punctuation-only structures are excluded, and tool arguments are exempt from repetition detection because ordinary code can contain repeated lines.

Other checks still apply to tool arguments. Long consecutive whitespace runs include JSON whitespace escapes, and each tool call has its own total argument-length counter. If an intended write is too large, divide the work into smaller calls instead of treating a stopped attempt as a completed write.

The finish check rejects a normal or token-limited ending that contains no answer text and no usable tool call. A tool call discarded at the token limit does not establish a usable result. The guard can detect this shape of empty completion; it cannot determine whether a fluent answer actually meets the user's request.

## Confirm recovery, then check the task

When investigating a stopped step, look for the guard failure and corrective notice, then inspect the retry's outcome. Confirm the requested artifact or behavior separately. A concise answer after retry is evidence that output recovered, not evidence that the underlying task succeeded.

The repository tests exercise synthetic text and tool payloads, stream fragmentation, cancellation, thresholds, and the one-retry limit. A real DSH Session test checks conversation-history handling. Those tests do not call a model or establish live provider behavior, and this guide does not claim live acceptance testing.

## Adjust deliberately

Legitimate repetitive output or large tool payloads can meet a heuristic limit. If this happens, compare the intended output with the active thresholds before changing them. Settings are read for new requests; configuration changes do not retroactively repair a failed step. Disabling checks removes this protection rather than proving the original output was valid.

See the [plugin README](../dsh-guard/README.en.md) for installation, the existing `output-guard` entry, every setting and default, and disabling options. [Output guard design](design/output-guard.en.md) explains the recovery boundary. This is a stream heuristic, so it does not guarantee correct answers or detection of every loop.