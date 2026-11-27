---
name: shot-sheet
description: 从 GIF 或视频按时间抽帧并拼图，也可拼多张截图、制作改前改后对比图或添加编号红框。
---

# shot-sheet

有 Python 技能内核的 agent 读取 [PYSKILL.md](PYSKILL.md)，直接调用 `skills.shot_sheet` 完整下划线入口；无内核的 agent 读取 [SKILL.md](SKILL.md)，使用正式命令行入口。只有未提供 PYSKILL.md 时才读取 SKILL.md；读取、格式、导入或调用错误必须先报告并处理，不得换说明、shell、subprocess 或临时脚本绕过接口。两份说明属于同一正式技能，只在示例调用方式上不同。

开始前阅读 [共用规则](references/common.md)。完整选项见 [命令参数参考](references/cli.md)，函数签名见 [函数参数参考](src/shot_sheet/__init__.py)。

一次看两张以上截图，先拼一张审查图再打开。先确认输入顺序、中文标题、输出路径，以及本次对比或标注的位置。生成与抽帧函数在进程内同步完成；函数调用不加 `await`。

## 动图与视频抽帧

本地 GIF 可直接处理；视频需要安装 `ffmpeg` 和 `ffprobe`（macOS 可用 `brew install ffmpeg`），格式支持取决于本机 FFmpeg，素材须有可读取的时长。直接生成拼图时，默认将全长均分为 8 段并取每段中点；可调整起止时间、帧数、列数、每格尺寸和成品长边。图上标注请求的采样时间，视频画面取该时刻正在显示的实际帧。小画面默认等比放大，可用 `upscale` 关闭。

```python
result = skills.shot_sheet.media_sheet(
    "demo.mp4", "review-sheet.png", count=8, start=0, end=12,
    title="演示视频审查", cols=4, cell=(600, 380), max_edge=3900,
)
result
```

```python
frames = skills.shot_sheet.extract_frames(
    "demo.mp4", "frames", times=[1.0, 3.5, 8.0], frame_max_edge=1600,
)
frames
```

视频默认等待每条 FFmpeg 命令完成。需要限时时，可将 `timeout` 设为大于零的有限秒数，命令行使用 `--timeout`。读取视频信息、定位每帧和解码每帧各自计时。超时会报告程序名、当时的操作和等待上限。

也可用 `interval` 从起点按秒间隔抽帧，或用 `times` 指定时间列表；这些方式不能与 `count` 同时使用。仅导出帧时返回各帧路径、采样时间和尺寸；一键拼图会清理临时帧并返回成品尺寸、素材时长和采样时间。默认不覆盖已有输出，只有拼图显式设置 `overwrite` 才能覆盖。

## 网格审查

每张图给路径、标题，也可带灰色来源行。主标题、来源说明、列数与末行余白的说明按实际任务填写。

```python
result = skills.shot_sheet.sheet(
    panels=[("shots/01.png", "组件库 · 1/2", "components.html?sheet=1"),
            ("shots/02.png", "组件库 · 2/2", "components.html?sheet=2")],
    out="review-sheet.png", title="项目名 — 方案名", subtitle="本次组件库截图",
    cols=2, notes=[("设计语言", "像一本做得很细的账本……")],
)
result
```

## 改前改后对比

每行一对图片，使用相同页面的改前与改后截图；对比标题与两侧标签可以调整。

```python
result = skills.shot_sheet.compare(
    pairs=[("before/01.png", "after/01.png", "总览页")], out="compare.png", title="改版对比",
)
result
```

## 编号红框

框使用原图的横坐标、纵坐标、宽和高，也支持 0 到 1 的相对比例。编号起点和线宽可调整。

```python
result = skills.shot_sheet.annotate(
    "page.png", [(120, 300, 400, 200), (0.5, 0.1, 0.3, 0.2)], out="annotated.png",
)
result
```

按任务选一种生成方式，不必全部执行。正式入口未安装时，命令的备用脚本入口见 [命令参数参考](references/cli.md)。列表、尺寸和参数 JSON 的编码也在该参考中。

## 核对与收尾

拼图和标注结果包含 `out`、`width`、`height`；单独抽帧返回 `frames`。默认成品长边不超过 3900；核对实际尺寸，再用宿主读图工具打开 `out`。按 [共用规则](references/common.md) 核对图片顺序、中文标题、标注位置、字体和最终尺寸，再交付成品路径。

命令成功退出 0，stdout 是结果 JSON；参数 JSON 或签名错误退出 2，生成失败退出 1，原因在 stderr JSON。函数调用直接返回结果字典，失败时保留异常原文。缺字体可能让中文变方块，要看实际成品再报告结果。输入保护、失败取消后的部分输出与清理由共用规则统一维护。
