#!/usr/bin/env sh
set -eu

# Create a self-contained copy of agy-python-repl (including python_repl_core and vendor/prime)
# suitable for standalone installation outside the oh-my-harness checkout.
DEST="${1:?Usage: bundle.sh <output-dir>}"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd -P)"
for existing in "$DEST"/* "$DEST"/.[!.]* "$DEST"/..?*; do
  if [ -e "$existing" ] || [ -L "$existing" ]; then
    echo "Choose an empty output directory: $DEST" >&2
    exit 1
  fi
done

cp "$REPO_ROOT/LICENSE" "$DEST/LICENSE"
for item in plugin.json mcp_config.json pyproject.toml uv.lock README.md hooks.json rules ui hooks; do
  cp -R "$PLUGIN_ROOT/$item" "$DEST/$item"
done
mkdir -p "$DEST/scripts" "$DEST/src"
cp "$PLUGIN_ROOT/scripts/start_mcp.sh" "$DEST/scripts/"
cp -R "$PLUGIN_ROOT/src/agy_python_repl" "$DEST/src/"
mkdir -p "$DEST/skills/agy-use/src"
cp -R "$PLUGIN_ROOT/skills/agy-use/src/agy_use" "$DEST/skills/agy-use/src/"
for item in SKILL.md PYSKILL.md pyproject.toml scripts references; do
  cp -R "$PLUGIN_ROOT/skills/agy-use/$item" "$DEST/skills/agy-use/$item"
done

mkdir -p "$DEST/_bundled/vendor"
cp -R "$REPO_ROOT/python-repl-core/src/python_repl_core" "$DEST/_bundled/python_repl_core"
cp -R "$REPO_ROOT/dsh-python-repl/vendor/prime" "$DEST/_bundled/vendor/prime"
find "$DEST" -depth -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
find "$DEST" -depth -type d -name '__pycache__' -empty -delete

echo "Bundled self-contained plugin to $DEST"
