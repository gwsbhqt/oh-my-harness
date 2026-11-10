# dsh-history-cap

Limit the number of history records sent to the DSH interface in a single response, so a turn with many tool events does not produce one enormous initial page. This improves history delivery; it does not trim model context or reduce model token usage.

## Requirements and installation

Requires a compatible DeepSeek Harness (DSH) installation with the session controller history service, Node.js `^22.19.0 || >=24.0.0`, and pnpm. The package manifest records the tested host dependencies; the current tests use DSH 0.2.2-rc.1. Keep the shared `tooling/` directory alongside this plugin in the containing repository. This source directory is not a standalone build project.

From this plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Merge a linked dependency and bundle into your DSH profile's package manifest:

```json
{
  "dependencies": {
    "dsh-history-cap": "link:../../path/to/oh-my-harness/dsh-history-cap"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-history-cap"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by DSH, validate the profile if a startup checker is available, and restart DSH. The bundle registers its entry; do not insert a duplicate entry.

## Behavior and relationship to DSH

DSH's history service can return a whole turn as one page. This plugin wraps the existing controller's `page`, `events`, and `follow` methods. If a response contains more than 1000 records, it returns the newest 1000 and sets `hasMore: true`. The interface's existing **Load earlier** action can retrieve earlier records. Only the first snapshot of a follow stream is capped; later live updates pass through unchanged.

The plugin does not modify session files, filter event types, or remove stored history. It does not change the agent's model request. Unloading restores inherited controller methods when this plugin still owns the wrapper.

The wrapper relies on host controller methods and their inherited implementation. A host update can change that contract; run the tests against the new host before deployment. Remove this plugin when DSH provides an equivalent raw-record page limit itself.

## Configuration

The bundle entry ID is `history-cap`. There are **no runtime configuration fields**. The limit is the source constant `DEFAULT_MAX_HISTORY_RECORDS = 1000`. Helper function parameters used by tests are not profile settings.

Disable the entry in your profile patch:

```yaml
- id: history-cap
  disabled: true
```

Code changes require rebuilding and restarting DSH. Reopening a page alone does not reload the host plugin.

## Development and verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

The synthetic large-history test creates 24000 records in one turn and checks opening the history, continuous backwards pagination without gaps, cancellation of the original stream, live update pass-through, and unload restoration. The tests resolve methods the same way as the host gateway. They do not constitute a GUI performance measurement; after deployment, verify switching between a normal and a large session and loading earlier history in the actual interface.

## License

MIT. See [LICENSE](LICENSE).
