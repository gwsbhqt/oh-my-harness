中文 | [English](README.en.md)

# browser-use

使用同一套指令控制 Cra 和 Chrome。Cra 网页由 Cra 原生 MCP 操作。Chrome 的指令转换为 Google 官方 Chrome DevTools MCP 调用。调试两个浏览器都使用同一套 `debug_*` 指令。

- [Python 使用入口](PYSKILL.md) 与[普通终端入口](SKILL.md)
- [连接条件与旧版归档](references/common.md)
- [工具和返回值](references/interfaces.md) 与[命令行](references/cli.md)

运行需要 Python 3.12 或更新版本。Python 包本身只使用标准库。安装所需浏览器及官方 MCP 程序后，运行 `browser-use --browser cra tabs_list`，或通过项目运行器 `uv run browser-use --browser cra tabs_list`。一串操作可以用 `session` 保持连接。`browser-use --browser chrome tools` 可离线查看完整接口。
