"""Discover trusted Python skills under configured roots and workspace roots."""

from __future__ import annotations

import keyword
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from ruamel.yaml import YAML, YAMLError
from ruamel.yaml.constructor import SafeConstructor
from ruamel.yaml.nodes import ScalarNode


@dataclass(frozen=True, slots=True)
class SkillEntry:
    name: str
    import_name: str
    directory: str
    source_root: str
    description: str
    doc_path: str
    is_project: bool = False
    document_error: str | None = None


_CORE_SCALARS = {f"tag:yaml.org,2002:{kind}" for kind in ("null", "bool", "int", "float")}


class _DocumentConstructor(SafeConstructor):
    def construct_non_recursive_object(self, node, tag=None):
        # The host preserves the text when an explicit core tag does not recognize its scalar.
        if isinstance(node, ScalarNode) and node.tag in _CORE_SCALARS:
            implicit = self.loader.resolver.resolve(ScalarNode, node.value, (True, False))
            if node.tag != str(implicit):
                return node.value
        return super().construct_non_recursive_object(node, tag)


def _read_metadata(path: Path) -> dict:
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("instruction document is not a regular file")
    text = path.read_text(encoding="utf-8-sig")
    header = re.match(r"^---\n(.*?)\n---(?:\n|$)", text, re.DOTALL)
    if header is None:
        return {}
    parser = YAML(typ="safe", pure=True)
    parser.Constructor = _DocumentConstructor
    # DSH selects the YAML 1.2 core schema: plain dates and merge keys are strings.
    for rules in parser.resolver.versioned_resolver.values():
        rules[:] = [rule for rule in rules if rule[0] not in ("tag:yaml.org,2002:timestamp", "tag:yaml.org,2002:merge")]
    try:
        metadata = parser.load(header[1])
    except (YAMLError, ValueError, KeyError, TypeError, RecursionError, OverflowError) as exc:
        reason = getattr(exc, "problem", None) or str(exc)
        raise ValueError(f"invalid YAML: {reason}") from exc
    return metadata if isinstance(metadata, dict) else {}


def _description(metadata: dict) -> str:
    value = metadata.get("description")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("instruction document requires a non-empty description")
    return value.strip()


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


def _discover_entry(directory: Path, fallback_name: str, is_project: bool) -> SkillEntry | None:
    standard = directory / "SKILL.md"
    document = standard
    name = fallback_name
    description = ""
    error = None
    try:
        try:
            standard.lstat()
        except FileNotFoundError:
            return None
        metadata = _read_metadata(standard)
        if isinstance(metadata.get("name"), str) and metadata["name"]:
            name = metadata["name"]
        description = _description(metadata)
    except (OSError, ValueError) as exc:
        error = f"{standard}: {exc}"

    import_name = _normalize_import_name(name)
    if not import_name or not _has_python_package(directory, import_name):
        return None
    if error is None:
        document = directory / "PYSKILL.md"
        try:
            # A dangling symlink, a directory or a denied read is an error on the selected document.
            try:
                document.lstat()
            except FileNotFoundError:
                document = standard
            else:
                metadata = _read_metadata(document)
            if "name" in metadata and metadata["name"] != name:
                raise ValueError(f"name must remain {name!r}")
            description = _description(metadata)
        except (OSError, ValueError) as exc:
            error = f"{document}: {exc}"
    return SkillEntry(name=name, import_name=import_name, directory=str(directory), source_root=str(directory / "src"),
                      description=description, doc_path=str(document), is_project=is_project, document_error=error)


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
            entry = _discover_entry(real_child, child.name, is_project)
            if entry is not None:
                seen_dirs.add(real_child)
                entries.append(entry)

    if project_roots:
        repo_root = find_repo_root(cwd or Path.cwd())
        for rel in project_roots:
            _scan_root(repo_root / rel, is_project=True)

    for root in skill_roots:
        _scan_root(root, is_project=False)

    return entries
