[中文](maintenance.md) | English

# Keeping the project maintainable

[← Documentation](README.en.md) · [Contributing](../CONTRIBUTING.en.md)

End each maintenance pass with a reproducible problem and an inspectable result. The home page helps people find an entry point; component docs help them use it; tests and design articles help the next contributor change it safely.

## Match checks to changes

| Change | Required verification |
| --- | --- |
| Docs, links, public metadata | `pnpm run check:public`; inspect rendered output for visual changes. |
| A DSH plugin | Its `pnpm run check`; add isolated startup and live UI acceptance when host loading changes. |
| A Python skill | Tests in its own development environment; verify entry points, packaging, and actual operations separately. |
| `tooling/` or `skills/_shared/` | Shared tests plus the consumers actually affected. |
| Measurements or measured source | `python3 benchmarks/run.py --check benchmarks/results.json`; explain changed inputs, estimates, and source hashes. |
| Demo media | Verify real actions, review extracted frames, and inspect identity information and metadata. Diagrams must not stand in for recordings. |

`check:public` runs before component dependencies are installed. It checks documentation links, release manifests, licensing, and explicit sensitive-content patterns. It does not replace human privacy review or establish that a website or desktop operation succeeded.

## Contribution priorities

These are contribution directions, not delivery-date commitments.

| Direction | What completion looks like |
| --- | --- |
| Reproduce the first installation | Install one plugin in a clean environment using the guide; record supported versions, failures, and acceptance results. |
| Make demos easier to update | Keep fictional input, recording steps, and outcome checks for each demo so another contributor can repeat it. |
| Add explicit compatibility evidence | Separate portable tests from live platform acceptance; expand support only from observed results. |
| Extract more reusable skills | Separate dependencies and permissions, preserve licensing, then build, test, and verify independently before migration. |
| Detect DSH upgrade changes earlier | Update contract tests from actual upstream interfaces; verify loading, cancellation, receipts, and recovery. |

Prioritize reproducible user failures and first-use blockers. Explain why the current layout is insufficient before changing it. A new service, abstraction, or dependency needs a concrete benefit.

## Build, verify, and roll back a pinned commit

A Source code ZIP is suitable for review, not a built artifact, and it lacks the `.git` entry required by the DSH build. The following steps were actually verified on macOS; other platforms are not verified in this guide. Run them from the root of a clean, full checkout. `REV` is a reproducible public example, not a promise that it is the latest stable version; maintainers can substitute another reviewed full commit.

```sh
set -eu
REV=57cfccb03b4f39121facc575a91bcff055d59fed
test -z "$(git status --porcelain)"
git checkout --detach "$REV"
test "$(git rev-parse HEAD)" = "$REV"
OUT="$(mktemp -d)"
pnpm --dir dsh-python-repl install --frozen-lockfile
uv python install 3.14
UV314="$(uv python find --managed-python 3.14)"
export PATH="$(dirname "$UV314"):$PATH"
python3 --version
pnpm --dir dsh-python-repl run check
pnpm --dir dsh-python-repl pack --pack-destination "$OUT"
AGY_DIR="$OUT/agy-python-repl"
sh agy-python-repl/scripts/bundle.sh "$AGY_DIR"
agy plugin validate "$AGY_DIR" --strict
git rev-parse HEAD > "$OUT/SOURCE_COMMIT"
set -- "$OUT"/*.tgz
test -f "$1"
tar -tzf "$1" package/lib/index.js package/lib/dsh-build.json package/vendor/PROVENANCE.md package/vendor/prime/LICENSE package/LICENSE
test -f "$AGY_DIR/_bundled/vendor/PROVENANCE.md"
test -f "$AGY_DIR/_bundled/vendor/prime/LICENSE"
test -f "$AGY_DIR/LICENSE"
test -x "$AGY_DIR/scripts/start_mcp.sh"
test -x "$AGY_DIR/skills/agy-use/scripts/agy-use"
(cd "$OUT" && shasum -a 256 ./*.tgz > DSH-SHA256SUMS)
(
AGY_UNSORTED=$(mktemp "$OUT/.AGY-SHA256SUMS.XXXXXX")
AGY_SORTED="$AGY_UNSORTED.sorted"
trap 'rm -f "$AGY_UNSORTED" "$AGY_SORTED"' EXIT
trap 'exit 1' HUP INT TERM
(cd "$AGY_DIR" && find . -type f -exec shasum -a 256 {} + > "$AGY_UNSORTED")
LC_ALL=C sort "$AGY_UNSORTED" > "$AGY_SORTED"
mv "$AGY_SORTED" "$OUT/AGY-SHA256SUMS"
)
```

If you also run AGY's Python tests on macOS, a long Unix socket path can fail with `AF_UNIX path too long`; keep the failure log and rerun with a shorter temporary `TMPDIR`.

The DSH artifact is the `.tgz`, which must contain `lib/index.js`, the build manifest, and the Prime provenance manifest. The AGY artifact is the standalone `$AGY_DIR` directory that passed strict validation. Keep `SOURCE_COMMIT`, both `SHA256SUMS`, and the artifacts together. A version in a filename cannot replace the commit and hashes. Hashes provide identity and integrity checks, not a signature.

