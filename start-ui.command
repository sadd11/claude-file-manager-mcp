#!/bin/sh
# Claude File Manager — setup UI (macOS / Linux).
# Double-click on macOS, or run:  sh start-ui.command
cd "$(dirname "$0")" || exit 1

if [ -x "runtime/node" ]; then
  NODE="./runtime/node"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 18+ is required. Install it with:  brew install node"
    exit 1
  fi
  NODE="node"
fi

exec "$NODE" ui/server.js
