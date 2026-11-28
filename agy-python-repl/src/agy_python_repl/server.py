"""FastMCP server for Antigravity Python REPL."""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic.json_schema import SkipJsonSchema

from agy_python_repl.display import render_kernel_state, render_run_code
from agy_python_repl.manager import KernelManager
from agy_python_repl.session_routing import mark_conversation_service, require_standalone_directory, resolve_execution_context

ToolReply = Annotated[CallToolResult, dict[str, Any]]

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
_conversation_service = False


@asynccontextmanager
async def _lifespan(_app: FastMCP):
    if _conversation_service:
        mark_conversation_service(_manager.data_dir)
    try:
        yield
    finally:
        await _manager.shutdown_all()


mcp = FastMCP("agy-python-repl", lifespan=_lifespan)


def _reply(receipt: dict[str, Any], text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], structuredContent=receipt)


@mcp.tool(
    title="Run Python Code",
    description=(
        "Run Python in this persistent kernel. Reuse existing variables, functions and prebound tools. "
        "Assignments are silent. A final expression displays a single value. For several named results, "
        "finish checks inside the cell, then print each on its own labeled line in the user's language."
    ),
)
async def run_code(
    code: str,
    timeout_seconds: float = 60.0,
    cwd: str | None = None,
    kernel: SkipJsonSchema[str | None] = None,
) -> ToolReply:
    effective_kernel, work_dir = resolve_execution_context(
        _manager.data_dir,
        "run_code",
        {"code": code, "timeout_seconds": timeout_seconds, "cwd": cwd, "kernel": kernel},
        managed=_conversation_service,
    )
    receipt = await _manager.run_code(
        code,
        kernel=effective_kernel,
        timeout_seconds=timeout_seconds,
        cwd=work_dir,
    )
    return _reply(receipt, render_run_code(receipt))


@mcp.tool(
    title="Manage Kernel State",
    description=(
        "Inspect, snapshot, restore or restart this session's Python kernel. Restart saves its variables "
        "and checks that they restore in a fresh process. Reset clears the kernel and deletes its snapshot."
    ),
)
async def kernel_state(
    action: Literal["list", "vars", "snapshot", "restore", "restart", "reset"],
    cwd: str | None = None,
    kernel: SkipJsonSchema[str | None] = None,
) -> ToolReply:
    effective_kernel, work_dir = resolve_execution_context(
        _manager.data_dir,
        "kernel_state",
        {"action": action, "cwd": cwd, "kernel": kernel},
        managed=_conversation_service,
    )
    receipt = await _manager.kernel_state(action, kernel=effective_kernel, cwd=work_dir)
    return _reply(receipt, render_kernel_state(action, receipt))


def _panel_manager() -> KernelManager:
    if not _conversation_service:
        require_standalone_directory(_manager.data_dir)
    return _manager


@mcp.tool(
    name="open_kernel_panel",
    title="Python REPL",
    description="Open the Python REPL panel.",
    meta=PANE_META,
)
async def open_kernel_panel() -> ToolReply:
    return _reply(_panel_manager().get_overview(), "Python REPL")


@mcp.tool(name="app_kernel_overview", meta=APP_ONLY_META)
async def app_kernel_overview() -> dict[str, Any]:
    return _panel_manager().get_overview()


@mcp.tool(name="app_kernel_action", meta=APP_ONLY_META)
async def app_kernel_action(
    action: Literal["vars", "snapshot", "restore", "restart", "reset"],
    kernel: str = "default",
) -> dict[str, Any]:
    return await _panel_manager().kernel_state(action, kernel=kernel)


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
    global _conversation_service
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conversation", action="store_true", help="Receive calls from the desktop conversation hook.")
    _conversation_service = parser.parse_args().conversation
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
