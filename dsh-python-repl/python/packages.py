"""`repl.install`: add third-party packages to the running kernel.

Why this exists: a kernel without a library pushed the model into starting a
second interpreter per cell (`uv run --with pymupdf python -c ...`), which
throws away the whole point of a persistent kernel — nothing that process
builds can stay in this namespace.

The kernel runs in its own venv, built by the host like Prime's kernel-venv,
so packages go straight into it with `uv pip install --python sys.executable`
and stay for every later kernel. A kernel that is not in a venv refuses: the
installer would write into a Python the rest of the machine uses.

What is NOT done: `importlib.reload` of already-imported modules. Reloading a
package with submodules or C extensions leaves a mix of old and new code that
fails later and obscurely. Such modules are reported as stale, and the model
chooses `repl.restart()`.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import importlib.util
import os
import shutil
import site
import sys
import sysconfig
from pathlib import Path
from typing import Any


def _site_packages() -> Path:
    return Path(sysconfig.get_paths()["purelib"])


def _distributions(target: Path) -> dict[str, tuple[str, Path]]:
    """Installed distributions in `target`: normalized name -> (version, dist-info path)."""
    found: dict[str, tuple[str, Path]] = {}
    for info in target.glob("*.dist-info"):
        try:
            dist = importlib.metadata.Distribution.at(info)
            name = dist.metadata["Name"]
            version = dist.version
        except Exception:  # noqa: BLE001 - a broken dist-info is reported by the installer, not here
            continue
        if name:
            found[name.lower().replace("_", "-").replace(".", "-")] = (version, info)
    return found


def _top_level_modules(info: Path) -> list[str]:
    """Importable top-level names a distribution provides."""
    dist = importlib.metadata.Distribution.at(info)
    listed = dist.read_text("top_level.txt")
    if listed:
        names = [line.strip() for line in listed.splitlines()]
    else:
        names = []
        for file in dist.files or ():
            first = file.parts[0] if file.parts else ""
            if first.endswith((".dist-info", ".data")) or first in ("..", "bin", "__pycache__"):
                continue
            if len(file.parts) == 1:
                if first.endswith(".py"):
                    first = first[:-3]
                elif first.endswith((".so", ".pyd")):
                    first = first.split(".", 1)[0]
                else:
                    continue
            names.append(first)
    return sorted({n for n in names if n.isidentifier()})


def _tail(text: str, lines: int = 15) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


class InstallResult(dict):
    """`repl.install` result: an ordinary dict that displays as a short report."""

    def __repr__(self) -> str:
        out = ["── repl.install · ok (view of a dict) ──"]
        changed = [f"{c['name']} {c['version']}" + (f" (was {c['previous']})" if c.get("previous") else "")
                   for c in self["changed"]]
        out.append("installed: " + (", ".join(changed) if changed else "nothing changed — already installed"))
        out.append(f"environment: {self['environment']} (the kernel venv; every later kernel uses it)")
        if self["importable_now"]:
            out.append("importable now: " + ", ".join(self["importable_now"]))
        if self["stale"]:
            out.append(
                "stale: " + ", ".join(self["stale"]) + " were imported before this install and still run the OLD "
                "code. await repl.restart() starts a fresh kernel after this cell (variables come back from "
                "the snapshot, installed packages stay)."
            )
        return "\n".join(out)

    __str__ = __repr__


async def install(specs: list[str], *, upgrade: bool = False, timeout: float | None = 900) -> InstallResult:
    """Install requirement specs into the kernel venv and make them importable now."""
    if not specs or not all(isinstance(s, str) and s.strip() for s in specs):
        raise ValueError('pass one or more requirement strings: await repl.install("pymupdf", "openpyxl>=3.1")')
    bad = [s for s in specs if s.lstrip().startswith("-")]
    if bad:
        raise ValueError(f"installer options are not accepted as requirements: {bad}; use upgrade=True for --upgrade")
    if sys.prefix == sys.base_prefix:
        raise RuntimeError(f"this kernel runs on {sys.executable}, not in its own venv, so repl.install is unavailable here")
    uv = shutil.which("uv")
    if uv is None:
        raise RuntimeError("repl.install needs `uv` on PATH, the installer the kernel venv was built with")
    target = _site_packages()
    before = _distributions(target)
    seen_pth = {p.name for p in target.glob("*.pth")}
    argv = [uv, "pip", "install", "--python", sys.executable, *(["--upgrade"] if upgrade else []), *(s.strip() for s in specs)]

    # The kernel's PYTHONPATH points at the bridge and vendored modules; the
    # installer has no business seeing them.
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        _refresh(target, seen_pth)
        raise RuntimeError(f"uv did not finish within {timeout} s and was killed; "
                           "the kernel venv may hold a partial install") from None
    except asyncio.CancelledError:
        proc.kill()
        raise
    _refresh(target, seen_pth)
    if proc.returncode != 0:
        text = _tail(err.decode(errors="replace")) or _tail(out.decode(errors="replace"))
        raise RuntimeError(f"uv failed (exit {proc.returncode}):\n{text}")

    after = _distributions(target)
    changed = []
    for name, (version, info) in sorted(after.items()):
        previous = before.get(name)
        if previous is None or previous[0] != version:
            changed.append({"name": name, "version": version, "previous": previous[0] if previous else None,
                            "modules": _top_level_modules(info)})
    modules = sorted({m for c in changed for m in c["modules"]})
    stale = [m for m in modules if m in sys.modules]
    # find_spec on a TOP-LEVEL name locates it without executing it.
    importable = [m for m in modules if m not in sys.modules and importlib.util.find_spec(m) is not None]
    return InstallResult(environment=sys.prefix, changed=changed, importable_now=importable, stale=stale)


def _refresh(target: Path, seen_pth: set[str]) -> None:
    """Let the import system see files that appeared after the kernel started."""
    sys.path_importer_cache.pop(str(target), None)
    for pth in sorted(target.glob("*.pth")):
        if pth.name not in seen_pth:
            site.addpackage(str(target), pth.name, set(sys.path))
    importlib.invalidate_caches()


#: Set by `repl.restart()`, read once by the host at the end of the cell.
_RESTART: dict[str, str] = {}


def request_restart(reason: str | None = None) -> dict[str, Any]:
    """Ask the host to replace this kernel once the current cell ends."""
    _RESTART["reason"] = reason or "requested by the cell"
    return {
        "restart": "after this cell",
        "effect": "the next cell runs on a fresh kernel with this kernel's variables restored from a "
                  "snapshot taken at the end of this cell; files and installed packages stay",
    }


def take_restart() -> str | None:
    """The pending restart reason, cleared on read."""
    return _RESTART.pop("reason", None)
