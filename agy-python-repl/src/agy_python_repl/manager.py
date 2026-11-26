"""Multi-kernel session manager for Antigravity Python REPL."""

from __future__ import annotations

import ast
import asyncio
import fcntl
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

import python_repl_core
from python_repl_core.kernel_client import CellResult, KernelClient, KernelProtocolError
from python_repl_core.output_budget import bound_text
from python_repl_core.skill_discovery import discover_python_skills
from python_repl_core.snapshot_store import reset_snapshot

from .bootstrap import SKILL_RETRY_MIME
from .snapshot_paths import NAMED_DIR, flat_names, has_snapshot, kernel_identity, named_storage, snapshot_paths


_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
_LEGACY_NAME_WARNING = (
    "This flat snapshot was opened by its exact disk spelling. Its original kernel name was not recorded."
)


def _name_warning(name: str, storage: Path) -> dict[str, str]:
    if storage.parent == Path(".") and name != "default" and not _UUID.fullmatch(name):
        return {"legacy_name_warning": _LEGACY_NAME_WARNING}
    return {}


_BUILTIN_SKILLS_DIR = Path(__file__).resolve().parents[2] / "skills"
_SNAPSHOT_PROTECTION_MESSAGE = (
    "Saving is paused because the previous snapshot could not be fully restored. "
    "Retry restore once its dependencies are available, or reset to discard that snapshot."
)


# AGY adds a hook/timestamp prefix and clips tool text around 10 KiB.
_HOST_TEXT_BYTES = 8 * 1024
_SUMMARY_BYTES = 4 * 1024


def _model_text(value: Any) -> str:
    # FastMCP renders dict returns as indented UTF-8 JSON in content[0].text.
    return json.dumps(value, ensure_ascii=False, indent=2)


def _model_bytes(value: Any) -> int:
    return len(_model_text(value).encode("utf-8", errors="replace"))


