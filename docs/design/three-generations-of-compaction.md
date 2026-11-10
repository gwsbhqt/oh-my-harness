# Three generations of context compaction: make the boundary inspectable

Long conversations create two different problems. The next request may contain more history than the model should read, and the history that replaces it may change what the user actually asked. A smaller request that silently loses a correction is not a successful optimization. Neither is a carefully written summary that leaves almost all of the old conversation beside it.

The compaction work behind this project went through three implementations: policy tuning around the host engine, a separate protocol-level compression layer, and the current bounded extension to the host engine. The first two are retired and their code is deliberately not distributed here. This article describes their mechanisms as historical design work, not as supported installation options or current performance claims. The current implementation and the measurements linked below are available in this repository.

## Separate the quantities before changing them

A conversation has an event log, a projected message list, a request assembled for a provider, and a provider's own token accounting. These are related views, not interchangeable totals. A successful compression tool receipt may say that a range was covered while a later request still contains equivalent text elsewhere. A request object inspected before SDK serialization may differ from the actual outgoing body. A character heuristic may disagree with reported input usage, especially for images or non-English text.

The resulting discipline is to name the measured boundary. Use complete outgoing bodies to establish what was sent, structured events to establish who authored a message, and reported usage only when its fields are present and understood. A missing number is unknown rather than zero. A content estimate is not a bill, and a smaller serialized request does not by itself prove that a prefix cache was preserved.

## Generation one: tune the existing machinery

The first implementation kept the host's basic compaction model but changed policy around it. Model-specific policies adjusted when compaction began. A separate summary-model selection path could choose another available model to write the checkpoint. A relevance filter could remove or shorten less useful material before that summary request.

The filter had to preserve roles and tool-call/result pairing. Earlier experiments representing mixed history as a single user-authored transcript exposed the danger of changing provenance: an assistant response inside a user message is no longer the same input. The later filtering path therefore supplied fewer original structured messages to the summary model, rather than installing a synthetic transcript as conversation history.

This generation also exposed an important economic tradeoff without establishing a universal winner. A smaller or differently priced summary model still has to read the conversation. Changing models or rewriting a prefix can lose reusable cache state. If selection or filtering fails, returning to the host path is safer than producing a malformed checkpoint. Cancellation must propagate instead of initiating another model attempt.

These are reasons to inspect the complete path, not evidence of a particular saving. The public release includes no private relevance-calibration data, historical provider bill, or reproduction environment for these retired policies. They are not used as numerical baselines in the benchmarks.

## Generation two: own the transformation and its evidence

The next design moved closer to provider request bodies. It could record requests without changing them, run a shadow conversion to check round-trip behavior, or apply compression. Keeping those modes separate made it possible to inspect a transformation before granting it the ability to alter a conversation.

The compression layer maintained numbered ranges, summaries, retrieval, and search. User-authored content and other protected material had to remain outside replaceable ranges. If a range crossed a protected user message, rejecting it was safer than moving its summary ahead of that message and changing the apparent order of question and answer. Old tool output could be represented by a retrieval pointer, but that made subsequent access an explicit operation.

Protocol conversion became part of the correctness surface. The implementation distinguished the host's original request, the transformed request, and the SDK-serialized transport body when capture was supported. Recording a transformed intermediate object could not certify the final bytes. Unsupported capture paths had to say which earlier boundary they actually observed.

A shadow round trip also showed why semantic equality is insufficient for cache-sensitive transformations. Rebuilding every unchanged message can alter field order or representation. The design restored original objects for unchanged material and rewrote only affected text where possible. This reduced unnecessary transformation; it did not prove that any particular provider would grant a cache hit.

Owning more of the request path required more lifecycle machinery. The custom layer and host compactor could not both rewrite the same conversation independently. A startup gate had to establish ownership before disabling the host path. Failure after that handoff required an explicit fallback state, with no claim that a merely restarted component had already restored safe compaction. Observation panels also needed to distinguish a confirmed replacement from an attempted compression or insufficient evidence.

The retained lesson is the measurement method: compare the actual downstream representation and disclose gaps. The cost is a broad maintenance surface across protocol mappings, adapters, state, retrieval, and UI. The present release chooses a narrower boundary. That is a scope decision; this article does not claim an accuracy or latency victory over the retired design.

## Generation three: extend host compaction in two places

DSH already supplies triggering, checkpoint storage, message replay, and its basic compaction engine. The current [plugin](../../dsh-compaction-bound/README.md) leaves those responsibilities with the host. It changes the recent-history retention setting and the recognized summary request. It does not change the model window, the trigger point, or the normal reply limit.

