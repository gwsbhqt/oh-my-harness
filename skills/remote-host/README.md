# remote-host

Execute explicit payloads over the system SSH client, inspect configured hosts, transfer and verify files, and manage remote jobs, application commands and screenshots. The asynchronous Python skill and the command line interface share the same routing and transport behavior.

## Requirements and installation

The supported calling platform is macOS with Python 3.10 or newer and the system SSH tools. Unix SSH destinations support the full relevant command set when their required interpreters and utilities are installed. Windows SSH destinations support limited explicit PowerShell payload execution; that does not provide Windows desktop or browser control.

Keep this directory alongside `_shared` for source use and put `scripts/remote-host` on PATH. Alternatively, `uv tool install ./remote-host` installs the console entry point; its wheel bundles the shared library. Expose this directory through the agent's configured skill search path. Python skill kernels read [PYSKILL.md](PYSKILL.md) and use `skills.remote_host`; other agents read [SKILL.md](SKILL.md).

```sh
remote-host hosts
remote-host -H alpha run 'uname -a'
```

```python
result = await skills.remote_host.run("uname -a", host="alpha", quiet=True)
```

`alpha` is an example SSH alias, not a built-in machine. Configure real destinations in your own SSH configuration. Host listing uses its native output; there is no `hosts --json` interface.

## Configuration and remote behavior

Authentication, users, ports, address families and jumps follow the system SSH configuration. The tool does not contain a personal host inventory. Pinning a host, interpreter and working directory uses the per-tool `pin.json` under `${XDG_STATE_HOME:-~/.local/state}/remote-host`; one tool's machine choice does not select another tool's machine.

Optional network labels are read from `${XDG_CONFIG_HOME:-~/.config}/remote-host/networks.json`, a JSON object mapping CIDRs to descriptive strings. With no file, diagnostics use unlabeled addresses. For example:

```json
{"192.0.2.0/24": "example network"}
```

`REMOTE_HOST_PROXY=host:port` overrides the child-process proxy address. Direct proxy borrowing needs a destination that can reach the calling machine. `reverse_proxy` instead creates a private, temporary SSH forwarding connection to an explicitly selected alias; it requires suitable remote `sh` and `lsof` support and does not change the user's SSH configuration or start a proxy service. Read [host and proxy behavior](references/hosts-and-proxy.md) and the [CLI reference](references/cli.md).

SSH destinations must already have the required command or interpreter. Native desktop/browser features additionally require their named tool and `_shared` support on the destination. Missing commands fail; there is no fallback to this machine and no automatic tool installation.

## Safety and development

Payloads run with the authenticated user's real permissions. This is not a sandbox. Read resolved paths before changing files, preserve symlink destinations, and verify transferred content. A timed-out mutation has an unknown outcome until checked; do not blindly replay it. Desktop screenshots and command output can contain private data. Authentication prompts and permission changes require explicit user action.

From the sibling-directory checkout:

```sh
uv run --project remote-host python -m unittest discover -s remote-host/tests -q
```

Tests use isolated fixtures and do not prove that a user's SSH destination is reachable. This directory is licensed under [MIT](LICENSE).
