# Bound output without confusing a preview with a result

“Output” crosses several boundaries in an agent system. A command produces bytes, a tool returns a structured result, a code cell displays a representation, and a model generates an answer or tool arguments. Each boundary can grow without bound, but cutting each one has different consequences. A shortened display may leave the original value intact. Stopping a model stream means the attempted reply failed. A bounded event history may mean old data is no longer available from the monitor at all.

This design uses separate mechanisms for those cases. `dsh-output-guard` protects model generation. `dsh-python-repl` controls cell displays and uses the host's spill storage. `dsh-monitor` delivers producer events. The monitor is independent of the output guard, not a required dependency. Treating all three as one truncation feature would conceal the most important question: where is the complete result now, if it exists?

## Start with the host's existing capabilities

DSH already provides tool result rendering, output truncation, background jobs, and spill storage. The Python plugin does not replace those general host services. It adds a cell-specific budget before a cell's output becomes the outer `run_code` result, and reuses the host's storage rather than introducing another file service. The [storage adapter](../../dsh-python-repl/src/index.ts) passes the session owner, tool call identity, complete displayed text, and a suggested filename to `spillStore.saveText`.

The model stream guard operates elsewhere. It wraps agent requests at `llm/stream` and participates in the host's request-error handling. Its [dependencies and registration](../../dsh-output-guard/src/index.ts) are the LLM and agent services. It neither truncates tool result datasets nor stores their complete contents. Meanwhile, the monitor composes host jobs, subprocess execution, and session delivery. These boundaries allow each plugin to be used for its own purpose.

| Boundary | Extra behavior | Meaning of a shortened or stopped output |
| --- | --- | --- |
| Python cell display | Estimated budget and retrievable spill text | The displayed text is shortened; a retained Python value can still be larger. |
| Agent model stream | Runaway detection and bounded corrective retry | The attempt failed; its partial output is not a successful answer. |
| Command event stream | Line decoding, batching, delivery, and bounded history | Notices and retained lines have limits; source replay requires producer support. |

## Cell clipping saves the text before hiding it

The [cell budget implementation](../../dsh-python-repl/src/output-budget.ts) joins the cell's log entries and estimates their size. ASCII characters contribute a quarter token and other code points one token. This is a deterministic heuristic, not a provider tokenizer. The configurable default is 8,000 estimated tokens. When the text exceeds the budget, the implementation first saves the entire joined text. Only after a successful save does it return a prefix, a suffix, an omitted-character notice, and the retrieval location.

The retained text budget allocates two thirds to the beginning and one third to the end. This is a design choice that preserves setup and final diagnostics; the repository does not establish that this ratio is optimal for all tasks. The explanatory notice adds overhead beyond that allocation. If no storage service exists, or saving fails, the plugin leaves its output whole. The host may still apply its own downstream output policy. The plugin's guarantee is about its own decision: it does not intentionally hide text that it failed to save.

“Whole text” means the cell's complete display text at this boundary. It is not automatically the original dataset, a lossless serialization of an arbitrary Python object, or the missing portion of an upstream tool result. A retained variable, its printed representation, and a spill file are distinct artifacts. The [output-budget tests](../../dsh-python-repl/test/output-budget.test.ts) check that the save callback receives the complete joined text, both ends survive, Unicode code points are not split, and storage failure leaves the text unchanged. A real-cell case retains a 200,000-item list and checks its length in a later cell after the display was bounded.

This makes recovery concrete: read the saved text, or reduce the retained value in Python. Re-executing an operation merely to recover hidden output can duplicate side effects or return different data. Neither the clipping function nor the completeness helpers automatically replay it.

## Completeness belongs to the source result

A short preview is harmless only when callers preserve the evidence needed to assess the source. The [Python bridge](../../dsh-python-repl/python/dsh_kernel.py) keeps structured fields such as exit status, truncation flags, and spill locations in its readable result views. It also exposes deliberately narrow helpers.

`repl.require_complete` validates a foreground Bash stream. By default it requires successful exit, normal completion, and an explicit false truncation flag. Setting `check_exit=False` permits analysis of failed output, while still rejecting interruption and truncation. A job receipt is not a final result. A spill location is a retrieval hint, not a promise of a durable, complete-output API.

