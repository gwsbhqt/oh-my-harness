中文 | [English](getting-started.en.md)

# 从一个插件开始

[← 文档导航](README.md) · [全部部件](components.md)

在 Antigravity 桌面应用中安装工作台后，另开一条对话。让助手在第一格定义 `samples = [3, 5, 8]` 并计算 `len(samples)`，第二格只运行 `sum(samples)`。展开该对话的两次 `run_code` 调用，两次状态均应为 `ok`，结果依次是 `3` 和 `16`。[安装 Antigravity 工作台](../agy-python-repl/README.md#install)

在终端直接处理图片，可以先用自己的两张图生成一张拼图。[独立命令行示例](../skills/shot-sheet/README.md#常用操作)

下面从一次真实的 DSH 安装开始。

## 1. 准备环境

按 [Python 插件的要求](../dsh-python-repl/README.md#使用条件和支持平台)准备 macOS、DSH、Node.js、pnpm 和 uv。模型需要支持工具调用。Python 解释器与内核依赖可以由 uv 管理，首次启动可能下载。

安装前读[信任边界](../SECURITY.md)。这个组合包会把 DSH 的 TypeScript 代码执行后端换成 Python，并关闭依赖原后端的工作流条目。它运行可信代码，不提供系统沙箱。

## 2. 克隆并检查

保留整个仓库。插件构建需要相邻的 `tooling/`，远程操作技能需要 `skills/_shared/`。

```sh
git clone https://github.com/gwsbhqt/oh-my-harness.git
cd oh-my-harness
pnpm run check:public
pnpm --dir dsh-python-repl install --frozen-lockfile
pnpm --dir dsh-python-repl run check
```

第一条检查只需要 Node.js 和 Git，核对公开文档与仓库约定。插件检查会运行类型检查、构建和测试，需要该部件的开发环境。检查通过说明本地构建和测试通过，还没有把插件装进 DSH。

## 3. 链接到自己的 DSH 配置

DSH 把一套配置称为 profile。在它的包清单中**合并**链接依赖和组合包登记，保留已有条目。路径相对于该 profile 目录，需要按你的源码位置调整：

```json
{
  "dependencies": {
    "dsh-python-repl": "link:../../src/oh-my-harness/dsh-python-repl"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-python-repl"] }
  }
}
```

在该 profile 目录，用 DSH 安装所配的 pnpm 安装依赖。运行 DSH 的启动检查后重启应用，再新建会话。组合包已经登记加载条目，不需要再手写一份 insert。参数和移除步骤见[部件安装说明](../dsh-python-repl/README.md#从本仓库安装)。

## 4. 核对变量真的保留下来

在新会话中让 Agent 连续执行两格代码：

> 第一格创建 `samples = [3, 5, 8]`，只返回元素数量。第二格不要重新赋值，直接计算 `sum(samples)`。告诉我两格的结果。

应依次得到 `3` 和 `16`。这验证了当前会话的变量复用。它不验证重启恢复、外部服务权限或模型处理真实业务的准确性。

想看更完整的例子，运行[虚构日志测量](../benchmarks/README.md)，或阅读[持久内核教程](dsh-python-repl.md)。

## 再加你需要的能力

| 接下来想做什么 | 安装入口 |
| --- | --- |
| 从外部 Agent 控制现有 DSH、派活并等待结果 | [dsh-use](../dsh-use/README.md#安装) |
| 操作网页或桌面应用 | [browser-use](../skills/browser-use/README.md) · [computer-use](../skills/computer-use/README.md) |
| 操作另一台机器 | [remote-host](../skills/remote-host/README.md) |
| 对长对话、后台事件或界面做改进 | [按问题选择部件](components.md) |

把 Python 技能加入可信目录会在导入时执行其代码。目录布局、软链接与个人配置的分工见[与 dotfiles 配合](dotfiles.md)。

## 卡住时看哪一步

- **构建失败：** 保留完整退出码和错误，先检查对应部件的环境要求。
- **DSH 里没有新能力：** 检查当前 profile 的链接、组合包登记与实际重启；源码变了不代表内存里的插件变了。
- **下一格找不到变量：** 检查是否是同一会话、内核是否被重置，以及恢复提示有没有丢失状态。
- **外部操作结果不确定：** 先查看原目标和回执；超时后不要直接重复发送或点击。

公开问题只附虚构复现。账号、真实日志或安全问题走[私密报告](../SECURITY.md)。
