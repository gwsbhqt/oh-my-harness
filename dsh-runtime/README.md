中文 | [English](README.en.md)

# dsh-runtime

[← 返回首页](../README.md#由哪几块组成)

**一句话：** DSH 启动即生效的宿主钩子——补全登录 shell 的环境，并在保存时顺着软链写、把补丁层的 YAML 写法抹平。没有界面、没有配置项。

## 它做两件事

1. **登录环境。** DSH 由 Dock、脚本或别的程序拉起时，继承到的环境各不相同，命令工具和插件调用的外部命令于是时有时无。本插件用系统账户登记的登录 shell 跑一次 `-l -c 'env -0'`，把结果补进宿主进程，并让宿主读密钥、找外部应用用的启动快照先看这份。宿主网络代理也按登录 shell 的代理变量重装。
2. **顺链接写 + 归一化。** dotfiles 用软链接管理按机器不同的凭据、profile 补丁层（`.credentials.yaml -> .credentials.main.yaml`）。DSH 保存时先写临时文件再改名顶替目标，如果目标是软链，被换掉的就会是链接本身。本插件把这种改名改道到链接最终指向的文件；落盘前把 `cordis.patch.*.yml` 的引号、行内数组空格、`\U` emoji 转义归一成仓库标准写法，避免纯格式差被图形界面显示成改动。

## 使用条件和安装

需要兼容的 DeepSeek Harness（DSH）、Node.js `^22.19.0 || >=24.0.0` 和 pnpm。保留所在仓库中与插件相邻的共用 `tooling/` 目录，不能只拿本目录单独构建。在本插件目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

在 DSH profile 的包清单中合入链接依赖和组合包（示例路径改成相对你的 profile 目录）：

```json
{
  "dependencies": {
    "dsh-runtime": "link:../../path/to/oh-my-harness/dsh-runtime"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-runtime"]
    }
  }
}
```

组合包已经登记条目，不要重复插入。装好后用 DSH 支持的 pnpm 安装 profile 依赖，先校验 profile 再重启 DSH。

## 行为和与 DSH 的分工

- 登录环境只在插件加载时读一次；读失败只记一条警告，环境保持启动方给的样子。宿主的 `DSH_*`、`ELECTRON_*` 和探测 shell 自己的会话变量不动。
- 顺链接写只处理 `node:fs/promises` 的 `rename`；同步版和回调版不改。多层链接一直解析到底，指向的文件不存在就新建。临时文件和目标不在同一磁盘时先复制到旁边再改名。
- 归一化只作用于 `cordis.patch.*.yml`。**规则只由本插件维护，没有 git 过滤器再分担一份。**
- **已知取舍：** 没有提交时兜底。只有经过本插件 `rename` 包装的 DSH 保存才归一化；插件加载前发生的保存、手动编辑后直接提交的文件都不处理。

## 配置

组合包条目 ID 是 `runtime`。**没有运行时配置项。** 禁用：

```yaml
- id: runtime
  disabled: true
```

代码改动需要重新构建并重启 DSH。只重新打开网页不会重新加载宿主插件。

## 开发和验证

```sh
pnpm run check      # typecheck + build + 单测
```

单测覆盖登录环境解析与快照接管、代理环境优先级；顺链接写覆盖 `writeFileAtomic` 与加载器两种临时文件命名、多层链接、悬空链接、循环链接、卸载恢复；归一化覆盖原样例、幂等、块标量与注释保留。

## 许可

MIT。见 [LICENSE](LICENSE)。
