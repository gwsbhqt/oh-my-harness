"""`repl.install` checks, and `make_wheel`, the local wheels test/repl-install.test.ts installs offline."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import packages  # noqa: E402


def make_wheel(directory: Path, name: str, version: str, value: str) -> Path:
    """A minimal pure-Python wheel whose module exposes VALUE."""
    files = {
        f"{name}/__init__.py": f"VALUE = {value!r}\n",
        f"{name}-{version}.dist-info/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{name}-{version}.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    record = []
    for path, content in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(content.encode())}")
    record.append(f"{name}-{version}.dist-info/RECORD,,")
    files[f"{name}-{version}.dist-info/RECORD"] = "\n".join(record) + "\n"
    wheel = directory / f"{name}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return wheel


class Refusals(unittest.TestCase):
    """What `repl.install` rejects before running anything. Real installs are in test/repl-install.test.ts."""

    def install(self, *specs: str):
        return asyncio.run(packages.install(list(specs)))

    def test_options_are_not_accepted_as_requirements(self) -> None:
        with self.assertRaises(ValueError):
            self.install("--index-url=http://example.invalid", "x")
        with self.assertRaises(ValueError):
            self.install()

    @unittest.skipIf(sys.prefix != sys.base_prefix, "the test interpreter is a venv")
    def test_a_kernel_outside_a_venv_never_installs(self) -> None:
        with self.assertRaises(RuntimeError) as caught:
            self.install("x")
        self.assertIn("not in its own venv", str(caught.exception))


class Restart(unittest.TestCase):
    def test_request_is_read_once(self) -> None:
        packages.request_restart("new numpy")
        self.assertEqual(packages.take_restart(), "new numpy")
        self.assertIsNone(packages.take_restart())


if __name__ == "__main__":
    unittest.main()
