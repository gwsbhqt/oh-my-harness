[中文](getting-started.md) | English

# Start with one plugin

[← Documentation](README.en.md) · [All components](components.en.md)

After installing the Antigravity workbench, open a new desktop conversation. In the first cell, define `samples = [3, 5, 8]` and run `len(samples)`. In the second, run only `sum(samples)`. Expand both `run_code` calls in that conversation. Both should have `status="ok"`, with results `3` and `16`. [Install the Antigravity workbench](../agy-python-repl/README.md#install)

On first launch, uv prepares Python and the locked dependencies for the current OS user. On a new machine or with an empty cache, go online and run the two cells above until you see `3` and `16`. If the plugin is listed as enabled but the startup log reports missing Python or a package, restore download access and retry on the same machine as the same user.

Once prepared, the local tool can restart with uv in offline mode (`UV_OFFLINE=1`). This setting controls dependency downloads. Desktop conversations using a cloud model still need a connection to the model service.

To try an independent CLI, make a contact sheet from two of your own images. [Standalone image examples](../skills/shot-sheet/README.en.md#common-operations)

The steps below install persistent Python in DSH.

## 1. Prepare the environment

Follow the [Python plugin requirements](../dsh-python-repl/README.en.md#requirements-and-supported-platforms) for macOS, DSH, Node.js, pnpm, and uv. Use a model with tool calling. uv can manage the interpreter and kernel dependencies; the first launch may download them.

Read the [trust boundaries](../SECURITY.en.md). This bundle replaces DSH's TypeScript execution backend with Python and disables workflow entries that depend on the original backend. It runs trusted code without an operating-system sandbox.

## 2. Clone and check

Keep the full repository. Plugin builds need the adjacent `tooling/`; remote operation skills need `skills/_shared/`.

```sh
git clone https://github.com/gwsbhqt/oh-my-harness.git
cd oh-my-harness
REV="$(git rev-parse HEAD)"  # Pin this checkout; replace it with a saved full commit to reproduce that version
git checkout --detach "$REV"
printf 'source commit: %s\n' "$REV"
pnpm run check:public
pnpm --dir dsh-python-repl install --frozen-lockfile
pnpm --dir dsh-python-repl run check
```

The public check needs only Node.js and Git and checks documentation and repository contracts. The plugin check runs type checking, builds, and tests in the component's development environment. Passing these checks does not install the plugin into DSH.

GitHub Source code is only a source snapshot: it contains neither DSH's built `lib/` nor an installable AGY directory, and DSH builds also need `.git`. Keep the full commit above; neither a moving `main` nor a component version uniquely identifies an artifact. See the [maintenance guide](maintenance.en.md) for built artifacts, verification, platform installation, and rollback.

## 3. Link it into your DSH profile

DSH calls a configuration set a profile. **Merge** the link dependency and bundle registration into its package manifest, preserving existing entries. Adjust the relative path from that profile directory to your source checkout:

```json
{
  "dependencies": {
    "dsh-python-repl": "link:../../src/oh-my-harness/dsh-python-repl"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-python-repl"] }
  }
}
```

In that profile directory, install dependencies with the pnpm supplied by your DSH installation. Run DSH's startup check, restart the app, and open a new session. The bundle already registers its loader entry; do not add a second insert. See the [component installation guide](../dsh-python-repl/README.en.md#install-from-this-repository) for configuration and removal.

## 4. Verify that a variable survives

Ask the agent in the new session to run two cells:

> In the first cell, create `samples = [3, 5, 8]` and return only its length. In the second, calculate `sum(samples)` without assigning it again. Report both results.

The results should be `3` and `16`. This verifies variable reuse in the current session. It does not verify restart recovery, external service permissions, or real business outcomes.

For a larger example, run the [fictional log measurement](../benchmarks/README.en.md) or read the [persistent kernel guide](dsh-python-repl.en.md).

## Add the next capability

| What you want next | Installation entry |
| --- | --- |
| Control a running DSH from another agent, dispatch work, and await results | [dsh-use](../dsh-use/README.en.md#install) |
| Operate a web page or desktop app | [browser-use](../skills/browser-use/README.en.md) · [computer-use](../skills/computer-use/README.en.md) |
| Work on another machine | [remote-host](../skills/remote-host/README.en.md) |
| Improve long conversations, background events, or the interface | [Choose by problem](components.en.md) |

Adding a Python skill to a trusted directory executes its code when imported. See [using dotfiles](dotfiles.en.md) for directory layout, symlinks, and personal configuration.

## If something fails

- **Build failure:** keep the complete exit status and error; check the component's environment requirements.
- **No new capability in DSH:** check the active profile's link, bundle registration, and actual restart. Edited source does not replace a loaded module.
- **Variable missing in the next cell:** check the session, kernel reset state, and any restore-loss report.
- **Uncertain external action:** inspect the original target and receipt before sending or clicking again.

Use fictional reproductions in public issues. Report account data, real logs, or security findings [privately](../SECURITY.en.md).
