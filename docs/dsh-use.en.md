[中文](dsh-use.md) | English

# Dispatch work and verify completion

`dsh-use` lets another local agent inspect and operate an existing DSH instance. It offers a CLI (command-line interface), an asynchronous Python API (application programming interface), and an MCP (Model Context Protocol for tool integration) stdio interface. Typical uses include finding a session, handing it a bounded task, answering its questions, and collecting its result without repeatedly asking a model for status.

## Inspect before sending

Begin with read operations:

```sh
dsh-use health --json
dsh-use sessions --limit 3 --json
```

Resolve the intended session before writing. Give a worker a concrete objective, permitted files or actions, required checks, and a stopping condition. For example, a fictional documentation task might require updating one guide and returning its location and validation evidence. Creating sessions, sending messages, cancelling work, and changing configuration require the user's authorization.

```sh
dsh-use send WORKER_SESSION 'Revise the example guide within the agreed scope and report the checks performed.' --notify LEAD_SESSION --json
```

Save the returned session identifier and starting sequence. A send receipt proves acceptance, not successful completion. If a response is lost or unclear, investigate the existing receipt and session history before sending again. Retry the wait rather than duplicating the task:

```sh
dsh-use wait WORKER_SESSION --since RECEIPT_SEQUENCE --settled --json
```

Replace the uppercase placeholders with actual returned values. `--settled` checks more than an idle session: queued work, background jobs, child agents, and automatically continuing goals can prevent completion. Inspect the exit status and structured outcome. Waiting for input, timing out, failing, and being aborted are different outcomes. Even a successful completion must still be checked against the requested deliverable.

If `new` fails, check how far the host got. JSON and Python results use the same recovery fields.

| What happened | Recovery fields | What to do |
|---|---|---|
| The host attempted to send the first message. Delivery is unknown. | `send-unconfirmed` uses `error.details`. An exception during the send uses top-level `data`. Both contain `sessionId`, `since`, `requestId`, and `sent: null`. | Inspect the original session and continue waiting from `since`. If you have the original receipt event, match the full `requestId`. |
| The session was created and setup failed before the first send. | Top-level `data` contains `created: true`, `sessionId`, and `sent: false`. | Run `dsh-use status <sessionId>` to inspect the existing session. The first message has not been sent. |
| The host returned no usable session ID. | Top-level `data` contains `created: null` and `sent: false`. | Run `dsh-use sessions --include-blank` on the same host. Creation is still unconfirmed. |

For an existing session, when `send` / `chat` hits an exception from the host before the reply (an inner failure while the outer response still returns), the top-level `data` of JSON and Python results carries `sessionId`, `since`, `requestId`, and `sent: null` (no `created`); the original error and its 500/400 class are unchanged, and `chat` does not auto-resend.

Recovery depends on the running server. Older servers also return identifiers in `error.details` for `send-unconfirmed`, but return only the original error for an exception during the first send. If you receive no ID or lose the entire response, list recent sessions and inspect their history. A timestamp alone cannot identify your request. Repeating `new` can create a duplicate.

## Use supervision for longer assignments

The embedded `dsh-supervise` workflow separates planning and acceptance from execution. The lead writes a task brief with the objective, boundaries, checklist, expected evidence, and conditions for reporting a problem. The worker carries out that brief. A useful brief defines an endpoint the worker can actually achieve, such as producing a reviewable patch, rather than depending on someone else's later approval.

Register completion notification when dispatching, then let the lead pause while waiting. The bundled watchdog supplements that notification with stall, outage, recovery, and checker-error notices. It examines state and progress rather than treating reassuring reply text as proof. A connection outage means the worker's state is unknown. After recovery, inspect the missed interval. Stop the watchdog's returned monitor when supervision ends.

At acceptance, compare the actual artifacts and checks with the brief. A worker's report, a send receipt, a registered watcher, and a finished session each establish different facts. None alone establishes that a deployed feature or visible interface works.

## Interfaces and limits

In Python, `await skills.dsh_use.health()` uses the same CLI. Results preserve JSON, `exit_code`, `stdout`, and `stderr`; nonzero exits need explicit handling. This skill is trusted Python code, while plugin commands remain constrained by `readOnly` and `denyNamespaces`.

The server uses a private Unix socket and trusts programs under the same operating-system account. Remote routing requires compatible installations, SSH (Secure Shell for remote connections), and optional shared remote support; missing remote support fails explicitly. MCP exposes a narrower task interface and does not provide global restarts or configuration changes. macOS is the supported platform.

See the [plugin README](../dsh-use/README.en.md) for full configuration, command examples, embedded supervision instructions, and remote prerequisites. [Controller and worker](design/controller-worker.en.md) explains the division of responsibility.