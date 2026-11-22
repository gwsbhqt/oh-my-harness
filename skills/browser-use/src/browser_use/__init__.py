"""Public Python API for Cra and Chrome browser control."""
from .browser import Browser
from .protocol import BrowserError

__all__ = ["Browser", "BrowserError"]
