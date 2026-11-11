[中文](README.md) | English

# Shared Python support (`agentkit`)

[← oh-my-harness](../../README.en.md#components)

**In short:** Shared library behind browser-control, computer-control, and remote-host: connections and target-machine handling. Not used on its own.

Internal Python support for the sibling browser, native-desktop and SSH tools. This directory is a library, not an agent skill: do not expose it as a callable skill or install a global compatibility alias.

## Layout and dependencies

Keep `_shared` beside `browser-control`, `computer-control` and `remote-host` for source use. Consumers locate it relative to their own source. Their installation builds bundle the required library code, so installed command line packages do not need a separate global `agentkit` installation.

The implementation uses the Python standard library. The supported calling platform is macOS; SSH payloads may run on compatible Unix destinations. Native UI adaptation requires macOS and the native companion's own permissions. A browser consumer additionally has its declared CDP dependencies.

- `agentkit.cli` adapts explicitly exported Python functions into CLI actions, validates arguments, awaits asynchronous work, and preserves nonzero failures and structured output.
- `agentkit.remote` provides explicit/per-tool target selection, SSH configuration and transport, reachability diagnostics, proxy forwarding, artifact transfer, and notification support.
- `agentkit.deps` loads the separate native companion from the sibling source directory or an importable `computer_control` package. `COMPUTER_CONTROL_SKILL` can explicitly select the companion source directory. It does not embed the native executor.

Consumers import modules such as `agentkit.remote.target` and `agentkit.remote.ssh`; agents normally use the owning tool's Python skill or CLI. This library has no standalone user command. CLI adapters use `agentkit.cli.main(module, prog=..., actions=...)` and return its status through `SystemExit`.

## Configuration and boundaries

Machine selection is separate for each tool. Pins use `${XDG_STATE_HOME:-~/.local/state}/<tool>/pin.json`; SSH identities and routing come from the user's SSH configuration, not a compiled machine inventory. Optional diagnostic labels use `${XDG_CONFIG_HOME:-~/.config}/remote-host/networks.json`. Native companion lookup can use `COMPUTER_CONTROL_SKILL`. Each consumer documents its own additional environment variables.

Remote use needs the real SSH executable, a known alias, the destination interpreter and the destination's named command where applicable. Failure to locate a required library, command or permission is an error, never permission to execute on another machine. This library does not provision remote machines.

Code and payloads execute with real user permissions. This is not a security sandbox. Screenshots, transferred files and command output may be sensitive. A notification that a request was recorded is not proof that a model acted on it; preserve the distinction between recorded, scheduled and completed work.

## Tests and license

From this directory:

```sh
python3 -m unittest discover -s tests -q
```

Tests use their own fixture directories and commands. Repository-wide checks for private skill inventories belong outside this distributable directory. This directory is licensed under [MIT](LICENSE).