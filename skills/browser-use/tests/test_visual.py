"""Pixel and file contracts using dedicated, synthetic screenshots only."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import struct
import subprocess
import tempfile
from threading import Barrier
import unittest
from unittest.mock import patch
from urllib.parse import quote
import zlib

from browser_use.protocol import BrowserError
from browser_use.visual import compare_screenshots


PNG = b"\x89PNG\r\n\x1a\n"


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def header(width, height, color, *, depth=8, interlace=0):
    return chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace))


END = chunk(b"IEND", b"")


def screenshot(width, rows, color=6, *, filters=None, extras=b"", level=1):
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    filters = filters or [0] * len(rows)
    raw = bytearray()
    previous = bytes(width * channels)
    for row, kind in zip(rows, filters, strict=True):
        assert len(row) == len(previous)
        raw.append(kind)
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            prediction = left + up - corner
            paeth = min((left, up, corner), key=lambda neighbor: abs(neighbor - prediction))
            raw.append((value - (0, left, up, (left + up) // 2, paeth)[kind]) % 256)
        previous = row
    data = zlib.compress(raw, level)
    half = len(data) // 2
    return PNG + header(width, len(rows), color) + extras + chunk(b"IDAT", data[:half]) + chunk(b"IDAT", data[half:]) + END


def diff_pixels(path):
    # Read the RGB artifact independently, including every chunk checksum and filter byte.
    data = path.read_bytes()
    assert data.startswith(PNG) and data.endswith(END)
    pos = len(PNG)
    compressed = bytearray()
    while pos < len(data):
        size, kind = struct.unpack_from(">I4s", data, pos)
        body = data[pos + 8:pos + 8 + size]
        assert data[pos:pos + size + 12] == chunk(kind, body)
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            assert (depth, color, compression, filtering, interlace) == (8, 2, 0, 0, 0)
        elif kind == b"IDAT":
            compressed.extend(body)
        pos += size + 12
    raw = zlib.decompress(compressed)
    stride = width * 3 + 1
    assert len(raw) == height * stride
    assert raw[::stride] == bytes(height)
    return [[tuple(raw[i:i + 3]) for i in range(y * stride + 1, (y + 1) * stride, 3)] for y in range(height)]


class VisualTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.baseline = self.root / "baseline.png"
        self.current = self.root / "current.png"
        self.output = self.root / "differences.png"
        self.baseline.write_bytes(screenshot(1, [bytes([12, 48, 96, 255])]))
        self.current.write_bytes(screenshot(1, [bytes([22, 58, 106, 255])]))

    def compare(self, **kwargs):
        return compare_screenshots(self.baseline, self.current, **kwargs)

    def test_all_filters_and_compression_levels_compare_equal(self):
        for color, channels in ((0, 1), (2, 3), (4, 2), (6, 4)):
            with self.subTest(color=color):
                rows = [bytes((x * 57 + y * 39 + x * y * 13) % 256 for x in range(17 * channels)) for y in range(5)]
                self.baseline.write_bytes(screenshot(17, rows, color, level=0))
                self.current.write_bytes(screenshot(17, rows, color, filters=[0, 1, 2, 3, 4], level=9,
                                                    extras=chunk(b"tEXt", b"fixture\0different metadata")))
                self.assertNotEqual(self.baseline.read_bytes(), self.current.read_bytes())
                self.assertEqual(self.compare(output=self.output), {
                    "changed": False, "sizeMismatch": False, "baseline": {"width": 17, "height": 5},
                    "current": {"width": 17, "height": 5}, "changedPixels": 0, "bounds": None, "diffPath": None,
                })
                self.assertFalse(self.output.exists())

    def test_color_types_and_color_key_transparency_compare_as_rgba(self):
        rgba = bytes((12, 12, 12, 0, 48, 48, 48, 255))
        self.baseline.write_bytes(screenshot(2, [rgba]))
        for color, row, extra in (
            (0, bytes((12, 48)), chunk(b"tRNS", struct.pack(">H", 12))),
            (2, bytes((12, 12, 12, 48, 48, 48)), chunk(b"tRNS", struct.pack(">3H", 12, 12, 12))),
            (4, bytes((12, 0, 48, 255)), b""),
        ):
            with self.subTest(color=color):
                self.current.write_bytes(screenshot(2, [row], color, extras=extra))
                self.assertFalse(self.compare()["changed"])
        self.current.write_bytes(screenshot(2, [bytes((12, 48))], 0))
        self.assertEqual(self.compare()["changedPixels"], 1)

    def test_sparse_changes_including_alpha_mark_only_those_pixels_red(self):
        pixel = bytes((40, 80, 120, 255))
        before = [pixel * 5 for _ in range(4)]
        after = [bytearray(row) for row in before]
        after[1][12:16] = bytes((2, 3, 4, 5))
        after[3][7] = 254
        self.baseline.write_bytes(screenshot(5, before))
        self.current.write_bytes(screenshot(5, after))
        summary = self.compare()
        self.assertEqual(summary, {"changed": True, "sizeMismatch": False, "baseline": {"width": 5, "height": 4},
                                   "current": {"width": 5, "height": 4}, "changedPixels": 2,
                                   "bounds": {"x": 1, "y": 1, "width": 3, "height": 3}, "diffPath": None})
        self.assertFalse(self.output.exists())
        result = self.compare(output=str(self.output))
        self.assertEqual(result, {**summary, "diffPath": str(self.output.absolute())})
        pixels = diff_pixels(self.output)
        self.assertEqual({(x, y) for y, row in enumerate(pixels) for x, p in enumerate(row) if p == (255, 0, 0)},
                         {(3, 1), (1, 3)})
        self.assertTrue(all(channel > 180 for channel in pixels[0][0]))

    def test_equal_and_mismatched_sizes_do_not_publish_or_disturb_an_old_diff(self):
        for width in (1, 3):
            with self.subTest(width=width):
                self.current.write_bytes(screenshot(width, [bytes((12, 48, 96, 255)) * width]))
                self.output.unlink(missing_ok=True)
                result = self.compare(output=self.output)
                self.assertFalse(self.output.exists())
                self.assertEqual(result, {"changed": width != 1, "sizeMismatch": width != 1,
                                          "baseline": {"width": 1, "height": 1}, "current": {"width": width, "height": 1},
                                          "changedPixels": 0 if width == 1 else None, "bounds": None, "diffPath": None})
                self.output.write_bytes(b"previous result")
                self.assertEqual(self.compare(output=self.output), result)
                self.assertEqual(self.output.read_bytes(), b"previous result")

    def test_never_replaces_either_input_an_existing_file_or_symlinks(self):
        self.output.write_bytes(b"keep this file")
        alias = self.root / "alias.png"
        alias.symlink_to(self.current)
        dangling = self.root / "dangling.png"
        dangling.symlink_to(self.root / "absent.png")
        hard_link = self.root / "hard.png"
        os.link(self.baseline, hard_link)
        originals = {path: path.read_bytes() for path in (self.baseline, self.current, self.output, alias, hard_link)}
        for path in (*originals, dangling):
            with self.subTest(path=path.name), self.assertRaises(BrowserError) as error:
                self.compare(output=path)
            self.assertEqual(error.exception.code, "file_exists")
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        self.assertTrue(dangling.is_symlink())
        self.assertFalse(dangling.exists())

    def test_racing_writers_publish_one_complete_file(self):
        publish = os.link
        waiting = Barrier(2)

        def synchronized_publish(staged, dest):
            self.assertEqual(diff_pixels(Path(staged)), [[(255, 0, 0)]])
            self.assertFalse(dest.exists())
            waiting.wait(timeout=10)
            publish(staged, dest)

        def run(_):
            try:
                return self.compare(output=self.output)["diffPath"]
            except BrowserError as error:
                return error.code

        with patch("browser_use.visual.os.link", side_effect=synchronized_publish), ThreadPoolExecutor(2) as pool:
            results = list(pool.map(run, (0, 1)))
        self.assertCountEqual(results, [str(self.output), "file_exists"])
        self.assertEqual(diff_pixels(self.output), [[(255, 0, 0)]])
        self.assertCountEqual(self.root.iterdir(), (self.baseline, self.current, self.output))

    def test_write_failure_cleans_the_unpublished_file(self):
        with patch("browser_use.visual._chunk", side_effect=OSError("synthetic write failure")):
            with self.assertRaisesRegex(BrowserError, "synthetic write failure") as error:
                self.compare(output=self.output)
        self.assertEqual(error.exception.code, "file_error")
        self.assertCountEqual(self.root.iterdir(), (self.baseline, self.current))

    def test_damaged_streams_and_invalid_chunk_structure_are_rejected(self):
        h = header(1, 1, 2)
        data = zlib.compress(b"\x00abc")
        idat = chunk(b"IDAT", data)
        bad_crc = idat[:-1] + bytes([idat[-1] ^ 1])
        cases = {
            "bad signature": b"not a PNG",
            "bad header length": PNG + chunk(b"IHDR", b"a") + idat + END,
            "invalid first chunk": PNG + idat + h + END,
            "duplicate header": PNG + h + h + idat + END,
            "missing IDAT": PNG + h + END,
            "bad CRC": PNG + h + bad_crc + END,
            "truncated chunk": PNG + h + idat[:-2],
            "out-of-order data": PNG + h + idat + chunk(b"tEXt", b"a\0b") + chunk(b"IDAT", b"") + END,
            "late transparency": PNG + h + idat + chunk(b"tRNS", bytes(6)) + END,
            "invalid transparency": PNG + h + chunk(b"tRNS", b"\x01\x01" * 3) + idat + END,
            "incomplete deflate stream": PNG + h + chunk(b"IDAT", data[:-2]) + END,
            "wrong deflate checksum": PNG + h + chunk(b"IDAT", data[:-1] + bytes([data[-1] ^ 1])) + END,
            "extra deflate stream": PNG + h + chunk(b"IDAT", data + data) + END,
            "excess pixel data": PNG + h + chunk(b"IDAT", zlib.compress(bytes(1024 * 1024))) + END,
            "short pixel data": PNG + h + chunk(b"IDAT", zlib.compress(b"\x00ab")) + END,
            "invalid filter": PNG + h + chunk(b"IDAT", zlib.compress(b"\x05abc")) + END,
            "missing end": PNG + h + idat,
            "nonempty end": PNG + h + idat + chunk(b"IEND", b"a"),
            "trailing data": PNG + h + idat + END + b"a",
        }
        for name, blob in cases.items():
            with self.subTest(name=name):
                self.current.write_bytes(blob)
                with self.assertRaisesRegex(BrowserError, "current") as error:
                    self.compare(output=self.output)
                self.assertEqual(error.exception.code, "invalid_png")
                self.assertFalse(self.output.exists())

    def test_unsupported_encodings_and_resource_limits_are_explicit(self):
        for h in (header(1, 1, 3), header(1, 1, 6, depth=16), header(1, 1, 0, interlace=1),
                  header(1, 1, 2) + chunk(b"acTL", bytes(8)), header(1, 1, 2) + chunk(b"ZZZZ", b"")):
            self.current.write_bytes(PNG + h + END)
            with self.assertRaises(BrowserError) as error:
                self.compare()
            self.assertEqual(error.exception.code, "unsupported_png")
        for width, height in ((1, 32769), (5000, 4000)):
            self.current.write_bytes(PNG + header(width, height, 6) + END)
            with self.assertRaises(BrowserError) as error:
                self.compare()
            self.assertEqual(error.exception.code, "image_too_large")
        with self.current.open("wb") as stream:
            stream.truncate(96 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(BrowserError, "96 MiB") as error:
            self.compare()
        self.assertEqual(error.exception.code, "image_too_large")

    def test_invalid_paths_reject_clearly(self):
        self.current.unlink()
        with self.assertRaisesRegex(BrowserError, "current") as error:
            self.compare()
        self.assertEqual(error.exception.code, "file_error")
        with self.assertRaisesRegex(BrowserError, "baseline") as error:
            compare_screenshots(self.root, self.baseline)
        self.assertEqual(error.exception.code, "file_error")
        with self.assertRaisesRegex(BrowserError, "output") as error:
            self.compare(output="")
        self.assertEqual(error.exception.code, "invalid_arguments")

    @unittest.skipUnless(os.environ.get("BROWSER_USE_LIVE_CHROME"), "Set BROWSER_USE_LIVE_CHROME for a fresh headless profile")
    def test_two_real_chrome_pngs_of_a_synthetic_color_change(self):
        for color, path in (("navy", self.baseline), ("teal", self.current)):
            html = ("<!doctype html><style>html{background:white}div{position:fixed;"
                    f"left:17px;top:23px;width:11px;height:7px;background:{color}" + "}</style><div></div>")
            subprocess.run([os.environ["BROWSER_USE_LIVE_CHROME"], "--headless", "--no-first-run", "--no-default-browser-check",
                            "--disable-sync", "--disable-extensions", "--disable-background-networking", "--use-mock-keychain",
                            f"--user-data-dir={self.root / 'profile'}", "--window-size=240,160", "--force-device-scale-factor=1",
                            f"--screenshot={path}", "data:text/html," + quote(html)], check=True, timeout=30, capture_output=True)
        result = self.compare(output=self.output)
        self.assertEqual(result["changedPixels"], 77)
        self.assertEqual(result["bounds"], {"x": 17, "y": 23, "width": 11, "height": 7})
        pixels = diff_pixels(self.output)
        self.assertEqual({(x, y) for y, row in enumerate(pixels) for x, p in enumerate(row) if p == (255, 0, 0)},
                         {(x, y) for x in range(17, 28) for y in range(23, 30)})
