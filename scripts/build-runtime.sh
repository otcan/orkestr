#!/usr/bin/env bash
set -euo pipefail

if [ "${ORKESTR_BUILD_WEB_FROM_SOURCE:-0}" = "1" ]; then
  npm run build
else
  npm run build:server
  npm run web:verify-static
fi
