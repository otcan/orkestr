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
export ORKESTR_DESKTOP_IDLE_STOP_MS="${ORKESTR_DESKTOP_IDLE_STOP_MS:-600000}"
export ORKESTR_DESKTOP_GEOMETRY="${ORKESTR_DESKTOP_GEOMETRY:-1280x720x16}"
export ORKESTR_DESKTOP_WINDOW_SIZE="${ORKESTR_DESKTOP_WINDOW_SIZE:-1280,720}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

mkdir -p "$ORKESTR_HOME" "$CODEX_HOME" "$ORKESTR_HOME/workspaces" "$ORKESTR_HOME/browsers" "$ORKESTR_HOME/secrets"
chmod 700 "$ORKESTR_HOME" "$CODEX_HOME" "$ORKESTR_HOME/secrets" 2>/dev/null || true

# The built-in WhatsApp bridge drives Chromium through puppeteer. The image
# installs Chromium from Debian and npm runs with --ignore-scripts, so
# puppeteer has no bundled browser: point it at the system one.
if [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -z "${WA_CHROME_PATH:-}" ]; then
  for candidate in chromium chromium-browser google-chrome-stable google-chrome; do
    if chrome_path="$(command -v "$candidate" 2>/dev/null)" && [ -n "$chrome_path" ]; then
      export PUPPETEER_EXECUTABLE_PATH="$chrome_path"
      break
    fi
  done
  if [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
    echo "warning: no Chromium found for the WhatsApp bridge; set WA_CHROME_PATH" >&2
  fi
fi

if ! command -v "$ORKESTR_CODEX_BIN" >/dev/null 2>&1; then
  echo "warning: Codex CLI not found at ORKESTR_CODEX_BIN=$ORKESTR_CODEX_BIN" >&2
fi

if [ -n "${ORKESTR_DEMO_WHATSAPP_NUMBER:-${ORKESTR_DEMO_WA_NUMBER:-}}" ]; then
  export ORKESTR_DEMO_MODE="${ORKESTR_DEMO_MODE:-1}"
  export ORKESTR_WHATSAPP_ACCESS_MODE="${ORKESTR_WHATSAPP_ACCESS_MODE:-relay}"
  node /app/scripts/demo-vm-ready-notify.mjs &
fi

exec "$@"
