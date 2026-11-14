"""加载 browser-control、computer-control 的规范 Python 包。

默认查找共享库旁的技能源码，按真实路径计算；独立安装时导入已安装的规范包。
BROWSER_CONTROL_SKILL、COMPUTER_CONTROL_SKILL 可显式指定技能根目录；缺失时抛 ImportError。
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys

SKILLS = Path(__file__).resolve().parents[2]


def _control(name):
    skill = name.replace("_", "-")
    configured = os.environ.get(f"{name.upper()}_SKILL")
    root = Path(configured).expanduser() if configured else SKILLS / skill
    if configured or root.is_dir():
        path = root / "src"
        if not (path / name / "__init__.py").is_file():
            raise ImportError(f"缺少 {skill}：{path / name}")
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:
        if exc.name != name:
            raise
        raise ImportError(f"缺少 {skill}：请部署源码技能或安装 {skill} 包") from exc


def computer_control():
    """加载 computer-control 的规范 computer_control 包。"""
    return _control("computer_control")


def browser_control():
    """加载 browser-control 的规范 browser_control 包。"""
    return _control("browser_control")
