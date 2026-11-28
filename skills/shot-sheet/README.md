中文 | [English](README.en.md)

# shot-sheet

把多张截图排成带标题和编号的审查图，制作改前改后对比，或在图片上标出编号红框。也可以按时间从 GIF、视频抽帧，再拼成一张图。

所有处理都在本机完成，不上传输入。Python 函数和命令行共用实现；不需要运行浏览器、桌面应用或 DSH。

## 安装与入口

需要 Python 3.10 或更新版本，以及 Pillow 10 或更新版本。视频抽帧还需要系统提供 `ffmpeg` 和 `ffprobe`；GIF 与静态图片不需要 FFmpeg。中文标题需要可用的 CJK 字体：macOS 通常使用 PingFang，Linux 可安装 Noto Sans CJK。字体和 FFmpeg 不随本包分发。

从仓库根目录安装命令：

```sh
uv tool install ./skills/shot-sheet
shot-sheet --help
```

只从源码运行时，保留相邻的 `skills/_shared` 目录，并执行：

```sh
uv run --project skills/shot-sheet shot-sheet --help
```

[源码启动脚本](scripts/shot-sheet)也可用 `uv run --script skills/shot-sheet/scripts/shot-sheet --help` 运行。它通过 uv 解析 Pillow 依赖；离线使用前先安装或缓存依赖。已安装的 wheel 包含共用命令行适配器，不依赖源码树或任何个人技能目录。

Agent 使用时，把本目录加入宿主的可信技能路径。有 Python 技能内核时阅读 [PYSKILL.md](PYSKILL.md)，直接调用 `skills.shot_sheet`；其他环境阅读 [SKILL.md](SKILL.md)。宿主发现源码不会自动安装依赖。普通 Python 项目安装本包后使用 `import shot_sheet`。

持久 Python 内核需要 Pillow 10 或更高版本。首次导入时若提示缺少 `PIL`，可在当前内核补装依赖并重新加载技能。[内核恢复步骤](PYSKILL.md)

## 常用操作

以下输入文件由调用者提供。图片顺序就是排版顺序。

```sh
shot-sheet sheet --panels '[["first.png","第一屏"],["second.png","第二屏"]]' --out review.png --cols 2
shot-sheet compare --pairs '[["before.png","after.png","总览"]]' --out comparison.png
shot-sheet annotate --image page.png --boxes '[[120,300,400,200]]' --out annotated.png
shot-sheet media-sheet --source demo.gif --out timeline.png --count 8 --cols 4
shot-sheet extract-frames --source demo.mp4 --out-dir frames --times '[1.0,3.5,8.0]'
```

Python 接口提供 `sheet`、`compare`、`annotate`、`extract_frames`、`media_sheet` 五个同步函数。完整参数见[命令参考](references/cli.md)及[图像函数](src/shot_sheet/__init__.py)、[媒体函数](src/shot_sheet/media.py)。

## 输出与限制

- 图片结果返回 `out`、`width`、`height`；默认成品长边不超过 3900 像素。媒体结果还含时长与请求的采样时间。抽帧结果返回各帧路径、尺寸和时间。
- 视频取请求时刻正在显示的实际帧；支持格式取决于本机 FFmpeg，文件必须有可读取的时长。默认等分为 8 段并取中点，最多 200 帧。
- 抽帧拒绝覆盖已有帧。`media_sheet` 默认拒绝覆盖，显式 `overwrite=True` 才覆盖成品。`sheet`、`compare` 和 `annotate` 会覆盖指定输出，调用前必须确认路径属于本任务且不同于输入。
- 缺少中文字体时会警告并回退到 Pillow 默认字体，中文可能不可读。必须打开实际成品核对顺序、标题、裁切和标注；命令成功不代表画面已经验收。

失败、取消与清理规则见[共用规则](references/common.md)。没有公开网络服务、安装状态或用户素材随技能发布。

## 测试与分发

从仓库根目录准备环境，再运行不联网的测试：

```sh
uv sync --project skills/shot-sheet --extra test
uv run --offline --no-sync --project skills/shot-sheet python -m pytest skills/shot-sheet/tests -q
```

测试现场生成虚构图片和 GIF，核验尺寸、颜色顺序、相对坐标、采样边界、覆盖保护及命令行结果。安装了 FFmpeg 时还会生成并读取 MP4、MOV、MKV、WebM；没有时明确跳过视频测试。Linux 的中文排版测试需要 CJK 字体，例如 Debian/Ubuntu 的 `fonts-noto-cjk`。

用[虚构素材生成器](tests/render_fixture.py)复现视觉验收，输出目录必须尚不存在：

```sh
uv run --offline --no-sync --project skills/shot-sheet python skills/shot-sheet/tests/render_fixture.py skills/shot-sheet/.artifacts/review
```

打开生成的 `review.png` 核对中文、图片顺序、红框和时间标签。素材在本机生成，不含真实界面或账号。

发布测试在临时目录构建 wheel 和源码包，再从源码包重新构建 wheel，核对独立安装后的真实命令输出。源码包白名单包含说明、参考、测试和源码；wheel 仅包含 Python 实现、命令入口及许可信息。测试不访问账号、桌面或外部网络。

## 来源与许可

这是 oh-my-harness 维护的原创技能，按 [MIT 许可证](LICENSE)发布。命令行复用同仓库 `skills/_shared/agentkit/cli.py`，构建时带入包内，不另行维护一份副本。Pillow 是独立安装的第三方依赖，遵循其自身许可证；FFmpeg 和系统字体也遵循各自许可证。
