# Recording checklist

This checklist describes how to capture and verify each demo. The README links the finished recordings and screenshots.

| Planned file | Real action and evidence to capture | Placement |
| --- | --- | --- |
| `python-data-locality.gif` | Pair captured raw terminal output with a real DSH session replay that filters the same fictional log and reuses the in-memory variable. Label the excerpts and show both reproducible text-payload estimates from [results.json](../../benchmarks/results.json). | README hero. |
| `controller-worker.gif` | Use two authorized test sessions. The controller sends a concrete brief, records its receipt and stops polling. The worker does the task. Show the resulting notification, controller inspection, and an actual correction or acceptance. Do not invent usage or elapsed-time counters. | Control capability. |
| `browser-control.gif` | Use a local fictional page or an example page, without account login. Bind a task window and exact page, make a visible change, and inspect the result. | Browser capability. |
| `computer-control.gif` | Use a native text editor containing only fictional text. Bind the window, edit a list, then capture and verify the intended result. Capture is deferred until the Mac is unlocked. | Desktop capability. |
| `monitor.gif` | Follow one local producer that emits a known example event. End the agent turn, emit that event, and show the session waking and acting. State which delivery mode is used. No model polling, duplicate monitor, or fake arrival. | Event capability. |
| `bounded-display.png` | Capture a real large fictional output with the actual beginning/end display and saved-full-text location. Verify the saved text and retained Python value. This demonstrates the REPL output budget, not the model-stream guard. | Output boundary example. |
| `remote-host.png` | Use explicitly authorized test destinations to run a read-only check or copy a fictional fixture. Show actual host selection and content verification. Hide account and network details. | SSH capability. |

Keep personal windows, notifications, account data, host identifiers, usernames, private paths, menu-bar identifiers, and credentials outside the captured surface. Prefer recording only the relevant window. Review extracted frames before publishing. Never log into an account just to make a demo look realistic.

Target compact media suitable for the README. If playback is sped up, show the multiplier in the frame. An interrupted producer stream or unconfirmed action must remain visible as uncertainty, not be cut into a false success. Check all named paths after the recordings are merged. Once a recording passes review, remove the corresponding pending-recording sentences from both READMEs; leave notices for recordings that remain unfinished.

The CI and release badges in the [README](../../README.md) link to GitHub Actions and releases.