[中文](README.md) | English

# shot-sheet

Arrange screenshots into labeled, numbered contact sheets, compare before and after images, or add numbered red boxes. Extract frames from GIFs and videos by elapsed time and turn them into a single review image.

Processing is local and does not upload inputs. Python and the command line share one implementation. No browser, desktop application, or running DSH instance is required.

## Installation and entry points

Requires Python 3.10 or newer and Pillow 10 or newer. Video extraction additionally requires system `ffmpeg` and `ffprobe`; static images and GIFs do not. Chinese labels require a CJK font: macOS commonly provides PingFang; Linux can use Noto Sans CJK. Fonts and FFmpeg are not bundled.

Install the command from the repository root:

```sh
uv tool install ./skills/shot-sheet
shot-sheet --help
```

To run from source, keep the sibling `skills/_shared` directory and use:

```sh
uv run --project skills/shot-sheet shot-sheet --help
```

The [source launcher](scripts/shot-sheet) also runs with `uv run --script skills/shot-sheet/scripts/shot-sheet --help`. It resolves Pillow through uv; install or cache dependencies before offline use. Installed wheels include the shared command adapter and do not depend on a source checkout or personal skill directory.

For an agent, expose this directory through the host's trusted skill search path. Python skill kernels read [PYSKILL.md](PYSKILL.md) and call `skills.shot_sheet`; other environments read [SKILL.md](SKILL.md). Source discovery does not install dependencies. Ordinary Python projects install this package and use `import shot_sheet`.

Persistent Python kernels require Pillow 10 or later. If the first import reports a missing `PIL` module, install the dependency in that kernel and reload the skill. [Kernel recovery steps](PYSKILL.md)

## Common operations

The caller supplies the input files. Input order determines panel order.

```sh
shot-sheet sheet --panels '[["first.png","First screen"],["second.png","Second screen"]]' --out review.png --cols 2
shot-sheet compare --pairs '[["before.png","after.png","Overview"]]' --out comparison.png
shot-sheet annotate --image page.png --boxes '[[120,300,400,200]]' --out annotated.png
shot-sheet media-sheet --source demo.gif --out timeline.png --count 8 --cols 4
shot-sheet extract-frames --source demo.mp4 --out-dir frames --times '[1.0,3.5,8.0]'
```

The Python API exposes five synchronous functions: `sheet`, `compare`, `annotate`, `extract_frames`, and `media_sheet`. See the [CLI reference](references/cli.md), [image functions](src/shot_sheet/__init__.py), and [media functions](src/shot_sheet/media.py) for full parameters.

## Results and limitations

- Image results contain `out`, `width`, and `height`; the default maximum image edge is 3900 pixels. Media results also contain duration and requested sample times. Frame extraction returns each frame's path, dimensions, and time.
- Video extraction selects the frame displayed at the requested time. Supported formats depend on the local FFmpeg installation, and media must have a readable duration. The default samples the midpoint of eight equal intervals, with a maximum of 200 frames.
- Frame extraction refuses existing destinations. `media_sheet` refuses overwrite unless explicitly given `overwrite=True`. `sheet`, `compare`, and `annotate` replace their output files; first confirm that each output belongs to the task and differs from the inputs.
- Without a CJK font the tool warns and uses Pillow's default font, which may not render Chinese. Open the actual output to verify order, labels, cropping, and boxes; successful execution alone is not visual acceptance.

See the [shared rules](references/common.md) for failure, interruption, and cleanup behavior. The skill distributes no hosted service, installation state, or user media.

## Tests and distribution

Prepare the environment from the repository root, then run tests without network access:

```sh
uv sync --project skills/shot-sheet --extra test
uv run --offline --no-sync --project skills/shot-sheet python -m pytest skills/shot-sheet/tests -q
```

Tests generate fictional images and GIFs, checking dimensions, color order, relative coordinates, sampling boundaries, overwrite protection, and CLI results. When FFmpeg is installed, they also create and read MP4, MOV, MKV, and WebM; otherwise video tests are explicitly skipped. Chinese layout tests on Linux require a CJK font, such as Debian/Ubuntu's `fonts-noto-cjk` package.

Reproduce the visual check with the [fictional fixture renderer](tests/render_fixture.py); its output directory must not exist yet:

```sh
uv run --offline --no-sync --project skills/shot-sheet python skills/shot-sheet/tests/render_fixture.py skills/shot-sheet/.artifacts/review
```

Open the generated `review.png` to check Chinese text, panel order, boxes, and time labels. Inputs are generated locally and contain no real interfaces or accounts.

Distribution tests build a wheel and source archive in a temporary directory, rebuild a wheel from that archive, and verify real command output after isolated installation. The source archive allowlist includes instructions, references, tests, and source. Wheels contain the Python implementation, command entry point, and license information. Tests do not access accounts, desktops, or external networks.

## Origin and license

An original skill maintained by oh-my-harness, released under the [MIT license](LICENSE). The CLI reuses `skills/_shared/agentkit/cli.py` from this repository; builds include it inside the package rather than maintaining another copy. Pillow is a separately installed dependency under its own license. FFmpeg and system fonts retain their respective licenses.
