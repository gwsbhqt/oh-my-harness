## Libraries a payload needs

Do not go hunting for an environment that happens to have the right package — ask for it.

```bash
remote-host run -i py -w pyyaml -w 'httpx,rich' <<'EOF'
import yaml, httpx
...
EOF
```

`--with` (`-w`, repeatable or comma-separated) routes a Python payload through
`uv run --no-project`, which builds an **ephemeral environment** on top of the host's
interpreter — measured at ~10ms once the wheel is cached. The host's `site-packages`
is not touched: after installing pyyaml this way, a plain `python3 -c "import yaml"`
on that box still raises `ModuleNotFoundError`. Package bodies live in `~/.cache/uv`.

**JavaScript needs nothing.** bun installs a missing `import` by itself, into
`~/.cache/bun`, leaving no `node_modules` behind; a later run resolves it offline.
`--with` on a non-Python payload is refused rather than silently ignored.

Shell payloads have no library concept. Installing a *command* is a different act —
it mutates the host (Homebrew, mise) and outlives the call — so `remote-host` will not do it
implicitly; run the install as an ordinary payload when that is really what you want.

A path as the interpreter is still the answer when the payload needs a specific
project's environment — its own code and config, not just a library.

`-i '~/proj/venv/bin/python'` runs in that virtualenv, imports and all; the same works for a repo-local node or a wrapper script. **Quote it** — an unquoted `~` is expanded by the local shell into the wrong home, and the failure reads as a missing interpreter. The same quoting applies to remote paths given to `put`, `get` and `-C`.

`js` prefers **bun** and drops to node when the host has no bun — bun is the more compatible runtime, so it wins when both are present. Name `bun` or `node` explicitly when a script needs one of them in particular.

```bash
remote-host run -i py <<'EOF'
import pathlib, json
print(json.dumps(sorted(p.name for p in pathlib.Path("/etc/mihomo").iterdir())))
EOF
```

`remote-host status` lists which of these the host actually has. A missing one fails fast with `remote-host: none of [bun node] found on this host` and exit 127 rather than a confusing shell error.

**Versions come from the host's own toolchain.** `remote-host` puts `~/.local/share/mise/shims` at the front of `PATH`, ahead of Homebrew and the system, so a payload gets the runtimes mise is configured to manage rather than whatever `/usr/bin` happens to hold. On the worker that is the difference between Python 3.14.7 and 3.11.2, and between bun 1.4.0 and no bun at all. A bare `ssh host 'bun …'` gets none of this — mise only activates in an interactive shell.

**bash is the default because payloads get written bash-shaped**, and `bash -l` is on every host. Pick another when the job suits it: **python or js when the work is real logic** — JSON, parsing, anything where shell quoting starts to hurt — and **fish when you need the box's own fish functions.** `proxy`, `timer` and `kauth` come from the stowed fish config; they are functions, not binaries, so nothing outside fish can see them. Non-interactive fish loads them fine, so `remote-host run -i fish 'proxy test'` prints the proxy settings while the bash equivalent reports command-not-found.

Two fish facts worth remembering: `$status` replaces `$?`, and **`grep` is a fish function aliased to `rg` even non-interactively** — call `command grep` when you mean grep.

The interpreter never changes how the wrapper behaves — `remote-host` always drives the far side with bash internally.
