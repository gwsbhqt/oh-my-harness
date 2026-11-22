"""Public Python API for Cra and Chrome browser control."""
from .browser import Browser, _BROWSER_ADAPTERS
from .protocol import BrowserError

__all__ = ["Browser", "BrowserError", *_BROWSER_ADAPTERS]


def __getattr__(name: str) -> Browser:
    if name in _BROWSER_ADAPTERS:
        return Browser(name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()).union(__all__))
