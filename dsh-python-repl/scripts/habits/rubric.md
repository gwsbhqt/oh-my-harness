# Labeling rubric (give this, verbatim, to each labeler)

Used for every calibration batch so labels stay comparable across rounds.
`{batch}` / `{labels}` are the files `label.py` printed.

## Function note (`stratified-*`, `census-*`)

You are labeling data to calibrate a "repeated code" detector for an AI agent that works in a persistent Python kernel (variables and functions survive across cells). When the agent writes code of the same SHAPE again (same structure, only literal values / local variable names differ), the detector may append a note to the cell output telling the agent: "this code shape ran before — make it a function now (it persists in the kernel) and call it from here on".

Read `{batch}`. Each item has an id, how many times that shape ran in the session in total, and its first and second occurrence (source excerpts).

For EVERY item answer: would that note have been a GOOD nudge?

label "yes" when the repeated part is real work logic — parsing/extracting/filtering results, checking conditions, a loop, a fixed multi-step procedure (run → parse → check; find → slice → print; sleep → poll → test) — so a small function taking the differing values as parameters would make later cells shorter or less error-prone. A higher total count makes "yes" more justified.

label "no" when:
- the resemblance is only a wrapper and the substance is the differing content (different edit texts, different scripts/commands/queries, different data literals);
- it is trivial (print a value, one simple call, an import, an assignment of a constant, a one-line attribute read) so a function saves nothing;
- it is a deliberate re-run of the same check once or twice (total 2) where nothing would be reused;
- the code is already calling a helper function (that IS reuse).

Write `{labels}` — one JSON object per line, one line per item, in file order:
`{"id": "<id>", "label": "yes"|"no", "confidence": "high"|"low", "reason": "<= 12 words"}`
Judge each item on its own; do not look at other files. Label every item and check the line count.

## Edit note (`edit-*`)

The kernel has an `edit` tool that replaces literal text in an existing file (`old_string` → `new_string`, exactly-once by default) and accepts several changes in one call: `await edit({"file_path": p, "edits": [{"old_string": a, "new_string": b}, ...]})`. The host enforces a file policy through it (the file must have been read first; stale writes are refused).

When the agent does the same by hand — read a file's text, `.replace(old, new)`, write it back — a second time, the detector says: "Hand-rolled file edit … Use the edit tool instead".

Read `{batch}`. For EVERY item: was that advice appropriate?
- "yes": this is editing existing file content by literal replacement, which the edit tool can do (even many replacements).
- "no": the edit tool would not fit — it rewrites/generates the whole file from computed content, replaces by regex or computed patterns, edits a binary/generated temp file where the policy adds nothing, writes a different file than it read, or the "replace" is not a file edit at all.

Write `{labels}` in the same JSON-lines format.
