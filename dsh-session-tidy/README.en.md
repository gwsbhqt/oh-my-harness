# dsh-session-tidy

Adds a "Tidy this workspace" item to the workspace "…" menu: one click archives the workspace's useless one-off/test sessions in bulk. Archiving is reversible.

## What it does

- The menu item sits above "Delete workspace" (order 250). Clicking runs in the background with no overlay; when done a top banner says "Archived N" (or "nothing to archive"); failures also show a banner. Archiving is reversible.
- The judgement is delegated to an external model (Jev): each candidate session is sent its title, creation time, idle days and first user message (truncated), and asked "is this a one-off test/temp/debug session". High probability means archive; two extra questions reinforce it.
- Only sessions that are not running, not open, not subagents, not pinned and not archived are touched. Nothing is deleted.
- The same action is exposed as the agent tool `tidy_workspace_sessions`.

## Install

Point the profile `dependencies` `link:` at this directory and add `dsh-session-tidy` to `dsh.profile.bundles`. The plugin ships its own patch layer inserting one `id: session-tidy` entry; do not write a second insert. Entry id and settings namespace are both `session-tidy`.

## Configuration

All three are volatile (take effect immediately, no restart):

| Key | Default | Description |
|---|---|---|
| `apiKeyRef` | `TYPESAFE_API_KEY` | Credential reference name for the key, not the key itself |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | Full request endpoint (including `/systemone`) |
| `model` | `jev-latest` | Model name |

Defaults target the generic Typesafe gateway. To use another gateway (for example a self-hosted Magpie), override the three fields on an id-only profile row; the code stays the same.

## Dependencies and degradation

- Loads with no external service: without a key it falls back to pure rules (title template + no user message for over 3 days). A failed or timed-out call keeps that session; it never archives because the model failed.
- With a key but the model service unavailable, or a call failed/timed out, that session is kept; only when no key is configured (empty apiKeyRef) does it fall back to pure rules. Neither affects loading or other features.

## Verify

`pnpm run check` (typecheck + build + test). In the real UI: the menu shows "Tidy this workspace", clicking runs silently and the toast reports the count, archiving is reversible; running/pinned/current/archived sessions are untouched.

## Upgrade notes

Depends on host internals `workspaceRegistry`, `sessionQuery`, `ctx.contextMenus`, `credentials.resolve`; re-run check and click through after a DSH upgrade.
