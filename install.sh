#!/bin/sh
# Raven installer for macOS / Linux:  sh install.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node --version))." >&2
  exit 1
fi

echo "Installing Raven dependencies..."
npm install --omit=optional --no-audit --no-fund
# the npm postinstall step already ran `raven setup`; this makes sure of it
node bin/raven.js setup
