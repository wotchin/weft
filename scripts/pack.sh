#!/usr/bin/env bash
# Build a Chrome Web Store upload zip from the extension source.
#
# The contents come from an allow-list (scripts/package-files.mjs), so a stray
# file in the working tree can never reach users. That script's --check mode
# guards the opposite mistake — a real runtime file missing from the list.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed." >&2
  echo "  macOS/Linux: usually preinstalled (otherwise: apt install zip)." >&2
  echo "  Windows:     use WSL, or Git Bash with zip available." >&2
  exit 1
fi

# Fails loudly if the allow-list has drifted from what the extension loads.
node scripts/package-files.mjs --check

OUT="weft-$(node -p "require('./manifest.json').version").zip"
rm -f "$OUT"

# Paths never contain spaces, so the word splitting here is intentional.
# OS junk can still appear inside the allow-listed directories, hence -x.
# shellcheck disable=SC2046
zip -r "$OUT" $(node scripts/package-files.mjs --list) \
  -x '*/.DS_Store' -x '*/Thumbs.db' \
  >/dev/null

echo "Built $OUT"
