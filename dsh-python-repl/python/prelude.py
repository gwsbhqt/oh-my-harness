"""Standard-library names every kernel starts with.

Models kept using `json`, `os`, `Path`, `Counter` without importing them —
often right after importing them in a `bash` subprocess, or in a kernel that
has since been replaced — and each NameError cost a retry. Stdlib only, already
loaded by the kernel or nearly free to load, no side effects on import.

These are ordinary names, not bridge bindings: the user may import them again
or rebind them freely, nothing warns, `restore_binding` does not own them, and
they are never saved for revival or reported as lost. A name counts as
preloaded only while it still holds the exact object installed here.
"""

from __future__ import annotations

import importlib
from typing import Any

#: name -> (module, attribute or None for the module itself).
#:
#: `datetime` is left out on purpose: sessions use it both as the module
#: (`datetime.datetime.now()`) and as the class (`datetime.now()`), and either
#: guess turns the other spelling into a confusing AttributeError instead of a
#: plain NameError.
NAMES: dict[str, tuple[str, str | None]] = {
    "json": ("json", None),
    "os": ("os", None),
    "re": ("re", None),
    "sys": ("sys", None),
    "time": ("time", None),
    "Path": ("pathlib", "Path"),
    "Counter": ("collections", "Counter"),
    "defaultdict": ("collections", "defaultdict"),
    "timedelta": ("datetime", "timedelta"),
    "timezone": ("datetime", "timezone"),
}

#: What `install` bound in this process; empty before it ran.
_INSTALLED: dict[str, Any] = {}


def _value(name: str) -> Any:
    module_name, attr = NAMES[name]
    module = importlib.import_module(module_name)
    return module if attr is None else getattr(module, attr)


def install(ns: dict[str, Any]) -> list[str]:
    """Bind every preloaded name into `ns`; returns the names."""
    _INSTALLED.clear()
    for name in NAMES:
        _INSTALLED[name] = ns[name] = _value(name)
    return list(_INSTALLED)


def is_preloaded(name: Any, value: Any) -> bool:
    """Whether `name` still holds the object `install` gave it."""
    return isinstance(name, str) and name in _INSTALLED and value is _INSTALLED[name]

