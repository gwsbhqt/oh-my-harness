"""Figure-reading notices, calibrated on the 2026-09-29 paper session.

Positive cases are cell shapes from session-60cd02e8 (Gemini 3.8 Flash reading a
36-page paper: 35 cropping cells, 18 pixel-counting cells). Negative cases are
shapes that are ordinary image work and must not be flagged.
"""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import figures  # noqa: E402


class PixelCounting(unittest.TestCase):
    def setUp(self) -> None:
        importlib.reload(figures)  # a fresh kernel: nothing reported yet

    def test_colour_mask_on_an_image_array(self) -> None:
        code = (
            'arr = np.array(img1)\n'
            'green_mask = (arr[:, :, 1] > 140) & (arr[:, :, 0] < 120)\n'
        )
        notes = figures.observe(code)
        self.assertEqual(len(notes), 1)
        self.assertIn('read_image({"file_path"', notes[0])
        self.assertNotIn('doc.images', notes[0])

    def test_np_all_on_an_array_slice(self) -> None:
        self.assertTrue(figures.observe('is_black = np.all(arr_d[:, x, :3] < 60, axis=-1)'))

    def test_getpixel(self) -> None:
        self.assertTrue(figures.observe('c = im.getpixel((10, 20))'))

    def test_reported_once_per_kernel(self) -> None:
        code = 'arr = np.array(img)\nm = arr[:, :, 1] > 3'
        self.assertTrue(figures.observe(code))
        self.assertEqual(figures.observe(code), [])

    def test_numpy_on_data_is_not_flagged(self) -> None:
        self.assertEqual(figures.observe('a = np.array([1, 2, 3])\nprint(np.where(a > 1))'), [])

    def test_saving_an_image_is_not_flagged(self) -> None:
        self.assertEqual(figures.observe('im = Image.new("RGB", (10, 10))\nim.save("/tmp/x.png")'), [])


class Cropping(unittest.TestCase):
    def setUp(self) -> None:
        importlib.reload(figures)  # a fresh kernel: nothing reported yet

    def test_first_crops_are_fine_the_fourth_is_noted(self) -> None:
        crop = 'img1.crop((0, 0, 100, 100)).save("/tmp/a.png")'
        for _ in range(figures.CROP_THRESHOLD - 1):
            self.assertEqual(figures.observe(crop), [])
        notes = figures.observe(crop)
        self.assertEqual(len(notes), 1)
        self.assertIn(f"{figures.CROP_THRESHOLD}th cell", notes[0])
        self.assertEqual(figures.observe(crop), [])

    def test_zoom_by_resize_counts(self) -> None:
        for _ in range(figures.CROP_THRESHOLD):
            notes = figures.observe('big = crop.resize((w * 3, h * 3), Image.NEAREST)')
        self.assertTrue(notes)

    def test_resize_to_fixed_size_does_not_count(self) -> None:
        for _ in range(figures.CROP_THRESHOLD + 2):
            self.assertEqual(figures.observe('i = i.resize((360, 240))'), [])


if __name__ == "__main__":
    unittest.main()
