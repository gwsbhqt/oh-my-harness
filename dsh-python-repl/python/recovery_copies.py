"""Locate recovery copies in the DSH session and retain its archive and snapshot policies."""
import lifecycle
import snapshot_refs
from python_repl_core import recovery_copies


def list_copies() -> list[str]:
    return recovery_copies.list_copies(lifecycle.state().dir)


def save(names: tuple[str, ...]) -> dict:
    if not snapshot_refs.install():
        raise RuntimeError("dill is unavailable for recovery copies")
    state = lifecycle.state()
    return recovery_copies.save(state.dir, names, archived=state.archived, protected=state.protected)


def read(copy_id: str) -> dict:
    if not snapshot_refs.install():
        raise RuntimeError("dill is unavailable for recovery copies")
    return recovery_copies.read(lifecycle.state().dir, copy_id)
