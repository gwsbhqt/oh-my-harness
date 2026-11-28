"""截图拼图、对比和标注，以及 GIF 和视频的按时间抽帧拼图。

内置中文字体回退链和中文折行；成品长边默认不超过 3900 像素。
"""

from __future__ import annotations

import glob
import os
import warnings
from typing import Literal
from PIL import Image, ImageDraw, ImageFont

FONTS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
]
LINUX_FONT_PATTERNS = [
    "/usr/share/fonts/**/NotoSansCJK*.ttc",
    "/usr/share/fonts/**/NotoSansCJK*.otf",
    "/usr/local/share/fonts/**/NotoSansCJK*.ttc",
    "/usr/local/share/fonts/**/NotoSansCJK*.otf",
    "/usr/share/fonts/**/wqy-zenhei.ttc",
    "/usr/share/fonts/**/wqy-microhei.ttc",
    "/usr/share/fonts/**/DroidSansFallbackFull.ttf",
]
BG = (245, 246, 248)
INK = (24, 28, 36)
SUB = (120, 128, 145)
BORDER = (210, 214, 222)
ACC = (37, 99, 235)
RED = (220, 38, 38)
WHITE = (255, 255, 255)
DEFAULT_MAX_EDGE = 3900

def _find_font():
    """按 macOS 和 Linux 的常见安装位置寻找可渲染中文的字体。"""
    candidates = FONTS + [path for pattern in LINUX_FONT_PATTERNS
                          for path in sorted(glob.glob(pattern, recursive=True))]
    return next((path for path in candidates if os.path.isfile(path)), None)


_FONT_PATH = _find_font()


def font(size, idx=0):
    """中文字体；idx=1 取 ttc 里的第二个字重（ PingFang 的粗体），拿不到退第一个。"""
    if _FONT_PATH is None:
        warnings.warn("未找到 CJK 中文字体，中文可能显示为方框；请安装 Noto Sans CJK 或文泉驿字体。当前回退到 Pillow 默认字体。",
                      RuntimeWarning, stacklevel=2)
        return ImageFont.load_default()
    try:
        return ImageFont.truetype(_FONT_PATH, size, index=idx)
    except Exception:
        return ImageFont.truetype(_FONT_PATH, size)


def _wrap(dr, text, f, maxw):
    """按像素宽度逐字折行（中文没有空格，英文单词会被拆开，接受这一点）。"""
    line, lines = "", []
    for ch in text:
        if dr.textlength(line + ch, font=f) > maxw and line:
            lines.append(line)
            line = ch
        else:
            line += ch
    return lines + [line]


def _open(path):
    return Image.open(path).convert("RGB")


