# shot-sheet 命令行

日常流程见 [CLI 主说明](../SKILL.md)，Python 调用见 [Python 主说明](../PYSKILL.md)。结果和验收统一见 [共用规则](common.md)。

正式命令是 `shot-sheet`。安装方式见 [README](../README.md)；未安装时从仓库根目录运行 `uv run --script skills/shot-sheet/scripts/shot-sheet`。命令复用 `sheet`、`compare`、`annotate`、`extract_frames` 和 `media_sheet` 函数。普通参数用完整连字符选项，图片、框和注释列表用 JSON：

```bash
shot-sheet sheet --panels '[["shots/01.png","第一屏"],["shots/02.png","第二屏"]]' --out review-sheet.png --cols 2
shot-sheet compare --input '{"pairs":[["before.png","after.png","总览"]],"out":"compare.png"}'
shot-sheet annotate --image page.png --boxes '[[120,300,400,200],[0.5,0.1,0.3,0.2]]' --out annotated.png
shot-sheet media-sheet --source demo.mp4 --out review.png --count 8 --cols 4
shot-sheet extract-frames --source demo.gif --out-dir frames --interval 0.5
shot-sheet media-sheet --help
```

## 详细参数

| 命令 | 参数与默认值 |
| --- | --- |
| `sheet` | `--panels` 必填 JSON，元素为 `[路径,标题]` 或 `[路径,标题,来源行]`；`--out` 必填；`--title`、`--subtitle` 可省略；`--cols` 默认 2；`--notes` 为 `[标题,说明]` 列表；`--cell` 默认 `[1200,750]`；`--max-edge` 默认 3900；`--upscale` 默认 false |
| `compare` | `--pairs` 必填 JSON，元素为 `[改前路径,改后路径]` 或再加一个标题；`--out` 必填；`--title` 可省略；`--labels` 默认 `["改前","改后"]`；`--cell` 默认 `[880,550]`；`--max-edge` 默认 3900 |
| `annotate` | `--image` 与 `--boxes` 必填；每框为 `[x,y,宽,高]`；`--out` 可省略，由函数生成路径；`--start` 默认 1；`--width` 默认 6；`--max-edge` 默认 3900 |
| `extract-frames` | `--source` 和 `--out-dir` 必填；默认均分全长取 8 帧；`--count` 设置帧数，`--start` / `--end` 设置秒数范围，`--interval` 按秒间隔取帧，`--times` 用 JSON 列表指定采样秒数；`--frame-max-edge` 限制单帧长边，`--prefix` 默认 `frame`，`--max-frames` 默认 200。`--timeout` 可为每次 `ffprobe` 或 `ffmpeg` 调用设置等待上限，单位为秒，须为有限正数，默认等待命令完成 |
| `media-sheet` | `--source` 和 `--out` 必填；抽帧参数同上（无 `--prefix`）；拼图参数 `--title`、`--subtitle`、`--cols`、`--notes`、`--cell`、`--max-edge` 同 `sheet`；`--upscale` 默认 true，`--overwrite` 默认 false |

列表和二元尺寸都用 JSON。`--input` 是参数 JSON 对象，字段使用 Python 下划线名字；它可与选项混用，但不能重复字段。图片列表不能为空，尺寸与列数必须为正数。`count` 和 `interval` 互斥；`times` 不能与它们或起止范围同时使用。采样范围左闭右开，`count` 取每段中点，`interval` 从 `start` 开始。GIF 按帧时长取画面；视频需要 `ffmpeg` 和 `ffprobe`，格式支持取决于本机 FFmpeg，素材须有可读取的时长；按视频帧时间选取对应时刻的画面。成功时 stdout 输出结果 JSON；媒体拼图包含成品尺寸、素材时长和采样时间，单独抽帧包含每帧的路径和尺寸。JSON 或签名参数错误退出 2，函数执行失败（含业务参数校验）退出 1，原因写入 stderr JSON；成功退出 0。
