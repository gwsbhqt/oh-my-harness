"""从 GIF 和视频按时间抽帧，并复用网格拼图。"""

from __future__ import annotations

import bisect
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, UnidentifiedImageError


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} 必须是有限数字")
    return float(value)


def _media_info(source):
    path = Path(source).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"找不到输入文件：{path}")
    try:
        with Image.open(path) as image:
            if image.format == "GIF":
                ends = []
                duration = 0.0
                for index in range(image.n_frames):
                    image.seek(index)
                    duration += max(0, image.info.get("duration", 0)) / 1000
                    ends.append(duration)
                if duration <= 0:
                    raise ValueError("GIF 没有可用的帧时长，无法按时间抽帧")
                return path, duration, ends, 0.0, 0.0
    except UnidentifiedImageError:
        pass

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("视频抽帧需要 ffmpeg 和 ffprobe，请先安装 FFmpeg")
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=start_time,duration:format=start_time,duration", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError(f"无法读取视频：{result.stderr.strip()}")
    info = json.loads(result.stdout)
    streams = info.get("streams", [])
    if not streams:
        raise ValueError("输入文件没有视频画面")
    def finite_or(value, default):
        try:
            number = float(value)
            return number if math.isfinite(number) else default
        except (TypeError, ValueError):
            return default

    container = info.get("format", {})
    container_start = finite_or(container.get("start_time"), 0.0)
    video_start = finite_or(streams[0].get("start_time"), container_start)
    stream_duration = finite_or(streams[0].get("duration"), 0.0)
    container_duration = finite_or(container.get("duration"), 0.0)
    duration = stream_duration if stream_duration > 0 else container_duration - max(0, video_start - container_start)
    if duration > 0:
        return path, duration, None, video_start, container_start
    raise ValueError("视频没有可用的时长信息，无法按时间抽帧")


def _sample_times(duration, count, start, end, interval, times, max_frames):
    if type(max_frames) is not int or max_frames < 1:
        raise ValueError("max_frames 必须是正整数")
    start = _number(start, "start")
    if times is not None:
        if count is not None or interval is not None or start != 0 or end is not None:
            raise ValueError("times 不能与 count、interval 或时间范围一起使用")
        if not isinstance(times, (list, tuple)) or not times:
            raise ValueError("times 必须是非空的时间列表")
        if len(times) > max_frames:
            raise ValueError(f"抽帧数量超过 max_frames={max_frames}")
        selected = [_number(t, "times") for t in times]
        if any(t < 0 or t >= duration for t in selected):
            raise ValueError(f"每个采样时间必须在 0（含）到 {duration:.6f} 秒（不含）之间")
        return selected
    if count is not None and interval is not None:
        raise ValueError("count 与 interval 只能指定一个")
    end = duration if end is None else _number(end, "end")
    if start < 0 or start >= end or end > duration:
        raise ValueError(f"时间范围必须满足 0 ≤ start < end ≤ {duration:.6f} 秒")
    if interval is not None:
        interval = _number(interval, "interval")
        if interval <= 0:
            raise ValueError("interval 必须大于 0")
        number = math.ceil((end - start) / interval)
        if number > max_frames:
            raise ValueError(f"抽帧数量超过 max_frames={max_frames}")
        return [start + i * interval for i in range(number) if start + i * interval < end]
    count = 8 if count is None else count
    if type(count) is not int or count < 1:
        raise ValueError("count 必须是正整数")
    if count > max_frames:
        raise ValueError(f"抽帧数量超过 max_frames={max_frames}")
    return [start + (i + 0.5) * (end - start) / count for i in range(count)]


def _save_frame(image, target, frame_max_edge):
    image = image.convert("RGB")
    if frame_max_edge is not None:
        image.thumbnail((frame_max_edge, frame_max_edge), Image.Resampling.LANCZOS)
    image.save(target, format="PNG")
    return image.size


def _video_frame_time(path, timestamp, video_start):
    point = video_start + timestamp
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals",
         f"{point:.9f}%{point + 0.001:.9f}", "-show_entries",
         "frame=best_effort_timestamp_time", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError(f"{timestamp:.3f} 秒读取帧时间失败：{result.stderr.strip()}")
    candidates = []
    for line in result.stdout.splitlines():
        try:
            value = float(line.split(",", 1)[0])
            if math.isfinite(value) and value <= point + 0.0000001:
                candidates.append(value)
        except ValueError:
            continue
    if not candidates:
        raise ValueError(f"{timestamp:.3f} 秒没有可解码的画面")
    return max(candidates)


def _decode_frames(path, ends, times, temp_dir, frame_max_edge, video_start, container_start):
    frames = []
    if ends is not None:
        with Image.open(path) as image:
            for index, timestamp in enumerate(times):
                image.seek(bisect.bisect_right(ends, timestamp))
                target = Path(temp_dir) / f"{index:06d}.png"
                width, height = _save_frame(image, target, frame_max_edge)
                frames.append((target, timestamp, width, height))
    else:
        decoded = {}
        for index, timestamp in enumerate(times):
            target = Path(temp_dir) / f"{index:06d}.png"
            frame_time = _video_frame_time(path, timestamp, video_start)
            if frame_time in decoded:
                previous, width, height = decoded[frame_time]
                shutil.copyfile(previous, target)
                frames.append((target, timestamp, width, height))
                continue
            seek = max(0.0, frame_time - container_start)
            result = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{seek:.9f}",
                 "-i", str(path), "-map", "0:v:0", "-frames:v", "1", "-y", str(target)],
                capture_output=True, text=True,
            )
            if result.returncode or not target.is_file() or target.stat().st_size == 0:
                raise ValueError(f"{timestamp:.3f} 秒抽帧失败：{result.stderr.strip() or '没有可解码的画面'}")
            with Image.open(target) as image:
                width, height = _save_frame(image, target, frame_max_edge)
            decoded[frame_time] = (target, width, height)
            frames.append((target, timestamp, width, height))
    return frames


