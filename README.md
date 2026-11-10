# oh-my-harness

Community additions for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a persistent Python runtime, session control, computer interaction, and context-size tools. This project is independent of DeepSeek and is not an official DeepSeek product.

## Included

| Component | Purpose |
| --- | --- |
| [dsh-python-repl](dsh-python-repl/README.md) | Persistent Python cells, trusted Python skills, snapshots, and background work |
| [dsh-control](dsh-control/README.md) | Local session control, CLI, Python API, MCP, and supervision skills |
| [dsh-monitor](dsh-monitor/README.md) | Background command output delivered to the working session |
| [dsh-output-guard](dsh-output-guard/README.md) | Bounded tool output with access to the full result |
| [dsh-compaction-bound](dsh-compaction-bound/README.md) | Context compaction with a bounded recent original-text window |
| [dsh-message-tidy](dsh-message-tidy/README.md) | Remove redundant messages before model submission |
| [dsh-image-cap](dsh-image-cap/README.md) | Bound image dimensions before model submission |
| [dsh-history-cap](dsh-history-cap/README.md) | Bound the history sent to the model |
| [browser-control](skills/browser-control/README.md) | Browser automation |
| [computer-control](skills/computer-control/README.md) | Native desktop interaction |
| [remote-host](skills/remote-host/README.md) | Explicit SSH operations on another machine |

`tooling/` contains shared builds, source/artifact manifests, scaffolding, and an offline Harness checker. `skills/_shared/` provides the shared Python support for the computer tools. The control plugin also includes the `dsh-control` and `dsh-supervise` agent skills.

## Requirements

Supported and tested on macOS. Install DeepSeek Harness, Node.js `^22.19.0 || >=24.0.0`, pnpm, uv, and Python 3.12 or later. Some components use uv-managed Python 3.14. Desktop and browser operations require their documented system permissions; native helper builds need Apple's command-line developer tools. SSH operations need explicitly configured and authenticated hosts.

See the individual READMEs for exact Harness API versions, additional dependencies, platform limits, and configuration.

## Install and check

Keep the repository layout intact: plugin builds use the adjacent `tooling/` directory.

```sh
for plugin in dsh-*/; do
  (cd "$plugin" && pnpm install --frozen-lockfile) || exit
done
pnpm run check
```

Follow each plugin's README to add its local dependency and bundle to your Harness profile. Enable only the components you want. The build tools discover direct `dsh-*` directories; Python skill directories are separate.

Follow the three computer-tool READMEs to install their commands and expose their skill directories to your agent. Keep `skills/_shared/` adjacent to them. In agents with a Python skill runtime, use the documented Python functions. Other agents use each skill's CLI instructions.

```sh
node tooling/doctor-cli.mjs --help
```

This checker and its startup probes are included here. A Harness installation and profile are needed for actual startup checks.

## Relationship to Harness and security

Harness supplies the agent runtime, tools, permissions, plugin loader, and UI. These additions integrate with those facilities. Python cells and imported skills run as trusted local code. They are not a sandbox. Only install skills and plugins you trust.

Browser, desktop, SSH, session-control, and MCP capabilities can act with the user's local access. Permission prompts and the host's controls still apply. Read the component documentation before enabling write operations or remote access.

## License

[MIT](LICENSE). Vendored code retains its original licenses and provenance in the relevant component directories, including the Prime REPL core in `dsh-python-repl/vendor/`.
