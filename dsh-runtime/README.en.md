[中文](README.md) | English

# dsh-runtime

[← oh-my-harness](../README.en.md#components)

**In short:** A host hook that takes effect at DSH startup — it fills in the login shell environment, and on save writes through symlinks and normalizes the patch layer's YAML style. No UI, no configuration.

## What it does

1. **Login environment.** When DSH is launched from Dock, a script, or another program, the environment it inherits differs. This plugin runs the account's login shell once with `-l -c 'env -0'` and merges the result into the host process, and lets the host's launch snapshot (used to read keys and find external apps) prefer it. The host network proxy is reinstalled from the login shell's proxy variables.
2. **Write-through + normalization.** dotfiles manages per-machine credentials and profile patch layers with symlinks (`.credentials.yaml -> .credentials.main.yaml`). DSH saves by writing a temp file then renaming it over the target; when the target is a symlink, the link itself is replaced. This plugin redirects such a rename to the file the link finally names, and normalizes `cordis.patch.*.yml` (quotes, inline-array spacing, `\U` emoji escapes) before writing, so purely cosmetic differences are not shown as changes in the GUI.

## Requirements and installation

Requires a compatible DeepSeek Harness (DSH), Node.js `^22.19.0 || >=24.0.0`, and pnpm. Keep the shared `tooling/` directory alongside this plugin; this source directory is not a standalone build project. From this plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Merge a linked dependency and bundle into your DSH profile's package manifest (replace the example path with one relative to your profile):

```json
{
  "dependencies": {
    "dsh-runtime": "link:../../path/to/oh-my-harness/dsh-runtime"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-runtime"]
    }
  }
}
```

The bundle already registers its entry; do not insert a duplicate. Install the profile's dependencies with the pnpm version DSH supports, validate the profile, then restart DSH.

## Behavior and relationship to DSH

- The login environment is read once at plugin load; on failure it logs one warning and leaves the launcher environment as is. `DSH_*`, `ELECTRON_*`, and the probe shell's own session variables are untouched.
- Write-through only handles `node:fs/promises` `rename`; sync and callback variants are not changed. Multi-level links are resolved to the end; a missing target file is created. If the temp file and target are on different disks, it copies next to the target first.
- Normalization only applies to `cordis.patch.*.yml`. **The rules are maintained only here; no git filter shares them.**
- **Known trade-off:** there is no commit-time fallback. Only DSH saves that go through this plugin's `rename` wrapper are normalized; saves before the plugin loads, and files edited and committed by hand, are not processed.

## Configuration

The bundle entry ID is `runtime`. There are **no runtime configuration fields**. Disable it:

```yaml
- id: runtime
  disabled: true
```

Code changes require rebuilding and restarting DSH. Reopening a page alone does not reload the host plugin.

## Development and verification

```sh
pnpm run check      # typecheck + build + tests
```

Tests cover login-environment parsing and snapshot takeover, proxy-source precedence; write-through across the two temp-file naming schemes, multi-level and dangling links, cycles, and unload restoration; normalization of the original samples, idempotence, and preservation of block scalars and comments.

## License

MIT. See [LICENSE](LICENSE).
