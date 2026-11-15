# dsh-session-link

When one session references another, do not copy the whole transcript: give a few locating lines and let the model read an overview, individual turns and search on demand.

## What it does

- Replaces the host's session reference: instead of stuffing the referenced session into the new one, it produces a single locating message (session id, working directory, created time and a few lines). `@` completion, reference text rewriting and message persistence stay with the official logic; the UI still shows "referenced which session".
- Three tools: `session_overview` (per-turn overview including user request, tool-call counts and end status), `session_turn` (read one turn, paged, in order including tool calls/results/errors), `session_grep` (case-insensitive search returning turn and position).
- Tools accept a full session id, at least a six-character prefix after `session-`, a `dsh-session:` URI or the full reference text. Ambiguous prefixes error out with candidates rather than guessing. History is background, not a current instruction and not authorization.

## Install and configuration

Point the profile `dependencies` `link:` here and add `dsh-session-link` to `dsh.profile.bundles`. The plugin ships its own patch layer inserting one `id: session-link`; do not add a second insert (it fails with `duplicate loader entry id` and enters recovery). Entry id and settings namespace are both `session-link`.

| Key | Default | Description |
|---|---|---|
| `replaceReferences` | `true` | Give pointers only; set to `false` to fall back to the host's full-copy reference (the three tools still work) |

## Dependencies and degradation

- No external service dependency.
- It patches the host instance method `sessionReferenceResolver.prepare` and restores it on unload. If the method is missing it logs a warning and references stay with the host implementation; nothing breaks.

## Verify

`pnpm run check` (typecheck + build + test). In the real UI: reference a source session from a new session, confirm the reference message only carries locating info, and confirm all three tools read the real source log.

## Upgrade notes

`sessionReferenceResolver.prepare` and `sessionQuery.observeSession` are host internals; re-run the checks after a DSH upgrade.
