"""从正式命令生成和标注专用临时图片，核验真实文件。"""
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image

SCRIPT = Path(__file__).parents[1] / "scripts/shot-sheet"


def test_cli_all_actions_create_real_images(tmp_path):
    before, after = tmp_path / "before.png", tmp_path / "after.png"
    Image.new("RGB", (100, 80), "white").save(before)
    Image.new("RGB", (100, 80), "blue").save(after)
    actions = {
        "sheet": {"panels": [[str(before), "改前"], [str(after), "改后"]]},
        "compare": {"pairs": [[str(before), str(after), "对比"]]},
        "annotate": {"image": str(before), "boxes": [[10, 10, 30, 20]]},
    }
    for action, values in actions.items():
        out = tmp_path / (action + ".png")
        values.update(out=str(out), max_edge=800)
        result = subprocess.run([sys.executable, str(SCRIPT), action, "--input", json.dumps(values)],
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        actual = json.loads(result.stdout)
        with Image.open(out) as image:
            assert image.size == (actual["width"], actual["height"])
            assert max(image.size) <= 800
            if action == "annotate":
                assert image.getpixel((12, 15)) == (220, 38, 38)


def test_cli_bad_shapes_and_zero_dimensions_fail(tmp_path):
    for values in ({"panels": [], "cols": 2}, {"panels": [["unused", "x"]], "cols": 0},
                   {"panels": [["only-one-field"]]}, {"panels": [["unused", "x"]], "cell": [0, 20]}):
        values["out"] = str(tmp_path / "must-not-exist.png")
        result = subprocess.run([sys.executable, str(SCRIPT), "sheet", "--input", json.dumps(values)],
                                capture_output=True, text=True)
        assert result.returncode != 0
        assert not result.stdout
        assert json.loads(result.stderr)["message"]
        assert not Path(values["out"]).exists()


def test_cli_media_sheet_and_extract_frames(tmp_path):
    source = tmp_path / "animation.gif"
    images = [Image.new("RGB", (90, 60), color) for color in ("red", "blue")]
    images[0].save(source, save_all=True, append_images=images[1:], duration=[250, 750], loop=0)
    cases = [("extract-frames", {"source": str(source), "out_dir": str(tmp_path / "frames"), "times": [0.1, 0.5]}),
             ("media-sheet", {"source": str(source), "out": str(tmp_path / "sheet.png"),
                              "count": 2, "cols": 2, "cell": [200, 120], "max_edge": 1000})]
    for action, values in cases:
        result = subprocess.run([sys.executable, str(SCRIPT), action, "--input", json.dumps(values)],
                                capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        actual = json.loads(result.stdout)
        assert len(actual["frames"]) == 2
        if action == "media-sheet":
            with Image.open(actual["out"]) as image:
                assert image.size == (actual["width"], actual["height"])
        else:
            assert all(Path(frame["path"]).is_file() for frame in actual["frames"])

    result = subprocess.run([sys.executable, str(SCRIPT), "media-sheet", "--source", str(source),
                             "--out", str(tmp_path / "flags.png"), "--start", "0.1", "--end", "0.9",
                             "--interval", "0.25", "--frame-max-edge", "45", "--cols", "2",
                             "--cell", "[120,80]", "--max-edge", "600"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    actual = json.loads(result.stdout)
    assert [round(frame["time"], 2) for frame in actual["frames"]] == [0.1, 0.35, 0.6, 0.85]
    assert max(actual["width"], actual["height"]) <= 600
