"""现场生成图片和媒体，核验排版、采样、输出保护及真实 CLI 共用行为。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from PIL import Image
import shot_sheet


def _img(path, size, color):
    Image.new("RGB", size, color).save(path)
    return path


def test_sheet_fits_max_edge_and_pastes(tmp_path):
    shots = [_img(str(tmp_path / f"{i}.png"), (1600, 1000), (i * 60, 100, 200)) for i in range(3)]
    out = str(tmp_path / "sheet.png")
    r = shot_sheet.sheet([(s, f"第{i+1}屏") for i, s in enumerate(shots)], out,
                 title="验收大图标题", notes=[("说明", "一段中文说明文字" * 10)], max_edge=900)
    assert os.path.exists(out)
    assert max(r["width"], r["height"]) <= 900
    im = Image.open(out).convert("RGB")
    # 三格图的内容色都应出现在成品里（LANCZOS 缩放保留实心区域的原色）
    colors = {c for _, c in im.getcolors(maxcolors=1 << 24)}
    assert (0, 100, 200) in colors and (60, 100, 200) in colors and (120, 100, 200) in colors


def test_long_notes_fall_below_the_grid(tmp_path):
    shots = [_img(str(tmp_path / f"{i}.png"), (1600, 1000), (i * 60, 100, 200)) for i in range(3)]
    out = str(tmp_path / "sheet.png")
    r = shot_sheet.sheet([(s, f"第{i+1}屏") for i, s in enumerate(shots)], out,
                 title="标题", notes=[("说明", "一段中文说明文字" * 10)], max_edge=900)
    assert max(r["width"], r["height"]) <= 900
    im = Image.open(out).convert("RGB")
    # 说明放不下末行余白时会整行追加在网格下面：底部 1/4 区域里应出现白卡
    band = im.crop((0, im.height * 3 // 4, im.width, im.height))
    colors = {c for _, c in band.getcolors(maxcolors=1 << 24)}
    assert shot_sheet.WHITE in colors


def test_compare_pairs(tmp_path):
    b = _img(str(tmp_path / "b.png"), (800, 500), (200, 50, 50))
    a = _img(str(tmp_path / "a.png"), (800, 500), (50, 200, 50))
    out = str(tmp_path / "cmp.png")
    r = shot_sheet.compare([(b, a, "总览页")], out, title="对比", max_edge=700)
    assert max(r["width"], r["height"]) <= 700


def test_annotate_absolute_and_relative(tmp_path):
    src = _img(str(tmp_path / "page.png"), (2000, 1200), (255, 255, 255))
    out = str(tmp_path / "ann.png")
    r = shot_sheet.annotate(src, [(100, 100, 300, 200), (0.5, 0.5, 0.2, 0.2)], out, max_edge=3900)
    im = Image.open(out)
    # 红框边框上必须是红色
    assert im.getpixel((103, 200))[0] > 180 and im.getpixel((103, 200))[1] < 80
    assert max(r["width"], r["height"]) <= 3900


def test_annotate_relative_box_with_integer_zero(tmp_path):
    src = _img(str(tmp_path / "page.png"), (1000, 500), (255, 255, 255))
    out = str(tmp_path / "ann.png")
    shot_sheet.annotate(src, [(0, 0.2, 0.5, 0.5)], out)
    im = Image.open(out)
    # 相对框落在 x 0..500、y 100..350：右边线上是红色
    assert im.getpixel((498, 200))[0] > 180 and im.getpixel((498, 200))[1] < 80


def test_annotate_very_flat_image_keeps_one_pixel(tmp_path):
    src = _img(str(tmp_path / "flat.png"), (5000, 1), (255, 255, 255))
    r = shot_sheet.annotate(src, [(1, 0, 10, 1)], str(tmp_path / "flat-out.png"), width=1)
    assert (r["width"], r["height"]) == (3900, 1)


def test_wrap_respects_pixel_width():
    im = Image.new("RGB", (100, 100))
    from PIL import ImageDraw
    dr = ImageDraw.Draw(im)
    lines = shot_sheet._wrap(dr, "一二三四五六七八九十", shot_sheet.font(20), 100)
    assert len(lines) > 1
    for l in lines:
        assert dr.textlength(l, font=shot_sheet.font(20)) <= 100 or len(l) == 1


def test_linux_cjk_font_discovery(monkeypatch, tmp_path):
    linux_font = tmp_path / "NotoSansCJK-Regular.ttc"
    linux_font.touch()
    monkeypatch.setattr(shot_sheet, "FONTS", [])

    def linux_glob(pattern, recursive=False):
        assert recursive is True
        return [str(linux_font)] if pattern == "/usr/share/fonts/**/NotoSansCJK*.ttc" else []

    monkeypatch.setattr(shot_sheet.glob, "glob", linux_glob)
    assert shot_sheet._find_font() == str(linux_font)


def test_missing_cjk_font_warns_before_default_fallback(monkeypatch):
    import pytest
    monkeypatch.setattr(shot_sheet, "_FONT_PATH", None)
    with pytest.warns(RuntimeWarning, match="CJK 中文字体.*Noto Sans CJK"):
        shot_sheet.font(20)


def _gif(path):
    frames = [Image.new("RGB", (100, 60), color) for color in ("red", "lime", "blue")]
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=[100, 300, 600], loop=0)
    return str(path)


def test_gif_extracts_by_elapsed_time_and_preserves_inputs(tmp_path):
    source = _gif(tmp_path / "animation.gif")
    original = open(source, "rb").read()
    result = shot_sheet.extract_frames(source, str(tmp_path / "frames"), times=[0.05, 0.2, 0.9],
                                       frame_max_edge=50, prefix="sample")
    assert result["duration"] == 1.0
    assert [frame["time"] for frame in result["frames"]] == [0.05, 0.2, 0.9]
    assert [(f["width"], f["height"]) for f in result["frames"]] == [(50, 30)] * 3
    assert [Image.open(f["path"]).getpixel((20, 15)) for f in result["frames"]] == [
        (255, 0, 0), (0, 255, 0), (0, 0, 255)]
    assert open(source, "rb").read() == original


def test_gif_media_sheet_samples_range_and_keeps_color_order(tmp_path):
    source = _gif(tmp_path / "animation.gif")
    out = str(tmp_path / "review.png")
    result = shot_sheet.media_sheet(source, out, start=0.1, end=0.9, count=2, cols=2,
                                    cell=(180, 120), max_edge=1000, title="动图审查")
    assert [round(f["time"], 2) for f in result["frames"]] == [0.3, 0.7]
    with Image.open(out) as image:
        assert image.size == (result["width"], result["height"])
        colors = image.getcolors(maxcolors=1 << 20)
        assert colors is not None
        colors = {color for _, color in colors}
        assert (0, 255, 0) in colors and (0, 0, 255) in colors


def test_media_sheet_enlarges_small_frames_unless_disabled(tmp_path):
    source = _gif(tmp_path / "animation.gif")
    for upscale in (True, False):
        out = tmp_path / f"upscale-{upscale}.png"
        shot_sheet.media_sheet(source, str(out), count=1, cols=1, cell=(260, 170), upscale=upscale)
        with Image.open(out) as image:
            pixel = image.getpixel((60, 135))
            assert pixel == ((0, 0, 255) if upscale else (255, 255, 255))


def test_media_sheet_handles_small_output_and_many_frames(tmp_path):
    source = _gif(tmp_path / "animation.gif")
    for name, options in (("small", {"count": 1, "max_edge": 80}),
                          ("dense", {"count": 80, "max_edge": 300})):
        out = tmp_path / f"{name}.png"
        result = shot_sheet.media_sheet(source, str(out), cell=(60, 40), **options)
        with Image.open(out) as image:
            assert image.size == (result["width"], result["height"])
            assert 0 < max(image.size) <= options["max_edge"]


def test_sampling_validation_and_existing_outputs_are_safe(tmp_path):
    import pytest
    source = _gif(tmp_path / "animation.gif")
    folder = tmp_path / "frames"
    result = shot_sheet.extract_frames(source, str(folder), start=0, end=0.8, interval=0.2)
    assert [round(f["time"], 2) for f in result["frames"]] == [0, 0.2, 0.4, 0.6]
    original = (folder / "frame-0001.png").read_bytes()
    with pytest.raises(FileExistsError):
        shot_sheet.extract_frames(source, str(folder), count=1)
    assert (folder / "frame-0001.png").read_bytes() == original
    for options in ({"times": [1.0]}, {"count": 2, "interval": 0.5},
                    {"times": [0.2], "start": 0.1}, {"interval": 0.001},
                    {"count": 0}, {"start": -1}, {"frame_max_edge": 0}):
        with pytest.raises(ValueError):
            shot_sheet.extract_frames(source, str(tmp_path / "bad"), **options)
    with pytest.raises(ValueError):
        shot_sheet.media_sheet(source, source, count=1, overwrite=True)


def test_media_sheet_does_not_overwrite_without_permission(tmp_path):
    import pytest
    source = _gif(tmp_path / "animation.gif")
    out = tmp_path / "review.png"
    out.write_bytes(b"existing content")
    with pytest.raises(FileExistsError):
        shot_sheet.media_sheet(source, str(out))
    assert out.read_bytes() == b"existing content"
    shot_sheet.media_sheet(source, str(out), count=1, overwrite=True)
    with Image.open(out) as image:
        assert image.format == "PNG"


def test_invalid_media_timeout_creates_no_output(tmp_path):
    import pytest
    source = _gif(tmp_path / "sample.gif")
    frames, sheet = tmp_path / "frames", tmp_path / "review.png"
    for invalid in (0, -1, True, False, float("inf"), float("nan"), "3"):
        for action, destination in ((shot_sheet.extract_frames, frames), (shot_sheet.media_sheet, sheet)):
            with pytest.raises(ValueError, match="timeout"):
                action(source, str(destination), timeout=invalid)
            assert not destination.exists()


def test_common_video_formats_extract_requested_frames(tmp_path, monkeypatch):
    import shutil
    import subprocess
    import pytest
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("视频测试需要 ffmpeg 和 ffprobe")
    real_run = subprocess.run

    def run_without_deadline(*args, **kwargs):
        assert kwargs.get("timeout") is None
        return real_run(*args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run_without_deadline)
    for index in range(12):
        color = ("red", "lime", "blue")[index // 4]
        Image.new("RGB", (120, 80), color).save(tmp_path / f"input-{index:02}.png")
    for extension, codec in (("mp4", "mpeg4"), ("mp4", "libx264"), ("mov", "mpeg4"),
                             ("mkv", "mpeg4"), ("webm", "libvpx-vp9")):
        source = tmp_path / f"video-{codec}.{extension}"
        command = ["ffmpeg", "-v", "error", "-framerate", "10", "-i",
                   str(tmp_path / "input-%02d.png"), "-c:v", codec, "-pix_fmt", "yuv420p", str(source)]
        subprocess.run(command, check=True, capture_output=True, text=True)
        result = shot_sheet.extract_frames(str(source), str(tmp_path / f"{extension}-{codec}"), times=[0.1, 0.5, 1.1, 1.19])
        for frame, channel in zip(result["frames"], (0, 1, 2, 2)):
            with Image.open(frame["path"]) as image:
                pixel = image.getpixel((30, 30))
                assert pixel[channel] > 180 and all(pixel[i] < 70 for i in range(3) if i != channel)
        if codec == "libx264":
            shifted = tmp_path / "shifted.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(source), "-c", "copy",
                            "-output_ts_offset", "5", str(shifted)], check=True, capture_output=True, text=True)
            shifted_frames = shot_sheet.extract_frames(str(shifted), str(tmp_path / "shifted"),
                                                      times=[0.39, 0.4, 1.19])["frames"]
            for frame, channel in zip(shifted_frames, (0, 1, 2)):
                with Image.open(frame["path"]) as image:
                    pixel = image.getpixel((30, 30))
                    assert pixel[channel] > 180 and all(pixel[i] < 70 for i in range(3) if i != channel)


def test_ffprobe_and_ffmpeg_timeouts_raise_clear_errors(tmp_path, monkeypatch):
    import json
    import subprocess
    import pytest
    from shot_sheet import media

    video = tmp_path / "sample.mp4"
    video.write_bytes(b"not-a-gif")
    out_dir = tmp_path / "frames"

    monkeypatch.setattr(media.shutil, "which", lambda name: f"/usr/bin/{name}")

    def hang_ffprobe(cmd, **kwargs):
        assert kwargs["timeout"] == 0.05
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(media.subprocess, "run", hang_ffprobe)
    with pytest.raises(TimeoutError, match=r"ffprobe.*读取视频信息超时"):
        shot_sheet.extract_frames(str(video), str(out_dir), times=[0.25], timeout=0.05)
    with pytest.raises(TimeoutError, match=r"ffprobe.*定位帧时间超时"):
        media._video_frame_time(video, 0.25, 0.0, timeout=0.05)

    probe_info = json.dumps({
        "streams": [{"start_time": "0", "duration": "2.0"}],
        "format": {"start_time": "0", "duration": "2.0"},
    })

    def hang_ffmpeg(cmd, **kwargs):
        assert kwargs["timeout"] == 0.05
        if cmd[0] == "ffprobe" and any("format=start_time" in part for part in cmd):
            return subprocess.CompletedProcess(cmd, 0, probe_info, "")
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, "0.250000\n", "")
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(media.subprocess, "run", hang_ffmpeg)
    with pytest.raises(TimeoutError, match=r"ffmpeg.*抽帧超时"):
        shot_sheet.extract_frames(str(video), str(out_dir), times=[0.25], timeout=0.05)
    assert list(out_dir.iterdir()) == []
    existing = tmp_path / "review.png"
    existing.write_bytes(b"original")
    with pytest.raises(TimeoutError, match=r"ffmpeg.*抽帧超时"):
        shot_sheet.media_sheet(str(video), str(existing), times=[0.25], timeout=0.05, overwrite=True)
    assert existing.read_bytes() == b"original"


def _solid(path, size, color):
    Image.new("RGB", size, color).save(path)
    return str(path)


def test_sheet_label_below_places_caption_under_image():
    """label_position="below"：标签带移到图片下方，几何与默认一致，仅换位置。"""
    import tempfile
    d = __import__("pathlib").Path(tempfile.mkdtemp())
    shots = [_solid(d / f"{i}.png", (1600, 1000), c) for i, c in enumerate([(0, 100, 200), (200, 50, 50)])]
    out = str(d / "below.png")
    r = shot_sheet.sheet([(shots[0], "第一屏"), (shots[1], "第二屏")], out,
                         title="下方标题", max_edge=1200, label_position="below")
    im = Image.open(out).convert("RGB")
    assert (im.width, im.height) == (r["width"], r["height"])
    # 找到第一格图片（实心色块）的上下边界：下方布局时图片应贴着标题区下方就开始，
    # 且格底部再出现标签带（背景色/说明区），即图片底部不在整张图最底部。
    W = im.width
    cw = (W - 2 * 48 - 32) // 2
    x = 48 + cw // 2
    target = (0, 100, 200)
    ys = [y for y in range(im.height - 1) if im.getpixel((x, y)) == target and im.getpixel((x, y + 1)) == target]
    assert ys, "第一格图片应可见"
    top, bottom = min(ys), max(ys)
    # 下方布局：图片紧接标题区（head=110 只有 title + M=48），顶边应接近 158；
    # 图片底边之后还有标签带，所以 bottom 明显小于画布最底。
    assert top < 175, top
    assert bottom < im.height - 20, bottom


def test_sheet_label_above_is_default_and_caption_over_image():
    """默认 label_position="above"：标签带在图片上方，与旧行为一致。"""
    import tempfile
    d = __import__("pathlib").Path(tempfile.mkdtemp())
    shots = [_solid(d / f"{i}.png", (1600, 1000), c) for i, c in enumerate([(0, 100, 200), (200, 50, 50)])]
    out = str(d / "above.png")
    r = shot_sheet.sheet([(shots[0], "第一屏"), (shots[1], "第二屏")], out, title="上方标题", max_edge=1200)
    im = Image.open(out).convert("RGB")
    cw = (im.width - 2 * 48 - 32) // 2
    x = 48 + cw // 2
    target = (0, 100, 200)
    ys = [y for y in range(im.height - 1) if im.getpixel((x, y)) == target and im.getpixel((x, y + 1)) == target]
    top = min(ys)
    # 上方布局：图片顶边 = head(110) + M(48) + LABEL_H(72) ≈ 230
    assert 220 <= top <= 240, top


def test_sheet_label_position_rejects_unknown_value():
    import tempfile
    import pytest
    d = __import__("pathlib").Path(tempfile.mkdtemp())
    shot = _solid(d / "a.png", (400, 300), (0, 100, 200))
    with pytest.raises(ValueError, match="label_position"):
        shot_sheet.sheet([(shot, "x")], str(d / "bad.png"), label_position="middle")


def test_sheet_label_below_keeps_source_and_panel_order():
    """下方布局保留来源行与面板顺序：三格各配来源，输出尺寸与上方布局相同（几何不变）。"""
    import tempfile
    d = __import__("pathlib").Path(tempfile.mkdtemp())
    colors = [(0, 100, 200), (200, 50, 50), (50, 180, 80)]
    shots = [_solid(d / f"{i}.png", (1600, 1000), c) for i, c in enumerate(colors)]
    panels = [(shots[i], f"第{i+1}屏", f"来源{i+1}") for i in range(3)]
    ra = shot_sheet.sheet(panels, str(d / "a.png"), title="标题", cols=2, max_edge=1400, label_position="above")
    rb = shot_sheet.sheet(panels, str(d / "b.png"), title="标题", cols=2, max_edge=1400, label_position="below")
    assert (ra["width"], ra["height"]) == (rb["width"], rb["height"])
    # 面板顺序不变：三色块在下方布局里仍按行优先出现。取每格图片中心颜色核对。
    im = Image.open(str(d / "b.png")).convert("RGB")
    cw = (im.width - 2 * 48 - 32) // 2
    ch = (ra["height"] - 110 - 2 * 48 - 72 - 32) // 2  # 两行，每行 LABEL_H+ch；粗算仅取中心可容忍误差
    # 直接按已知几何：第一格图片中心
    # 简化：扫三个目标色的出现次数均 > 0 且位置顺序符合行优先
    found = {}
    for y in range(im.height):
        for xx in (48 + cw // 2, 48 + cw + 32 + cw // 2):
            p = im.getpixel((min(xx, im.width - 1), y))
            if p in colors and p not in found:
                found[p] = y
    assert all(c in found for c in colors), found
    # 第一行第一格(蓝) 比 第一行第二格(红) 在视觉上属于同一行；第三格(绿) 在下一行更靠下
    assert found[colors[0]] == found[colors[1]], found
    assert found[colors[2]] > found[colors[0]], found
