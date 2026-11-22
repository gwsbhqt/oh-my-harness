"""Command line and stdio MCP entry points for one Browser session."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .browser import Browser
from .protocol import BrowserError, mcp_result


PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")), flush=True)


def parse_object(text):
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


async def run_one(browser, params):
    if not isinstance(params, dict) or not isinstance(params.get("name"), str):
        raise BrowserError("invalid_arguments", "Expected a tool name")
    args = params.get("arguments", {})
    if not isinstance(args, dict):
        raise BrowserError("invalid_arguments", "Expected an arguments object")
    return await browser.call(params["name"], **args)


async def serve(browser, *, mcp):
    initialized = False
    pending = {}

    async def respond(request_id, args):
        try:
            result = mcp_result(await run_one(browser, args))
        except BrowserError as error:
            if error.data and isinstance(error.data, dict) and error.data.get("isError") and "content" in error.data:
                result = error.data
            else:
                result = mcp_result(error.as_dict()) | {"isError": True}
        except Exception as error:
            result = mcp_result({"code": "internal_error", "message": str(error), "outcome": "unknown"}) | {"isError": True}
        emit({"jsonrpc": "2.0", "id": request_id, "result": result})

    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            if not line.strip():
                continue
            request_id = None
            try:
                msg = parse_object(line)
            except (ValueError, UnicodeError) as error:
                if mcp:
                    emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(error)}})
                else:
                    emit({"error": {"code": "invalid_json", "message": str(error)}})
                continue
            if not mcp:
                try:
                    emit({"result": await run_one(browser, msg)})
                except BrowserError as error:
                    emit({"error": error.as_dict()})
                continue
            request_id = msg.get("id")
            method = msg.get("method")
            params = msg.get("params", {})
            if msg.get("jsonrpc") != "2.0" or not isinstance(method, str) or not isinstance(params, dict):
                emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}})
                continue
            if "id" not in msg:
                if method == "notifications/cancelled":
                    cancelled_id = params.get("requestId")
                    if type(cancelled_id) in (int, str) and cancelled_id in pending:
                        pending[cancelled_id].cancel()
                continue
            if type(request_id) not in (int, str) or request_id in pending:
                emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid or outstanding ID"}})
                continue
            reply = {"jsonrpc": "2.0", "id": request_id}
            if method == "initialize" and not initialized:
                version = params.get("protocolVersion")
                initialized = True
                reply["result"] = {"protocolVersion": version if version in PROTOCOLS else PROTOCOLS[0],
                                   "capabilities": {"tools": {}}, "serverInfo": {"name": "browser-use", "version": "3.1.0"}}
            elif method == "ping":
                reply["result"] = {}
            elif not initialized:
                reply["error"] = {"code": -32600, "message": "Initialize this session first"}
            elif method == "tools/list":
                reply["result"] = {"tools": browser.tools()}
            elif method == "tools/call":
                task = asyncio.create_task(respond(request_id, params))
                pending[request_id] = task
                task.add_done_callback(lambda _, key=request_id: pending.pop(key, None))
                continue
            else:
                reply["error"] = {"code": -32601, "message": f"Unknown method {method}"}
            emit(reply)
    finally:
        if pending:
            await asyncio.gather(*tuple(pending.values()), return_exceptions=True)


async def run(args):
    async with Browser(args.browser, endpoint=args.endpoint, google_executable=args.google_executable,
                       cra_executable=args.cra_executable, cra_socket=args.cra_socket, local_files=args.local_files) as browser:
        if args.operation in ("mcp", "session"):
            await serve(browser, mcp=args.operation == "mcp")
        elif args.operation == "tools":
            emit(browser.tools())
        elif args.operation == "capabilities":
            emit(browser.capabilities())
        else:
            value = sys.stdin.read() if args.arguments == "-" else args.arguments
            emit(await browser.call(args.operation, **parse_object(value)))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="browser-use", description="Control or debug a specific Cra or Chrome instance")
    parser.add_argument("--browser", choices=("cra", "chrome"), default="cra")
    parser.add_argument("--endpoint", help="Debugging endpoint of this browser instance")
    parser.add_argument("--cra-socket", help="Socket for the official Cra app bridge")
    parser.add_argument("--cra-executable", help="Official Cra executable")
    parser.add_argument("--google-executable", help="Installed chrome-devtools-mcp executable")
    parser.add_argument("--local-files", action="store_true", help="Confirm that the target Chrome shares this machine's files")
    parser.add_argument("operation", help="tools, capabilities, session (JSON lines), mcp, or a tool name")
    parser.add_argument("arguments", nargs="?", default="{}", help="Tool arguments as JSON, or - for stdin")
    args = parser.parse_args(argv)
    try:
        asyncio.run(run(args))
    except (BrowserError, ValueError, OSError) as error:
        details = error.as_dict() if isinstance(error, BrowserError) else {"code": "error", "message": str(error)}
        print(json.dumps({"error": details}, ensure_ascii=False), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
