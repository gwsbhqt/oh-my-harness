"""FastMCP server for Antigravity Python REPL Workbench."""

from __future__ import annotations

import hashlib
import json
import os
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


def _data_dir() -> Path:
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


def _consume_session_route(route_key: str) -> tuple[str | None, Path | None]:
    route_file = _data_dir() / "routing" / f"{route_key}.json"
    if not route_file.is_file():
        return None, None
    try:
        data = json.loads(route_file.read_text(encoding="utf-8"))
        route_file.unlink(missing_ok=True)
        conv_id = data.get("conversationId") or None
        cwd_str = data.get("cwd") or ""
        return conv_id, (Path(cwd_str).expanduser() if cwd_str else None)
    except Exception:
        return None, None


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
        "Prefer this over `run_command` for any ad-hoc Python execution, data/log/JSON/CSV analysis, "
        "multi-step calculations, or `skills.*` orchestration. Runs in a per-session persistent Prime "
        "Python kernel (auto-scoped and auto-restored). Supports top-level `await`, `repl.preview()`, "
        "and `await skills.list()`."
    ),
)
async def run_code(
    code: str,
    timeout_seconds: float = 60.0,
) -> dict[str, Any]:
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]
    conv_id, work_dir = _consume_session_route(f"run_{digest}")
    return await _manager.run_code(
        code,
        kernel=conv_id or "default",
        timeout_seconds=timeout_seconds,
        cwd=work_dir,
    )


@mcp.tool(
    title="Manage Kernel State",
    description="Inspect, snapshot, restore, or reset the current session's Python REPL kernel.",
)
async def kernel_state(
    action: Literal["list", "vars", "snapshot", "restore", "reset"],
) -> dict[str, Any]:
    conv_id, _ = _consume_session_route(f"state_{action}")
    return await _manager.kernel_state(action, kernel=conv_id or "default")


@mcp.tool(
    name="open_kernel_panel",
    title="Python REPL",
    description="Open the Python REPL Kernel Inspector panel.",
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
