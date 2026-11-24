#!/usr/bin/env sh
set -eu

# Create a self-contained copy of agy-python-repl (including python_repl_core and vendor/prime)
# suitable for standalone installation outside the oh-my-harness checkout.
DEST="${1:?Usage: bundle.sh <output-dir>}"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"

rm -rf "$DEST"
mkdir -p "$DEST"

for item in plugin.json mcp_config.json pyproject.toml uv.lock README.md hooks.json rules src ui hooks scripts; do
  if [ -e "$PLUGIN_ROOT/$item" ]; then
    cp -R "$PLUGIN_ROOT/$item" "$DEST/$item"
  fi
done

mkdir -p "$DEST/_bundled/vendor"
cp -R "$REPO_ROOT/python-repl-core/src/python_repl_core" "$DEST/_bundled/python_repl_core"
cp -R "$REPO_ROOT/dsh-python-repl/vendor/prime" "$DEST/_bundled/vendor/prime"
find "$DEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

echo "Bundled self-contained plugin to $DEST"
