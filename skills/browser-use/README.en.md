[中文](README.md) | English

# browser-use

Control Cra and Chrome with one Cra-shaped API. Cra uses its native MCP service and Chrome uses Google's Chrome DevTools MCP. Both support CSS and console inspection, element and full-page PNGs, and JSON fixtures for read endpoints on loopback development pages. Compare two PNGs locally to locate visual changes.

In a Python skill kernel, use `async with skills.browser_use.cra as browser:` for a task, or use `skills.browser_use.chrome` for Chrome. Each attribute access creates a fresh session.

Run `browser-use --help` for connection options and `browser-use --browser chrome tools` to print the shared input schemas. Use `session` for a sequence of commands or `mcp` for a persistent stdio MCP connection. The package requires Python 3.12 or newer, the selected browser and its official MCP server. Python itself has no third-party runtime dependencies.

See the [Python guide](PYSKILL.md), [CLI guide](references/cli.md), [connection and archive information](references/common.md) and [tool contract](references/interfaces.md). The previous self-managed driver is preserved at Git tag `archive/browser-use-before-mcp`.