def _output_receipt(
    metadata: dict[str, Any], res: CellResult, directory: Path, max_chars: int
) -> dict[str, Any]:
    channels = {name: text for name, text in (
        ("stdout", res.stdout), ("stderr", res.stderr), ("result", res.result)
    ) if text is not None and (text or name == "result")}
    limits = {"stdout": max_chars, "stderr": max(4000, max_chars // 2), "result": max_chars}
    raw = metadata | channels
    over_budget = sum(map(len, channels.values())) > _HOST_TEXT_BYTES or _model_bytes(raw) > _HOST_TEXT_BYTES
    if not over_budget and not any(0 < limits[name] < len(text) for name, text in channels.items()):
        return raw

    captures = [(name, "txt", text) for name, text in channels.items()]
    if _model_bytes(metadata) > _SUMMARY_BYTES // 2:
        captures.append(("details", "json", _model_text(metadata)))
        metadata = metadata.copy()
        for key, value in metadata.items():
            if isinstance(value, dict):
                # Keep the error or restore outcome inline. The capture retains full diagnostics.
                metadata[key] = {
                    field: bound_text(item, max_chars=320).text if isinstance(item, str) else item
                    for field, item in value.items()
                    if field in {"ename", "evalue", "status", "restored", "reason"}
                }
            elif isinstance(value, str):
                metadata[key] = bound_text(value, max_chars=320).text
        metadata["details_truncated"] = True

    files: list[str] = []
    errors: dict[str, str] = {}
    for name, extension, text in captures:
        path = directory / f"{res.cell_id}_{name}.{extension}"
        try:
            directory.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors[name] = bound_text(str(exc), max_chars=320).text
        else:
            files.append(str(path))

    header: dict[str, Any] = {}
    if files:
        if _model_bytes(files) <= _SUMMARY_BYTES - 1024:
            header["overflow_files"] = files
        else:
            header["overflow_index"] = {"directory": str(directory), "files": [Path(f).name for f in files]}
    if errors:
        header["overflow_errors"] = errors
    header.update(metadata)
    header["truncated"] = True
    header["output_note"] = "Output is captured text. The kernel's display text for a result may already be truncated."

    # Each trial measures one whole MCP text block, including its paths, escapes and diagnostics.
    # Short channels stay intact while the larger previews shrink to fit around them.
    cap = _SUMMARY_BYTES
    while True:
        previews = {}
        for name, text in channels.items():
            limit = min(cap, limits[name]) if limits[name] > 0 else cap
            previews[name] = bound_text(text, max_chars=limit).text
        receipt = header | previews
        if _model_bytes(receipt) <= _SUMMARY_BYTES or cap == 1:
            return receipt
        cap //= 2


async def _control_cell(client: KernelClient, code: str, operation: str) -> CellResult:
    result = await client.execute(code, timeout_s=30.0)
    if result.timed_out:
        raise KernelProtocolError(f"{operation} timed out")
    if result.status != "ok":
        error = result.error or {}
        raise KernelProtocolError(f"{operation} failed: {error.get('ename', 'Error')}: {error.get('evalue', result.status)}")
    return result


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
    storage: Path
    ownership: BinaryIO
    client: KernelClient
    cwd: Path | None
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    skill_report: dict[str, Any] = field(default_factory=dict)
    pending_restore_notice: dict[str, Any] | None = None
    snapshot_protected: bool = False

    def apply_skill_retry(self, display: dict[str, Any]) -> None:
        update = display.get(SKILL_RETRY_MIME)
        if not isinstance(update, dict) or "error" not in update:
            return
        name, error = update.get("import_name"), update["error"]
        failed = self.skill_report["failed"]
        if not isinstance(name, str) or name not in failed:
            return
        if error is None:
            self.skill_report["loaded"] = sorted([*self.skill_report["loaded"], name])
            del failed[name]
        elif isinstance(error, str):
            failed[name] = error

    def skill_status(self) -> dict[str, Any]:
        failed = self.skill_report.get("failed", {})
        return {"skills_loaded": self.skill_report.get("loaded", []), **({"skills_failed": failed.copy()} if failed else {})}


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
        self.data_dir = (data_dir or _default_data_dir()).absolute()
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
        self._locks: dict[str, asyncio.Lock] = {}
        self._history: list[CellHistoryEntry] = []

    def _kernel_identity(self, kernel: str) -> tuple[str, Path]:
        name = kernel or "default"
        if name in self._kernels:
            return name, self._kernels[name].storage
        return kernel_identity(self.data_dir, name)

    def _saved_names(self) -> set[str]:
        names = flat_names(self.data_dir)
        for marker in (self.data_dir / "snapshots" / NAMED_DIR).glob("*.name"):
            try:
                name = marker.read_bytes().decode("utf-8")
            except (OSError, UnicodeError):
                continue
            storage = named_storage(name)
            if storage.name == marker.stem and has_snapshot(*snapshot_paths(self.data_dir, storage)):
                names.add(name)
        return names

    async def _ensure_kernel(self, key: str, storage: Path, *, cwd: Path | None = None) -> ManagedKernel:
        requested = cwd.resolve(strict=True) if cwd is not None else None
        if requested is not None and not requested.is_dir():
            raise NotADirectoryError(f"Kernel working directory is not a directory: {requested}")
        existing = self._kernels.get(key)
        if existing and existing.client.alive:
            if requested is not None and requested != existing.cwd:
                # Cancellation can arrive after the subprocess has already changed directory.
                existing.cwd = None
                await _control_cell(
                    existing.client,
                    f"__import__('os').chdir({str(requested)!r})",
                    f"Switching kernel working directory to {requested}",
                )
                existing.cwd = requested
            existing.last_used_at = time.time()
            return existing
        if existing:
            await existing.client.shutdown()
            del self._kernels[key]
            ownership = existing.ownership
        else:
            ownership = self._acquire_ownership(key, storage)
        try:
            work_dir = requested or (existing.cwd if existing else None) or Path.cwd()
            managed = await self._start_kernel(key, storage, ownership, work_dir)
        except BaseException:
            ownership.close()
            raise
        self._kernels[key] = managed
        return managed

    def _acquire_ownership(self, key: str, storage: Path) -> BinaryIO:
        path = self.data_dir / "locks" / storage.with_suffix(".lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        # Never unlink this inode: independent opens must continue to contend on the same file.
        ownership = path.open("a+b")
        try:
            fcntl.flock(ownership.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            ownership.close()
            raise KernelProtocolError(
                f"Kernel {key!r} is in use by another AGY service. "
                "Use kernel_state('list') or the panel overview to inspect it. "
                "Retry after that service releases the kernel, or use another kernel name."
            ) from None
        except BaseException:
            ownership.close()
            raise
        return ownership

    async def _start_kernel(
        self, key: str, storage: Path, ownership: BinaryIO, work_dir: Path,
    ) -> ManagedKernel:
        entries = discover_python_skills(
            skill_roots=self.skill_roots, project_roots=self.project_skill_roots, cwd=work_dir
        )
        configured = {entry.import_name for entry in entries}
        entries.extend(
            entry for entry in discover_python_skills(skill_roots=[_BUILTIN_SKILLS_DIR])
            if entry.import_name not in configured
        )
        ownership_fd = ownership.fileno()
        snapshot, manifest = snapshot_paths(self.data_dir, storage)
        bootstrap_code = (
            # Prime retains the lock through its EOF snapshot. FileIO.close stays idempotent on nested forks.
            f"__import__('os').set_inheritable({ownership_fd}, False)\n"
            "__import__('os').register_at_fork("
            f"after_in_child=__import__('io').FileIO({ownership_fd}, 'r+').close)\n"
            # A -m process pins its initial directory in sys.path. An interactive REPL follows cwd.
            "if __import__('sys').path[:1] == [__import__('os').getcwd()]:\n"
            "    __import__('sys').path[0] = ''\n"
            "__import__('python_repl_core.snapshot_store', fromlist=['register_snapshot'])"
            f".register_snapshot({str(snapshot)!r}, {str(manifest)!r})\n"
            "__import__('agy_python_repl.bootstrap', fromlist=['install_antigravity_surface'])"
            f".install_antigravity_surface({[asdict(entry) for entry in entries]!r})"
        )
        client = KernelClient(
            python_exe=self.python_exe,
            vendor_dir=self.vendor_dir,
            compat_dir=self.compat_dir,
            cwd=work_dir,
            pass_fds=(ownership_fd,),
            extra_pythonpath=[
                Path(__file__).resolve().parents[1],
                Path(python_repl_core.__file__).resolve().parents[1],
            ],
        )
        try:
            await client.start()
            boot = await _control_cell(client, bootstrap_code, "Kernel bootstrap")
            try:
                report = ast.literal_eval(boot.result or "")
            except (SyntaxError, ValueError) as exc:
                raise KernelProtocolError("Kernel bootstrap returned an invalid skill report") from exc
            if not (
                isinstance(report, dict)
                and isinstance(report.get("loaded"), list)
                and isinstance(report.get("failed"), dict)
            ):
                raise KernelProtocolError("Kernel bootstrap returned an invalid skill report")

            restored = None
            if self.auto_snapshot:
                restored = await client.restore_if_present(snapshot, manifest)
                if restored is not None:
                    restored.update(_name_warning(key, storage))
        except BaseException:
            await client.shutdown()
            raise

        managed = ManagedKernel(
            name=key,
            storage=storage,
            ownership=ownership,
            client=client,
            cwd=work_dir,
            skill_report=report,
            pending_restore_notice=restored,
            snapshot_protected=restored is not None and not restored["restored"],
        )
        client.on_display = managed.apply_skill_retry
        return managed

    async def run_code(
        self,
        code: str,
        *,
        kernel: str = "default",
        timeout_seconds: float = 60.0,
        cwd: Path | None = None,
    ) -> dict[str, Any]:
        key, storage = self._kernel_identity(kernel)
        async with self._locks.setdefault(key, asyncio.Lock()):
            managed = await self._ensure_kernel(key, storage, cwd=cwd)
            started = time.monotonic()
            res: CellResult = await managed.client.execute(code, timeout_s=timeout_seconds)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            managed.last_used_at = time.time()

            status = "timeout" if res.timed_out else res.status
            out: dict[str, Any] = {"status": status}
            if managed.snapshot_protected:
                out["snapshot_warning"] = _SNAPSHOT_PROTECTION_MESSAGE
            elif self.auto_snapshot and not res.timed_out:
                snapshot, manifest = snapshot_paths(self.data_dir, storage)
                try:
                    saved = await self._save_snapshot(managed, snapshot, manifest)
                except Exception as exc:
                    out["snapshot_error"] = f"{type(exc).__name__}: {exc}"
                else:
                    if saved.get("status") != "ok":
                        out["snapshot_error"] = saved.get("reason") or "Kernel could not save the snapshot"
                    elif skipped := saved.get("skipped"):
                        out["snapshot_skipped_count"] = len(skipped)
                        out["snapshot_skipped_names"] = [bound_text(item["name"], max_chars=96).text for item in skipped[:3]]
                        out["snapshot_manifest"] = str(manifest)
            if managed.pending_restore_notice is not None:
                out["restored"] = managed.pending_restore_notice
                managed.pending_restore_notice = None

        if res.error is not None:
            out["error"] = res.error

        out = _output_receipt(out, res, self.data_dir / "overflow" / storage, self.max_output_chars)

        self._history.append(
            CellHistoryEntry(
                cell_id=res.cell_id,
                kernel=key,
                code_preview=code.strip().splitlines()[0][:120] if code.strip() else "",
                status=status,
                duration_ms=elapsed_ms,
                timestamp=time.time(),
                truncated=out.get("truncated", False),
            )
        )
        if len(self._history) > 100:
            self._history = self._history[-100:]
        return out

    async def _save_snapshot(self, managed: ManagedKernel, snapshot: Path, manifest: Path) -> dict[str, Any]:
        if managed.storage.parent != Path("."):
            marker = snapshot.with_suffix(".name")
            if marker.is_file():
                if marker.read_bytes() != managed.name.encode("utf-8"):
                    raise ValueError("Snapshot name record does not match the requested kernel")
            else:
                marker.parent.mkdir(parents=True, exist_ok=True)
                temp = tempfile.NamedTemporaryFile(dir=marker.parent, delete=False)
                try:
                    with temp:
                        temp.write(managed.name.encode("utf-8"))
                    os.replace(temp.name, marker)
                finally:
                    Path(temp.name).unlink(missing_ok=True)
        return await managed.client.snapshot(snapshot, manifest)

    async def kernel_state(
        self,
        action: str,
        *,
        kernel: str = "default",
        cwd: Path | None = None,
    ) -> dict[str, Any]:
        key, storage = self._kernel_identity(kernel)

        if action == "list":
            def _belongs(name: str) -> bool:
                if key == "default" or name == key:
                    return True
                return ":" not in key and "__" not in key and name.startswith((f"{key}:", f"{key}__"))

            saved = sorted(name for name in self._saved_names() if _belongs(name))
            return {
                "active_kernels": [
                    {
                        "name": k.name,
                        "alive": k.client.alive,
                        "python": k.client.python_version,
                        **k.skill_status(),
                    }
                    for k in self._kernels.values()
                    if _belongs(k.name)
                ],
                "saved_snapshots": saved,
            }

        async with self._locks.setdefault(key, asyncio.Lock()):
            if action == "reset":
                existing = self._kernels.get(key)
                if existing:
                    await existing.client.shutdown()
                    del self._kernels[key]
                    ownership = existing.ownership
                else:
                    ownership = self._acquire_ownership(key, storage)
                def clear_snapshot() -> None:
                    with ownership:
                        snapshot, manifest = snapshot_paths(self.data_dir, storage)
                        reset_snapshot(snapshot, manifest)
                        if storage.parent != Path("."):
                            snapshot.with_suffix(".name").unlink(missing_ok=True)

                # Cancellation may release the asyncio lock while another process still has a read open.
                # The worker retains ownership until it has removed this kernel's files.
                await asyncio.shield(asyncio.to_thread(clear_snapshot))
                return {"kernel": key, "status": "reset"}

            managed = await self._ensure_kernel(key, storage, cwd=cwd)
            if action == "vars":
                info = await managed.client.list_names()
                return {"kernel": key, "names": info.get("names", [])}

            snap_path, manifest_path = snapshot_paths(self.data_dir, storage)
            if action == "snapshot":
                if managed.snapshot_protected:
                    return {"kernel": key, "status": "error", "error": _SNAPSHOT_PROTECTION_MESSAGE}
                done = await self._save_snapshot(managed, snap_path, manifest_path)
                return {"kernel": key, "snapshot_path": str(snap_path), **done}

            if action == "restore":
                was_protected = managed.snapshot_protected
                managed.snapshot_protected = True
                done = await managed.client.restore(snap_path)
                if done.get("reason") == "snapshot not found":
                    managed.snapshot_protected = was_protected
                    return {"kernel": key, "status": "error", "error": f"No snapshot found at {snap_path}"}
                if done.get("status") != "ok" or done.get("reason"):
                    status = "error"
                elif done.get("failed"):
                    status = "partial"
                else:
                    status = "ok"
                    managed.snapshot_protected = False
                managed.pending_restore_notice = None
                manifest = done.pop("snapshot_manifest", {})
                done.pop("snapshot_skipped", None)
                return {"kernel": key, "snapshot_path": str(snap_path), **done, "status": status,
                        "saved_names": manifest.get("savedNames", []), "skipped": manifest.get("skipped", []),
                        **_name_warning(key, storage)}

            raise ValueError(f"Unknown kernel_state action: {action!r}")

    def get_overview(self) -> dict[str, Any]:
        return {
            "kernels": [
                {
                    "name": k.name,
                    "alive": k.client.alive,
                    "python": k.client.python_version,
                    **k.skill_status(),
                    "last_used_at": k.last_used_at,
                }
                for k in self._kernels.values()
            ] + [
                {"name": name, "alive": False, "python": "", "skills_loaded": [], "last_used_at": None}
                for name in sorted(self._saved_names() - self._kernels.keys())
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
        # Include in-flight starts and serialize each close with its final execution/save.
        for key, lock in list(self._locks.items()):
            async with lock:
                managed = self._kernels.get(key)
                if managed:
                    await managed.client.shutdown()
                    managed.ownership.close()
                    del self._kernels[key]
