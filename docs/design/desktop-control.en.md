[中文](desktop-control.md) | English

# Which window gets the click on a shared Mac?

Suppose two notes are open, both titled “Draft.” You are typing in one. An assistant has been asked to press Preview in the other. A screenshot of the correct note can still give the assistant a point that lands on yours. This project's `computer-use` tool lets a caller bind an action to a particular macOS window and address a control inside it. Actions that use the pointer or keyboard need additional checks on where the input will go.

## Who supplies the desktop?

*Computer use* describes a way of working. A program observes an interface, takes an action, and uses the result to decide what to do next. The computer use tool in Claude, the desktop feature in Codex, and this repository's macOS tool each implement part of that idea.

Anthropic's open-source Computer Use Demo provides a resettable Linux desktop. Claude requests an action. The program in the container moves the pointer, clicks, or types on an X11 display and returns results such as screenshots to the model. A person can watch the same display over VNC. That makes the demo a good place to study how a model picks a point in an image or to repeat an experiment on a dedicated desktop. Claude defines the tools it can request. The application that answers those requests chooses the execution environment.

Peekaboo is an open-source option for a local Mac. Its `see` command can return a screenshot and identifiers for controls exposed through Accessibility. Subsequent commands can target an exact window ID. Peekaboo offers background delivery for supported actions and an explicit foreground mode. Its menu-bar app guides users through permissions, its CLI can run on its own, and its MCP server makes the tools available to compatible assistants.

## Why keep a window interface here?

The project's early maintenance guide gives one reason. It credits OpenAI Codex Computer Use for the pattern of observing an interface and acting on a reference from that observation. That spares a model the repeated work of estimating coordinates. The current implementation returns a list of controls by default and can include a window screenshot in the same observation.

![A single TextEdit window with three checklist items, the first two marked complete in turn](<../assets/computer-use.gif>)

*These frames from the existing demo show one real TextEdit window. The tool reads a fictional three-item list, changes `[ ]` to `[x]` on the first two lines, and reads back the final text. The frames retain the tool’s earlier name.*

The targeted mouse and synthetic focus code adapts two Swift files from `iFurySt/open-codex-computer-use`, whose upstream credits include Cua Driver and yabai. The adaptation notes describe a specific limit. Sending a background right-click event to TextEdit failed to open its context menu. The default right-click path asks the control to show its menu and returns an error if it can't find a reliable menu action. Some targeted pointer operations rely on private macOS SkyLight interfaces and can stop working after a system update.

The current interfaces show what maintaining this layer buys an existing task. A Python caller can keep its bound window object. A command-line caller can pass the same window reference back. Both get enough information to decide whether to select a window again or first read the draft to avoid repeating an input.

- **Window identity.** The tool obtains a system window number from the Accessibility window and records the app's bundle identifier, process ID, and process start time. A relaunch, a missing window, or more than one matching window invalidates the reference. Reopening another note called “Draft” requires a fresh selection.
- **Control identity.** Accessibility exposes a control's role, label, identifier when available, and supported actions. A numbered control comes from a complete snapshot. If something has taken its place and the original had an identifier, the tool looks for the original role and identifier within the window. A replacement labelled “Preview” alone doesn't qualify. A button that supports the press action can handle that request directly, with the pointer left where it is.
- **A point on the screen.** A window capture can show the button even under another window. A bound capture that fails returns an error. Only an unbound capture can fall back to a screen rectangle, which includes whatever covers it. A control's measured bounds are screen coordinates from the snapshot, and its occlusion field is unknown. Moving the real pointer requires explicit global mouse mode. Before sending the click, the tool checks the app under the point, the window that was bound, and the owner of the topmost window there. A covering window from another app causes the global click to be refused.

## When the user switches notes

The host process needs Accessibility permission to inspect and operate controls, Screen Recording for screenshots, and permission to post synthetic input for the event-based paths. Those grants apply to the process. The user still chooses which note a task may change. The tool records task ownership for ordinary apps and uses short per-window locks for shared browsers. Event-based input also takes a shared input lock. A person at the keyboard can still switch focus between two checks.

When typing into a bound window, the sender rechecks the frontmost app, the focused window, and whether the focused element belongs to it. Two text fields in the same window both satisfy that last check. If the user switches away before the first key goes out, the result is `not_sent`. After some input has gone out, a focus change gives `unknown`. The caller has to read the note again. Retyping the whole string could duplicate its first character. A button drawn on a canvas poses another limit. The assistant might see it clearly yet find no control it can press in the background.

On a Mac with the component's test environment ready, run this from the repository root.

```sh
uv run --no-sync --project skills/computer-use python -B -m unittest discover \
  -s skills/computer-use/tests -p test_native.py -k text_focus_change
```

The test feeds `A中😀` to the Swift text sender and records key events in a stand-in for the receiver. Simulated focus loss before typing leaves the record empty. Focus loss after the first character leaves one key-down and one key-up. This checks where the sender stops. The note itself would have to be read back to confirm which characters the application accepted.

## Code, tests, and primary sources

- Original design intent, scope of the adaptation, and upstream credits. [Maintenance guide](../../skills/computer-use/references/maintenance.md#设计来源) · [Adaptation notes](../../skills/computer-use/VENDORED.md) · [Third-party notices](../../skills/computer-use/THIRD_PARTY_NOTICES.md)
- Window identity, event delivery, and the occlusion field. [Swift executor](../../skills/computer-use/bin/computer-use.swift) · [Python element handles](../../skills/computer-use/src/computer_use/elements.py)
- Window replacement, focus loss, snapshot checks, and handoff between tasks. [Native boundary tests](../../skills/computer-use/tests/test_native.py) · [Python interface tests](../../skills/computer-use/tests/test_contract.py) · [Task isolation](task-isolation.en.md)
- Peekaboo's local Mac interfaces, observation, and delivery modes. [Project guide](https://github.com/openclaw/Peekaboo/blob/v4.9.9/README.md) · [Automation guide](https://github.com/openclaw/Peekaboo/blob/v4.9.9/docs/automation.md)
- Anthropic's execution environment, tool loop, and coordinate handling. [Claude tool interface](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) · [Demo guide](https://github.com/anthropics/anthropic-quickstarts/blob/5264b729deda905dba3e5402d717bebed000325c/computer-use-demo/README.md) · [Desktop tool implementation](https://github.com/anthropics/anthropic-quickstarts/blob/5264b729deda905dba3e5402d717bebed000325c/computer-use-demo/computer_use_demo/tools/computer.py)
- The two source files adapted for targeted events. [SkyLight interface](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyLightSPI.swift) · [Click and focus simulation](https://github.com/iFurySt/open-codex-computer-use/blob/93b817501e0b9fa04fba155face2630bfcd0322e/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyClickSimulation.swift)
