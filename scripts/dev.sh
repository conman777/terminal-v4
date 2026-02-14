#!/bin/sh
set -eu

case "$0" in
  */*) SCRIPT_PATH_DIR=${0%/*} ;;
  *) SCRIPT_PATH_DIR=. ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$SCRIPT_PATH_DIR" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
else
  echo "[dev] Node.js not found. Install Node 22+ or add node to PATH." >&2
  exit 1
fi

exec "$NODE_BIN" "$ROOT_DIR/scripts/dev.cjs" "$@"
