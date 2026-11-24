"""Multi-kernel session manager for Antigravity Python REPL."""

from __future__ import annotations

import json
import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import python_repl_core
from python_repl_core.kernel_client import CellResult, KernelClient
from python_repl_core.output_budget import bound_text
from python_repl_core.skill_discovery import discover_python_skills


def _default_vendor_dir() -> Path:
    plugin_root = Path(__file__).resolve().parents[2]
    repo_root = plugin_root.parent
    for candidate in (
        plugin_root / "_bundled" / "vendor" / "prime",
        repo_root / "python-repl-core" / "vendor" / "prime",
        repo_root / "dsh-python-repl" / "vendor" / "prime",
    ):
        if (candidate / "rlm" / "repl.py").is_file():
            return candidate
    raise FileNotFoundError(f"Could not locate vendored Prime kernel under {plugin_root} or {repo_root}")


def _default_compat_dir() -> Path:
    return Path(python_repl_core.__file__).resolve().parent / "compat"


def _default_data_dir() -> Path:
    env_dir = os.environ.get("PLUGIN_DATA") or os.environ.get("AGY_PYTHON_REPL_DATA")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".gemini" / "antigravity" / "plugin_data" / "agy-python-repl"


@dataclass(slots=True)
class CellHistoryEntry:
    cell_id: str
    kernel: str
    code_preview: str
    status: str
    duration_ms: int
    timestamp: float
    truncated: bool = False


@dataclass(slots=True)
class ManagedKernel:
    name: str
    client: KernelClient
    cwd: Path
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    skill_report: dict[str, Any] = field(default_factory=dict)
    pending_restore_notice: dict[str, Any] | None = None


