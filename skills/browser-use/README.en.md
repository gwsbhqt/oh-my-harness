[中文](README.md) | English

# browser-use

Control Cra and Chrome with a common Cra-shaped API. Cra uses its native MCP service. Chrome control uses the official Chrome DevTools MCP. Both browsers use the same `debug_*` calls to inspect CSS rule sources, capture individual elements and diagnose network, console, performance and memory behavior.

Run `browser-use --help` for connection options and `browser-use --browser chrome tools` to print the shared input schemas. Use `session` for a sequence of commands or `mcp` for a persistent stdio MCP connection. The package requires Python 3.12 or newer, the selected browser and its official MCP server. Python itself has no third-party runtime dependencies.

See the [Python guide](PYSKILL.md), [CLI guide](references/cli.md), [connection and archive information](references/common.md) and [tool contract](references/interfaces.md). The previous self-managed driver is preserved at Git tag `archive/browser-use-before-mcp`.
