[中文](README.md) | English

# Diagrams and demo media

The home page uses an editable concept diagram and excerpts from the existing log demo. The diagram explains capability groups; it is not a runtime capture. GIFs and screenshots show real operations with fictional inputs.

The table describes existing media and the evidence to retain when recording again. Private source sessions and account data are not distributed. Component READMEs link the corresponding recordings and screenshots.

| Planned file | Real action and evidence to capture | Placement |
| --- | --- | --- |
| [overview.en.svg](overview.en.svg) · [Chinese](overview.svg) · [Mobile](overview-mobile.en.svg) · [Mobile Chinese](overview-mobile.svg) | Hand-authored SVG concept diagram: persistent data, session coordination, and computer tools. No performance claims or simulated interface. | [Home page](../../README.en.md). |
| `python-data-locality.gif` | Pair captured raw terminal output with a real DSH session replay that filters the same fictional log and reuses the in-memory variable. Label the excerpts and show both reproducible text-payload estimates from [results.json](../../benchmarks/results.json). | [dsh-python-repl component README](../../dsh-python-repl/README.en.md). |
| `controller-worker.gif` | Use two authorized test sessions. The controller sends a concrete brief, records its receipt and stops polling. The worker does the task. Show the resulting notification, controller inspection, and an actual correction or acceptance. Do not invent usage or elapsed-time counters. | [dsh-use component README](../../dsh-use/README.en.md). |
| [two-tabs.png](two-tabs.png) | The archived browser-use opened the same fictional checklist twice. Only the first copy was checked. The capture shows the counters at 1/3 and 0/3. | [Original steps and capture](../browser-use.en.md#two-tabs) · [Browser design](../design/browser-control.en.md). |
| [browser-use.gif](browser-use.gif) | The archived browser-use filled in a local example page, checked a box, and read back the result. | [Archived version and recording](../browser-use.en.md#two-tabs). |
| `computer-use.gif` | Recorded and reviewed: a bound macOS TextEdit window with a fictional checklist, two edited items, and native text read-back verification. The 16-second GIF shows eight labeled capture excerpts. | [skills/computer-use component README](../../skills/computer-use/README.en.md). |
| `monitor.gif` | Follow one local producer that emits a known example event. End the agent turn, emit that event, and show the session waking and acting. State which delivery mode is used. No model polling, duplicate monitor, or fake arrival. | [dsh-monitor component README](../../dsh-monitor/README.en.md). |
| `bounded-display.png` | Capture a real large fictional output with the actual beginning/end display and saved-full-text location. Verify the saved text and retained Python value. This demonstrates the REPL (read-evaluate-print loop) output budget, not the model-stream guard. | [dsh-python-repl component README](../../dsh-python-repl/README.en.md). |
| `remote-host.png` | Use explicitly authorized test destinations to run a read-only check or copy a fictional fixture. Show actual host selection and content verification. Hide account and network details. | [skills/remote-host component README](../../skills/remote-host/README.en.md). |

Keep personal windows, notifications, account data, host identifiers, usernames, private paths, menu-bar identifiers, and credentials outside the captured surface. Prefer recording only the relevant window. Review extracted frames before publishing. Never log into an account just to make a demo look realistic.

Target compact media suitable for the component READMEs. If playback is sped up, show the multiplier in the frame. An interrupted producer stream or unconfirmed action must remain visible as uncertainty, not be cut into a false success. Check all named paths after the recordings are merged. Once a recording passes review, remove the corresponding pending-recording sentences from the relevant documents; leave notices for recordings that remain unfinished.

The CI badge in the [README](../../README.en.md) links to GitHub Actions; the license badge links to the MIT license.