# A controller and a worker need receipts, state, and an acceptance boundary

A long task can benefit from two different kinds of attention. A controller investigates the problem, chooses a direction, and checks the result. A fictional worker follows an explicit checklist through implementation and verification. Both remain ordinary, visible DSH conversations. The useful distinction is responsibility, not a promise that one model is always wiser or another is always cheaper.

The [dsh-supervise skill](../../dsh-control/skills/dsh-supervise/SKILL.md) describes this arrangement. Its model-selection policy and review cadence are instructions for agents. They are not a new multi-agent execution engine added by the plugin. DSH already supplies sessions, model execution, persistent goals, queued messages, questions, and background-job state. The [dsh-control plugin](../../dsh-control/README.md) adds access to the running instance, receipt-preserving dispatch, completion observation, and notices. The distinction matters when something stalls: a skill can tell an agent how to recover, but it cannot invent a host capability that is absent.

This article explains implemented mechanisms and testable design choices. It does not report a fresh production experiment or personal usage savings.

## Make the task transferable before dispatch

The controller first resolves enough uncertainty to write a useful brief. The [brief template](../../dsh-control/skills/dsh-supervise/references/brief-template.md) asks for the requested end state, a checklist, verification methods, exclusions, decisions requiring the user, and selected milestones for controller review. The worker cannot infer the controller's earlier conversation. A self-contained brief is therefore part of correctness, not administrative overhead.

The workflow prefers a short, dedicated controller conversation. Repeatedly waking a conversation requires the model to process its available context again; unnecessary history and repeated inspection add work. This is a reason for the policy, not evidence of a particular saving. The controller normally assigns routine execution to a fast tier, but an explicit model and reasoning setting are also supported. Actual availability depends on the configured model catalog. The strategy belongs to the skill; the plugin supplies model-selection commands.

A separate worktree can isolate file edits. It does not isolate credentials, browser accounts, or the desktop. The brief must still constrain which resources the worker may change and what it must leave alone.

## Give each conversation its own finish line

The controller's persistent goal describes the overall deliverable and acceptance criteria. The worker's goal covers only its assigned portion. The bundled skill defaults to segments of 10 worker goal rounds. That number is a review parameter in the instructions, not a measured optimum or a guarantee of progress.

The worker completes its goal after its own checks. The controller completes the overall goal after independently checking the required evidence. If the result needs another person's decision, the controllable finish line should describe the prepared handoff rather than claim that the other person has acted.

Waiting is a distinct state. The controller pauses its own goal while waiting for the worker, and the worker pauses when only an external answer remains. Keeping an automatically continuing goal active merely to say “still waiting” would spend rounds without advancing the task. Paused goals retain the objective without requesting another model turn simply to restate the same condition.

The plugin accesses existing host services for these operations. [gateway.ts](../../dsh-control/src/gateway.ts) describes the adapter to the same typed invocation machinery used by the interface. [service.ts](../../dsh-control/src/service.ts) reads goal state and dispatches session operations; it does not replace the host's goal scheduler.

## A receipt says what happened to the message

A successful send returns a request identifier, session identifier, and starting transcript sequence, `since`. These describe the accepted dispatch and establish a boundary for later observation. They do not establish that the model responded or that the assigned work passed review.

Preserving that boundary prevents a common mistake: a send succeeds, the subsequent wait fails, and the caller resends the task as though nothing had happened. The correct recovery is to query the original session and continue waiting from the saved sequence. An unconfirmed send must likewise be investigated before replay.

The [Python API](../../dsh-control/skills/dsh-control/src/dsh_control/__init__.py) is a thin asynchronous wrapper around the CLI. It retains raw JSON, exit code, stdout, and stderr. Nonzero results remain visible. Cancelling the local wrapper does not automatically cancel the DSH conversation or replay the message. This separation preserves the uncertainty that an outer timeout cannot resolve.

Completion notification registration is another operation. The receipt needs a notification watch identifier to confirm registration. If registration fails after sending, the receipt retains the send and includes the notification error. The caller should use `wait --settled`, not send the task again.

## Ending a turn is not completing the assignment

Ordinary waiting requires a newly ended turn after the saved sequence and a session without running or queued work. Questions have their own waiting-input result. A failed or aborted final turn is not reported as successful work.