If the delivery is a ZIP, extract it into a new empty directory, then change into the directory that actually contains `SOURCE_COMMIT`; do not overwrite an existing extraction and leave stale files behind. Set `REV` to the full commit declared by the maintainer; the example below reuses the commit above. DSH uses `shasum -c` to check the whole `.tgz`. For AGY, remove only one optional leading `./` from the filename after the checksum and mode separator in each `shasum` line on both sides, then sort and compare them independently. This accepts both formal filename spellings and complete legacy unsorted manifests. Confirm that both delivered commands are still executable:

```sh
set -e
OUT="$PWD"
AGY_DIR="$OUT/agy-python-repl"
REV=57cfccb03b4f39121facc575a91bcff055d59fed
test "$(cat "$OUT/SOURCE_COMMIT")" = "$REV"
(cd "$OUT" && shasum -a 256 -c DSH-SHA256SUMS)
test -x "$AGY_DIR/scripts/start_mcp.sh"
test -x "$AGY_DIR/skills/agy-use/scripts/agy-use"
(
AGY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/agy-verify.XXXXXX")
trap 'rm -rf "$AGY_TMP"' EXIT
trap 'exit 1' HUP INT TERM
AGY_NORMALIZE='s/^([0-9a-f]{64} [ *])\.\//\1/'
sed -E "$AGY_NORMALIZE" "$OUT/AGY-SHA256SUMS" > "$AGY_TMP/expected.unsorted"
LC_ALL=C sort "$AGY_TMP/expected.unsorted" > "$AGY_TMP/expected"
(cd "$AGY_DIR" && find . -type f -exec shasum -a 256 {} + > "$AGY_TMP/current.raw")
sed -E "$AGY_NORMALIZE" "$AGY_TMP/current.raw" > "$AGY_TMP/current.unsorted"
LC_ALL=C sort "$AGY_TMP/current.unsorted" > "$AGY_TMP/current"
diff -u "$AGY_TMP/expected" "$AGY_TMP/current"
)
```

These checks need neither network access nor source code. Generation and receipt both finish scanning before sorting, so a read, normalization, or sort failure returns non-zero. Generation writes temporary files in the output directory and renames the completed result into place, never leaving a partial official manifest or replacing an existing complete one after a failure. Receipt writes temporary files only in a newly created system temporary directory and removes them on exit, so the delivered directory can remain read-only. No other path cleanup or deduplication is performed. The single archive hash covers every file in the DSH package. For AGY, the manifest difference identifies changed content, extra regular files, and missing regular files. The AGY inventory does not check directory structure, symbolic links, or other file types, and the permission checks cover only the two commands above. Recipients no longer need another build just to detect extra files.

Use the existing platform installation paths. For DSH, replace the getting-started profile's `link:` dependency with an absolute `file:` path to the verified `.tgz`, preserve the bundle registration, then install with Harness's pnpm, run its startup check, and restart. For Antigravity, run `agy plugin validate "$AGY_DIR" --strict && agy plugin install "$AGY_DIR"`, then confirm with `agy plugin list --json`. Strict validation catches malformed tool or hook configuration before installation replaces the active copy. For temporary acceptance only, give the AGY commands a new empty `HOME`; first confirm that `plugin list --json` returns `[]`, and do not touch the daily app.

Host inputs are not interchangeable. DSH's `file:` must name the `.tgz` that passed `DSH-SHA256SUMS`, not `$AGY_DIR`; Antigravity must install the `$AGY_DIR` that passed the directory-inventory check above, not the `.tgz`. pnpm can successfully install a local directory as a dependency without producing a loadable DSH plugin, so an install command's zero exit status does not replace this host-input check.

Keep the previous verified artifact set and existing snapshots for rollback. For DSH, point `file:` back to the old `.tgz`, reinstall the profile dependencies, check, and restart. For AGY, roll back in place. Set `PREVIOUS_AGY_DIR` to the previous verified standalone directory and run `agy plugin validate "$PREVIOUS_AGY_DIR" --strict && agy plugin install "$PREVIOUS_AGY_DIR"`. Then use the path returned by `agy plugin list --json` as `AGY_INSTALLED` and run `diff -r "$PREVIOUS_AGY_DIR" "$AGY_INSTALLED"`; no output and exit status 0 establish that the content was restored. Do not rely on the unchanged version number. A DSH installation still using a source `link:` must check out the old commit and rerun the component checks; edited source alone does not prove that the running instance rolled back.

## Before a release

1. Review a focused diff. Keep Chinese and English entry points aligned, and run public examples without private configuration.
2. Complete relevant checks and report live acceptance separately from unverified behavior. Media and numbers need traceable sources.
3. Check the worktree, package contents, commit identity, and relevant history. Removing a sensitive value from the current file does not erase it from history.
4. Update the [changelog](../CHANGELOG.en.md) with observable changes, compatibility impact, and migration steps.
5. Review the actual release contents before tagging. A version heading or queued workflow does not establish a release.

Use [private reports](../SECURITY.en.md) for security findings. Keep private audit vocabulary and real findings outside the repository; commit only general prevention rules and fictional regression fixtures.
