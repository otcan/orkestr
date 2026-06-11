#!/usr/bin/env bash
set -euo pipefail

export ORKESTR_HOME="${ORKESTR_HOME:-/data}"
export CODEX_HOME="${CODEX_HOME:-$ORKESTR_HOME/codex}"
export ORKESTR_HOST="${ORKESTR_HOST:-0.0.0.0}"
export ORKESTR_PORT="${ORKESTR_PORT:-${PORT:-3000}}"
export PORT="${PORT:-$ORKESTR_PORT}"
export ORKESTR_BROWSER_DESKTOP_MODE="${ORKESTR_BROWSER_DESKTOP_MODE:-browserctl}"
export ORKESTR_BROWSERCTL_PATH="${ORKESTR_BROWSERCTL_PATH:-/app/scripts/browserctl.mjs}"
export ORKESTR_CHROME_NO_SANDBOX="${ORKESTR_CHROME_NO_SANDBOX:-1}"
export ORKESTR_CODEX_BIN="${ORKESTR_CODEX_BIN:-codex}"

mkdir -p "$ORKESTR_HOME" "$CODEX_HOME" "$ORKESTR_HOME/workspaces" "$ORKESTR_HOME/browsers" "$ORKESTR_HOME/secrets"
chmod 700 "$ORKESTR_HOME" "$CODEX_HOME" "$ORKESTR_HOME/secrets" 2>/dev/null || true

if ! command -v "$ORKESTR_CODEX_BIN" >/dev/null 2>&1; then
  echo "warning: Codex CLI not found at ORKESTR_CODEX_BIN=$ORKESTR_CODEX_BIN" >&2
fi

exec "$@"
