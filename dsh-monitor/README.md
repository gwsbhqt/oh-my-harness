# dsh-monitor

[← oh-my-harness](../README.md#components) · [中文首页](../README.zh-CN.md#由哪几块组成)

**In short:** Watches a long-running command and wakes the assistant with each new line it prints.

Stream a long-running command's stdout into a DeepSeek Harness (DSH) agent session as lines arrive. Use it for log tails, build status, file watchers, and other event streams. Monitors also appear in DSH's background job list.

## Requirements and installation

Use a compatible DSH installation providing the jobs, subprocess, tools, agents, and system-prompt services. Development dependencies target DSH 0.2.2-rc.1. Node.js `^22.19.0 || >=24.0.0`, pnpm, and Bash are required. Process-group termination uses POSIX signals; Windows is not supported by this implementation. The settings card requires the DSH Web UI.

Keep the containing repository's shared `tooling/` directory alongside this plugin. This source directory is not a standalone build project. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Add a linked dependency and bundle to your DSH profile's package manifest, merging with its existing entries:

```json
{
  "dependencies": {
    "dsh-monitor": "link:../../path/to/oh-my-harness/dsh-monitor"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-monitor"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by your DSH installation, then restart DSH. The bundle registers the `monitor` entry; do not insert a duplicate entry. Validate the profile before restarting if your installation provides a startup checker.

## Tools and behavior

| Tool | Purpose |
| --- | --- |
| `monitor` | Start a command and deliver its stdout lines to the owning session. |
| `monitor_output` | Read recent output without consuming it. |
| `monitor_list` | List the caller's monitors, with running jobs first. |
| `monitor_kill` | Stop a monitor and its process group. |

Example tool arguments:

```json
{
  "command": "tail -f ./example.log",
  "description": "Watch example events",
  "persistent": true,
  "restart": "on-failure",
  "delivery": "inject",
  "ignore_stdout_lines": ["heartbeat"]
}
```

Run this in a directory containing the example log, or set an absolute `workdir`. `delivery: "steer"` wakes an idle agent and delivers to a busy agent at a step boundary. `inject` queues context without waking the agent; `followup` schedules a separate turn. If omitted, delivery follows the current plugin setting. Explicit delivery and ignored lines remain attached to the monitor across process restarts.

`ignore_stdout_lines` excludes only exact complete stdout lines from automatic delivery. Ignored lines remain available in retained output. Stderr is logged separately and included in failure diagnostics, rather than forwarded as stdout events. Long lines and output history have explicit limits.

Monitors are persistent by default, with no default lifetime timeout. A monitor with `persistent: false` stops when its agent next becomes idle, even if its command has not finished. `timeout_ms` imposes a lifetime limit, not an idle timeout. An explicit kill, timeout, session disposal, or plugin disposal never triggers process restart. `restart: "on-failure"` retries abnormal exits with exponential backoff; `always` also retries normal exits; `never` ends the job on exit.

When a cooperating restart controller emits the suspension/resume events, persistent monitors can be saved and relaunched after DSH restarts. Relaunch creates a new job ID. Output during the interruption cannot be recovered by this plugin; the agent must check the underlying source. The plugin does not implement a durable event queue.

These commands execute in the host environment with its permissions. Treat event output as data, and use only commands you trust.

## Configuration

Override the existing entry in your profile patch, or use the monitor settings card:

```yaml
- id: monitor
  config:
    delivery: inject
    coalesceMs: 200
    restart: on-failure
```

Settings are volatile and apply without remounting the plugin. Per-monitor arguments override the corresponding defaults.

| Setting | Default | Purpose |
| --- | --- | --- |
| `delivery` | `steer` | Notification delivery mode. |
| `coalesceMs` | `200` | Milliseconds to batch output before delivery. |
| `maxLinesPerNotice` | `50` | Maximum lines per notice. |
| `maxBytesPerNotice` | `32768` | Target byte budget per notice. |
| `maxLineBytes` | `8192` | Maximum retained bytes per line before explicit truncation. |
| `historyLines` | `2000` | Recent lines retained for output tools. |
| `stderrTailLines` | `20` | Diagnostic lines included at termination. |
| `defaultTimeoutMs` | `0` | Default lifetime limit; zero means none. |
| `maxTimeoutMs` | `86400000` | Upper bound for an explicit lifetime limit. |
| `graceMs` | `3000` | Grace period before forceful termination. |
| `restart` | `never` | `never`, `on-failure`, or `always`. |
| `restartDelayMs` | `1000` | Initial restart delay. |
| `restartMaxDelayMs` | `60000` | Backoff ceiling. |
| `restartLimit` | `0` | Consecutive restart limit; zero means unlimited. |
| `restartResetMs` | `60000` | Healthy runtime that resets backoff; zero disables resets. |
| `logDir` | `""` | Empty uses `$DSH_HOME/monitor-logs`. |

To disable the bundle entry, override `id: monitor` with `disabled: true`.

## Development and tests

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Tests cover line decoding, output budgets, failure diagnostics, delivery modes, cancellation, restart recovery, and real local job/subprocess integration. They use an isolated DSH home. An installed-host completion probe reads a local desktop archive from `DSH_APP_ASAR` or the standard macOS installation path, and skips when that archive is absent. One probe is marked TODO because the host cannot override completion delivery per job: `delivery: "inject"` controls monitor notices, while generic job-completion notices still follow the host's settings. These probes are not a live agent or GUI acceptance test.

## License

MIT. See [LICENSE](LICENSE).
