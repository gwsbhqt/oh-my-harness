"""Compare the decoded sample values of two local, static PNG screenshots."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path
import stat
import struct
import tempfile
import zlib

from .protocol import BrowserError


_PNG = b"\x89PNG\r\n\x1a\n"
_HEADER = struct.Struct(">IIBBBBB")
_MAX_FILE = 96 * 1024 * 1024
_MAX_PIXELS = 16 * 1024 * 1024
_MAX_SIDE = 32768
_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}
_FADE = bytes(191 + value // 4 for value in range(256))


def _invalid(message):
    raise BrowserError("invalid_png", message)


def _chunks(data):
    if not data.startswith(_PNG):
        _invalid("Missing PNG signature")
    view = memoryview(data)
    pos = len(_PNG)
    while pos + 12 <= len(view):
        size, kind = struct.unpack_from(">I4s", view, pos)
        end = pos + 8 + size
        if end + 4 > len(view):
            _invalid("Truncated PNG chunk")
        body = view[pos + 8:end]
        checksum, = struct.unpack_from(">I", view, end)
        if checksum != zlib.crc32(body, zlib.crc32(kind)):
            _invalid(f"Bad CRC in {kind!r}")
        pos = end + 4
        if not kind.isalpha():
            _invalid(f"Invalid PNG chunk name {kind!r}")
        if kind == b"IEND" and (size or pos != len(view)):
            _invalid("IEND must be empty and end the PNG")
        yield kind, body
        if kind == b"IEND":
            return
    _invalid("Missing or truncated PNG end chunk")


@lru_cache(maxsize=8)
def _byte_masks(length):
    return int.from_bytes(b"\x7f" * length), int.from_bytes(b"\x80" * length)


def _add_bytes(left, right, masks):
    # Add a whole scanline modulo 256 without carrying into neighboring bytes.
    low, high = masks
    return ((left & low) + (right & low)) ^ ((left ^ right) & high)


def _unfilter(kind, row, previous, bpp):
    if kind == 0:
        return row
    if kind in (1, 2):
        masks = _byte_masks(len(row))
        value = int.from_bytes(row)
        if kind == 1:
            shift = bpp
            while shift < len(row):
                value = _add_bytes(value, value >> (8 * shift), masks)
                shift *= 2
        else:
            value = _add_bytes(value, int.from_bytes(previous), masks)
        return value.to_bytes(len(row))
    if kind not in (3, 4):
        _invalid(f"Unknown PNG scanline filter {kind}")
    result = bytearray(row)
    for i, above in enumerate(previous):
        left = result[i - bpp] if i >= bpp else 0
        if kind == 3:
            predictor = (left + above) // 2
        else:
            corner = previous[i - bpp] if i >= bpp else 0
            estimate = left + above - corner
            pa, pb, pc = abs(estimate - left), abs(estimate - above), abs(estimate - corner)
            predictor = left if pa <= pb and pa <= pc else above if pb <= pc else corner
        result[i] = (result[i] + predictor) & 255
    return result


def _rgba(row, width, color, transparent):
    if color == 6:
        return row
    rgba = bytearray(b"\xff") * (width * 4)
    if color == 2:
        rgba[0::4], rgba[1::4], rgba[2::4] = row[0::3], row[1::3], row[2::3]
    else:
        gray = row if color == 0 else row[0::2]
        rgba[0::4] = rgba[1::4] = rgba[2::4] = gray
        if color == 4:
            rgba[3::4] = row[1::2]
    if transparent is not None:
        channels = _CHANNELS[color]
        for x in range(width):
            if row[x * channels:(x + 1) * channels] == transparent:
                rgba[4 * x + 3] = 0
    return rgba


@dataclass
class _Image:
    width: int
    height: int
    rows: list[bytes | bytearray]

    def size(self):
        return {"width": self.width, "height": self.height}


def _decode(data):
    chunks = _chunks(data)
    kind, header = next(chunks)
    if kind != b"IHDR" or len(header) != _HEADER.size:
        _invalid("Expected a 13-byte IHDR as the first chunk")
    width, height, depth, color, compression, filtering, interlace = _HEADER.unpack(header)
    if not width or not height:
        _invalid("PNG dimensions must be positive")
    if depth != 8 or color not in _CHANNELS or compression or filtering or interlace:
        raise BrowserError("unsupported_png", "Expected an 8-bit non-interlaced grayscale, gray/alpha, RGB or RGBA PNG "
                           f"(depth={depth}, color={color}, compression={compression}, filter={filtering}, interlace={interlace})")
    if max(width, height) > _MAX_SIDE or width * height > _MAX_PIXELS:
        raise BrowserError("image_too_large", f"PNG {width}x{height} exceeds {_MAX_SIDE} per side or {_MAX_PIXELS} pixels")

    channels = _CHANNELS[color]
    stride = width * channels
    expected = height * (stride + 1)
    palette_seen = False
    transparent = None
    inflater = zlib.decompressobj()
    raw = bytearray()
    seen_data = data_ended = False
    for kind, body in chunks:
        if kind == b"IDAT":
            if data_ended:
                _invalid("PNG image data chunks must be consecutive")
            seen_data = True
            try:
                raw.extend(inflater.decompress(body, expected + 1 - len(raw)))
            except zlib.error as error:
                _invalid(f"Corrupt PNG compressed data: {error}")
            if len(raw) > expected or inflater.unconsumed_tail or inflater.unused_data:
                _invalid("PNG has excess pixel or compressed data")
            continue
        data_ended = seen_data
        if kind == b"PLTE":
            if (palette_seen or transparent is not None or seen_data or color in (0, 4)
                    or not 0 < len(body) <= 768 or len(body) % 3):
                _invalid("Invalid PNG palette or palette position")
            palette_seen = True
        elif kind == b"tRNS":
            if transparent is not None or seen_data or color not in (0, 2) or len(body) != channels * 2:
                _invalid("Invalid tRNS for this PNG color type or chunk order")
            values = struct.unpack(f">{channels}H", body)
            if max(values) > 255:
                _invalid("PNG transparency sample exceeds its bit depth")
            transparent = bytes(values)
        elif kind in (b"acTL", b"fcTL", b"fdAT"):
            raise BrowserError("unsupported_png", "Animated PNG is not a static screenshot")
        elif kind == b"IHDR":
            _invalid("Duplicate PNG header")
        elif kind != b"IEND" and kind[:1].isupper():
            raise BrowserError("unsupported_png", f"Unknown critical PNG chunk {kind!r}")
    if not inflater.eof or len(raw) != expected:
        _invalid("Incomplete PNG compressed stream or pixel data")

    previous = bytes(stride)
    rows = []
    for offset in range(0, expected, stride + 1):
        previous = _unfilter(raw[offset], raw[offset + 1:offset + 1 + stride], previous, channels)
        rows.append(_rgba(previous, width, color, transparent))
    return _Image(width, height, rows)


def _path(value, label):
    try:
        name = os.fspath(value)
        if isinstance(name, str) and name and "\0" not in name:
            return Path(name).expanduser().absolute()
    except (TypeError, ValueError, OSError, RuntimeError) as error:
        raise BrowserError("invalid_arguments", f"Invalid {label} path: {error}") from error
    raise BrowserError("invalid_arguments", f"{label} must be a nonempty local path")


def _open_input(name, flags):
    # A FIFO must not stall the caller before fstat can reject its file type.
    return os.open(name, flags | getattr(os, "O_NONBLOCK", 0))


def _read_image(path, label):
    try:
        with open(path, "rb", opener=_open_input) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise BrowserError("file_error", "Expected a regular file")
            if info.st_size > _MAX_FILE:
                raise BrowserError("image_too_large", "PNG file exceeds 96 MiB")
            data = stream.read(info.st_size + 1)
            if len(data) != info.st_size:
                raise BrowserError("file_error", "PNG changed size while being read")
        return _decode(data)
    except BrowserError as error:
        raise BrowserError(error.code, f"{label} ({path}): {error}") from error
    except OSError as error:
        raise BrowserError("file_error", f"Cannot read {label} ({path}): {error}") from error


def _faded_rgb(rgba):
    rgb = bytearray(len(rgba) // 4 * 3)
    for channel in range(3):
        rgb[channel::3] = rgba[channel::4].translate(_FADE)
    return rgb


def _compare(baseline, current, make_diff):
    changed = 0
    left, top, right, bottom = current.width, current.height, -1, -1
    highlighted = {}
    for y, (before, after) in enumerate(zip(baseline.rows, current.rows)):
        if before == after:
            continue
        rgb = _faded_rgb(after) if make_diff else None
        old_pixels, new_pixels = memoryview(before).cast("I"), memoryview(after).cast("I")
        for x, (old, new) in enumerate(zip(old_pixels, new_pixels)):
            if old != new:
                changed += 1
                left, right = min(left, x), max(right, x)
                if rgb is not None:
                    rgb[3 * x:3 * x + 3] = b"\xff\0\0"
        if rgb is not None:
            highlighted[y] = rgb
        top, bottom = min(top, y), y
    bounds = {"x": left, "y": top, "width": right - left + 1, "height": bottom - top + 1} if changed else None
    return changed, bounds, highlighted


def _chunk(stream, kind, body):
    stream.write(struct.pack(">I4s", len(body), kind))
    stream.write(body)
    stream.write(struct.pack(">I", zlib.crc32(body, zlib.crc32(kind))))


def _write_diff(path, current, highlighted):
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".browser-use-diff-", delete_on_close=False) as staged:
            staged.write(_PNG)
            _chunk(staged, b"IHDR", _HEADER.pack(current.width, current.height, 8, 2, 0, 0, 0))
            compressor = zlib.compressobj()
            for y, row in enumerate(current.rows):
                rgb = highlighted.get(y)
                if rgb is None:
                    rgb = _faded_rgb(row)
                part = compressor.compress(b"\0" + rgb)
                if part:
                    _chunk(staged, b"IDAT", part)
            _chunk(staged, b"IDAT", compressor.flush())
            _chunk(staged, b"IEND", b"")
            staged.close()
            # Publish the closed, complete file in one operation that refuses even dangling symlinks.
            os.link(staged.name, path)
    except FileExistsError as error:
        raise BrowserError("file_exists", f"Output already exists: {path}") from error
    except OSError as error:
        raise BrowserError("file_error", f"Cannot create diff at {path}: {error}") from error


def compare_screenshots(baseline: str | os.PathLike[str], current: str | os.PathLike[str], *,
                        output: str | os.PathLike[str] | None = None) -> dict:
    """Compare two local 8-bit non-interlaced grayscale, gray/alpha, RGB or RGBA PNGs.

    Alpha is compared exactly. Display metadata does not affect sample comparisons. Bounds are
    top-left x/y and inclusive pixel counts for width/height. A size change has no pixel
    count or bounds. Only a same-size change can create the optional new RGB diff file.
    """
    destination = None if output is None else _path(output, "output")
    before = _read_image(_path(baseline, "baseline"), "baseline")
    after = _read_image(_path(current, "current"), "current")
    mismatch = before.size() != after.size()
    result = {"changed": mismatch, "sizeMismatch": mismatch, "baseline": before.size(), "current": after.size(),
              "changedPixels": None, "bounds": None, "diffPath": None}
    if not mismatch:
        count, bounds, highlighted = _compare(before, after, destination is not None)
        result.update(changed=bool(count), changedPixels=count, bounds=bounds)
        if count and destination is not None:
            _write_diff(destination, after, highlighted)
            result["diffPath"] = str(destination)
    return result