def extract_frames(source: str, out_dir: str, *, count: int | None = None,
                   start: float = 0.0, end: float | None = None,
                   interval: float | None = None, times: list[float] | None = None,
                   frame_max_edge: int | None = None, prefix: str = "frame",
                   max_frames: int = 200):
    """按时间从 GIF 或视频导出 PNG 图片，返回时长和每张图的路径、采样时间与尺寸。

    source 是本地文件；out_dir 是输出目录。默认将全长均分为 8 段，取每段中点；
    count 可调数量，start/end 可选时间范围，interval 改为从 start 按秒间隔抽帧；
    times 是明确的秒数列表，与 count、interval 和范围互斥。end 和文件时长不含末端。
    frame_max_edge 可限制每帧长边；prefix 为文件名前缀；max_frames 默认最多 200 张。
    不覆盖已存在的帧；视频需要 ffmpeg 与 ffprobe，缺依赖或解码失败会抛出异常。
    视频采样时间是请求的位置，画面取该时刻正在显示的实际帧。
    """
    if frame_max_edge is not None and (type(frame_max_edge) is not int or frame_max_edge <= 0):
        raise ValueError("frame_max_edge 必须是正整数")
    if not isinstance(prefix, str) or not prefix or prefix in (".", "..") or Path(prefix).name != prefix:
        raise ValueError("prefix 必须是不含目录的文件名前缀")
    path, duration, ends, video_start, container_start = _media_info(source)
    selected = _sample_times(duration, count, start, end, interval, times, max_frames)
    destination = Path(out_dir).expanduser()
    destination.mkdir(parents=True, exist_ok=True)
    targets = [destination / f"{prefix}-{i + 1:04d}.png" for i in range(len(selected))]
    for target in targets:
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"输出文件已存在：{target}")
    created = []
    with tempfile.TemporaryDirectory(prefix="shot-sheet-frames-") as temp_dir:
        frames = _decode_frames(path, ends, selected, temp_dir, frame_max_edge, video_start, container_start)
        try:
            for (temporary, _, _, _), target in zip(frames, targets):
                with temporary.open("rb") as src, target.open("xb") as dst:
                    created.append(target)
                    shutil.copyfileobj(src, dst)
        except Exception:
            for target in created:
                target.unlink(missing_ok=True)
            raise
    return {"source": str(path), "duration": duration,
            "frames": [{"path": str(target), "time": timestamp, "width": width, "height": height}
                       for target, (_, timestamp, width, height) in zip(targets, frames)]}


def _time_label(seconds):
    total_ms = round(seconds * 1000)
    minutes, milliseconds = divmod(total_ms, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def media_sheet(source: str, out: str, *, count: int | None = None,
                start: float = 0.0, end: float | None = None,
                interval: float | None = None, times: list[float] | None = None,
                frame_max_edge: int | None = None, max_frames: int = 200,
                title: str | None = None, subtitle: str | None = None,
                cols: int = 2, notes: list[tuple[str, str]] | None = None,
                cell: tuple[int, int] = (1200, 750), max_edge: int = 3900,
                upscale: bool = True, overwrite: bool = False):
    """从 GIF 或视频抽帧并拼图，返回成品尺寸、素材时长和各帧采样时间。

    抽帧参数与 extract_frames 相同；title、subtitle、cols、notes、cell 和 max_edge
    与 sheet 相同。默认等比放大小帧，可用 upscale=False 关闭；默认不覆盖成品，
    明确设置 overwrite=True 才覆盖已有输出文件。标签显示请求采样时间；临时帧
    在完成或失败后清理，不修改输入文件。
    """
    from . import sheet

    output = Path(out).expanduser()
    if output.resolve() == Path(source).expanduser().resolve():
        raise ValueError("输出不能与输入文件相同")
    if output.exists() and not overwrite:
        raise FileExistsError(f"输出文件已存在：{output}")
    with tempfile.TemporaryDirectory(prefix="shot-sheet-media-") as temp_dir:
        result = extract_frames(source, temp_dir, count=count, start=start, end=end,
                                interval=interval, times=times, frame_max_edge=frame_max_edge,
                                max_frames=max_frames)
        panels = [(frame["path"], _time_label(frame["time"])) for frame in result["frames"]]
        with tempfile.NamedTemporaryFile(prefix=".shot-sheet-", suffix=output.suffix or ".png",
                                         dir=output.parent, delete=False) as temporary:
            temp_output = Path(temporary.name)
        try:
            rendered = sheet(panels, str(temp_output), title=title, subtitle=subtitle,
                             cols=cols, notes=notes, cell=cell, max_edge=max_edge, upscale=upscale)
            if overwrite:
                os.replace(temp_output, output)
            else:
                os.link(temp_output, output)
        finally:
            temp_output.unlink(missing_ok=True)
    return {"out": str(output), "width": rendered["width"], "height": rendered["height"],
            "duration": result["duration"],
            "frames": [{"time": frame["time"]} for frame in result["frames"]]}
