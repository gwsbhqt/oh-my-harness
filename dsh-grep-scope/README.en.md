# dsh-grep-scope

Adds an "all" scope to the model's file search: include hidden and ignored files when needed (VCS metadata still excluded).

## What it does

- Does not modify the host package; instead it registers same-named `grep`/`glob` in each Agent's own tool layer, shadowing the official versions.
- `grep` gains an optional `scope`: `normal` (default, honors ignore rules, does not auto-search hidden dirs) and `all` (includes hidden and ignored paths, excluding `.git`/`.hg`/`.svn`/`.jj` metadata).
- Dependency and cache directories (`node_modules`, `.venv`, `site-packages`, `__pycache__`, etc.) are skipped by default; they are searched only when the path or pattern names one of them.
- When output is too large it stops at 10 MB and marks `outputCapped`; long lines are cut to 2000 bytes and marked `clippedLines`.
- `glob` also reaches into `app.asar`: it extracts a read-only copy and searches it, and gives a readable copy path for packed paths the host `read` cannot open.

## Install and configuration

Point the profile `dependencies` `link:` here and add `dsh-grep-scope` to `dsh.profile.bundles`. The plugin ships its own patch layer inserting one `id: grep-scope`; do not add a second insert.

## Dependencies and degradation

- No external service dependency; depends on host `dsh-tool-fs-search`, subprocess, ripgrep and the result-saving interface.
- The caller must judge coverage from the `scope` it passed; `matches: []` only means no match within that scope, not that the whole repository lacks it.

## Verify

`pnpm run check` (typecheck + build + test). In the real UI: in a dedicated fixture workspace search hidden/ignored files with `scope: all` and confirm coverage, and that "not found" never claims the whole repository has zero.

## Upgrade notes

The host `dsh-tool-fs-search` subprocess, output parsing, saving interface and preset sampling switches are internal contracts; re-run check and click through in a real session after a DSH upgrade.
