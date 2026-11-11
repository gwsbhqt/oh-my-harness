中文 | [English](README.en.md)

# dsh-history-cap

[← 返回首页](../README.md#由哪几块组成) · [教程](../docs/dsh-history-cap.md)

**一句话：** 打开很长的会话时，界面分页加载历史，不一次拉完。只影响界面，不影响模型看到的内容。

限制 DSH 每次回复界面时发送的历史记录数，避免某一轮工具事件很多，就一次加载出巨大页面。它改善历史传送，不裁剪模型上下文，也不减少模型 token 用量。

## 使用条件和安装

需要兼容的 DeepSeek Harness（DSH），提供会话控制器的历史服务。还需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。包清单记录已测试的宿主依赖；当前测试使用 DSH 0.2.2-rc.1。保留所在仓库中与插件相邻的共用 `tooling/` 目录。不能只拿这个源码目录单独构建。

在本插件目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

在 DSH profile 的包清单中合入链接依赖和组合包：

```json
{
  "dependencies": {
    "dsh-history-cap": "link:../../path/to/oh-my-harness/dsh-history-cap"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-history-cap"]
    }
  }
}
```

把示例链接改成相对于你的 profile 目录的路径。使用 DSH 支持的 pnpm 安装 profile 依赖。提供启动检查器时先校验 profile，再重启 DSH。组合包已经登记条目，不要重复插入。

## 行为和与 DSH 的分工

DSH 的历史服务可能把整轮当成一页返回。插件包住现有控制器的 `page`、`events` 和 `follow` 方法。一份回复超过 1000 条记录时，只返回最新 1000 条，并设 `hasMore: true`。界面现有的**加载更早**操作可以继续取前面的记录。持续跟随的流只限制第一帧快照，后续实时更新原样通过。

插件不修改会话文件，不按事件类型筛选，也不删除已存历史。它不改助手发给模型的请求。卸载时，如果包装方法仍归本插件所有，就恢复继承的控制器方法。

这层包装依赖宿主控制器方法及其继承实现。宿主升级可能改变约定，部署前要对新宿主跑测试。DSH 自己提供等效的原始记录分页上限后，再移除本插件。

## 配置

组合包条目 ID 是 `history-cap`。**没有运行时配置项。** 上限来自源码常量 `DEFAULT_MAX_HISTORY_RECORDS = 1000`。测试中的辅助函数参数不是 profile 设置。

在 profile 补丁中禁用条目：

```yaml
- id: history-cap
  disabled: true
```

代码改动需要重新构建并重启 DSH。只重新打开网页不会重新加载宿主插件。

## 开发和验证

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

大型历史测试在一轮中构造 24000 条虚构记录，检查打开历史、向前连续分页没有缺口、取消原始流、实时更新透传和卸载恢复。测试按宿主网关的同样方式查找方法。这不能代替界面性能测量；部署后还要在真实界面切换普通会话和大历史会话，核对加载更早记录的操作。

## 许可

MIT。见 [LICENSE](LICENSE)。
