"""FastMCP server for Antigravity Python REPL Workbench."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP

from agy_python_repl.manager import KernelManager

APP_URI = "ui://agy-python-repl/panel.html"

PANE_META = {
    "ui": {"resourceUri": APP_URI},
    "com.google.antigravity/ui": {
        "entrypoints": [
            {"type": "aux_pane", "title": "Python REPL"},
        ]
    },
}

APP_ONLY_META = {
    "ui": {"visibility": ["app"]},
}

_manager = KernelManager()


@asynccontextmanager
async def _lifespan(_app: FastMCP):
    try:
        yield
    finally:
        await _manager.shutdown_all()


mcp = FastMCP("agy-python-repl", lifespan=_lifespan)


@mcp.tool(
    title="Run Python Code",
    description=(
        "Use this session's persistent Python kernel as the first tool for data questions, batch file "
        "reads, log/JSON/CSV analysis, calculations and trusted Python skills. Open the authorized "
        "inputs in the cell, keep records in variables, and return a bounded result. Supports "
        "top-level await, repl.preview(value) and await skills.list()."
    ),
)
async def run_code(
    code: str,
    timeout_seconds: float = 60.0,
    kernel: str = "default",
    cwd: str | None = None,
) -> dict[str, Any]:
    work_dir = Path(cwd).expanduser() if cwd else None
    return await _manager.run_code(
        code,
        kernel=kernel,
        timeout_seconds=timeout_seconds,
        cwd=work_dir,
    )


@mcp.tool(
    title="Manage Kernel State",
    description="Inspect, snapshot, restore, or reset the current session's Python REPL kernel.",
)
async def kernel_state(
    action: Literal["list", "vars", "snapshot", "restore", "reset"],
    kernel: str = "default",
    cwd: str | None = None,
) -> dict[str, Any]:
    work_dir = Path(cwd).expanduser() if cwd else None
    return await _manager.kernel_state(action, kernel=kernel, cwd=work_dir)


@mcp.tool(
    name="open_kernel_panel",
    title="Python REPL",
    description="Open the Python REPL panel.",
    meta=PANE_META,
)
async def open_kernel_panel() -> dict[str, Any]:
    return _manager.get_overview()


@mcp.tool(name="app_kernel_overview", meta=APP_ONLY_META)
async def app_kernel_overview() -> dict[str, Any]:
    return _manager.get_overview()


@mcp.tool(name="app_kernel_action", meta=APP_ONLY_META)
async def app_kernel_action(
    action: Literal["vars", "snapshot", "restore", "reset"],
    kernel: str = "default",
) -> dict[str, Any]:
    return await _manager.kernel_state(action, kernel=kernel)


@mcp.resource(
    APP_URI,
    name="Python REPL Panel",
    mime_type="text/html;profile=mcp-app",
    meta={"ui": {"prefersBorder": False}},
)
def panel_html() -> str:
    html_path = Path(__file__).resolve().parents[2] / "ui" / "panel.html"
    return html_path.read_text(encoding="utf-8")


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
