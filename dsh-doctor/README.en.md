[中文](README.md) | English

# dsh-doctor

Startup pre-checks. The CLI and the host tool share a core that depends only on Node built-in modules.

```sh
cd dsh-doctor
pnpm run check
node bin/doctor.mjs --json --sanitize-env
node bin/doctor.mjs --full --json --sanitize-env
```

Options: `--home`, `--profile`, `--app`, `--json`, `--repair-credentials`, `--full`, `--timeout-ms`, `--sanitize-env`. It checks `desktop` by default; total budget 120000ms by default, with up to 3 extra seconds for cleanup. Exit 0 means checks passed, 1 means a check failed, 2 means a CLI argument error. Unverified items are listed separately and do not count as passes.

## Host entry

- Tool `doctor`, camelCase arguments.
- Read-only typert interface `doctor/getReport`, request `{ "options": { "profile": "desktop" } }`, returns the Report directly (no envelope).
- Report: `{ok, checks: [{id, ok, message, fix?}], unverified, ...}`.
- The host entry clears `ELECTRON_RUN_AS_NODE` contamination; credential repair is never on by default. Only an explicit CLI `--repair-credentials` rewrites real credential permissions to exactly `0600` without changing content.

## Safety and verification boundaries

By default it uses the real App version, composer, compatibility decision, and CLI. Config is copied into a short-path temporary DSH_HOME; dependencies are linked read-only per package; all writes are confined to the temp directory; network defaults to localhost only. It checks that all enabled host plugins become active, not just that the App's core startup passes. A profile with doctor mounted also calls doctor/getReport through the real typertGateway to check the remote binding and return shape; the probe uses a nonexistent App path to end early and does not recurse into startup trials. A plugin whose apply throws or whose required services are missing must fail. Temporary copies and subprocesses are cleaned up at the end.

The real desktop shell does not apply to the CLI; the isolated startup disables the desktop window, keeps the other host plugins, and lets the existing web service use a random local port without opening a browser. Client checks only verify files and the packaging shell; they do not execute the factory, and do not prove React, apply, connection, or page rendering. Verify in a real GUI.

The store check validates `~/Library/pnpm/store/<App store version>` per this repository's macOS convention; it is **not** a full dynamic computation of arbitrary user configuration. A legitimate but non-conforming override still fails. Paths are compared as strings, not realpath. A global storeDir override is not allowed; the terminal environment is compared by the PNPM_HOME, XDG_DATA_HOME precedence.

`--full` alone checks the App pnpm frozen lockfile and minimum-release-age policy online, and sends one real default-model request. It keeps custom bundles, models, proxy, and compliance settings; only the web/desktop interaction shell is replaced by the official headless runner. Only a real answer in official JSON `final` and a successful exit count as a pass; echo of the prompt does not. It does not switch models, disable compliance guards, or relax minimumReleaseAge automatically. A real policy rejection means the full check failed; the default offline pass cannot replace it.

String values in credentials and subscription settings are used to redact output; file contents are not printed. Evidence keeps only the redacted Report, not raw credentials or plugin logs.

## Related

The build/contract utilities come from the shared `tooling/` directory next to this plugin. Keep it alongside; this source directory is not a standalone build project.

## License

MIT. See [LICENSE](LICENSE).
