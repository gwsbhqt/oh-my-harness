"""shot-sheet 命令行，直接调用 shot_sheet 的公开 Python 函数。"""
import sys
from pathlib import Path

shared = Path(__file__).resolve().parents[3] / "_shared"
if (shared / "agentkit/cli.py").is_file():
    sys.path.insert(0, str(shared))
    from agentkit.cli import main as dispatch
else:
    from ._cli_adapter import main as dispatch

from . import sheet, compare, annotate, extract_frames, media_sheet


def main(argv=None):
    return dispatch(prog="shot-sheet", actions={'sheet': sheet, 'compare': compare, 'annotate': annotate,
                                               'extract-frames': extract_frames, 'media-sheet': media_sheet}, argv=argv)
