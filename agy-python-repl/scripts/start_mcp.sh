#!/usr/bin/env sh
set -eu

ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA="${PLUGIN_DATA:-${TMPDIR:-/tmp}/agy-python-repl}"
VENV="$DATA/venv"

UV_PROJECT_ENVIRONMENT="$VENV" uv sync --frozen --no-install-project --project "$ROOT" --python 3.14 >/dev/null 2>&1
PYTHONPATH="$ROOT/src" exec "$VENV/bin/python" -m agy_python_repl.server
