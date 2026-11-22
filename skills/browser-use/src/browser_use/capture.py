"""Save a full-page regression image through the bound official inspector."""
from __future__ import annotations

import os
import shutil
from pathlib import Path
import struct
import tempfile

from ._chrome import _evaluate
from .protocol import BrowserError


_DOCUMENT_PIXELS = """() => {
  const root = document.documentElement, body = document.body;
  return [Math.round(Math.max(root.scrollWidth, body?.scrollWidth ?? 0) * devicePixelRatio),
          Math.round(Math.max(root.scrollHeight, body?.scrollHeight ?? 0) * devicePixelRatio)];
}"""


async def save_full_page(google, page_id, file_path):
    output = Path(file_path)
    if not output.is_absolute() or output.suffix.lower() != ".png" or "\0" in file_path:
        raise BrowserError("invalid_arguments", "Choose an absolute .png output path.")
    if os.path.lexists(output):
        raise BrowserError("output_exists", "Choose a new PNG file for this capture.")
    size = await _evaluate(google, page_id, _DOCUMENT_PIXELS)
    if not isinstance(size, list) or len(size) != 2 or not all(type(x) is int and x > 0 for x in size):
        raise BrowserError("protocol_error", "Google did not report valid page dimensions.")
    if max(size) > 16384:
        raise BrowserError("unsupported", "This page exceeds Chromium's 16384-device-pixel capture limit.")
    try:
        with tempfile.TemporaryDirectory(prefix="browser-use-capture-") as temp:
            captured = Path(temp, "page.png")
            await google("take_screenshot", {"pageId": page_id, "fullPage": True,
                                             "format": "png", "filePath": str(captured)})
            with captured.open("rb") as image:
                header = image.read(24)
                if len(header) != 24 or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
                    raise BrowserError("image_unavailable", "Google did not save a PNG at the requested location.")
                width, height = struct.unpack(">II", header[16:])
                if any(abs(actual - expected) > 1 for actual, expected in zip((width, height), size)):
                    raise BrowserError("capture_size_changed", "Page dimensions changed or the inspector resized the capture.")
                image.seek(-12, os.SEEK_END)
                if image.read(12) != bytes.fromhex("00000000 49454e44 ae426082"):
                    raise BrowserError("image_unavailable", "Google returned an incomplete PNG.")
            # Google's workspace always admits its temporary directory. Publish on the destination filesystem.
            with tempfile.TemporaryDirectory(prefix=".browser-use-", dir=output.parent) as local:
                staged = Path(local, "page.png")
                shutil.copyfile(captured, staged)
                staged.chmod(0o600)
                os.link(staged, output)
    except FileExistsError as error:
        raise BrowserError("output_exists", "Another capture already created this output file.") from error
    except OSError as error:
        raise BrowserError("capture_io_error", f"Could not save the full-page PNG: {error}") from error
    return {"path": str(output), "width": width, "height": height, "mimeType": "image/png"}
