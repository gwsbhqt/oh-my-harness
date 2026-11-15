# dsh-grep-scope

给模型的文件搜索加一个「全部」范围：需要时连隐藏目录和被忽略的文件一起搜（版本库元数据除外）。

## 它做什么

- 不修改宿主安装包，而是在每个 Agent 自身的工具层注册同名 `grep`/`glob`，遮蔽官方版本。
- `grep` 增加可选 `scope`：`normal`（默认，尊重忽略规则、不自动搜隐藏目录）与 `all`（含隐藏和被忽略路径，排除 `.git`/`.hg`/`.svn`/`.jj` 元数据）。
- 默认跳过依赖与缓存目录（`node_modules`、`.venv`、`site-packages`、`__pycache__` 等）；只有路径或类型里点到这些名字时才搜进去。
- 输出过多时在 10 MB 处提前停并标 `outputCapped`；长行按 2000 字节截短并标 `clippedLines`。
- `glob` 也能进 `app.asar`：自动解出只读副本再搜，宿主 `read` 读不了的打包内路径给出可读副本路径。

## 安装与配置

profile `dependencies` 用 `link:` 指到本目录，`dsh.profile.bundles` 加 `dsh-grep-scope`。插件自带补丁层插入一条 `id: grep-scope`，**不要**手写第二条 insert。

## 依赖与降级

- 无外部服务依赖；依赖宿主 `dsh-tool-fs-search`、子进程、ripgrep 与结果保存接口。
- 调用方要根据自己传入的 `scope` 判断覆盖范围；返回 `matches: []` 只代表所选范围里没有匹配，不能证明全库不存在。

## 验证

`pnpm run check`（typecheck + build + test）。真实：在专用夹具工作区用 `scope: all` 搜隐藏/被忽略文件，确认覆盖范围和「没找到也不误报全库为零」。

## 升级注意

宿主 `dsh-tool-fs-search` 的子进程、输出解析、保存接口与预设采样开关都是内部约定，DSH 升级后重跑 check 并在真实会话里点一遍。
