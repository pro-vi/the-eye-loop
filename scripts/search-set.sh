#!/usr/bin/env bash
# Thin wrapper around scripts/search-set.mjs — the ramp stage 6 search-set
# runner. See that file for env knobs and exit-code contract.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/search-set.mjs "$@"
