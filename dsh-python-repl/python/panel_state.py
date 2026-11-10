"""Value-free protocol metadata; installed outside the frozen upstream tree."""
from __future__ import annotations

import os
import sys
import types

import repl_info
import panel_preview


def _origin(name: str, value) -> str:
    origin = repl_info._origin(name, value)
    if origin in ("system", "preloaded", "import"):
        return origin
    cls = type(value)
    if cls is types.MethodType:
        value = types.MethodType.__dict__["__func__"].__get__(value)
        cls = types.FunctionType
    if cls is types.FunctionType or cls is types.BuiltinFunctionType:
        module = cls.__dict__["__module__"].__get__(value)
    elif repl_info._actual_instance(value, type):
        module = type.__dict__["__module__"].__get__(value)
    else:
        # Data bindings carry no import provenance; do not guess from their value.
        return origin
    return "import" if type(module) is str and module != "__main__" else origin


def install(kernel, epoch: int) -> None:
    """Extend the existing list_names handler without executing a cell."""
    send = kernel._send
    skip = kernel._ALWAYS_SKIP
    getcwd = os.getcwd
    python_version = ".".join(str(p) for p in sys.version_info[:3])
    executable = sys.executable
    compile_cell = kernel._compile_cell

    def compile_with_source(source, filename):
        codes, trailing = compile_cell(source, filename)
        panel_preview.remember_source(codes, source)
        return codes, trailing

    kernel._compile_cell = compile_with_source

    async def handle(req: dict, ns: dict) -> None:
        if "preview" in req:
            request = req["preview"]
            result = panel_preview.preview(ns, request.get("name"), request.get("epoch"), epoch) if type(request) is dict else {"status": "error", "reason": "invalid preview request"}
            send({"event": "done", "id": req["id"], "status": "ok", "preview": result})
            return
        # Non-exact strings could run a user hash/comparison/startswith hook.
        bindings = sorted((name, value) for name, value in ns.copy().items() if type(name) is str)
        names = [name for name, _ in bindings if not name.startswith("_") and name not in skip]
        items = []
        for name, value in bindings:
            if name.startswith("__") and name.endswith("__"):
                continue
            cls = type(value)
            type_name = str.__getitem__(type.__dict__["__name__"].__get__(cls), slice(128))
            summary = type_name
            if any(cls is candidate for candidate in repl_info._SAFE_SIZED_EXACT):
                summary += f", len={len(value)}"
            items.append({"name": name, "kind": repl_info._kind(value),
                          "origin": _origin(name, value), "summary": summary})
        send({"event": "done", "id": req["id"], "status": "ok", "names": names,
              "info": {"epoch": epoch, "python": python_version,
                       "executable": executable, "cwd": getcwd()},
              "metadata": items, "complete": True, "total": len(items),
              "scope": "top-level-excluding-dunder"})

    kernel._handle_list_names = handle
