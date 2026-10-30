#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!(a>22||a===22&&b>=19))process.exit(1)'
command -v python3 >/dev/null
command -v ssh >/dev/null
cd "$repo"
npm ci --ignore-scripts --no-audit --no-fund
npm test
printf 'Ready. Run node bin/starport-pi.mjs configure, then node bin/starport-pi.mjs auth.\n'
