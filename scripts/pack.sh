#!/usr/bin/env bash
# Build a Chrome Web Store upload zip from the extension source.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="weft-$(node -p "require('./manifest.json').version").zip"
rm -f "$OUT"

zip -r "$OUT" . \
  -x '.git/*' \
  -x '.agent/*' \
  -x 'node_modules/*' \
  -x 'scripts/*' \
  -x 'test/*' \
  -x '.github/*' \
  -x 'docs/*' \
  -x '*.md' \
  -x 'package.json' \
  -x 'package-lock.json' \
  -x 'eslint.config.js' \
  -x '.prettierrc.json' \
  -x '.prettierignore' \
  -x '.gitignore' \
  -x '*.zip' \
  >/dev/null

echo "Built $OUT"
