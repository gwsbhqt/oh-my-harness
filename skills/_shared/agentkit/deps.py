"""browser-control、figma-use 加载 computer-control Python 包的唯一入口（browser-control 的 login 用它操作 1Password 浮层，figma-use 用它点 Figma 界面）。

默认位置是本目录旁边的 computer-control 技能，按真实路径计算，从 ~/.agents/skills 的软链进来也能找到。
测试或独立部署用 COMPUTER_CONTROL_SKILL 指向技能根目录。找不到就抛 ImportError，由调用方转成自己的错误。
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys

SKILLS = Path(__file__).resolve().parents[2]


def computer_control():
    """加载 computer-control 的规范 computer_control 包。"""
    configured = os.environ.get("COMPUTER_CONTROL_SKILL")
    root = Path(configured).expanduser() if configured else SKILLS / "computer-control"
    if configured or root.is_dir():
        path = root / "src"
        if not (path / "computer_control" / "__init__.py").is_file():
            raise ImportError(f"缺少 computer-control：{path / 'computer_control'}")
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    try:
        return importlib.import_module("computer_control")
    except ModuleNotFoundError as exc:
        if exc.name != "computer_control":
            raise
        raise ImportError("缺少 computer-control：请部署源码技能或安装 computer-control 包") from exc