File reads have a different limit. `repl.read_window` checks contiguous line numbers and known truncation markers and supplies the next offset. It explicitly leaves byte completeness unknown. Reaching the last reported line does not certify that every byte of every line was delivered. The [result-safety tests](../../dsh-python-repl/test/result-safety.test.ts) and [Python safety tests](../../dsh-python-repl/test/python/test_result_safety.py) encode this refusal to overclaim. Similarly, paging and unreadable search paths must be resolved before counting matches as a complete population. A presentation limit cannot fix incomplete retrieval.

## Stop an invalid model attempt instead of clipping it into success

A model can repeat text indefinitely, emit long blank runs, produce an oversized tool argument block, or finish without an answer. A host output cap alone does not distinguish those cases from useful work. The [stream guard](../../dsh-output-guard/src/guard.ts) checks chunks while generation proceeds and emits a failure when a configured boundary is crossed. Returning from the async iteration closes the upstream iterator; the triggering fragment is not forwarded as useful output. The [stream tests](../../dsh-output-guard/test/guard.test.ts) check upstream closure, fragmented input, normal pass-through, and the retry limit.

The [detector](../../dsh-output-guard/src/detector.ts) normalizes whitespace and common Markdown emphasis characters for repetition comparison. Defaults examine a recent 1,000-character window, looking for cycles of 4–160 normalized characters, at least 8 repeats, and at least 64 characters covered by the repeated segment. Units without letters are excluded to avoid treating numeric or punctuation structures as language loops. These are code parameters, not measured detection rates.

Tool arguments are exempt from repetition detection because ordinary code can repeat legitimately. They still have blank-run protection and a per-call length limit. Defaults stop a blank run at 2,000 characters and stop tool arguments above 50,000 characters. The blank detector also handles JSON whitespace escapes across chunks. Counters belong to individual blocks or calls rather than an undifferentiated transcript.

With automatic retry enabled, the [agent hook](../../dsh-output-guard/src/index.ts) adds a corrective notice and retries at most once for the same agent, turn, and step. It does not reinsert the runaway text, switch models, or modify permanent instructions. Another failure returns to host error handling. The [Session test](../../dsh-output-guard/test/session.test.ts) uses a real DSH Session to show that a failed attempt is absent from derived conversation history while the corrective notice reaches retry history. This is a conversation-state test, not a live-provider reliability result. Plausible but incorrect answers, semantic loops with changing wording, and repetitive legitimate prose remain limitations of this heuristic.

## Producer events need their own contract

The [monitor implementation](../../dsh-monitor/src/index.ts) reads stdout and stderr separately. UTF-8 decoding preserves characters split across subprocess chunks. Stdout lines enter a delivery queue; stderr becomes diagnostic history and a separate log. This prevents a diagnostic line from being mistaken for a producer event.

Defaults batch for 200 milliseconds, with 50 lines and a target 32,768-byte budget per notice. An overlong line keeps a prefix of at most 8,192 bytes plus an explicit truncation marker, and recent history retains 2,000 lines. Exact ignored stdout lines are excluded from automatic delivery but remain in bounded retained output. Crucially, line shortening happens before history and job output receive the line. Those stores cannot recover the original long line. The notice byte budget also permits the first line even if its size exceeds the target; it is not an absolute serialized-message ceiling.

Persistent monitors can be relaunched through a cooperating restart controller, but output during the interruption is unavailable unless the producer supports replay. The [monitor README](../../dsh-monitor/README.md) explicitly disclaims a durable event queue. A resumed process and a new job identity prove that listening resumed, not that every event was received. Applications needing complete event history must retain it at the producer and expose a cursor or another retrieval method.

## Measure each boundary separately

The shared [benchmark results](../../benchmarks/results.json) hold recorded measurements; this article does not invent compression ratios or billing savings. A reproducible display experiment should record input size, configured budget, full saved-text equality, retained-value equality, displayed bytes, and the estimator used. A stream-guard experiment should replay fixed chunks and record detection, upstream closure, retry count, and false positives on legitimate text. A monitor experiment should include split Unicode, overlong lines, history eviction, and restart gaps.

The cited tests were inspected rather than rerun during drafting. They provide reproducible contracts, with synthetic streams and local integration fixtures clearly separated from real provider or durable-source guarantees. The useful result is a system that can say what was shortened, what was stopped, what remains recoverable, and what the available evidence cannot establish.