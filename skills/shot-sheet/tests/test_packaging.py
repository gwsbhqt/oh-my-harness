"""Exercise release artifacts without the sibling source tree or network access."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import venv
import zipfile

from PIL import Image
import pytest

ROOT = Path(__file__).resolve().parents[1]


def _run(*command, cwd, env=None):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return result


@pytest.fixture(scope="module")
def release_artifacts(tmp_path_factory):
    work = tmp_path_factory.mktemp("release")
    source = work / "checkout" / "shot-sheet"
    shutil.copytree(ROOT, source, ignore=shutil.ignore_patterns(
        ".venv", ".pytest_cache", "__pycache__", "*.pyc", "dist", "uv.lock", ".artifacts"))
    shared = ROOT.parent / "_shared" / "agentkit" / "cli.py"
    if shared.is_file():
        shared_copy = source.parent / "_shared" / "agentkit" / "cli.py"
        shared_copy.parent.mkdir(parents=True)
        shutil.copyfile(shared, shared_copy)
    (source / "local-note.txt").write_text("Not a release input", encoding="utf-8")
    cache = source / "src" / "shot_sheet" / "__pycache__"
    cache.mkdir()
    (cache / "stale.pyc").write_bytes(b"not a Python module")
    _run(sys.executable, "-m", "hatchling", "build", "-t", "wheel", "-t", "sdist", cwd=source)
    wheel, = (source / "dist").glob("*.whl")
    sdist, = (source / "dist").glob("*.tar.gz")
    unpacked = work / "unpacked"
    with tarfile.open(sdist) as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            assert not path.is_absolute() and ".." not in path.parts
            target = unpacked.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                assert member.isfile(), member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as data:
                    target.write_bytes(data.read())
    rebuilt_source, = unpacked.iterdir()
    assert not (rebuilt_source.parent / "_shared").exists()
    _run(sys.executable, "-m", "hatchling", "build", "-t", "wheel", cwd=rebuilt_source)
    rebuilt_wheel, = (rebuilt_source / "dist").glob("*.whl")
    return {"direct": wheel, "rebuilt": rebuilt_wheel, "sdist": sdist}


def test_release_contents_include_docs_adapter_and_license(release_artifacts):
    with tarfile.open(release_artifacts["sdist"]) as archive:
        names = {"/".join(PurePosixPath(m.name).parts[1:]) for m in archive.getmembers()}
    assert {"SKILL.md", "PYSKILL.md", "README.md", "README.en.md", "LICENSE", "AGENTS.md",
            "references/common.md", "references/cli.md", "scripts/shot-sheet",
            "src/shot_sheet/_cli_adapter.py", "tests/test_shot_sheet.py", "tests/render_fixture.py"} <= names
    assert not any("__pycache__" in name or name.endswith(".pyc") or name == "local-note.txt"
                   for name in names)
    for kind in ("direct", "rebuilt"):
        with zipfile.ZipFile(release_artifacts[kind]) as archive:
            names = set(archive.namelist())
            assert "shot_sheet/_cli_adapter.py" in names
            assert any(name.endswith("/licenses/LICENSE") for name in names)
            assert not any(name.startswith(("tests/", "references/", "scripts/", "agentkit/"))
                           or "__pycache__" in name for name in names)
            metadata, = [name for name in names if name.endswith(".dist-info/METADATA")]
            assert "License-Expression: MIT" in archive.read(metadata).decode()


@pytest.mark.parametrize("kind", ["direct", "rebuilt"])
def test_installed_wheel_runs_without_source_or_global_adapter(release_artifacts, tmp_path, kind):
    environment = tmp_path / "environment"
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    command = environment / ("Scripts/shot-sheet.exe" if os.name == "nt" else "bin/shot-sheet")
    clean_env = {"PATH": os.defpath}
    for key in ("SYSTEMROOT", "WINDIR"):
        if key in os.environ:
            clean_env[key] = os.environ[key]
    site_result = _run(str(python), "-I", "-c",
                       "import sysconfig; print(sysconfig.get_path('purelib'))",
                       cwd=tmp_path, env=clean_env)
    site_packages = Path(site_result.stdout.strip())
    # Reuse only the prepared Pillow runtime, never the parent environment's import paths.
    pillow = Path(Image.__file__).resolve().parent
    shutil.copytree(pillow, site_packages / "PIL")
    for libraries in pillow.parent.glob("[Pp]illow.libs"):
        shutil.copytree(libraries, site_packages / libraries.name)
    _run(str(python), "-I", "-m", "pip", "install", "--disable-pip-version-check",
         "--no-index", "--no-deps", str(release_artifacts[kind]), cwd=tmp_path, env=clean_env)
    probe = _run(str(python), "-I", "-c", """
import json, pathlib, sys
import shot_sheet
import shot_sheet.cli
assert pathlib.Path(shot_sheet.__file__).is_relative_to(pathlib.Path(sys.prefix))
assert shot_sheet.cli.dispatch.__module__ == 'shot_sheet._cli_adapter'
assert 'agentkit.cli' not in sys.modules
print(json.dumps({'module': shot_sheet.__file__}))
""", cwd=tmp_path, env=clean_env)
    assert json.loads(probe.stdout)["module"]
    source = tmp_path / "animation.gif"
    images = [Image.new("RGB", (90, 60), color) for color in ("red", "blue")]
    images[0].save(source, save_all=True, append_images=images[1:], duration=[250, 750], loop=0)
    original = source.read_bytes()
    output = tmp_path / "review.png"
    result = _run(str(command), "media-sheet", "--source", str(source), "--out", str(output),
                  "--times", "[0.1,0.5]", "--cols", "2", "--cell", "[180,120]",
                  cwd=tmp_path, env=clean_env)
    receipt = json.loads(result.stdout)
    assert [frame["time"] for frame in receipt["frames"]] == [0.1, 0.5]
    with Image.open(output) as image:
        assert image.size == (receipt["width"], receipt["height"])
        assert image.getpixel((120, 180)) == (255, 0, 0)
        assert image.getpixel((330, 180)) == (0, 0, 255)
    assert source.read_bytes() == original