def _contain(im, cw, ch, upscale=False):
    """等比放进 cell，居中贴在白底上。"""
    if upscale and im.width < cw and im.height < ch:
        scale = min(cw / im.width, ch / im.height)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    im.thumbnail((cw, ch), Image.LANCZOS)
    cell = Image.new("RGB", (cw, ch), WHITE)
    cell.paste(im, ((cw - im.width) // 2, (ch - im.height) // 2))
    return cell


def _fit_scale(w, h, max_edge):
    m = max(w, h)
    return 1.0 if m <= max_edge else max_edge / m


def _chip(dr, x, y, num, size=44, color=ACC):
    """编号小方块 + 白色两位数。"""
    dr.rounded_rectangle((x, y, x + size, y + size), radius=max(4, size // 7), fill=color)
    f = font(size // 2, 1)
    t = f"{num:02d}"
    dr.text((x + size / 2 - dr.textlength(t, font=f) / 2, y + size * 0.22), t, font=f, fill=WHITE)


def _notes_block(dr, x0, y0, x1, notes, pad=40):
    """白卡说明块；先量出总高再画卡片，返回占用的底部 y。"""
    blocks = [(k, _wrap(dr, v, font(24), (x1 - x0) - pad * 2)) for k, v in notes]
    total = sum(42 + len(lines) * 36 + 24 for _, lines in blocks)
    y1 = y0 + pad + total + pad - 24
    dr.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=WHITE, outline=BORDER, width=2)
    yy = y0 + pad
    for k, lines in blocks:
        dr.text((x0 + pad, yy), k, font=font(28, 1), fill=INK)
        for j, l in enumerate(lines):
            dr.text((x0 + pad, yy + 42 + j * 36), l, font=font(24), fill=(72, 80, 97))
        yy += 42 + len(lines) * 36 + 24
    return yy + pad - 24


def _validate_geometry(cell, max_edge):
    if len(cell) != 2 or any(type(v) is not int or v <= 0 for v in cell):
        raise ValueError("cell 必须是两个正整数")
    if type(max_edge) is not int or max_edge <= 0:
        raise ValueError("max_edge 必须是正整数")


def sheet(panels: list[tuple[str, str] | tuple[str, str, str]], out: str, *,
          title: str | None = None, subtitle: str | None = None, cols: int = 2,
          notes: list[tuple[str, str]] | None = None,
          cell: tuple[int, int] = (1200, 750), max_edge: int = DEFAULT_MAX_EDGE,
          upscale: bool = False, label_position: Literal["above", "below"] = "above"):
    """网格审查大图。

    panels: [(图片路径, 中文标题)] 或 [(图片路径, 中文标题, 灰色来源行)]，按行优先编号排版。
    out: 输出图片路径。title/subtitle 是标题；cols 是每行列数，必须为正整数。
    notes: 可省；[(小标题, 正文)]，放进末行余白，末行满了就整行追加在网格下面。
    cell: 每格图片的宽、高像素，两个正整数；max_edge 是成品长边上限。
    upscale 为 True 时等比放大尺寸小于格子的图片，默认不放大。
    label_position 为 "above"（默认）时标题在图片上方，为 "below" 时标题移到图片下方；
    编号、来源行一起移动，面板顺序、脚注和 source 字段都不变，整体几何只换标签带位置。
    返回 {"out", "width", "height"}。长边保证 ≤ max_edge。
    """
    _validate_geometry(cell, max_edge)
    if type(upscale) is not bool:
        raise ValueError("upscale 必须是布尔值")
    if label_position not in ("above", "below"):
        raise ValueError('label_position 只能是 "above" 或 "below"')
    if not panels:
        raise ValueError("panels 至少需要一张图片")
    if type(cols) is not int or cols <= 0:
        raise ValueError("cols 必须是正整数")
    M, GAP, LABEL_H = 48, 32, 72
    panels = [tuple(p) for p in panels]
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    rows = (len(panels) + cols - 1) // cols
    last_row_count = len(panels) - (rows - 1) * cols
    spare_cols = cols - last_row_count
    head = 0 if not (title or subtitle) else (150 if subtitle else 110)

    def measure(width):
        """notes 在给定宽度下逐块折行后的总行高（含块间距，不含卡片内边距）。"""
        blocks = [(k, _wrap(probe, v, font(24), width - 80)) for k, v in notes] if notes else []
        return blocks, sum(42 + len(lines) * 36 + 24 for _, lines in blocks)

    def geometry(cw, ch):
        """返回 (W, H, place, below_h)：notes 放得下末行余白就放，放不下整行追加在网格下。"""
        W = M * 2 + cols * cw + (cols - 1) * GAP
        grid_h = rows * (LABEL_H + ch) + (rows - 1) * GAP
        H = head + M + grid_h + M
        place, below_h = None, 0
        if notes:
            if spare_cols:
                notes_w = spare_cols * cw + (spare_cols - 1) * GAP
                _, total = measure(notes_w)
                if total <= ch - 80:  # 卡片上下内边距各 40
                    place = "spare"
            if place is None:
                _, total = measure(W - M * 2)
                below_h = total + 96  # 卡片内边距 80 + 与网格间距 16
                H += below_h
                place = "below"
        return W, H, place, below_h

    for _ in range(6):
        cw, ch = cell
        W, H, place, below_h = geometry(cw, ch)
        s = _fit_scale(W, H, max_edge)
        if s >= 1.0:
            break
        cell = (max(1, int(cw * s)), max(1, int(ch * s)))
    grid_h = rows * (LABEL_H + ch) + (rows - 1) * GAP
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    if title:
        dr.text((M, 40), title, font=font(46, 1), fill=INK)
    if subtitle:
        dr.text((M, 104), subtitle, font=font(24), fill=SUB)
    for i, p in enumerate(panels):
        path, label = p[0], p[1]
        source = p[2] if len(p) > 2 else None
        r, c = divmod(i, cols)
        x = M + c * (cw + GAP)
        y = head + M + r * (LABEL_H + ch + GAP)
        # 标签带固定在每格顶部（above）或底部（below），图片摆到另一侧；整格高度不变。
        if label_position == "below":
            img_y, band_y = y, y + ch
        else:
            img_y, band_y = y + LABEL_H, y
        _chip(dr, x, band_y + 10, i + 1)
        dr.text((x + 58, band_y + 6), label, font=font(32, 1), fill=INK)
        if source:
            f = font(20)
            dr.text((x + cw - dr.textlength(source, font=f), band_y + 20), source, font=f, fill=SUB)
        img.paste(_contain(_open(path), cw, ch, upscale=upscale), (x, img_y))
        dr.rectangle((x - 1, img_y - 1, x + cw, img_y + ch), outline=BORDER, width=2)
    if notes and place == "spare":
        notes_w = spare_cols * cw + (spare_cols - 1) * GAP
        x0 = M + last_row_count * (cw + GAP)
        # 说明卡与最后一行图片对齐；标签带在下方时图片贴行顶，上方时在标签带之后。
        y0 = head + M + (rows - 1) * (LABEL_H + ch + GAP) + (0 if label_position == "below" else LABEL_H)
        x1 = x0 + notes_w
        y1 = y0 + ch
        dr.rounded_rectangle((x0, y0, x1, y1), radius=16, fill=WHITE, outline=BORDER, width=2)
        limit = y1 - 36  # 卡片底边以内最后一行的基线
        # 排版时已确认放得下；这里仍留截断兜底，防量算与绘制不一致
        blocks = [(k, _wrap(dr, v, font(24), notes_w - 80)) for k, v in notes]
        total = sum(42 + len(lines) * 36 + 24 for _, lines in blocks)
        avail = limit - (y0 + 40)
        reserve = 56 if total > avail else 0
        yy = y0 + 40
        truncated = 0
        for k, lines in blocks:
            need = 42 + len(lines) * 36
            if yy + need > limit - reserve:
                truncated += len(lines)
                continue
            dr.text((x0 + 40, yy), k, font=font(28, 1), fill=INK)
            for j, l in enumerate(lines):
                dr.text((x0 + 40, yy + 42 + j * 36), l, font=font(24), fill=(72, 80, 97))
            yy += need + 24
        if truncated:
            dr.text((x0 + 40, limit - 30), f"…（省略 {truncated} 行，说明太长放不下）", font=font(20), fill=SUB)
    elif notes and place == "below":
        y0 = head + M + grid_h + 16
        _notes_block(dr, M, y0, W - M, notes)
    s = _fit_scale(W, H, max_edge)
    if s < 1.0:
        img = img.resize((max(1, int(W * s)), max(1, int(H * s))), Image.LANCZOS)
    img.save(out, optimize=True)
    return {"out": out, "width": img.width, "height": img.height}


def compare(pairs: list[tuple[str, str] | tuple[str, str, str]], out: str, *,
            title: str | None = None, labels: tuple[str, str] = ("改前", "改后"),
            cell: tuple[int, int] = (880, 550), max_edge: int = DEFAULT_MAX_EDGE):
    """改前/改后对比图：每行一对，行首是标题，图上是改前/改后角标。

    pairs: [(改前路径, 改后路径)] 或 [(改前路径, 改后路径, 行标题)]，至少一对。
    out 是输出路径，title 是总标题，labels 是改前/改后两段角标文字。
    cell 为每格宽、高像素的正整数对；max_edge 是成品长边上限。
    返回 {"out", "width", "height"}。
    """
    _validate_geometry(cell, max_edge)
    if not pairs:
        raise ValueError("pairs 至少需要一对图片")
    M, GAP, LABEL_H = 48, 32, 64
    pairs = [tuple(p) for p in pairs]
    for _ in range(6):
        cw, ch = cell
        head = 110 if title else 0
        W = M * 2 + 2 * cw + GAP
        H = head + M + len(pairs) * (LABEL_H + ch + GAP) + M
        s = _fit_scale(W, H, max_edge)
        if s >= 1.0:
            break
        cell = (max(1, int(cw * s)), max(1, int(ch * s)))
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    if title:
        dr.text((M, 40), title, font=font(46, 1), fill=INK)
    for i, p in enumerate(pairs):
        before, after, label = p[0], p[1], (p[2] if len(p) > 2 else "")
        y = head + M + i * (LABEL_H + ch + GAP)
        _chip(dr, M, y + 6, i + 1)
        dr.text((M + 58, y + 2), label, font=font(32, 1), fill=INK)
        for j, path in enumerate((before, after)):
            x = M + j * (cw + GAP)
            img.paste(_contain(_open(path), cw, ch), (x, y + LABEL_H))
            dr.rectangle((x - 1, y + LABEL_H - 1, x + cw, y + LABEL_H + ch), outline=BORDER, width=2)
            tag = labels[j]
            f = font(22, 1)
            tw = dr.textlength(tag, font=f)
            dr.rounded_rectangle((x + 10, y + LABEL_H + 10, x + 26 + tw, y + LABEL_H + 44), radius=6, fill=INK)
            dr.text((x + 18, y + LABEL_H + 14), tag, font=f, fill=WHITE)
    s = _fit_scale(W, H, max_edge)
    if s < 1.0:
        img = img.resize((max(1, int(W * s)), max(1, int(H * s))), Image.LANCZOS)
    img.save(out, optimize=True)
    return {"out": out, "width": img.width, "height": img.height}


def annotate(image: str, boxes: list[tuple[int | float, int | float, int | float, int | float]],
             out: str | None = None, *, max_edge: int = DEFAULT_MAX_EDGE,
             start: int = 1, width: int = 6):
    """红框编号标注：boxes 是 [(x, y, w, h)]，原图像素；四个值都 ≤1 且至少一个是小数时按相对比例算。

    image 是原图路径；out 缺省在原图旁边加 -annotated 后缀。
    max_edge 是成品长边上限；start 是首个编号，width 是框线像素，均为正整数。
    返回 {"out", "width", "height"}。
    """
    _validate_geometry((1, 1), max_edge)
    if type(width) is not int or width <= 0 or type(start) is not int or start < 1:
        raise ValueError("width 和 start 必须是正整数")
    if not boxes or any(len(box) != 4 or box[2] <= 0 or box[3] <= 0 for box in boxes):
        raise ValueError("boxes 至少需要一个包含 x、y、正宽、正高的框")
    im = _open(image)
    W, H = im.size
    dr = ImageDraw.Draw(im)
    for i, b in enumerate(boxes):
        x, y, w, h = b
        # JSON 和手写的相对框里 0 常写成整数，只要求至少一个是小数
        if all(v <= 1 for v in b) and any(isinstance(v, float) for v in b):
            x, y, w, h = x * W, y * H, w * W, h * H
        x, y, w, h = int(x), int(y), int(w), int(h)
        dr.rectangle((x, y, x + w, y + h), outline=RED, width=width)
        r = 26
        cx, cy = x + r + 4, y + r + 4
        dr.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED)
        f = font(30, 1)
        t = str(start + i)
        dr.text((cx - dr.textlength(t, font=f) / 2, cy - 20), t, font=f, fill=WHITE)
    s = _fit_scale(W, H, max_edge)
    if s < 1.0:
        im = im.resize((max(1, int(W * s)), max(1, int(H * s))), Image.LANCZOS)
    if out is None:
        root, ext = os.path.splitext(image)
        out = root + "-annotated" + (ext or ".png")
    im.save(out, optimize=True)
    return {"out": out, "width": im.width, "height": im.height}


from .media import extract_frames, media_sheet