`wait --settled` goes further. The [completion checks](../../dsh-control/src/service.ts) inspect background jobs, running or queued descendants, pending restarts, and whether a goal is both active and armed to continue. An active but disarmed goal does not itself imply another automatic round. Missing access to the required host state produces an unsupported error rather than a guessed completion.

After blockers clear, the implementation requires 3 seconds of stable clearance by default. This covers a possible gap between a background job ending and the host queuing its completion event. It is an explicit debounce parameter, not proof that every possible future event has been excluded.

Even a settled session can have reached a segment limit or paused for a decision. A turn ending with `completed` describes the execution of that turn. It does not distinguish a finished objective from a worker stopping at its allowed round count. The controller therefore reads goal phase, activation, and stop reason before deciding whether to accept, extend, answer, or correct the work.

## Wait with events; check exceptions without a model loop

The workflow has three notification routes: the registered completion watch, selected worker milestone or exception notices, and a separate watchdog for stalled or unavailable state. Routine progress can be injected quietly into the controller's context without waking it.

[done-watch.ts](../../dsh-control/src/done-watch.ts) reuses the settled predicate. Status events trigger checks, and a 5-second timer supplies a fallback. Repeated registration for the same worker and notification recipient reuses a pending watch. Concurrent registrations are coordinated, and duplicate persisted watches are merged on startup. Question reminders are keyed so the same observed question is not announced every check.

The watch persists its state. On startup, a pending watch resumes. A record left in `delivering` is marked failed rather than blindly delivered again: the process cannot know whether the recipient already received it. Reported delivery failures have bounded retries. This is a deliberate tradeoff between duplicate wakeups and uncertain delivery, not an exactly-once messaging guarantee. [Watcher tests](../../dsh-control/test/done-watch.test.ts) cover restart recovery, deduplication, question reminders, and failed delivery.

Event-driven supervision does not mean that no code polls. The distinction is that small background checks run without repeatedly invoking the controller model. The controller resumes when it has a decision or verification to perform.

## Detect silence without inventing failure

The bundled [watchdog](../../dsh-control/skills/dsh-supervise/scripts/watchdog.py) uses structured status, goal, job ownership, and transcript sequence fields. It does not scan a worker's prose for “done.” Its defaults are a 120-second check interval, a 30-minute stall threshold, and a 15-minute outage reminder threshold. Long legitimate builds may need a larger stall threshold.

A stall means that recorded sequence progress has stopped while some busy condition remains. It is a prompt to inspect the last turn and background task, not a verdict that the worker failed. Conversely, an increasing sequence can conceal unproductive repetition; semantic progress still requires comparing the checklist and actual changes.

During an outage, the checker reports unknown state, suppresses repeated alerts, and sends a recovery notice. It adjusts progress timing for the unobserved interval so a network gap does not immediately become a false stall. Broken JSON or invalid command arguments are checker failures, separate from task failures. [Watchdog tests](../../dsh-control/skills/dsh-supervise/scripts/test_watchdog.py) exercise these distinctions with controlled state and time.

On wakeup, the controller checks the goal, running state, questions, checklist changes, and relevant artifacts. A productive segment can receive another bounded segment. Repetition calls for a narrower task or corrected direction. A missing goal should be repaired in the existing conversation when supported, rather than discarding the conversation and redispatching its side effects. After acceptance, the controller stops the watchdog and closes its own goal.

## Measure orchestration separately from output quality

The watchdog suite is reproducible without a live worker:

```sh
python3 -I dsh-control/skills/dsh-supervise/scripts/test_watchdog.py
```

These fixture tests establish decision rules, not real network reliability or model quality. Plugin verification instructions are in the [development README](../../dsh-control/README.md); this document does not claim they were rerun for this essay.

For a workload comparison, keep the brief, acceptance checks, model routes, and initial repository state fixed. Record dispatch acceptance, watch registration, wakeup count, state-check failures, accepted deliverables, corrections, elapsed time, and model usage when the provider actually reports it. Separate timer checks from controller model calls. Include unsuccessful work and uncertain delivery rather than counting only accepted runs.

Publish actual measurements in [benchmark results](../../benchmarks/results.json), with the commands and input needed to reproduce them. No savings percentage follows merely from using two conversations. The design's defensible benefit is a clearer control loop: receipts identify accepted messages, state identifies why execution stopped, and independent evidence determines whether the requested result is ready.