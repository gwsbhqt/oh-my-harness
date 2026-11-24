"""Discover trusted Python skills under configured roots and workspace roots."""

from __future__ import annotations

import keyword
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SkillEntry:
    name: str
    import_name: str
    directory: str
    source_root: str
    description: str
    doc_path: str
    is_project: bool = False


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Minimal YAML-frontmatter parser for `name` and `description` without PyYAML."""
    if not text.startswith("---"):
        return {}
    lines = text.splitlines()
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx is None:
        return {}

    meta: dict[str, str] = {}
    current_key: str | None = None
    buf: list[str] = []

    def _flush() -> None:
        nonlocal current_key, buf
        if current_key is not None:
            meta[current_key] = " ".join(part.strip() for part in buf if part.strip()).strip("\"'")
        current_key = None
        buf = []

    for line in lines[1:end_idx]:
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            _flush()
            key, val = m.group(1), m.group(2).strip()
            if val in (">-", ">", "|-", "|"):
                current_key = key
                buf = []
            else:
                meta[key] = val.strip("\"'")
        elif current_key is not None and (line.startswith(" ") or line.startswith("\t") or not line.strip()):
            buf.append(line)
    _flush()
    return meta


def _has_python_package(skill_dir: Path, import_name: str) -> bool:
    src_dir = skill_dir / "src"
    if not src_dir.is_dir():
        return False
    return (src_dir / import_name / "__init__.py").is_file() or (src_dir / f"{import_name}.py").is_file()


def _normalize_import_name(name: str) -> str | None:
    candidate = name.replace("-", "_")
    if not candidate.isidentifier() or keyword.iskeyword(candidate):
        return None
    return candidate


def find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for parent in (cur, *cur.parents):
        if (parent / ".git").exists():
            return parent
    return cur


def discover_python_skills(
    *,
    skill_roots: list[Path],
    project_roots: list[Path] | None = None,
    cwd: Path | None = None,
) -> list[SkillEntry]:
    """Scan trusted roots for skills exposing `src/<import_name>/`."""
    entries: list[SkillEntry] = []
    seen_dirs: set[Path] = set()

    def _scan_root(root: Path, is_project: bool) -> None:
        resolved_root = root.expanduser().resolve()
        if not resolved_root.is_dir():
            return
        for child in sorted(resolved_root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            real_child = child.resolve()
            if real_child in seen_dirs:
                continue
            skill_md = real_child / "SKILL.md"
            if not skill_md.is_file():
                continue
            try:
                meta = _parse_frontmatter(skill_md.read_text(encoding="utf-8"))
            except OSError:
                continue
            raw_name = meta.get("name") or child.name
            import_name = _normalize_import_name(raw_name)
            if not import_name or not _has_python_package(real_child, import_name):
                continue
            seen_dirs.add(real_child)
            pyskill_md = real_child / "PYSKILL.md"
            doc_path = pyskill_md if pyskill_md.is_file() else skill_md
            entries.append(
                SkillEntry(
                    name=raw_name,
                    import_name=import_name,
                    directory=str(real_child),
                    source_root=str(real_child / "src"),
                    description=meta.get("description", ""),
                    doc_path=str(doc_path),
                    is_project=is_project,
                )
            )

    if project_roots:
        repo_root = find_repo_root(cwd or Path.cwd())
        for rel in project_roots:
            _scan_root(repo_root / rel, is_project=True)

    for root in skill_roots:
        _scan_root(root, is_project=False)

    return entries
