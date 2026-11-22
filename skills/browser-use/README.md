中文 | [English](README.en.md)

# browser-use

使用同一套指令操作 Cra 和 Chrome。Cra 使用原生 MCP，Chrome 使用 Google 官方 Chrome DevTools MCP。两个浏览器都能查 CSS 来源、展开报错、截取元素和整页，或在本机开发页复现接口的空态和错误态。两张 PNG 还可在本机比较并标出差异。

- [Python 使用入口](PYSKILL.md) 与[普通终端入口](SKILL.md)
- [连接条件与旧版归档](references/common.md)
- [工具和返回值](references/interfaces.md) 与[命令行](references/cli.md)

运行需要 Python 3.12 或更新版本。Python 包本身只使用标准库。安装所需浏览器及官方 MCP 程序后，运行 `browser-use --browser cra tabs_list`，或通过项目运行器 `uv run browser-use --browser cra tabs_list`。一串操作可以用 `session` 保持连接。`browser-use --browser chrome tools` 可离线查看完整接口。
