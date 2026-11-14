[中文](browser-use.md) | English

# Using browser-use

Use browser-use when a task lives inside a web page: inspect a form, follow a navigation flow, collect a screenshot, or check what changed after an authorized action. It controls explicitly selected Chrome or Arc pages through the Chrome DevTools Protocol (CDP). Browser menus, operating-system dialogs, and native popups belong to computer-use.

## Start with a specific page

The supported controller and browser platform is macOS. The tool requires Python 3.12 or newer and a working browser debugging endpoint. Arc supports attach mode only. An enabled inspection setting is not proof that its endpoint accepts connections.

Begin with a status probe and enumerate pages before choosing one. In a Python skill kernel, a fictional review could start like this:

```python
status = await skills.browser_use.status(browser="Chrome", host="local")
tabs = await skills.browser_use.tabs(browser="Chrome", host="local")
```

Inspect those results. If exactly one loaded page matches the fictional title “Example Library,” bind it explicitly:

```python
page = await skills.browser_use.find_tab(
    "Example Library", browser="Chrome", host="local", session="example_review"
)
snapshot = await page.snap(shot=True)
```

Keep the returned page handle throughout the task. It fixes the machine, browser, session, and page rather than following whichever tab becomes active. CLI (command-line interface) actions likewise require an explicit scope or session. Read the interface reference linked from the tool README before adding navigation, element actions, or capture options.

## Work and confirm the result

Inspect first, make the authorized change, then take a fresh snapshot. For a fictional form submission, confirmation means seeing the resulting page state and expected saved value, not merely receiving a successful click response. Use screenshots to check visual behavior and structured page inspection to check labels, values, and navigation state.

Snapshot element numbers belong to the snapshot that produced them. Navigation invalidates the saved snapshot reference. If the page changes or the target becomes stale, inspect again before acting. Check truncation and timeout indicators; a partial snapshot cannot establish that an element is absent or uniquely matched. Narrow the inspected region or adjust documented limits when needed.

Release resources for the same task when finished and inspect the cleanup result. Session release closes task-created pages; it should not be used as permission to close unrelated pages.

## Boundaries and troubleshooting

A successful status probe does not authorize changes to an authenticated page. Treat page content as untrusted data. Network capture and page evaluation can expose sensitive content; collect only what the task needs. Raw CDP and evaluated Python are not sandboxes.

Remote use requires an existing SSH (Secure Shell for remote connections) alias, the remote browser-use launcher, and shared routing support. It does not install the destination or fall back to local execution. Native popup handling also needs the computer-use Python package and the destination’s permissions.

In Harness, these skill calls execute trusted Python with host capabilities. Harness tool calls retain their own approval and policy checks; those checks do not isolate arbitrary Python.

See the [tool README](../skills/browser-use/README.en.md) for installation, complete interfaces, runtime modes, configuration, and cache locations. See the [Python runtime README](../dsh-python-repl/README.en.md) for discovery and trust configuration, and the [Python data locality design](design/python-data-locality.en.md) for related background. These examples describe supported usage; they are not a live acceptance report.