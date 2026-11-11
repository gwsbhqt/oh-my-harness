中文 | [English](README.en.md)

# 公共 Python 支持（`agentkit`）

[← 返回首页](../../README.md#由哪几块组成)

**一句话：** 负责连接和目标机器的判断，它本身不单独使用。

为同级的浏览器、原生桌面和 SSH 工具提供 Python 底层支持。本目录是库，不是助手技能；不要把它暴露成可调用技能，也不要安装全局兼容别名。

## 目录和依赖

从源码使用时，把 `_shared` 与 `browser-control`、`computer-control`、`remote-host` 放在同一层。使用方相对于自己的源码查找它。各工具的安装构建会把所需库代码打进包里，因此已安装的命令行包不需要单独安装全局 `agentkit`。

实现使用 Python 标准库。调用端支持 macOS；通过 SSH 发送的内容可以在兼容的 Unix 目标上运行。原生界面适配需要 macOS，也需要原生配套工具自己的权限。浏览器使用方还需要它声明的 CDP 依赖。

- `agentkit.cli` 把明确导出的 Python 函数接成命令行动作，校验参数，等待异步工作，并保留非零失败和结构化输出。
- `agentkit.remote` 提供明确的目标选择和各工具独立的选择记录、SSH 配置与传输、连通性诊断、代理转发、产物传输和通知支持。
- `agentkit.deps` 从同级源码目录或可导入的 `computer_control` 包加载独立的原生配套工具。`COMPUTER_CONTROL_SKILL` 可明确指定其源码目录。本库不包含原生执行程序。

使用方导入 `agentkit.remote.target`、`agentkit.remote.ssh` 等模块；助手通常使用所属工具的 Python 技能或命令行。本库没有独立用户命令。命令行适配器调用 `agentkit.cli.main(module, prog=..., actions=...)`，通过 `SystemExit` 返回状态。

## 配置和边界

每个工具分别选择机器。目标记录使用 `${XDG_STATE_HOME:-~/.local/state}/<tool>/pin.json`；SSH 身份和连接路径来自用户 SSH 配置，不是编译进去的机器清单。可选诊断标签使用 `${XDG_CONFIG_HOME:-~/.config}/remote-host/networks.json`。原生配套工具查找可用 `COMPUTER_CONTROL_SKILL`。各使用方分别说明自己的其他环境变量。

远程使用需要真实 SSH 程序、已知别名、目标解释器，以及适用时目标上相应的命令。找不到必需的库、命令或权限就报错，绝不意味着可以换到另一台机器执行。本库不负责为远端准备软件环境。

代码和执行内容使用用户的真实权限。这不是安全沙箱。截图、传输文件和命令输出都可能敏感。收到“请求已记录”的通知，不证明模型已经执行；应始终区分已记录、已调度和已完成。

## 测试和许可

在本目录执行：

```sh
python3 -m unittest discover -s tests -q
```

测试使用自己的样例目录和命令。针对整个仓库的私人技能清单检查应放在这个可分发目录之外。本目录按 [MIT](LICENSE) 许可发布。