The [retention integration](../../dsh-compaction-bound/src/retain.ts) injects a default only where a compaction-engine row has not explicitly selected `retainTokens` or `retainRatio`. It preserves other row fields and follows the host registry's generation lifecycle. Removing the plugin removes only its own injection. Existing sessions can still refer to their old preset generation; changing a registry definition is not proof that a running session adopted it.

The summary integration uses `llm/stream` and checks both the compaction purpose and the stock instruction prefix. It replaces the recognized final instruction rather than rebuilding the conversation prefix. If the host contract is not recognized or the request cannot be modified, it warns and leaves the host request alone. The appendix is coupled to successful rewriting so the plugin does not partially adopt a different checkpoint contract.

The current instruction asks the model to maintain a bounded, structured summary. User messages follow a different path: they are collected from host provenance, not chosen or paraphrased by the model. Only the host's user source and the plugin's validated appendix in a host checkpoint contribute to that collection. A reminder, tool result, or assistant reply containing the same apparent markup is not proof of user authorship.

## Preserve exact words without an ever-growing appendix

Keeping every user message verbatim forever would eventually recreate the original size problem. The [bounding implementation](../../dsh-compaction-bound/src/summary.ts) keeps a contiguous newest suffix verbatim under a serialized-line budget. Older messages become index items with turn, time, length, and a short prefix. If those index lines exceed their separate budget, the oldest items merge into a turn range and count.

A single message too large for the verbatim allowance becomes an index item rather than a clipped quotation. JSON lines preserve text blocks, whitespace, quotation marks, and embedded end-tag strings without inventing delimiters inside user text. The cost is explicit: an indexed older message is no longer automatically visible to the model. Its full text remains in the session event log and requires a host history reader to inspect.

The optional `historyReaderHint` names that reader for a particular host. Its default uses generic wording because this plugin installs no reader. A configured sentence substitutes literal `{sessionId}` placeholders and retains the existing turn-range note. A hint is guidance, not validation that a named tool exists. An unavailable reader must be reported before exact wording is relied on.

## A target is not a hard maximum

The model-written summary and the deterministic appendix have separate limits. If a summary exceeds its target, the plugin requests one shortening attempt using the summary alone, without tools or conversation replay. It accepts that attempt only if it fits, retains required headings in order, and leaves the active-user-requirements section exactly unchanged. If validation fails, it keeps the original and records `over-kept`. Cutting the last characters would make the size smaller while potentially deleting the unresolved requirement.

The failed-summary path remains the host's path: cancellation, model failure, or exhausting the reply limit does not become a successful checkpoint merely because the plugin can attach text. The status records distinguish within-target, condensed, over-kept, and failed output. These records describe the hook's actual observation, not a guarantee of answer quality.

## Reproduce the numbers at the right boundary

Run the command in [benchmarks/README.md](../../benchmarks/README.md). [results.json](../../benchmarks/results.json) records defaults read from the current schema and measurements made by importing the production bounding and rendering functions. No model is called. The fixtures include increasing history sizes, one oversized message, and escaped Unicode text. Each verifies both item budgets, representation of every original message, and parsing back to the bounded items.

The default recent-text retention estimate is 12,000 tokens under the host's four-character convention. The model-summary target is 12,000 UTF-16 code units; verbatim lines have 8,000 and index lines 2,000. Read these defaults from `compaction.defaults` rather than treating them as universal model parameters. The measured extended fixture has 10,000 messages but its rendered appendix is only 10,645 UTF-16 code units, including the generic reader notes and tags. The report separately counts full items, index items, and messages represented by ranges.

The combined illustrative text target adds the retained-tail estimate, summary target, and measured appendix, then divides by four. It is conditional: an oversized retained message, failed summary shortening, long custom reader hint, system instructions, tools, images, or provider encoding can exceed it. The benchmark is therefore a reproducible text-budget calculation, not a ceiling on real model tokens or a replay of historical provider savings.

The [real-host chain tests](../../dsh-compaction-bound/test/host-chain.test.ts) cover repeated compaction and reading original indexed turns from the log using host storage and runtime components with a synthetic model adapter. The [format and failure tests](../../dsh-compaction-bound/test/compaction-bound.test.ts) cover provenance, escaping, malformed output, retention ownership, and the reader hint. They establish specific contracts; they do not test a real provider's summarization quality.

Across the three generations, the lasting design choice is to keep transformation, provenance, and evidence separately inspectable. The current implementation is smaller in responsibility because it reuses host compaction, while retaining a deterministic route back to exact user wording. That route has to be available and actually read when needed; a pointer in a checkpoint is only the beginning of that verification.