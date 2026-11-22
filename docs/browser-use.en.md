[中文](browser-use.md) | English

# Using browser-use

Cra and Chrome accept the same page calls. `tab_open` opens a tab, `page_snapshot` reads the page, and `page_click` acts on a control from its snapshot. Debugging has a separate `debug_*` API. For example, `debug_network` reads network requests for a chosen tab.

| Browser | Page controls | Debugging |
| --- | --- | --- |
| Cra | Official Cra MCP, with first-use approval in Cra | Google’s Chrome DevTools MCP, using the debugging endpoint for that Cra instance |
| Chrome | Google’s Chrome DevTools MCP, using an already-running Chrome with debugging enabled | The same Google tools, connected to that Chrome instance |

Prepare the browser you intend to use. Chrome’s `endpoint` accepts a loopback address with an explicit port for a running instance with remote debugging enabled. The instance’s profile determines which accounts are signed in. See the [skill README](../skills/browser-use/README.en.md) for installation and connection requirements. [Official Cra MCP](https://github.com/VictorKildahl/cra/blob/v0.1.53/docs/mcp.md) · [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)

## Open a tab and read its page

In a DSH Python session with the skill installed, this example opens a background Cra tab, inspects a public example page, and closes the tab it created. The open result contains `tabId`. For a task that calls for an existing tab, use `tabs_list()` and take the `id` of the selected entry.

```python
async with skills.browser_use.Browser("cra") as browser:
    opened = await browser.tab_open(url="https://example.com/")
    tab_id = opened["tabId"]
    try:
        snapshot = await browser.page_snapshot(tabId=tab_id)
        print(snapshot)
    finally:
        await browser.tab_close(tabId=tab_id)
```

Keep the `tabId` on the same connection. Both browsers use Cra’s navigation arguments. Call `page_navigate(tabId=tab_id, url=...)` to visit a URL or `page_history(tabId=tab_id, action="reload")` to reload. For a click, use a `ref` from that tab’s latest snapshot. Read the page again after navigation or a change to a control. For example, after submitting a form, check the original tab for the expected saved value. If the click times out, read back the same page before deciding whether another action is needed. Use the [desktop tool](computer-use.en.md) for browser menus and system dialogs.

## Read network requests from the same tab

The example endpoint below represents the Chrome instance you prepared. The page and debugging calls both take its `tabId`. For Cra debugging, enable Cra’s page JavaScript tool so the debugger can verify the tab identity. Use `"cra"` and the endpoint for that Cra instance. Cra page controls on their own can omit `endpoint`.

```python
async with skills.browser_use.Browser("chrome", endpoint="http://127.0.0.1:9222") as browser:
    opened = await browser.tab_open(url="https://example.com/")
    tab_id = opened["tabId"]
    try:
        snapshot = await browser.page_snapshot(tabId=tab_id)
        requests = await browser.debug_network(tabId=tab_id)
    finally:
        await browser.tab_close(tabId=tab_id)
```

The first shell command lists Cra tabs. To keep one connection across calls, configure your MCP client to start the second command. It connects to an existing Chrome instance.

```sh
browser-use --browser cra tabs_list
browser-use --browser chrome --endpoint http://127.0.0.1:9222 mcp
```

<a id="two-tabs"></a>

## Archived capture of two tabs with the same title and URL

The archived browser-use opened the [fictional checklist](examples/browser-task.html) twice and checked a box only in the first tab. The two reads returned `[1, 0]`. The capture shows 1/3 in the first tab and 0/3 in the second. The original Python steps, screenshot and recording are available here. [Archived instructions](https://github.com/gwsbhqt/oh-my-harness/blob/archive/browser-use-before-mcp/docs/browser-use.en.md#two-tabs) · [Two-tab capture](assets/two-tabs.png) · [Archived recording](assets/browser-use.gif)

Page content and network requests may contain account data. Limit what you collect and display to what the task requires, and verify actions against the page. Python skills run with the permissions of the current process. [Python runtime](../dsh-python-repl/README.en.md) · [Browser design](design/browser-control.en.md)