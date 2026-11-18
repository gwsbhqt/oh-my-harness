# dsh-session-ui

Four small improvements to the DSH session UI, merged into one plugin with one loader entry and one settings namespace `session-ui`. Each of the four switches can be turned off on its own.

| Switch | What it does |
| --- | --- |
| `hideFinished` | The header "jobs" and "subagents" buttons only show what is still running; when everything finished the button disappears (kept while the team board has content). |
| `pathMention` | A path written in backticks in an assistant reply that really exists on this machine becomes a clickable mention: files preview in the sidebar, directories open in the system; right-click opens with an app; can be dragged into the composer. |
| `runStatus` | A line above the composer says exactly what "thinking" is stuck on and for how long; a stats card below the composer replaces the built-in one with more accurate session statistics; the expanded card shows Magpie output speed, DSH speed including waits, and request timing. |
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
| `magpieBaseUrl` | `''` | Magpie gateway for routing speed and segmented timing. An empty setting uses a locally installed Magpie |
| `magpieKeyRef` | `''` | Credential reference name of the gateway key (not the key itself) |

Gateway selection: if a local Magpie is installed (a `magpie` on PATH), use the local address and local key; otherwise use the explicitly configured remote address and reference; with neither, the card displays DSH’s own statistics. No gateway address or key is hard-coded; both come from configuration.

## Reading the speed figures

- **Magpie average output** matches the unfiltered live Routing page. The gateway keeps up to 60 recent requests across all sessions. Within that window, the card divides this session’s total measurable output by its total measured generation time. In-flight and failed routes count toward the request count. Retries within a route count once.
- Timing starts at the first observed output or reasoning signal. When the reasoning start is unknown, only an answer with a timed first text can be measured. A buffered reply may show a `≥` lower bound or no rate. The card shows how many requests contribute to the average and the most recent individual results.
- **Speed including waits** uses DSH’s step start and completed reply times. It includes preparation, waiting and reasoning. The pill shows the latest turn. The expanded card adds the session average since the last model change and the median wait for content. These figures come from session history and remain available when a session leaves the gateway window or the gateway is offline.

## How it works

See the Chinese [README.md](README.md) for detail. In short: `hideFinished` shadows the host header buttons with filtered wrappers; `pathMention` resolves existing files through authenticated host routes and uses the host application chooser to open directories; `runStatus` listens only to public host events and hook timing, exposes a read-only state route and a `runStatusTotals` session projection; `copySessionId` adds a header button whose machine name comes from its own `/api/session-ui.machine` route.

## Development

```sh
pnpm install
pnpm run check   # typecheck + build (host and client) + test
```

Test fixtures are synthetic or fictional, with no real session ids, paths, logs or private endpoints.

## License

MIT
