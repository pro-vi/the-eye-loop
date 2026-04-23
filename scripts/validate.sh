#!/usr/bin/env bash
# Thin wrapper around scripts/validate.mjs — the ramp stage 2-5 live smoke.
# See that file for env knobs and exit-code contract.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/validate.mjs "$@"
