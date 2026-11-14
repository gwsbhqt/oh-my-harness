[中文](computer-use.md) | English

# Using computer-use

Use computer-use for native macOS applications, browser chrome, and dialogs outside a web page. Typical tasks include inspecting an application’s controls, changing a setting through its interface, or checking a native dialog after a browser action. For content inside a web page, start with browser-use.

## Prepare the destination

The tool combines an asynchronous Python interface with a locally compiled Swift executor. It supports macOS and requires Python 3.12 or newer plus Xcode Command Line Tools with a working Swift compiler. Compile on the destination rather than copying a cached executable from another architecture.

Check permissions before attempting control:

```python
permissions = await skills.computer_use.perms(host="local")
windows = await skills.computer_use.windows("Calculator", host="local")
```

This fictional walkthrough uses Calculator as an inspection target. Read the returned permission and window information before continuing. Accessibility permission enables native inspection and actions; Screen Recording permission enables screenshots. Grants apply to the actual host process, so a working version command does not establish either permission. Requesting or granting permissions requires an explicit user decision.

## Bind, inspect, act, inspect again

Select the application and stable window returned by inspection, and keep that selection for the task. A window title alone is insufficient, especially for browsers with multiple windows. The Python application handle can retain the chosen host, task scope, and window reference. Use the documented interface to create that handle and inspect its controls before issuing input.

For a fictional settings task, first read the current value, change the intended control, and then inspect the same window again. Confirm the new value and any visible save confirmation. If the task produces a document, check the resulting document as well. A successful input response proves only that step; it does not establish the final application result.

Snapshots provide element information, and optional screenshots show visual state. When an element reference is stale, inspect again and locate the control from the new state. Do not reuse an old number after the interface changes. Keep screenshots and structured inspection complementary: one shows appearance, while the other can expose control names and values.

## Failure boundaries

Targeted input does not silently switch to global foreground input. Explicit global input can affect the foreground application, so use it only when the authorized task requires it. Selected targeted mouse and synthetic-focus operations use private SkyLight interfaces and may stop working after a macOS update. Unsupported operations fail rather than switching to a different mouse path.

Inspection can launch an application automatically when it is not running. The documented no-autolaunch setting is available when that behavior is unwanted. Remote operations require an existing SSH (Secure Shell for remote connections) alias, the remote command, shared routing support, and permissions on that destination. Missing tools or permissions cause errors; the request neither installs software nor falls back to this computer.

The tool and its Python environment are not sandboxes. In Harness, trusted Python can access host resources independently, while Harness tool calls retain their approval and policy checks. Application ownership checks help keep actions on the selected target; they do not replace task authorization.

Use the [tool README](../skills/computer-use/README.en.md) and its linked references for complete parameters, ownership behavior, runtime settings, and maintenance. Consult the [Python runtime README](../dsh-python-repl/README.en.md) for trusted skill discovery and the [Python data locality design](design/python-data-locality.en.md) for background. This guide does not claim live application acceptance.