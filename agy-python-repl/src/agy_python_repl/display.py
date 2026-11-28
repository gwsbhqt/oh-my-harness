"""Render the bounded kernel receipt for the text part of a run_code reply."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from python_repl_core.output_budget import bound_text


SUMMARY_BYTES = 4 * 1024


def _join(parts: list[str], *, blank_line: bool = False) -> str:
    chunks: list[str] = []
    for part in parts:
        if chunks:
            previous = chunks[-1]
            if not previous.endswith("\n"):
                chunks.append("\n")
            if blank_line and not previous.endswith(("\n\n", "\n\r\n")):
                chunks.append("\n")
        chunks.append(part)
    return "".join(chunks)


def _sample_names(names: list[str]) -> list[str]:
    return [name if len(name) <= 64 else name[:63] + "…" for name in names[:3]]


def summarize_restored_names(names: list[str]) -> dict[str, Any]:
    return {"restored_count": len(names), "restored_sample": _sample_names(names)}


def _names(label: str, names: Any, count: int | None = None) -> str:
    if not isinstance(names, list):
        return f"{label}: unavailable."
    total = len(names) if count is None else count
    sample = _sample_names(names)
    if total > len(sample):
        sample.append("…")
    example = f" ({', '.join(sample)})" if sample else ""
    return f"{label}: {total}{example}."


def _state_details(report: dict[str, Any], *, show_path: bool) -> list[str]:
    parts = []
    omitted = False
    if show_path and (path := report.get("snapshot_path")):
        parts.append(f"Snapshot: {path}")
    for key in ("error", "reason", "legacy_name_warning"):
        if message := report.get(key):
            detail = bound_text(str(message), max_chars=768)
            parts.append(detail.text)
            omitted |= detail.truncated
    if report.get("original_kept") is True:
        parts.append("The original kernel is still running.")
    for key in ("failed", "skipped"):
        issues = report.get(key) or []
        for issue in issues[:3]:
            name = issue.get("name", "unknown variable")
            reason = issue.get("reason", "reason unavailable")
            detail = bound_text(f"{name} ({reason})", max_chars=512)
            parts.append(f"{key.capitalize()}: {detail.text}")
            omitted |= detail.truncated
        if len(issues) > 3:
            parts.append(f"{len(issues) - 3} more {key} variables.")
            omitted = True
    if pruned := report.get("pruned"):
        parts.append(_names("Removed from the live kernel", pruned))
    if omitted:
        parts.append("Full diagnostics are in structuredContent.")
    return parts


def _restore_notice(report: Any) -> str:
    if not isinstance(report, dict):
        return "Snapshot restore could not be confirmed."
    status = report.get("status")
    complete = status == "ok" and report.get("restored") is True and not (report.get("failed") or report.get("reason"))
    if complete:
        names = report.get("restored_names", report.get("restored_sample"))
        headline = _names("Restored variables", names, report.get("restored_count"))
    elif status == "error":
        headline = "Snapshot restore failed."
    elif status == "partial":
        headline = "Snapshot partially restored."
    else:
        headline = "Snapshot restore could not be confirmed."
    show_path = not complete or bool(report.get("failed") or report.get("skipped"))
    return _join([headline, *_state_details(report, show_path=show_path)])


def render_kernel_state(action: str, receipt: dict[str, Any]) -> str:
    if action == "list":
        active = receipt.get("active_kernels")
        if isinstance(active, list):
            labels = [row["name"] + (" [stopped]" if row.get("alive") is False else "") for row in active[:3]]
            kernels = _names("Kernels", labels, len(active))
        else:
            kernels = "Kernels: unavailable."
        return _join([kernels, _names("Saved snapshots", receipt.get("saved_snapshots"))])
    if action == "vars":
        return _names("Variables", receipt.get("names"))

    status = receipt.get("status")
    issues = bool(receipt.get("failed") or receipt.get("skipped"))
    name_field = "saved" if action == "snapshot" else "restored"
    names = receipt.get(name_field)
    if status == "error" or receipt.get("error") or receipt.get("reason") or (action == "restart" and issues):
        headline = f"{action.capitalize()} failed."
    elif status == "partial" or receipt.get("failed"):
        headline = f"{action.capitalize()} partially completed."
    elif action == "reset" and status == "reset":
        return "Kernel reset."
    elif status == "ok" and action != "reset" and isinstance(names, list):
        success = {"snapshot": "Snapshot saved.", "restore": "Snapshot restored.", "restart": "Kernel restarted."}
        headline = f"{success[action]} {_names(f'{name_field.capitalize()} variables', names)}"
    elif status == "ok" and action != "reset":
        headline = f"{action.capitalize()} could not be confirmed. Missing {name_field} variable list."
    else:
        headline = f"{action.capitalize()} could not be confirmed (status: {status or 'missing'})."
    show_path = status != "ok" or issues or bool(receipt.get("error") or receipt.get("reason")) or not isinstance(names, list)
    return _join([headline, *_state_details(receipt, show_path=show_path)])


def render_run_code(receipt: dict[str, Any]) -> str:
    parts: list[str] = []
    status = receipt.get("status")
    if status == "timeout":
        parts.append("Execution timed out.")
    elif status == "error":
        parts.append("Execution failed.")
    elif status != "ok":
        parts.append(f"Unconfirmed execution status: {status or 'missing'}.")

    if receipt.get("truncated"):
        parts.append("Output truncated.")
        if receipt.get("details_truncated"):
            parts.append("Diagnostics truncated.")
        paths = receipt.get("overflow_files", [])
        index = receipt.get("overflow_index") or {}
        if not paths and index.get("directory") and index.get("files"):
            directory = Path(index["directory"])
            paths = [str(directory / name) for name in index["files"]]
            if len("\n".join(paths).encode("utf-8", errors="replace")) > SUMMARY_BYTES:
                paths = [f"Capture directory: {directory}", *index["files"]]
        parts.extend(paths)
        errors = receipt.get("overflow_errors", {})
        for channel, message in errors.items():
            parts.append(f"Could not save {channel}: {message}")
        if not paths and not errors:
            parts.append("No capture path was returned.")
        if note := receipt.get("output_note"):
            parts.append(note)

    if message := receipt.get("state_loss"):
        parts.append(message)
    if "restored" in receipt:
        parts.append(_restore_notice(receipt["restored"]))
    if message := receipt.get("snapshot_warning"):
        parts.append(message)
    if error := receipt.get("snapshot_error"):
        parts.append(f"Snapshot save failed: {error}")
    if "snapshot_skipped_count" in receipt:
        skipped = receipt["snapshot_skipped_count"]
        names = receipt.get("snapshot_skipped_names", [])
        notice = f"Variables skipped in snapshot: {skipped}"
        parts.append(f"{notice} ({', '.join(names)})" if names else notice)
        if skipped > len(names) and (manifest := receipt.get("snapshot_manifest")):
            parts.append(f"Snapshot manifest: {manifest}")

    stdout = receipt.get("stdout")
    stderr = receipt.get("stderr")
    if stdout and stderr and (status != "ok" or receipt.get("truncated")):
        stderr = f"[stderr]\n{stderr}"
    outputs = [text for text in (stdout, stderr, receipt.get("result")) if text is not None]
    if outputs:
        parts.append(_join(outputs, blank_line=True))

    error = receipt.get("error") or {}
    if trace := error.get("traceback"):
        parts.append(_join(trace))
    elif error or status == "error":
        summary = ": ".join(filter(None, (error.get("ename"), error.get("evalue"))))
        parts.append(summary or "No error details were returned.")
    if hint := receipt.get("reuse_hint"):
        parts.append(f"Hint: {' '.join(hint.split())}")
    return _join(parts)
