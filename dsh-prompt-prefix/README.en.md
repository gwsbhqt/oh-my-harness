# dsh-prompt-prefix

Moves the three injections that never change within a session (workspace instructions, skill catalog, memory profile) to the end of the system prompt, pinning stable content there for cache reuse; whether it hits depends on the model service and an identical prefix.

## What it does

- In `agent/pre-step` (`prepend`, outside the official plugin) it captures the three messages the official layer generates for this step, pins their text to the session, and appends them to the segments produced by `system-prompt/assemble`. On later steps it dedupes: a workspace-instructions baseline identical to the pinned text is replaced by a one-line pointer, and identical skill catalogs / memory profiles are dropped.
- When the skill catalog changes it replaces the old catalog in the system prompt and persists it; workspace-instruction changes pass through as usual.
- The `<available-memories>` path list inside the memory profile is unstable, so it is not put in the cached segment (models find memories with the OpenViking search tools).
- Pinned content is stored per session under `$DSH_HOME/plugins/prompt-prefix/sessions/<hashed session id>.json`; files not read for 30 days are cleaned at startup.

## Install

Point the profile `dependencies` `link:` here and add `dsh-prompt-prefix` to `dsh.profile.bundles`. The plugin ships its own patch layer inserting one `id: prompt-prefix`; do not add a second insert. No configuration.

## Dependencies and degradation

- Works with no external service dependency; the main benefit is pinning stable content to the end of the system prompt for cross-session cache reuse (a hit depends on the model service and an identical prefix).
- **The memory-profile enhancement depends on a local `profileMessage(... {consume:true})` patch of the OpenViking memory plugin.** If the memory plugin is absent or lacks that patch, the memory-profile part passes through unchanged (the memory plugin emits it or not on its own); the rest (pinning workspace instructions and the skill catalog) is unaffected — only moving the profile to the end is skipped.

## Verify

`pnpm run check` (typecheck + build + test, with real cordis waterfall events).

## Upgrade notes

Depends on host `agent/pre-step`, `system-prompt/assemble` details (workspace-instructions `source.baseline`, skill catalog `source.kind`, memory profile `source.kind`, fork inherited segment). Check these after a DSH or memory-plugin upgrade; if unrecognized it passes content through and never drops it.
