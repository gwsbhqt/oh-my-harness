#!/usr/bin/env sh
set -eu

ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA="${PLUGIN_DATA:-${AGY_PYTHON_REPL_DATA:-${HOME:?}/.gemini/antigravity/plugin_data/agy-python-repl}}"
VENV="$DATA/venv"

UV="$(command -v uv || true)"
if [ -z "$UV" ]; then
  # Desktop clients can launch with the system PATH, even when uv is installed for the user.
  for candidate in "${XDG_BIN_HOME:-$HOME/.local/bin}/uv" "${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if [ -x "$candidate" ]; then UV="$candidate"; break; fi
  done
fi
if [ -z "$UV" ]; then
  echo "agy-python-repl requires uv. Install uv in your user bin directory, or add it to Antigravity's PATH." >&2
  exit 127
fi

UV_PROJECT_ENVIRONMENT="$VENV" "$UV" sync --quiet --frozen --no-install-project --project "$ROOT" --python 3.14 >&2
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$ROOT/src" exec "$VENV/bin/python" -m agy_python_repl.server
