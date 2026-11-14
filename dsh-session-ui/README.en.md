# dsh-session-ui

Four small improvements to the DSH session UI, merged into one plugin with one loader entry and one settings namespace `session-ui`. Each of the four switches can be turned off on its own.

| Switch | What it does |
| --- | --- |
| `hideFinished` | The header "jobs" and "subagents" buttons only show what is still running; when everything finished the button disappears (kept while the team board has content). |
| `pathMention` | A path written in backticks in an assistant reply that really exists on this machine becomes a clickable mention: files preview in the sidebar, directories open in the system; right-click opens with an app; can be dragged into the composer. |
| `runStatus` | A line above the composer says exactly what "thinking" is stuck on and for how long; a stats card below the composer replaces the built-in one with more accurate session statistics; requests through magpie also show segmented timing. |
| `copySessionId` | A "copy session id" button in the header copies the bare session id; on the web it appends `#machine`. Pasting into the composer turns it into a reference chip via dsh-composer. |

All four default to on. Turning one off registers no slot, route or event listener for it.

## Install

Point the profile `dependencies` at this directory with `link:`, and add `dsh-session-ui` to `dsh.profile.bundles`.
Do not hand-write an `insert` with the same id in the profile `cordis.patch.yml` — the bundled patch layer already inserts `id: session-ui`; a duplicate fails with `duplicate loader entry id`.
To turn one feature off, write an override line with only the id (no `name`):

```yaml
- id: session-ui
  config:
    runStatus: false
```

## Configuration

Both the entry id and the settings namespace are `session-ui`. All six fields are volatile:

| Key | Default | Meaning |
| --- | --- | --- |
| `hideFinished` | `true` | Header shows only running jobs and subagents |
| `pathMention` | `true` | Existing paths in replies are clickable, right-click openable, draggable |
| `runStatus` | `true` | Status line above and stats card below the composer |
| `copySessionId` | `true` | Copy-session-id button in the header |
| `magpieBaseUrl` | `''` | Magpie gateway for segmented timing. Empty: use local `127.0.0.1:3425` if Magpie is installed, otherwise hide that section |
| `magpieKeyRef` | `''` | Credential reference name of the gateway key (not the key itself) |

Gateway selection: if a local Magpie is installed (a `magpie` on PATH), use the local address and local key; otherwise use the explicitly configured remote address and reference; if neither, segmented timing is not read and the rest works as usual. No gateway address or key is hard-coded; both come from configuration.

## How it works

See the Chinese [README.md](README.md) for detail. In short: `hideFinished` shadows the host header buttons with filtered wrappers; `pathMention` adds three same-origin host routes plus a reply-layer client wrapper; `runStatus` listens only to public host events and hook timing, exposes a read-only state route and a `runStatusTotals` session projection; `copySessionId` adds a header button whose machine name comes from its own `/api/session-ui.machine` route.

## Development

```sh
pnpm install
pnpm run check   # typecheck + build (host and client) + test
```

Test fixtures are synthetic or fictional, with no real session ids, paths, logs or private endpoints.

## License

MIT