class KernelManager:
    """Manages named Prime Python kernels, snapshots, and execution history."""

    def __init__(
        self,
        *,
        data_dir: Path | None = None,
        vendor_dir: Path | None = None,
        compat_dir: Path | None = None,
        python_exe: str | None = None,
        skill_roots: list[Path] | None = None,
        project_skill_roots: list[Path] | None = None,
        max_output_chars: int = 24_000,
        auto_snapshot: bool = True,
    ) -> None:
        self.data_dir = data_dir or _default_data_dir()
        self.vendor_dir = vendor_dir or _default_vendor_dir()
        self.compat_dir = compat_dir or _default_compat_dir()
        self.python_exe = python_exe or sys.executable
        self.skill_roots = skill_roots if skill_roots is not None else [
            Path.home() / ".agents" / "skills",
        ]
        self.project_skill_roots = project_skill_roots if project_skill_roots is not None else [
            Path(".agents") / "skills",
        ]
        self.max_output_chars = max_output_chars
        self.auto_snapshot = auto_snapshot

        self._kernels: dict[str, ManagedKernel] = {}
        self._start_locks: dict[str, asyncio.Lock] = {}
        self._history: list[CellHistoryEntry] = []

    def _sanitize_kernel_name(self, kernel: str) -> str:
        clean = "".join(ch if (ch.isalnum() or ch in "-_:") else "_" for ch in (kernel or "default"))
        return clean.replace(":", "__") or "default"

    async def _ensure_kernel(self, kernel: str, *, cwd: Path | None = None) -> ManagedKernel:
        key = self._sanitize_kernel_name(kernel)
        existing = self._kernels.get(key)
        if existing and existing.client.alive:
            existing.last_used_at = time.time()
            return existing

        lock = self._start_locks.setdefault(key, asyncio.Lock())
        async with lock:
            existing = self._kernels.get(key)
            if existing and existing.client.alive:
                existing.last_used_at = time.time()
                return existing

            work_dir = cwd or Path.cwd()
            agy_src = Path(__file__).resolve().parents[1]
            core_src = Path(python_repl_core.__file__).resolve().parents[1]

            client = KernelClient(
                python_exe=self.python_exe,
                vendor_dir=self.vendor_dir,
                compat_dir=self.compat_dir,
                cwd=work_dir,
                extra_pythonpath=[agy_src, core_src],
            )
            await client.start()

            entries = discover_python_skills(
                skill_roots=self.skill_roots,
                project_roots=self.project_skill_roots,
                cwd=work_dir,
            )
            payload = [
                {
                    "name": e.name,
                    "import_name": e.import_name,
                    "directory": e.directory,
                    "source_root": e.source_root,
                    "description": e.description,
                    "doc_path": e.doc_path,
                    "is_project": e.is_project,
                }
                for e in entries
            ]
            bootstrap_code = (
                "from agy_python_repl.bootstrap import install_antigravity_surface as _install\n"
                f"_install({payload!r})"
            )
            boot_res = await client.execute(bootstrap_code, timeout_s=30.0)
            report: dict[str, Any] = {}
            if boot_res.status == "ok" and boot_res.result:
                try:
                    import ast
                    parsed = ast.literal_eval(boot_res.result)
                    if isinstance(parsed, dict):
                        report = parsed
                except Exception:
                    pass

            restore_notice: dict[str, Any] | None = None
            if self.auto_snapshot:
                snap_path, manifest_path = self._snapshot_paths(key)
                restore_notice = await client.restore_if_present(snap_path, manifest_path)

            managed = ManagedKernel(
                name=key,
                client=client,
                cwd=work_dir,
                skill_report=report,
                pending_restore_notice=restore_notice,
            )
            self._kernels[key] = managed
            return managed

    async def run_code(
        self,
        code: str,
        *,
        kernel: str = "default",
        timeout_seconds: float = 60.0,
        cwd: Path | None = None,
    ) -> dict[str, Any]:
        key = self._sanitize_kernel_name(kernel)
        managed = await self._ensure_kernel(key, cwd=cwd)
        started = time.monotonic()
        res: CellResult = await managed.client.execute(code, timeout_s=timeout_seconds)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        managed.last_used_at = time.time()

        if self.auto_snapshot and not res.timed_out:
            snap_path, manifest_path = self._snapshot_paths(key)
            try:
                await managed.client.snapshot(snap_path, manifest_path)
            except Exception:
                pass

        restored = managed.pending_restore_notice
        managed.pending_restore_notice = None

        overflow_dir = self.data_dir / "overflow" / key
        stdout_bounded = bound_text(
            res.stdout,
            max_chars=self.max_output_chars,
            overflow_dir=overflow_dir,
            overflow_name=f"{res.cell_id}_stdout.txt",
        )
        stderr_bounded = bound_text(
            res.stderr,
            max_chars=max(4000, self.max_output_chars // 2),
            overflow_dir=overflow_dir,
            overflow_name=f"{res.cell_id}_stderr.txt",
        )

        result_text = res.result
        result_truncated = False
        if result_text is not None:
            res_bounded = bound_text(
                result_text,
                max_chars=self.max_output_chars,
                overflow_dir=overflow_dir,
                overflow_name=f"{res.cell_id}_result.txt",
            )
            result_text = res_bounded.text
            result_truncated = res_bounded.truncated

        any_truncated = stdout_bounded.truncated or stderr_bounded.truncated or result_truncated
        self._history.append(
            CellHistoryEntry(
                cell_id=res.cell_id,
                kernel=key,
                code_preview=code.strip().splitlines()[0][:120] if code.strip() else "",
                status="timeout" if res.timed_out else res.status,
                duration_ms=elapsed_ms,
                timestamp=time.time(),
                truncated=any_truncated,
            )
        )
        if len(self._history) > 100:
            self._history = self._history[-100:]

        out: dict[str, Any] = {
            "status": "timeout" if res.timed_out else res.status,
        }
        if stdout_bounded.text:
            out["stdout"] = stdout_bounded.text
        if stderr_bounded.text:
            out["stderr"] = stderr_bounded.text
        if result_text is not None:
            out["result"] = result_text
        if res.error is not None:
            out["error"] = res.error
        if any_truncated:
            out["truncated"] = True
            overflow_files = [
                p for p in (stdout_bounded.overflow_path, stderr_bounded.overflow_path) if p
            ]
            if overflow_files:
                out["overflow_files"] = overflow_files
        if restored is not None:
            out["restored"] = restored
        return out

    def _snapshot_paths(self, key: str) -> tuple[Path, Path]:
        snap_dir = self.data_dir / "snapshots"
        return snap_dir / f"{key}.dill", snap_dir / f"{key}.manifest.json"

    async def kernel_state(
        self,
        action: str,
        *,
        kernel: str = "default",
        cwd: Path | None = None,
    ) -> dict[str, Any]:
        key = self._sanitize_kernel_name(kernel)

        if action == "list":
            snap_dir = self.data_dir / "snapshots"
            def _belongs(name: str) -> bool:
                return key == "default" or name == key or name.startswith(f"{key}__")

            saved = (
                sorted(p.stem for p in snap_dir.glob("*.dill") if _belongs(p.stem))
                if snap_dir.is_dir()
                else []
            )
            return {
                "active_kernels": [
                    {
                        "name": k.name,
                        "alive": k.client.alive,
                        "python": k.client.python_version,
                        "skills_loaded": k.skill_report.get("loaded", []),
                        **({"skills_failed": k.skill_report["failed"]} if k.skill_report.get("failed") else {}),
                    }
                    for k in self._kernels.values()
                    if _belongs(k.name)
                ],
                "saved_snapshots": saved,
            }

        if action == "reset":
            existing = self._kernels.pop(key, None)
            if existing:
                await existing.client.shutdown()
            for path in self._snapshot_paths(key):
                if path.is_file():
                    path.unlink()
            return {"kernel": key, "status": "reset"}

        managed = await self._ensure_kernel(key, cwd=cwd)

        if action == "vars":
            info = await managed.client.list_names()
            return {"kernel": key, "names": info.get("names", [])}

        if action == "snapshot":
            snap_path, manifest_path = self._snapshot_paths(key)
            done = await managed.client.snapshot(snap_path, manifest_path)
            return {"kernel": key, "snapshot_path": str(snap_path), **done}

        if action == "restore":
            snap_path, _ = self._snapshot_paths(key)
            if not snap_path.is_file():
                return {"kernel": key, "status": "error", "error": f"No snapshot found at {snap_path}"}
            done = await managed.client.restore(snap_path)
            return {"kernel": key, "snapshot_path": str(snap_path), **done}

        raise ValueError(f"Unknown kernel_state action: {action!r}")

    def get_overview(self) -> dict[str, Any]:
        return {
            "kernels": [
                {
                    "name": k.name,
                    "alive": k.client.alive,
                    "python": k.client.python_version,
                    "skills_loaded": k.skill_report.get("loaded", []),
                    "last_used_at": k.last_used_at,
                }
                for k in self._kernels.values()
            ],
            "history": [
                {
                    "cell_id": h.cell_id,
                    "kernel": h.kernel,
                    "code_preview": h.code_preview,
                    "status": h.status,
                    "duration_ms": h.duration_ms,
                    "truncated": h.truncated,
                }
                for h in reversed(self._history[-20:])
            ],
        }

    async def shutdown_all(self) -> None:
        for managed in list(self._kernels.values()):
            await managed.client.shutdown()
        self._kernels.clear()
