"""Render a reproducible review using fictional images, without network access."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw
import shot_sheet


def _screen(path, title, done, accent):
    image = Image.new("RGB", (720, 480), "#f4f6fa")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 720, 76), fill="#172033")
    draw.text((110, 18), "示例工作台 · " + title, font=shot_sheet.font(28, 1), fill="white")
    draw.text((28, 96), "虚构项目：春日展览", font=shot_sheet.font(23), fill="#172033")
    for index, label in enumerate(("准备展签", "摆放展品", "检查灯光")):
        y = 148 + index * 96
        draw.rounded_rectangle((28, y, 692, y + 74), radius=12, fill="white", outline="#d7dce5", width=2)
        draw.ellipse((48, y + 23, 76, y + 51), fill=accent if index < done else "#d7dce5")
        draw.text((96, y + 19), label, font=shot_sheet.font(25), fill="#172033")
        draw.text((562, y + 22), "已完成" if index < done else "待处理",
                  font=shot_sheet.font(20), fill=accent if index < done else "#67748c")
    image.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out_dir", type=Path, help="A new output directory")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=False)
    before, after = args.out_dir / "before.png", args.out_dir / "after.png"
    _screen(before, "改前", 1, "#d76525")
    _screen(after, "改后", 3, "#16736d")
    marked = shot_sheet.annotate(str(after), [(480, 162, 192, 240)],
                                 str(args.out_dir / "annotated.png"), width=4)
    comparison = shot_sheet.compare([(str(before), str(after), "完成状态核对")],
                                     str(args.out_dir / "comparison.png"), cell=(720, 480))
    animation = args.out_dir / "animation.gif"
    with Image.open(before) as first, Image.open(after) as second:
        first.save(animation, save_all=True, append_images=[second], duration=[300, 700], loop=0)
    frames = shot_sheet.extract_frames(str(animation), str(args.out_dir / "frames"), times=[0.1, 0.6])
    timeline = shot_sheet.media_sheet(str(animation), str(args.out_dir / "timeline.png"),
                                      times=[0.1, 0.6], cols=2, cell=(720, 480))
    result = shot_sheet.sheet([
        (comparison["out"], "改前改后", "comparison"),
        (marked["out"], "编号红框", "annotation"),
        (timeline["out"], "GIF 按时间取帧", "0.100 s / 0.600 s"),
    ], str(args.out_dir / "review.png"), title="截图审查 · 虚构素材验收",
       subtitle="现场生成输入，核对顺序、字体、时间与标注", cols=2, cell=(960, 640),
       notes=[("验收范围", "输入和输出均为虚构素材。第一格左侧完成一项、右侧完成三项；第二格框住三个状态；第三格按时间先后排列。")])
    print(json.dumps({**result, "frames": frames["frames"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
