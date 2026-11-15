# dsh-settings

一个 DSH 设置包，把三页设置合成一个设置侧栏入口：

- **模式偏好**：按工作区选新会话的默认模式。
- **技能**：按全局和每个项目调整每个技能给模型看多少。
- **快捷回复**：输入框工具行的按钮，点一条预设话术直接发出；设置侧栏一页可编辑预设。

三页共用同一套「草稿 / 撤销 / 保存」页头；客户端插件不能跨插件共用代码，同一个包里才能共享这份页头。

## 装法

在 profile 的 `package.json` 里 `dependencies` 用 `link:` 指向本目录，`dsh.profile.bundles` 加 `dsh-settings`。
插件自带一个补丁层，插入唯一一条 `id: settings-prefs` 的条目；不要在 profile 里再手写同 id 的 insert。

## 配置

主配置只有一个开关（在 profile 的 `cordis.patch.yml` 写 `- id: settings-prefs` 加 `config:`）：

```yaml
- id: settings-prefs
  config:
    quickReply: false
```

`quickReply` 关掉后，输入框按钮和设置侧栏「快捷回复」页都不出现，改回 `true` 即时出现，不用重启。

其它设置都在界面上改：

- 模式偏好和快捷回复存在 `preferences.json` 的 `presetPreferences` / `quickReplies` 段。
- 技能规则存在 `~/.agents/skill-exposure.json`。

## 开发

```bash
pnpm install
pnpm run check   # typecheck + build + test
```

细节见 [AGENTS.md](AGENTS.md)。
