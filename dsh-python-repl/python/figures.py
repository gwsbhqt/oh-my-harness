"""Notice a cell that reads a chart by counting pixels, or re-crops one image again and again.

The pattern this answers (2026-09-29, a 36-page paper read by Gemini 3.8 Flash):
123 cells, 35 of them cropped or zoomed an image with PIL and 18 analysed pixel
colours with numpy to find axis ticks and bar tops. Each detour is another model
step carrying the whole context — that session cost $2.41, most of it steps
like these. A model that can see images reads a chart better by looking at it
once.

Across 2814 cells of the other local sessions neither shape occurred once, so a
reminder here is almost never wrong. Each kind is reported once per kernel.
"""

from __future__ import annotations

import re

#: Colour arithmetic on an image array: masks, per-channel thresholds, getpixel.
_PIXELS = re.compile(
    r"np\.array\(\s*(?:Image\.open|\w*(?:img|im|crop|pic|image|fig)\w*)\s*[,)]"
    r"|\.getpixel\("
    r"|\barr\w*\[\s*:\s*,\s*:\s*,\s*\d\s*\]\s*[<>]"
    r"|np\.(?:all|any|where)\(\s*\w*arr\w*\[",
    re.I,
)
#: A crop or zoom of an image with PIL.
_CROP = re.compile(r"\.crop\(\s*\(|\.resize\(\s*\(\s*\w+\s*\*\s*\d")

#: How many cropping cells before the reminder: one or two crops to zoom into a
#: panel are normal; the paper session made 35.
CROP_THRESHOLD = 4

_REPORTED: set[str] = set()
_CROPS = 0

PIXELS_NOTE = (
    "This cell reads image content by counting pixel colours. Axis ticks, legends, "
    "hatching and background mix into such masks, and each attempt is one more step "
    "carrying the whole context. Look at the image instead "
    "(`await tools.read_image({\"file_path\": path})`), and read the numbers from it."
)
CROPS_NOTE = (
    "This is the {n}th cell this session that crops or zooms an image. Each crop you "
    "look at is another step carrying the whole context. Open the full figure once, "
    "decide which panel you need, and crop only when text is too small to read."
)


def observe(code: str) -> list[str]:
    """Advice for one successful cell."""
    global _CROPS
    notes: list[str] = []
    if "pixels" not in _REPORTED and _PIXELS.search(code):
        _REPORTED.add("pixels")
        notes.append(PIXELS_NOTE)
    if _CROP.search(code):
        _CROPS += 1
        if "crops" not in _REPORTED and _CROPS >= CROP_THRESHOLD:
            _REPORTED.add("crops")
            notes.append(CROPS_NOTE.format(n=_CROPS))
    return notes
