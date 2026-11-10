"""Replay the kernel's note selection (habits.Tracker.observe) over cells.pkl.

Decisions go through habits.Policy.due itself; only the bookkeeping around it
is restated here, because re-parsing 12k cells per policy would make a grid
search take hours. tests: evaluate.py `replay` must agree with this.
"""

import common  # noqa: F401  (puts python/ on sys.path)
import habits

FIELDS = set(habits.Unit.__dataclass_fields__)


def prepare(cells):
    """Units as habits.Unit, largest first, with occurrence and the cell's spans."""
    out = {}
    for sess, rows in cells.items():
        prepared = []
        for row in rows:
            units = sorted(((habits.Unit(**{k: u[k] for k in FIELDS}), u["occ"]) for u in row), key=lambda x: -x[0].size)
            prepared.append(units)
        out[sess] = prepared
    return out


_CACHE = {}


def run(cells, policy):
    """{"cells": n noted cells, "function": {(sess, key)}, "edit": {...}, "covered": {...}}."""
    prepared = _CACHE.get(id(cells))
    if prepared is None:
        prepared = _CACHE[id(cells)] = prepare(cells)
    noted_cells, function, edit, covered = 0, set(), set(), set()
    for sess, rows in prepared.items():
        noted = set()
        for units in rows:
            for unit, occ in units:
                if unit.key in noted or not policy.due(unit, occ):
                    continue
                noted_cells += 1
                (edit if unit.hand_edit else function).add((sess, unit.key))
                for other, _ in units:
                    if not (other.last < unit.first or other.first > unit.last):
                        noted.add(other.key)
                        covered.add((sess, other.key))
                break
    return {"cells": noted_cells, "function": function, "edit": edit, "covered": covered}
